import {
  type BeforeApplicationShutdown,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { Channel, ConsumeMessage } from 'amqplib';
import { ApiException } from '../common/api-exception.js';
import { runWithContext } from '../common/request-context.js';
import type { RabbitConnection } from '../infrastructure/rabbit.module.js';
import { type DocumentEvent, readDocumentEvent, RejectedEvent } from './document-event.js';
import type { DocumentPipeline } from './document-pipeline.js';
import { describeError } from './fixed-delay-scheduler.js';
import { declareTopology, ISSUE_QUEUE } from './messaging.js';

/*
 * Consume la cola de comprobantes y hace avanzar cada documento, como orchestration/DocumentWorker.java. Recibir
 * dos veces el mismo evento es inocuo: el pipeline decide qué hacer según el estado en que encuentre el
 * documento. Solo existe en modo worker.
 */

/** Esperas entre reintentos de un mensaje que falló: 2, 4 y 8 s (el retry de Spring, con máximo de 10 s). */
export const RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000];

const MIN_RESTART_MS = 1_000;
const MAX_RESTART_MS = 30_000;

export class DocumentWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(DocumentWorker.name);
  private readonly inFlight = new Set<Promise<void>>();
  private channel: Channel | null = null;
  private consumerTag: string | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartMs = MIN_RESTART_MS;
  private stopped = false;
  /** Se cumple al empezar a apagarse: corta la espera de un reintento. */
  private stopping!: () => void;
  private readonly stoppingSignal = new Promise<void>((resolve) => {
    this.stopping = resolve;
  });

  constructor(
    private readonly rabbit: RabbitConnection,
    private readonly pipeline: DocumentPipeline,
    /** Mensajes en curso a la vez: el máximo de consumidores (EINVOICE_WORKER_MAX_CONSUMERS). */
    private readonly prefetch: number,
    private readonly retryDelaysMs: readonly number[] = RETRY_DELAYS_MS,
  ) {}

  onApplicationBootstrap(): void {
    // Sin esperar al broker: con RabbitMQ caído la aplicación arranca y el consumo se reintenta.
    void this.consume();
  }

  /** Para de consumir y espera a los mensajes en curso antes de que se cierren la base y RabbitMQ. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    this.stopping();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const channel = this.channel;
    if (channel !== null && this.consumerTag !== null) await channel.cancel(this.consumerTag).catch(() => undefined);
    await Promise.allSettled(this.inFlight);
    this.channel = null;
    if (channel !== null) await channel.close().catch(() => undefined);
  }

  /** Si consume ahora mismo (para las pruebas y el diagnóstico). */
  isConsuming(): boolean {
    return this.channel !== null && this.consumerTag !== null;
  }

  private async consume(): Promise<void> {
    if (this.stopped) return;
    try {
      const channel = await this.rabbit.channel();
      channel.on('close', () => {
        if (this.channel !== channel) return;
        this.channel = null;
        this.consumerTag = null;
        if (!this.stopped) {
          this.logger.warn('El canal de consumo de RabbitMQ se cerró; se volverá a abrir');
          this.scheduleRestart();
        }
      });
      await declareTopology(channel);
      await channel.prefetch(this.prefetch);
      this.channel = channel;
      const { consumerTag } = await channel.consume(ISSUE_QUEUE, (message) => this.receive(channel, message));
      this.consumerTag = consumerTag;
      this.restartMs = MIN_RESTART_MS;
      if (this.stopped) await channel.cancel(consumerTag).catch(() => undefined);
    } catch (error) {
      this.logger.warn(`No se pudo consumir ${ISSUE_QUEUE}: ${describeError(error)}`);
      this.scheduleRestart();
    }
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return;
    const delay = this.restartMs;
    this.restartMs = Math.min(this.restartMs * 2, MAX_RESTART_MS);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.consume();
    }, delay);
    this.restartTimer.unref();
  }

  private receive(channel: Channel, message: ConsumeMessage | null): void {
    // null: el broker canceló el consumidor (la cola se borró); el cierre del canal lo vuelve a abrir.
    if (message === null) {
      void channel.close().catch(() => undefined);
      return;
    }
    const work = this.handle(channel, message);
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  private async handle(channel: Channel, message: ConsumeMessage): Promise<void> {
    let event: DocumentEvent;
    try {
      event = readDocumentEvent(message.content);
    } catch (error) {
      // Ilegible o incompleto: reintentar no lo arreglará. Va a la cola de mensajes muertos.
      const reason = error instanceof RejectedEvent ? error.message : describeError(error);
      this.logger.warn(`Mensaje rechazado sin volver a la cola: ${reason}`);
      settle(() => channel.nack(message, false, false));
      return;
    }
    await runWithContext({ correlationId: String(event.eventId), documentId: event.documentId }, () =>
      this.advance(channel, message, event),
    );
  }

  private async advance(channel: Channel, message: ConsumeMessage, event: DocumentEvent): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        const state = await this.pipeline.advance(event.tenantId, event.documentId);
        this.logger.log(`Documento ${event.documentId} en estado ${state} tras el evento ${event.eventType}`);
        settle(() => channel.ack(message));
        return;
      } catch (error) {
        if (error instanceof ApiException) {
          // El documento no existe para esa empresa: reintentar no lo arreglará.
          this.logger.warn(`Evento ${event.eventId} descartado: el documento ${event.documentId} no existe`);
          settle(() => channel.ack(message));
          return;
        }
        if (attempt >= this.retryDelaysMs.length) {
          this.logger.error(
            `El evento ${event.eventId} del documento ${event.documentId} falló ${attempt + 1} veces y va a la cola de mensajes muertos: ${describeError(error)}`,
          );
          settle(() => channel.nack(message, false, false));
          return;
        }
        this.logger.warn(`El evento ${event.eventId} falló y se reintentará: ${describeError(error)}`);
        const stopped = await Promise.race([
          new Promise<false>((resolve) => setTimeout(() => resolve(false), this.retryDelaysMs[attempt]).unref()),
          this.stoppingSignal.then(() => true as const),
        ]);
        if (stopped) {
          // Al apagarse no se espera al reintento: el mensaje vuelve a la cola para otro worker.
          settle(() => channel.nack(message, false, true));
          return;
        }
      }
    }
  }
}

/** ack o nack en un canal que pudo cerrarse: el broker volverá a entregar el mensaje, no hay nada que hacer. */
function settle(action: () => void): void {
  try {
    action();
  } catch {
    // Canal cerrado: el mensaje sin confirmar vuelve a la cola.
  }
}
