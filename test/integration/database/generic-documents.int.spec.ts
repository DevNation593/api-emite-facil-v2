import { BigDecimal } from '../../../src/common/big-decimal.js';
import {
  expectConstraintViolation,
  insertDocument,
  newScenario,
} from '../../support/billing-data.js';
import type { DbHandle } from '../../support/db-handle.js';
import { startDb } from '../../support/db-handle.js';

// Traducción de GenericDocumentsMigrationIT: el sobre común de fiscal_documents admite todos los tipos y
// rechaza las combinaciones incoherentes.
const CONTENT = '{}';
const ONE = BigDecimal.of('1');
const MODIFY = `UPDATE fiscal_documents SET modified_document_id = $1, modified_doc_code = '01',
  modified_doc_number = '001-001-000000001', modified_doc_date = DATE '2026-10-01' WHERE id = $2`;

let handle: DbHandle;
beforeAll(async () => {
  handle = await startDb();
}, 300_000);
afterAll(async () => {
  await handle?.stop();
});

const update = (text: string, ...params: unknown[]) =>
  handle.pgc.query(text, params);

describe('sobre común de comprobantes', () => {
  it('solo admite los tipos conocidos', async () => {
    const s = await newScenario(handle.pgc);
    await expectConstraintViolation(
      insertDocument(handle.pgc, s, 1, {
        type: '02',
        total: ONE,
        content: CONTENT,
      }),
    );
    await insertDocument(handle.pgc, s, 2, {
      type: '03',
      total: ONE,
      content: CONTENT,
    });
  });

  it('solo la guía de remisión no tiene total', async () => {
    const s = await newScenario(handle.pgc);
    await insertDocument(handle.pgc, s, 1, {
      type: '06',
      total: null,
      content: CONTENT,
    });
    await expectConstraintViolation(
      insertDocument(handle.pgc, s, 2, {
        type: '06',
        total: ONE,
        content: CONTENT,
      }),
    );
    await expectConstraintViolation(
      insertDocument(handle.pgc, s, 3, {
        type: '04',
        total: null,
        content: CONTENT,
      }),
    );
  });

  it('el contenido propio solo va fuera de las facturas', async () => {
    const s = await newScenario(handle.pgc);
    await expectConstraintViolation(
      insertDocument(handle.pgc, s, 1, {
        type: '01',
        total: ONE,
        content: CONTENT,
      }),
    );
    await expectConstraintViolation(
      insertDocument(handle.pgc, s, 2, {
        type: '05',
        total: ONE,
        content: null,
      }),
    );
    await insertDocument(handle.pgc, s, 3, { type: '01', total: ONE });
    await insertDocument(handle.pgc, s, 4, {
      type: '05',
      total: ONE,
      content: CONTENT,
    });
  });

  it('la factura conserva sus totales', async () => {
    const s = await newScenario(handle.pgc);
    const invoice = await insertDocument(handle.pgc, s, 1, {
      type: '01',
      total: ONE,
    });
    await expectConstraintViolation(
      update(
        'UPDATE fiscal_documents SET subtotal = NULL WHERE id = $1',
        invoice,
      ),
    );
    await expectConstraintViolation(
      update(
        'UPDATE fiscal_documents SET total_tax = NULL WHERE id = $1',
        invoice,
      ),
    );
    const liquidation = await insertDocument(handle.pgc, s, 2, {
      type: '03',
      total: ONE,
      content: CONTENT,
    });
    await update(
      'UPDATE fiscal_documents SET subtotal = NULL WHERE id = $1',
      liquidation,
    );
  });

  it('el documento modificado va completo o ausente', async () => {
    const s = await newScenario(handle.pgc);
    const invoice = await insertDocument(handle.pgc, s, 1, {
      type: '01',
      total: ONE,
    });
    const note = await insertDocument(handle.pgc, s, 2, {
      type: '04',
      total: ONE,
      content: CONTENT,
    });
    await update(MODIFY, invoice, note);
    const other = await insertDocument(handle.pgc, s, 3, {
      type: '04',
      total: ONE,
      content: CONTENT,
    });
    await expectConstraintViolation(
      update(
        "UPDATE fiscal_documents SET modified_doc_number = '001-001-000000001' WHERE id = $1",
        other,
      ),
    );
    await expectConstraintViolation(
      update(
        'UPDATE fiscal_documents SET modified_document_id = $1 WHERE id = $2',
        invoice,
        other,
      ),
    );
    await expectConstraintViolation(
      update(
        `UPDATE fiscal_documents SET modified_doc_code = '01', modified_doc_number = '1-1-1',
          modified_doc_date = DATE '2026-10-01' WHERE id = $1`,
        other,
      ),
    );
  });

  it('el documento modificado se queda en la empresa', async () => {
    const a = await newScenario(handle.pgc);
    const b = await newScenario(handle.pgc);
    const foreignInvoice = await insertDocument(handle.pgc, b, 1, {
      type: '01',
      total: ONE,
    });
    const ownInvoice = await insertDocument(handle.pgc, a, 1, {
      type: '01',
      total: ONE,
    });
    const note = await insertDocument(handle.pgc, a, 2, {
      type: '04',
      total: ONE,
      content: CONTENT,
    });
    await expectConstraintViolation(update(MODIFY, foreignInvoice, note));
    await expectConstraintViolation(update(MODIFY, note, note));
    await update(MODIFY, ownInvoice, note);
  });
});
