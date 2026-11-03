import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { DocumentIssuer, recipientOf } from '../../../src/billing/document-issuer.js';
import type { DocumentEnvelope } from '../../../src/billing/document-envelope.js';
import { DocumentKinds } from '../../../src/billing/document-kind.js';
import { DocumentXmlCheck } from '../../../src/billing/document-xml-check.js';
import { FiscalDocumentRepository } from '../../../src/billing/fiscal-document.repository.js';
import { IdempotencyStore } from '../../../src/billing/idempotency-store.js';
import { CatalogLines } from '../../../src/billing/catalog-lines.js';
import { FinalConsumerLimit } from '../../../src/billing/final-consumer-limit.js';
import { InvoiceController } from '../../../src/billing/invoice.controller.js';
import { InvoiceKind } from '../../../src/billing/invoice-kind.js';
import { IssueInvoiceDto } from '../../../src/billing/invoice.dto.js';
import { InvoiceService } from '../../../src/billing/invoice.service.js';
import { JsonContentKind } from '../../../src/billing/json-content-kind.js';
import { contentCodec } from '../../../src/billing/json-content.js';
import { OutboxWriter } from '../../../src/billing/outbox-writer.js';
import { BigDecimal } from '../../../src/common/big-decimal.js';
import { ApiException } from '../../../src/common/api-exception.js';
import { recordNumberSource } from '../../../src/common/json-source.js';
import { runWithContext } from '../../../src/common/request-context.js';
import { validationPipe } from '../../../src/common/validation.js';
import { CatalogRepository } from '../../../src/catalog/catalog.repository.js';
import { CustomerService } from '../../../src/catalog/customer.service.js';
import { AuditLog } from '../../../src/compliance/audit-log.js';
import { APP_CONFIG, type AppConfig } from '../../../src/config/app-config.js';
import { DATABASE } from '../../../src/database/database.module.js';
import type { DB } from '../../../src/database/schema.js';
import { createPinoLogger } from '../../../src/observability/logging.js';
import { XsdValidator } from '../../../src/xml/xsd-validator.js';
import { SequenceService } from '../../../src/sequence/sequence.service.js';
import { TaxpayerService } from '../../../src/taxpayer/taxpayer.service.js';
import { TenantAccess } from '../../../src/tenancy/tenant-access.js';
import { DOCUMENT_SCHEMAS, DOCUMENT_TYPES } from '../../../src/xml/document-type.js';
import { newUser } from '../../support/billing-data.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import {
  type BillingScenario,
  billingScenario,
  invoiceBody,
  invoiceJson,
  invoiceLine,
  invoiceRequest,
  issueInvoice,
} from '../../support/scenario.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

/*
 * Traducción de DocumentIssuerIT (replacementMustBeOfTheSameType llega con la reemisión), más las
 * pruebas del cambio de día fiscal, de los textos que el XML no admite y del documentId en los logs.
 */
let stack: StackHandle;
let testApp: TestApp;
let db: pg.Client;
let kysely: Kysely<DB>;
let s: BillingScenario;

beforeAll(async () => {
  stack = await startStack();
  testApp = await startTestApp(stack, { EINVOICE_RATE_LIMIT_WRITES: '1000000' });
  db = new pg.Client({ connectionString: stack.databaseUrl });
  await db.connect();
  kysely = testApp.app.get<Kysely<DB>>(DATABASE);
}, 300_000);
afterAll(async () => {
  await db?.end();
  await testApp?.close();
  await stack?.stop();
});
beforeEach(async () => {
  s = await billingScenario(testApp.http, db);
});

const http = () => testApp.http;
const count = async (sql: string, ...params: unknown[]) =>
  Number((await db.query<{ n: string }>(sql, params.length === 0 ? [s.tenant] : params)).rows[0]!.n);
const documentCount = () => count('SELECT count(*) AS n FROM fiscal_documents WHERE tenant_id = $1');

/** Contenido de la liquidación de prueba: cualquier objeto con un campo. */
interface Sample {
  text: string;
}

