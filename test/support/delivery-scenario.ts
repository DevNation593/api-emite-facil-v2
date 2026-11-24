import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { DATABASE } from '../../src/database/database.module.js';
import type { DB } from '../../src/database/schema.js';
import { DeliveryService } from '../../src/delivery/delivery.service.js';
import { DocumentPipeline } from '../../src/orchestration/document-pipeline.js';
import type { ArtifactKind } from '../../src/storage/artifact-kind.js';
import { ArtifactStore } from '../../src/storage/artifact-store.js';
import { startStack, type StackHandle } from './containers.js';
import { ScriptedSmtp } from './scripted-smtp.js';
import {
  accessKeyOf,
  billingScenario,
  invoiceJson,
  issueInvoice,
  uploadTestCertificate,
  type BillingScenario,
} from './scenario.js';
import { SriStub, sriTestEnv } from './sri-stub.js';
import { startTestApp, type TestApp } from './test-app.js';

/** Remitente configurado en las pruebas. */
export const SENDER = 'facturas@plataforma.test';

/** El correo de las pruebas va a un servidor SMTP simulado, con esperas mínimas (AbstractIntegrationTest). */
export function deliveryTestEnv(smtp: ScriptedSmtp): Record<string, string> {
  return {
    DELIVERY_EMAIL_ENABLED: 'true',
    DELIVERY_EMAIL_FROM: SENDER,
    SPRING_MAIL_PORT: String(smtp.port),
    EINVOICE_DELIVERY_RETRY_BACKOFF: '1s',
    EINVOICE_DELIVERY_SEND_LEASE: '30s',
  };
}

/** Lo que una prueba de entrega necesita: contenedores, SRI y SMTP simulados y la aplicación (AbstractDeliveryIT). */
export class DeliveryHarness {
  private constructor(
    readonly stack: StackHandle,
    readonly sri: SriStub,
    readonly smtp: ScriptedSmtp,
    readonly testApp: TestApp,
    readonly db: pg.Client,
  ) {}

  static async start(env: Record<string, string> = {}): Promise<DeliveryHarness> {
    const stack = await startStack();
    const sri = await SriStub.start();
    const smtp = await ScriptedSmtp.start();
    const testApp = await startTestApp(stack, { ...sriTestEnv(sri), ...deliveryTestEnv(smtp), ...env });
    const db = new pg.Client({ connectionString: stack.databaseUrl });
    await db.connect();
    return new DeliveryHarness(stack, sri, smtp, testApp, db);
  }

  async stop(): Promise<void> {
    await this.db.end();
    await this.testApp.close();
    await this.smtp.close();
    await this.sri.close();
    await this.stack.stop();
  }

  get http(): TestApp['http'] {
    return this.testApp.http;
  }

  get kysely(): Kysely<DB> {
    return this.testApp.app.get(DATABASE);
  }

  get pipeline(): DocumentPipeline {
    return this.testApp.app.get(DocumentPipeline);
  }

  get deliveries(): DeliveryService {
    return this.testApp.app.get(DeliveryService);
  }

  /** Empresa con certificado cuyo cliente tiene ese correo (nulo: ninguno). */
  async scenario(email: string | null): Promise<BillingScenario> {
    const s = await billingScenario(this.http, this.db);
    await uploadTestCertificate(this.http, s.owner, s.taxpayer);
    await this.db.query('UPDATE customers SET email = $1 WHERE id = $2', [email, s.customer]);
    return s;
  }

  /**
   * Una factura autorizada de un emisor con certificado, cuyo cliente tiene un correo único para que el guion del
   * SMTP simulado no se mezcle con el de otras pruebas.
   */
  async authorizedInvoice(): Promise<AuthorizedInvoice> {
    const email = `c-${randomUUID()}@cliente.test`;
    const s = await this.scenario(email);
    const document = await issueInvoice(this.http, s.owner, invoiceJson(s, '2', '23.00'));
    const key = await accessKeyOf(this.db, document);
    const state = await this.pipeline.advance(s.tenant, document);
    if (state !== 'AUTHORIZED') throw new Error(`La factura quedó en ${state}`);
    return new AuthorizedInvoice(this, s, email, document, key);
  }
}

export interface DeliverySqlRow {
  id: string;
  tenant_id: string;
  channel: string;
  recipient: string;
  status: string;
  attempt_count: number;
  next_attempt_at: Date | null;
  retry_after: Date | null;
  sending_since: Date | null;
  last_error: string | null;
  provider_message_id: string | null;
  requested_by: string | null;
  sent_at: Date | null;
}

export class AuthorizedInvoice {
  constructor(
    private readonly harness: DeliveryHarness,
    readonly s: BillingScenario,
    readonly email: string,
    readonly document: string,
    readonly key: string,
  ) {}

  /** Lo que hace el worker al recibir un evento de entrega del comprobante. */
  process(service: DeliveryService = this.harness.deliveries): Promise<number> {
    return service.process(this.s.tenant, this.document);
  }

  async rows(): Promise<DeliverySqlRow[]> {
    return (
      await this.harness.db.query<DeliverySqlRow>('SELECT * FROM deliveries WHERE document_id = $1 ORDER BY created_at, id', [
        this.document,
      ])
    ).rows;
  }

  /** La única entrega del comprobante. */
  async delivery(): Promise<DeliverySqlRow> {
    const rows = await this.rows();
    if (rows.length !== 1) throw new Error(`Se esperaba una entrega y hay ${rows.length}`);
    return rows[0]!;
  }

  async artifact(kind: ArtifactKind): Promise<Buffer | null> {
    const found = await this.harness.testApp.app
      .get(ArtifactStore)
      .find(this.harness.kysely, this.s.tenant, this.document, kind);
    return found?.content ?? null;
  }
}
