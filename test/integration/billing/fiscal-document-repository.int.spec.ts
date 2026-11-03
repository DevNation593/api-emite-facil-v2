import type { Transaction } from 'kysely';
import type { DB } from '../../../src/database/schema.js';
import { ApiException } from '../../../src/common/api-exception.js';
import type { DocumentEnvelope } from '../../../src/billing/document-envelope.js';
import {
  FiscalDocumentRepository,
  type InvoiceBody,
  type NewDocument,
} from '../../../src/billing/fiscal-document.repository.js';
import { IdempotencyStore } from '../../../src/billing/idempotency-store.js';
import { OutboxWriter } from '../../../src/billing/outbox-writer.js';
import { BigDecimal } from '../../../src/common/big-decimal.js';
import { DOCUMENT_TYPES } from '../../../src/xml/document-type.js';
import {
  insertDocument,
  newScenario,
  randomAccessKey,
  type Scenario,
} from '../../support/billing-data.js';
import type { DbHandle } from '../../support/db-handle.js';
import { startDb } from '../../support/db-handle.js';

const d = (text: string) => BigDecimal.of(text);
/** Los BigDecimal como texto, para comparar valor y escala con toEqual. */
const plain = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (_key, v: unknown) =>
      v instanceof BigDecimal ? `BD:${v.toString()}` : v,
    ),
  );

const repository = new FiscalDocumentRepository();
const idempotency = new IdempotencyStore();
const outbox = new OutboxWriter();

let handle: DbHandle;
beforeAll(async () => {
  handle = await startDb();
}, 300_000);
afterAll(async () => {
  await handle?.stop();
});

function invoiceEnvelope(
  sequence: number,
  overrides: Partial<DocumentEnvelope> = {},
): DocumentEnvelope {
  return {
    type: DOCUMENT_TYPES.INVOICE,
    environment: '1',
    issuer: {
      legalName: 'Comercial Andina S.A.',
      tradeName: 'Andina',
      ruc: '1790012345001',
      headOfficeAddress: 'Av. Amazonas N34-12, Quito',
      establishmentAddress: 'Av. 10 de Agosto, Quito',
      accountingRequired: true,
      specialTaxpayerCode: '5368',
      withholdingAgentCode: '1',
      rimpeRegime: 'EMPRENDEDOR',
      phone: '022345678',
    },
    accessKey: randomAccessKey(),
    establishmentCode: '001',
    emissionPointCode: '001',
    sequence,
    issueDate: '2026-10-19',
    recipient: {
      idType: '05',
      idNumber: '1712345678',
      name: 'María Pérez',
      address: 'Av. República, Quito',
      email: 'maria@example.test',
      phone: '0991234567',
    },
    totals: {
      subtotal: d('34.00'),
      totalDiscount: d('0.00'),
      totalTax: d('3.00'),
      total: d('37.00'),
    },
    modified: null,
    providerRuc: '1790099999001',
    ...overrides,
  };
}

function newDocument(
  s: Scenario,
  envelope: DocumentEnvelope,
  contentJson: string | null = null,
): NewDocument {
  return {
    tenantId: s.tenant,
    taxpayerId: s.taxpayer,
    emissionPointId: s.point,
    customerId: s.customer,
    state: 'RESERVED',
    createdBy: s.user,
    envelope,
    contentJson,
  };
}

const inTransaction = <T>(work: (trx: Transaction<DB>) => Promise<T>) =>
  handle.db.transaction().execute(work);

