import { contentCodec } from '../../../src/billing/json-content.js';
import { FiscalDocumentRepository } from '../../../src/billing/fiscal-document.repository.js';
import { JsonContentKind } from '../../../src/billing/json-content-kind.js';
import type { DocumentEnvelope } from '../../../src/billing/document-envelope.js';
import { BigDecimal } from '../../../src/common/big-decimal.js';
import {
  DOCUMENT_SCHEMAS,
  DOCUMENT_TYPES,
} from '../../../src/xml/document-type.js';
import { insertDocument, newScenario } from '../../support/billing-data.js';
import type { DbHandle } from '../../support/db-handle.js';
import { startDb } from '../../support/db-handle.js';

// Traducción de JsonContentKindIT: el contenido propio de un tipo viaja como JSON por la columna content
// sin perder la escala de los importes.
interface Sample {
  text: string;
  amount: BigDecimal;
}

/** Tipo de prueba: solo ejercita la base; no genera XML. */
class SampleKind extends JsonContentKind<Sample> {
  readonly type = DOCUMENT_TYPES.PURCHASE_LIQUIDATION;
  readonly schema = DOCUMENT_SCHEMAS.PURCHASE_LIQUIDATION_1_1_0;
  readonly displayName = 'Muestra';
  readonly fileStem = 'muestra';
  readonly auditReserved = 'SAMPLE_RESERVED';

  constructor(documents: FiscalDocumentRepository) {
    super(
      contentCodec<Sample>([
        ['text', 'string'],
        ['amount', 'decimal'],
      ]),
      documents,
    );
  }

  buildXml(_envelope: DocumentEnvelope, _content: Sample): Buffer {
    throw new Error('no se usa');
  }
}

let handle: DbHandle;
let kind: SampleKind;
beforeAll(async () => {
  handle = await startDb();
  kind = new SampleKind(new FiscalDocumentRepository());
}, 300_000);
afterAll(async () => {
  await handle?.stop();
});

async function insert(type: string, content: string | null) {
  const s = await newScenario(handle.pgc);
  const document = await insertDocument(handle.pgc, s, 1, {
    type,
    total: BigDecimal.of('1.50'),
    content,
  });
  return { tenant: s.tenant, document };
}

describe('JsonContentKind', () => {
  it('el contenido hace la ida y vuelta conservando la escala', async () => {
    const sample: Sample = { text: 'a', amount: BigDecimal.of('1.50') };
    const content = kind.contentJson(sample) as string;
    expect(content).toContain('"amount":"1.50"');

    const inserted = await insert('03', content);
    const loaded = await kind.loadContent(
      handle.db,
      inserted.tenant,
      inserted.document,
    );
    expect(loaded.text).toBe('a');
    expect(loaded.amount.toString()).toBe('1.50');
    expect(loaded.amount.scale).toBe(2);
  });

  it('sin contenido falla, y también con otra empresa', async () => {
    const invoice = await insert('01', null);
    await expect(
      kind.loadContent(handle.db, invoice.tenant, invoice.document),
    ).rejects.toThrow(
      `El comprobante ${invoice.document} no existe o no tiene contenido propio`,
    );
    const sample = await insert(
      '03',
      kind.contentJson({ text: 'b', amount: BigDecimal.of('1') }),
    );
    await expect(
      kind.loadContent(
        handle.db,
        '00000000-0000-4000-8000-000000000000',
        sample.document,
      ),
    ).rejects.toThrow('no existe o no tiene contenido propio');
  });

  it('una propiedad desconocida falla al cargar', async () => {
    const inserted = await insert(
      '03',
      '{"text":"a","amount":"1.50","renamed":1}',
    );
    await expect(
      kind.loadContent(handle.db, inserted.tenant, inserted.document),
    ).rejects.toThrow();
  });

  it('reloaded conserva el valor y la escala', () => {
    const sample: Sample = { text: 'a', amount: BigDecimal.of('1.50') };
    const reloaded = kind.reloaded(sample);
    expect(reloaded.amount.toString()).toBe('1.50');
    expect(reloaded.amount.scale).toBe(2);
    expect(reloaded.text).toBe('a');
  });
});