/** Liquidación de prueba cuyo XML nunca pasa el XSD: solo tiene el elemento raíz. */
class BrokenLiquidationKind extends JsonContentKind<Sample> {
  readonly type = DOCUMENT_TYPES.PURCHASE_LIQUIDATION;
  readonly schema = DOCUMENT_SCHEMAS.PURCHASE_LIQUIDATION_1_1_0;
  readonly displayName = 'Liquidación de prueba';
  readonly fileStem = 'liquidacion-prueba';
  readonly auditReserved = 'SAMPLE_RESERVED';

  constructor(documents: FiscalDocumentRepository) {
    super(contentCodec<Sample>([['text', 'string']]), documents);
  }

  buildXml(_envelope: DocumentEnvelope, _content: Sample): Buffer {
    return Buffer.from('<liquidacionCompra/>', 'utf8');
  }
}

async function ownerAccess(): Promise<TenantAccess> {
  return new TenantAccess(await newUser(db), s.tenant, 'OWNER');
}

function issueBroken(access: TenantAccess, key: string, hash: string): Promise<string> {
  const issuer = testApp.app.get(DocumentIssuer);
  const customers = testApp.app.get(CustomerService);
  const kind = new BrokenLiquidationKind(testApp.app.get(FiscalDocumentRepository));
  return issuer.issue(
    access,
    key,
    hash,
    {
      taxpayerId: s.taxpayer,
      establishmentCode: '001',
      emissionPointCode: '001',
      issueDate: null,
      currency: null,
      replacesDocumentId: null,
    },
    async (trx) => {
      const customer = await customers.get(access, s.customer, trx);
      return {
        kind,
        customerId: customer.id,
        recipient: recipientOf(customer),
        totals: { subtotal: null, totalDiscount: null, totalTax: null, total: BigDecimal.of('1') },
        modified: null,
        content: { text: 'x' },
      };
    },
  );
}

it('un XML inválido se rechaza sin dejar rastro', async () => {
  // El contador de liquidaciones del punto ya existe: la reserva lo avanzaría si no se revirtiera.
  await db.query(
    `INSERT INTO document_sequences (tenant_id, emission_point_id, environment, document_type, next_value)
     VALUES ($1, $2, '1', '03', 5)`,
    [s.tenant, s.point],
  );
  const access = await ownerAccess();
  const key = randomUUID();

  const error = await issueBroken(access, key, 'hash-1').catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiException);
  const problem = error as ApiException;
  expect(problem.status).toBe(422);
  expect(problem.errorCode).toBe('DOCUMENT_XML_INVALID');
  expect(problem.detail.trim()).not.toBe('');
  expect(problem.detail.length).toBeLessThanOrEqual(500);

  expect(
    await count(
      "SELECT next_value AS n FROM document_sequences WHERE emission_point_id = $1 AND document_type = '03'",
      s.point,
    ),
  ).toBe(5);
  expect(await documentCount()).toBe(0);
  expect(await count('SELECT count(*) AS n FROM outbox_events WHERE tenant_id = $1')).toBe(0);
  expect(await count('SELECT count(*) AS n FROM idempotency_records WHERE tenant_id = $1')).toBe(0);

  // La clave quedó libre: otra petición con ella vuelve a emitirse (y vuelve a fallar por el XML), sin conflicto.
  await expect(issueBroken(access, key, 'hash-2')).rejects.toMatchObject({ errorCode: 'DOCUMENT_XML_INVALID' });
});