describe('FiscalDocumentRepository', () => {
  it('el sobre insertado vuelve igual por envelope', async () => {
    const s = await newScenario(handle.pgc);
    const envelope = invoiceEnvelope(1);
    const id = await inTransaction((trx) =>
      repository.insert(trx, newDocument(s, envelope)),
    );
    const loaded = await repository.envelope(handle.db, s.tenant, id);
    expect(plain(loaded)).toEqual(plain(envelope));
    const row = await repository.find(handle.db, s.tenant, id);
    expect(row).toMatchObject({
      id,
      documentType: '01',
      state: 'RESERVED',
      currency: 'USD',
      sequence: 1,
      issueDate: '2026-10-19',
      authorizedAt: null,
    });
    expect(row?.total?.toString()).toBe('37.00');
  });

  it('el sobre de una nota lleva el documento modificado y su contenido', async () => {
    const s = await newScenario(handle.pgc);
    const invoice = await inTransaction((trx) =>
      repository.insert(trx, newDocument(s, invoiceEnvelope(1))),
    );
    const envelope = invoiceEnvelope(2, {
      type: DOCUMENT_TYPES.CREDIT_NOTE,
      modified: {
        documentId: invoice,
        code: '01',
        number: '001-001-000000001',
        issueDate: '2026-10-01',
      },
    });
    const note = await inTransaction((trx) =>
      repository.insert(trx, newDocument(s, envelope, '{"reason":"x"}')),
    );
    expect(plain(await repository.envelope(handle.db, s.tenant, note))).toEqual(
      plain(envelope),
    );
    expect(
      JSON.parse(
        (await repository.content(handle.db, s.tenant, note)) as string,
      ),
    ).toEqual({ reason: 'x' });
    expect(await repository.content(handle.db, s.tenant, invoice)).toBeNull();
  });

  it('una lectura con la empresa de otra no encuentra nada', async () => {
    const a = await newScenario(handle.pgc);
    const b = await newScenario(handle.pgc);
    const id = await inTransaction((trx) =>
      repository.insert(trx, newDocument(a, invoiceEnvelope(1))),
    );
    await inTransaction((trx) =>
      repository.insertInvoiceBody(trx, a.tenant, id, {
        lines: [],
        taxes: [
          {
            taxCode: '2',
            rateCode: '4',
            rate: d('15.00'),
            base: d('1.00'),
            amount: d('0.15'),
          },
        ],
        payments: [
          { methodCode: '01', amount: d('1.15'), term: null, timeUnit: null },
        ],
      }),
    );
    expect(await repository.find(handle.db, b.tenant, id)).toBeNull();
    expect(await repository.envelope(handle.db, b.tenant, id)).toBeNull();
    expect(await repository.content(handle.db, b.tenant, id)).toBeNull();
    expect(await repository.taxes(handle.db, b.tenant, id)).toEqual([]);
    expect(await repository.payments(handle.db, b.tenant, id)).toEqual([]);
    expect(await repository.lines(handle.db, b.tenant, id)).toEqual([]);
    expect(await repository.page(handle.db, b.tenant, null, 0, 10)).toEqual([]);
    expect(await repository.count(handle.db, b.tenant, null)).toBe(0);
    await expect(repository.links(handle.db, b.tenant, id)).rejects.toThrow();
    await inTransaction(async (trx) => {
      expect(await repository.lockForProcessing(trx, b.tenant, id)).toBeNull();
    });
    expect((await repository.taxes(handle.db, a.tenant, id)).length).toBe(1);
  });

  it('creditedTotal sin notas es cero (escala 0) y con una nota de 5.00 es 5.00', async () => {
    const s = await newScenario(handle.pgc);
    const invoice = await insertDocument(handle.pgc, s, 1, {
      type: '01',
      total: d('10.00'),
    });
    const none = await repository.creditedTotal(handle.db, s.tenant, invoice);
    expect(none.toString()).toBe('0');
    expect(none.scale).toBe(0);

    const note = await insertDocument(handle.pgc, s, 2, {
      type: '04',
      total: d('5.00'),
      content: '{}',
    });
    await handle.pgc.query(
      `UPDATE fiscal_documents SET modified_document_id = $1, modified_doc_code = '01',
        modified_doc_number = '001-001-000000001', modified_doc_date = DATE '2026-10-01' WHERE id = $2`,
      [invoice, note],
    );
    const credited = await repository.creditedTotal(
      handle.db,
      s.tenant,
      invoice,
    );
    expect(credited.toString()).toBe('5.00');
    expect(credited.scale).toBe(2);

    await handle.pgc.query(
      "UPDATE fiscal_documents SET state = 'NOT_AUTHORIZED' WHERE id = $1",
      [note],
    );
    expect(
      (await repository.creditedTotal(handle.db, s.tenant, invoice)).toString(),
    ).toBe('0');
    const other = await newScenario(handle.pgc);
    expect(
      (
        await repository.creditedTotal(handle.db, other.tenant, invoice)
      ).toString(),
    ).toBe('0');
  });

  it('el cuerpo de la factura vuelve con sus escalas y en su orden', async () => {
    const s = await newScenario(handle.pgc);
    const id = await inTransaction((trx) =>
      repository.insert(trx, newDocument(s, invoiceEnvelope(1))),
    );
    const body: InvoiceBody = {
      lines: [
        {
          productId: null,
          mainCode: 'SRV-001',
          description: 'Servicio',
          quantity: d('2.000000'),
          unitPrice: d('10.000000'),
          discount: d('0.00'),
          subtotal: d('20.00'),
          taxCode: '2',
          taxRateCode: '4',
          taxRate: d('15.00'),
          taxAmount: d('3.00'),
        },
        {
          productId: null,
          mainCode: 'LIB-001',
          description: 'Libro',
          quantity: d('1.500000'),
          unitPrice: d('9.333333'),
          discount: d('0.00'),
          subtotal: d('14.00'),
          taxCode: '2',
          taxRateCode: '0',
          taxRate: d('0.00'),
          taxAmount: d('0.00'),
        },
      ],
      // Se devuelven por código de tarifa numérico: 0 antes que 4.
      taxes: [
        {
          taxCode: '2',
          rateCode: '4',
          rate: d('15.00'),
          base: d('20.00'),
          amount: d('3.00'),
        },
        {
          taxCode: '2',
          rateCode: '0',
          rate: d('0.00'),
          base: d('14.00'),
          amount: d('0.00'),
        },
      ],
      payments: [
        {
          methodCode: '20',
          amount: d('30.00'),
          term: d('30.00'),
          timeUnit: 'dias',
        },
        { methodCode: '01', amount: d('7.00'), term: null, timeUnit: null },
      ],
    };
    await inTransaction((trx) =>
      repository.insertInvoiceBody(trx, s.tenant, id, body),
    );
    const loaded = await repository.invoiceBody(handle.db, s.tenant, id);
    expect(plain(loaded)).toEqual(
      plain({ ...body, taxes: [body.taxes[1], body.taxes[0]] }),
    );
    expect(
      (await repository.lines(handle.db, s.tenant, id)).map((l) => l.lineNo),
    ).toEqual([1, 2]);
    expect(
      (await repository.payments(handle.db, s.tenant, id)).map((p) => p.lineNo),
    ).toEqual([1, 2]);
  });

  it('el cambio de estado deja su evento, y el bloqueo y la programación leen y escriben el documento', async () => {
    const s = await newScenario(handle.pgc);
    const id = await inTransaction((trx) =>
      repository.insert(trx, newDocument(s, invoiceEnvelope(1))),
    );
    await inTransaction(async (trx) => {
      await repository.recordStateChange(
        trx,
        s.tenant,
        id,
        null,
        'RESERVED',
        'Reservado',
      );
      await repository.schedule(trx, s.tenant, id, 1500, 2);
      const locked = await repository.lockForProcessing(trx, s.tenant, id);
      expect(locked).toMatchObject({
        state: 'RESERVED',
        documentType: '01',
        environment: '1',
        attemptCount: 2,
      });
      expect(typeof locked?.version).toBe('number');
    });
    const events = await handle.pgc.query(
      'SELECT previous_state, new_state, reason FROM state_events WHERE document_id = $1 AND tenant_id = $2',
      [id, s.tenant],
    );
    expect(events.rows).toEqual([
      { previous_state: null, new_state: 'RESERVED', reason: 'Reservado' },
    ]);
    const scheduled = await handle.pgc.query(
      "SELECT next_attempt_at > now() AND next_attempt_at < now() + interval '5 seconds' AS soon FROM fiscal_documents WHERE id = $1",
      [id],
    );
    expect((scheduled.rows[0] as { soon: boolean }).soon).toBe(true);

    await inTransaction((trx) =>
      repository.schedule(trx, s.tenant, id, null, 0),
    );
    const cleared = await handle.pgc.query(
      'SELECT next_attempt_at, attempt_count FROM fiscal_documents WHERE id = $1',
      [id],
    );
    expect(cleared.rows[0]).toEqual({
      next_attempt_at: null,
      attempt_count: 0,
    });
  });

  it('authorizedAt sale como ISO_INSTANT con 0, 3 o 6 decimales', async () => {
    const s = await newScenario(handle.pgc);
    const id = await inTransaction((trx) =>
      repository.insert(trx, newDocument(s, invoiceEnvelope(1))),
    );
    const cases: [string, string][] = [
      ['2026-10-19 10:00:00+00', '2026-10-19T10:00:00Z'],
      ['2026-10-19 10:00:00.250+00', '2026-10-19T10:00:00.250Z'],
      ['2026-10-19 10:00:00.123456+00', '2026-10-19T10:00:00.123456Z'],
      ['2026-10-19 05:00:00-05', '2026-10-19T10:00:00Z'],
    ];
    for (const [stored, expected] of cases) {
      await handle.pgc.query(
        'UPDATE fiscal_documents SET authorized_at = $1, authorization_number = $2 WHERE id = $3',
        [stored, '1'.repeat(49), id],
      );
      expect(
        (await repository.find(handle.db, s.tenant, id))?.authorizedAt,
      ).toBe(expected);
    }
  });

  it('página y cuenta filtran por empresa y por tipo, del más reciente al más antiguo', async () => {
    const s = await newScenario(handle.pgc);
    const first = await insertDocument(handle.pgc, s, 1, { type: '01' });
    const second = await insertDocument(handle.pgc, s, 2, { type: '01' });
    await insertDocument(handle.pgc, s, 3, { type: '05', content: '{}' });
    expect(
      (await repository.page(handle.db, s.tenant, '01', 0, 10)).map(
        (r) => r.id,
      ),
    ).toEqual([second, first]);
    expect(await repository.count(handle.db, s.tenant, null)).toBe(3);
    expect(await repository.count(handle.db, s.tenant, '05')).toBe(1);
    expect(await repository.page(handle.db, s.tenant, null, 1, 2)).toHaveLength(
      1,
    );
  });

  it('el enlace de reemisión se ve desde los dos lados', async () => {
    const s = await newScenario(handle.pgc);
    const old = await insertDocument(handle.pgc, s, 1);
    const fresh = await insertDocument(handle.pgc, s, 2);
    await inTransaction((trx) =>
      repository.linkReplacement(trx, s.tenant, fresh, old),
    );
    expect(await repository.replacementOf(handle.db, s.tenant, old)).toBe(
      fresh,
    );
    expect(
      await repository.replacementOf(handle.db, s.tenant, fresh),
    ).toBeNull();
    expect(await repository.links(handle.db, s.tenant, old)).toEqual({
      customerId: s.customer,
      replacesDocumentId: null,
      replacedByDocumentId: fresh,
    });
    expect(
      (await repository.links(handle.db, s.tenant, fresh)).replacesDocumentId,
    ).toBe(old);
    expect(
      await repository.replacementOf(
        handle.db,
        (await newScenario(handle.pgc)).tenant,
        old,
      ),
    ).toBeNull();
  });

  it('las escrituras exigen una transacción', async () => {
    const s = await newScenario(handle.pgc);
    const id = await insertDocument(handle.pgc, s, 1);
    const trx = handle.db as unknown as Transaction<DB>;
    await expect(
      repository.insert(trx, newDocument(s, invoiceEnvelope(9))),
    ).rejects.toThrow('transacción');
    await expect(
      repository.recordStateChange(trx, s.tenant, id, null, 'X', null),
    ).rejects.toThrow('transacción');
    await expect(
      repository.lockForProcessing(trx, s.tenant, id),
    ).rejects.toThrow('transacción');
    await expect(
      repository.schedule(trx, s.tenant, id, null, 0),
    ).rejects.toThrow('transacción');
    await expect(idempotency.begin(trx, s.tenant, 'k', 'h')).rejects.toThrow(
      'transacción',
    );
    await expect(outbox.write(trx, s.tenant, id, 'E', {})).rejects.toThrow(
      'transacción',
    );
  });
});

