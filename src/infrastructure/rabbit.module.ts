import {
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { connect, type ChannelModel, type ConfirmChannel } from 'amqplib';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const HEARTBEAT_SECONDS = 30;
const CLOSE_GRACE_MS = 2_000;
// Plazo del socket y del handshake AMQP, como la comprobación de health: sin él, un broker que
// acepta y no contesta deja `connecting` sin resolver y la conexión no se reintenta.
const CONNECT_TIMEOUT_MS = 2_000;

/**
 * Conexión a RabbitMQ bajo demanda. No conecta al crearse: la primera llamada a channel() o
 * ensureOpen() abre la conexión. Si se pierde, reconecta sola con espera creciente (1 s hasta
 * 30 s). Nada de esto emite errores sin atender: con el broker caído la aplicación sigue viva.
 * La topología (exchanges y colas) la declara quien consuma el canal.
 */
@Injectable()
export class RabbitConnection implements OnApplicationShutdown {
  private readonly logger = new Logger(RabbitConnection.name);
  private connection: ChannelModel | null = null;
  private connecting: Promise<ChannelModel> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs = MIN_BACKOFF_MS;
  private closed = false;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  isOpen(): boolean {
    return this.connection !== null;
  }

  /** Abre la conexión si hace falta. El llamador acota el tiempo con su propio plazo. */
  async ensureOpen(): Promise<void> {
    await this.open();
  }

  async channel(): Promise<ConfirmChannel> {
    const connection = await this.open();
    return connection.createConfirmChannel();
  }

  private open(): Promise<ChannelModel> {
    if (this.closed)
      return Promise.reject(new Error('RabbitMQ: conexión cerrada'));
    if (this.connection) return Promise.resolve(this.connection);
    this.connecting ??= this.connectOnce().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connectOnce(): Promise<ChannelModel> {
    const { host, port, user, password, vhost, tls } = this.config.rabbit;
    const connection = await connect(
      {
        protocol: tls ? 'amqps' : 'amqp',
        hostname: host,
        port,
        username: user,
        password,
        vhost,
        heartbeat: HEARTBEAT_SECONDS,
      },
      { timeout: CONNECT_TIMEOUT_MS },
    );
    if (this.closed) {
      // Se apagó mientras conectaba: no queda nadie para usar esta conexión.
      await this.closeQuietly(connection);
      throw new Error('RabbitMQ: conexión cerrada');
    }
    // Un error de la conexión va siempre seguido de 'close': aquí solo se evita que escale.
    connection.on('error', (error: Error & { code?: string }) => {
      this.logger.warn(`Error de RabbitMQ: ${error.code ?? error.name}`);
    });
    connection.on('close', () => {
      if (this.connection !== connection) return;
      this.connection = null;
      if (!this.closed) {
        this.logger.warn('Conexión con RabbitMQ perdida; se reintentará');
        this.scheduleReconnect();
      }
    });
    this.connection = connection;
    this.backoffMs = MIN_BACKOFF_MS;
    return connection;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open().catch(() => this.scheduleReconnect());
    }, delay);
    // La reconexión nunca debe impedir que el proceso termine.
    this.reconnectTimer.unref();
  }

  private async closeQuietly(connection: ChannelModel): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        connection.close(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, CLOSE_GRACE_MS);
        }),
      ]);
    } catch {
      // Ya estaba cerrada o el broker no contesta: da igual al apagar.
    } finally {
      clearTimeout(timer);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const connection = this.connection;
    this.connection = null;
    if (connection) await this.closeQuietly(connection);
  }
}

@Module({ providers: [RabbitConnection], exports: [RabbitConnection] })
export class RabbitModule {}