it('el XML validado al emitir es, byte a byte, el que se genera después de lo guardado', async () => {
  const check = testApp.app.get(DocumentXmlCheck);
  const spy = vi.spyOn(check, 'problem');
  try {
    const document = await issueInvoice(
      http(),
      s.owner,
      invoiceBody(s, s.customer, [invoiceLine(s.product, '2', '1.5')], '3.45'),
    );
    expect(spy).toHaveBeenCalledTimes(1);
    const issued = spy.mock.calls[0]![0];

    const documents = testApp.app.get(FiscalDocumentRepository);
    const kind = testApp.app.get(DocumentKinds).find('01')!;
    const envelope = (await documents.envelope(kysely, s.tenant, document))!;
    const generated = kind.buildXml(envelope, await kind.loadContent(kysely, s.tenant, document));
    expect(generated.toString('utf8')).toBe(issued.toString('utf8'));
    expect(generated.equals(issued)).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

it('el evento del outbox es DOCUMENT_RESERVED y la auditoría INVOICE_RESERVED', async () => {
  const document = await issueInvoice(http(), s.owner, invoiceJson(s, '1', '11.50'));
  const outbox = await db.query<{ event_type: string }>('SELECT event_type FROM outbox_events WHERE aggregate_id = $1', [
    document,
  ]);
  expect(outbox.rows.map((r) => r.event_type)).toEqual(['DOCUMENT_RESERVED']);
  const audit = await db.query<{ action: string; metadata: Record<string, unknown> }>(
    'SELECT action, metadata FROM audit_events WHERE tenant_id = $1 AND entity_id = $2',
    [s.tenant, document],
  );
  expect(audit.rows).toEqual([{ action: 'INVOICE_RESERVED', metadata: { sequence: 1, environment: '1' } }]);
  // Programado para que el planificador lo retome si el evento se pierde, sin intentos todavía.
  const scheduled = await db.query<{ attempt_count: number; ok: boolean }>(
    `SELECT attempt_count, next_attempt_at BETWEEN now() + interval '4 minutes' AND now() + interval '6 minutes' AS ok
     FROM fiscal_documents WHERE id = $1`,
    [document],
  );
  expect(scheduled.rows).toEqual([{ attempt_count: 0, ok: true }]);
});

describe('textos que el XML no admite', () => {
  const nextValue = async () =>
    (await db.query('SELECT next_value FROM document_sequences WHERE emission_point_id = $1', [s.point])).rows[0];

  it('un carácter que XML no admite en el cliente es 422 y no consume el secuencial', async () => {
    await db.query("UPDATE customers SET name = E'Mar\\u0001ía' WHERE id = $1", [s.customer]);
    const res = await invoiceRequest(http(), s.owner, invoiceJson(s, '1', '11.50'), randomUUID()).expect(422);
    expect(res.body).toMatchObject({ errorCode: 'DOCUMENT_XML_INVALID', detail: 'Carácter no admitido en XML: U+1' });
    expect(await documentCount()).toBe(0);
    expect(await nextValue()).toBeUndefined();
  });

  it('una razón social de 301 caracteres es 422 con un detalle de 500 caracteres o menos', async () => {
    await db.query("UPDATE taxpayers SET legal_name = repeat('A', 301) WHERE id = $1", [s.taxpayer]);
    const res = await invoiceRequest(http(), s.owner, invoiceJson(s, '1', '11.50'), randomUUID()).expect(422);
    expect(res.body.errorCode).toBe('DOCUMENT_XML_INVALID');
    expect((res.body.detail as string).length).toBeGreaterThan(0);
    expect((res.body.detail as string).length).toBeLessThanOrEqual(500);
    expect(await documentCount()).toBe(0);
    expect(await nextValue()).toBeUndefined();
  });
});

describe('el XML no se puede comprobar', () => {
  const nothingLeft = async () => {
    expect(await documentCount()).toBe(0);
    expect(await count('SELECT count(*) AS n FROM document_sequences WHERE tenant_id = $1')).toBe(0);
    expect(await count('SELECT count(*) AS n FROM outbox_events WHERE tenant_id = $1')).toBe(0);
    expect(await count('SELECT count(*) AS n FROM idempotency_records WHERE tenant_id = $1')).toBe(0);
  };

  it('el detalle de un problema de XML se corta en los primeros 500 caracteres', async () => {
    const check = testApp.app.get(DocumentXmlCheck);
    const problem = `${'a'.repeat(500)}${'b'.repeat(100)}`;
    const spy = vi.spyOn(check, 'problem').mockResolvedValueOnce(problem);
    try {
      const res = await invoiceRequest(http(), s.owner, invoiceJson(s, '1', '11.50'), randomUUID()).expect(422);
      expect(res.body).toMatchObject({ errorCode: 'DOCUMENT_XML_INVALID', detail: 'a'.repeat(500) });
    } finally {
      spy.mockRestore();
    }
    await nothingLeft();
  });

  it('un fallo del motor de validación es 500 y no deja comprobante, secuencial, outbox ni idempotencia', async () => {
    const validator = testApp.app.get(XsdValidator);
    const spy = vi.spyOn(validator, 'validate').mockRejectedValueOnce(new Error('worker caído'));
    try {
      const res = await invoiceRequest(http(), s.owner, invoiceJson(s, '1', '11.50'), randomUUID()).expect(500);
      expect(res.body.errorCode).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(res.body)).not.toContain('worker caído');
    } finally {
      spy.mockRestore();
    }
    await nothingLeft();
    // Con el motor de nuevo en pie, la misma empresa emite.
    await issueInvoice(http(), s.owner, invoiceJson(s, '1', '11.50'));
  });
});

/** El controlador con un DocumentIssuer cuyo reloj es fijo; lo demás, las piezas de la aplicación. */
function controllerAt(now: Date): InvoiceController {
  const app = testApp.app;
  const issuer = new DocumentIssuer(
    kysely,
    app.get(TaxpayerService),
    app.get(SequenceService),
    app.get(FiscalDocumentRepository),
    app.get(DocumentXmlCheck),
    app.get(OutboxWriter),
    app.get(AuditLog),
    app.get(IdempotencyStore),
    app.get<AppConfig>(APP_CONFIG).providerRuc,
    () => now,
  );
  const service = new InvoiceService(
    issuer,
    app.get(InvoiceKind),
    app.get(CustomerService),
    app.get(CatalogLines),
    app.get(CatalogRepository),
    app.get(FinalConsumerLimit),
  );
  return new InvoiceController(service, kysely);
}

async function dto(body: unknown): Promise<IssueInvoiceDto> {
  const parsed = JSON.parse(JSON.stringify(body), recordNumberSource) as unknown;
  return (await validationPipe.transform(parsed, { type: 'body', metatype: IssueInvoiceDto })) as IssueInvoiceDto;
}

it('a las 22:30 de Guayaquil la fecha de hoy es la de Guayaquil', async () => {
  // 2026-11-03T03:30Z son las 22:30 del 2 de noviembre en Guayaquil (UTC-5).
  const controller = controllerAt(new Date('2026-11-03T03:30:00Z'));
  const access = await ownerAccess();

  const implicit = await controller.issue(access, randomUUID(), await dto(invoiceJson(s, '1', '11.50')));
  expect(implicit.state).toBe('RESERVED');
  const row = await db.query<{ d: string }>("SELECT to_char(issue_date, 'YYYY-MM-DD') AS d FROM fiscal_documents WHERE id = $1", [
    implicit.id,
  ]);
  expect(row.rows[0]!.d).toBe('2026-11-02');

  const sameDay = await controller.issue(
    access,
    randomUUID(),
    await dto({ ...invoiceJson(s, '1', '11.50'), issueDate: '2026-11-02' }),
  );
  expect(sameDay.state).toBe('RESERVED');

  const tomorrow = await controller
    .issue(access, randomUUID(), await dto({ ...invoiceJson(s, '1', '11.50'), issueDate: '2026-11-03' }))
    .catch((e: unknown) => e);
  expect(tomorrow).toMatchObject({
    status: 422,
    errorCode: 'INVALID_ISSUE_DATE',
    detail: 'La fecha de emisión no puede ser futura',
  });
});

it('el log de la emisión lleva el documentId', async () => {
  const lines: string[] = [];
  const logger = createPinoLogger(
    { ...testApp.app.get<AppConfig>(APP_CONFIG), logFormat: 'json' },
    { write: (line: string) => void lines.push(line) },
  );
  const controller = new InvoiceController(testApp.app.get(InvoiceService), kysely);
  const access = await ownerAccess();
  const body = await dto(invoiceJson(s, '1', '11.50'));

  const id = await runWithContext({ correlationId: 'emision-1' }, async () => {
    const issued = await controller.issue(access, randomUUID(), body);
    logger.info('después de la emisión');
    return issued.id;
  });
  logger.info('fuera de la petición');

  const [inside, outside] = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(inside).toMatchObject({ correlationId: 'emision-1', documentId: id, message: 'después de la emisión' });
  expect(outside).not.toHaveProperty('documentId');
});