describe('IdempotencyStore', () => {
  const hash = 'a'.repeat(64);

  it('un intento nuevo toma la clave y la repetición devuelve el documento', async () => {
    const s = await newScenario(handle.pgc);
    const id = await insertDocument(handle.pgc, s, 1);
    await inTransaction(async (trx) => {
      expect(await idempotency.begin(trx, s.tenant, 'k-1', hash)).toBeNull();
      await idempotency.complete(trx, s.tenant, 'k-1', id);
    });
    await inTransaction(async (trx) => {
      expect(await idempotency.begin(trx, s.tenant, 'k-1', hash)).toBe(id);
    });
  });

  it('la clave con otra huella, o sin documento, es 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const s = await newScenario(handle.pgc);
    const id = await insertDocument(handle.pgc, s, 1);
    await inTransaction(async (trx) => {
      await idempotency.begin(trx, s.tenant, 'k-2', hash);
      await idempotency.complete(trx, s.tenant, 'k-2', id);
      await idempotency.begin(trx, s.tenant, 'k-3', hash);
    });
    const reused = (key: string, requestHash: string) =>
      inTransaction((trx) =>
        idempotency.begin(trx, s.tenant, key, requestHash),
      ).catch((e: unknown) => e);
    for (const error of [
      await reused('k-2', 'b'.repeat(64)),
      await reused('k-3', hash),
    ]) {
      expect(error).toBeInstanceOf(ApiException);
      expect(error).toMatchObject({
        status: 409,
        errorCode: 'IDEMPOTENCY_KEY_REUSED',
        detail: 'La clave de idempotencia ya se usó con una petición distinta',
      });
    }
    // La misma clave en otra empresa es independiente.
    const other = await newScenario(handle.pgc);
    await inTransaction(async (trx) => {
      expect(
        await idempotency.begin(trx, other.tenant, 'k-2', 'b'.repeat(64)),
      ).toBeNull();
    });
  });

  it('si la transacción se revierte la clave queda libre', async () => {
    const s = await newScenario(handle.pgc);
    await inTransaction(async (trx) => {
      await idempotency.begin(trx, s.tenant, 'k-4', hash);
      throw new Error('revertir');
    }).catch(() => undefined);
    await inTransaction(async (trx) => {
      expect(await idempotency.begin(trx, s.tenant, 'k-4', hash)).toBeNull();
    });
  });
});

describe('OutboxWriter', () => {
  it('deja el evento con solo identificadores', async () => {
    const s = await newScenario(handle.pgc);
    const id = await insertDocument(handle.pgc, s, 1);
    await inTransaction((trx) =>
      outbox.write(trx, s.tenant, id, 'DOCUMENT_RESERVED', { documentId: id }),
    );
    const rows = await handle.pgc.query(
      'SELECT event_type, payload::text AS payload, dispatched_at FROM outbox_events WHERE aggregate_id = $1 AND tenant_id = $2',
      [id, s.tenant],
    );
    expect(rows.rows).toEqual([
      {
        event_type: 'DOCUMENT_RESERVED',
        payload: JSON.stringify({ documentId: id }).replace(':', ': '),
        dispatched_at: null,
      },
    ]);
  });

  it('si la transacción se revierte no queda evento', async () => {
    const s = await newScenario(handle.pgc);
    const id = await insertDocument(handle.pgc, s, 1);
    await inTransaction(async (trx) => {
      await outbox.write(trx, s.tenant, id, 'DOCUMENT_RESERVED', {
        documentId: id,
      });
      throw new Error('revertir');
    }).catch(() => undefined);
    const rows = await handle.pgc.query(
      'SELECT 1 FROM outbox_events WHERE aggregate_id = $1',
      [id],
    );
    expect(rows.rowCount).toBe(0);
  });
});
