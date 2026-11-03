import { contentCodec, list } from '../../../src/billing/json-content.js';
import { BigDecimal } from '../../../src/common/big-decimal.js';
import { CREDIT_NOTE_CODEC } from '../../../src/notes/credit-note-content.js';
import { DEBIT_NOTE_CODEC } from '../../../src/notes/debit-note-content.js';
import { creditContent, d, debitContent } from '../notes/note-fixtures.js';

// contentSurvivesTheJsonRoundTrip de NoteKindsTest y las reglas del mapper de JsonContentKind.
const PRODUCT = '0b9e6c1a-3d47-4f2e-8a15-7c3d9e0f2b64';

describe('ida y vuelta de las notas', () => {
  it('el contenido de la nota de crédito sobrevive al JSON', () => {
    const content = creditContent();
    const json = CREDIT_NOTE_CODEC.write(content);
    const back = CREDIT_NOTE_CODEC.read(json);
    expect(back).toEqual(content);
    expect(CREDIT_NOTE_CODEC.write(back)).toBe(json);
  });

  it('el contenido de la nota de débito sobrevive al JSON, con y sin plazo', () => {
    for (const content of [
      debitContent('Mora'),
      {
        ...debitContent('Mora'),
        payments: [
          {
            methodCode: '01',
            amount: d('17.25'),
            term: d('2'),
            timeUnit: 'meses',
          },
        ],
      },
    ]) {
      const json = DEBIT_NOTE_CODEC.write(content);
      const back = DEBIT_NOTE_CODEC.read(json);
      expect(back).toEqual(content);
      expect(DEBIT_NOTE_CODEC.write(back)).toBe(json);
    }
  });

  it('cada decimal conserva su escala', () => {
    const back = CREDIT_NOTE_CODEC.read(
      CREDIT_NOTE_CODEC.write(creditContent()),
    );
    expect(back.lines[0]!.quantity.toString()).toBe('2');
    expect(back.lines[0]!.unitPrice.toString()).toBe('10.00');
    expect(back.lines[1]!.quantity.toString()).toBe('1.5');
    expect(back.lines[1]!.unitPrice.toString()).toBe('9.333333');
  });
});

describe('escritura', () => {
  it('escribe todas las propiedades en el orden del record, los null y los decimales como cadena', () => {
    const content = creditContent();
    content.lines = [
      { ...content.lines[0]!, invoiceLineNo: null, productId: PRODUCT },
    ];
    expect(CREDIT_NOTE_CODEC.write({ ...content, taxes: [] })).toBe(
      '{"reason":"Devolución de mercadería","lines":[{"invoiceLineNo":null,"productId":"' +
        PRODUCT +
        '","mainCode":"SRV-001","description":"Servicio de consultoría","quantity":"2","unitPrice":"10.00",' +
        '"discount":"0.00","subtotal":"20.00","taxCode":"2","taxRateCode":"4","taxRate":"15.00",' +
        '"taxAmount":"3.00"}],"taxes":[]}',
    );
  });

  it('escapa como Jackson: controles con hex en mayúsculas y sin tocar el resto', () => {
    const content = {
      ...creditContent('Tab\t \n \r \b \f " \\ \u0001 \u001f \u007f é 😀 /  '),
      taxes: [],
      lines: [],
    };
    expect(CREDIT_NOTE_CODEC.write(content)).toBe(
      '{"reason":"Tab\\t \\n \\r \\b \\f \\" \\\\ \\u0001 \\u001F \u007f é 😀 /  ","lines":[],"taxes":[]}',
    );
  });

  it('no usa la notación científica de JSON ni números para los decimales', () => {
    const codec = contentCodec<{ amount: BigDecimal | null }>([
      ['amount', 'decimal'],
    ]);
    expect(codec.write({ amount: BigDecimal.of('0.0000001') })).toBe(
      '{"amount":"1E-7"}',
    );
    expect(codec.write({ amount: null })).toBe('{"amount":null}');
  });
});

describe('lectura', () => {
  it('una propiedad desconocida lanza', () => {
    const json = CREDIT_NOTE_CODEC.write({
      ...creditContent(),
      lines: [],
      taxes: [],
    });
    expect(() =>
      CREDIT_NOTE_CODEC.read(json.replace('}', ',"extra":1}')),
    ).toThrow('Propiedad desconocida: extra');
    expect(() =>
      CREDIT_NOTE_CODEC.read(
        '{"reason":"x","lines":[{"invoiceLineNo":1,"renombrada":"x"}],"taxes":[]}',
      ),
    ).toThrow('Propiedad desconocida: renombrada');
    expect(() =>
      DEBIT_NOTE_CODEC.read(
        '{"reasons":[],"taxes":[{"codigo":"2"}],"payments":[]}',
      ),
    ).toThrow('Propiedad desconocida: codigo');
  });

  it('una propiedad que falta queda null', () => {
    const back = CREDIT_NOTE_CODEC.read('{"reason":"x"}');
    expect(back).toEqual({ reason: 'x', lines: null, taxes: null });
    const line = CREDIT_NOTE_CODEC.read(
      '{"reason":"x","lines":[{"mainCode":"A"}],"taxes":[]}',
    ).lines[0]!;
    expect(line.mainCode).toBe('A');
    expect(line.invoiceLineNo).toBeNull();
    expect(line.quantity).toBeNull();
  });

  it('lee cada decimal con su escala y el UUID en minúsculas', () => {
    const read = CREDIT_NOTE_CODEC.read(
      '{"reason":"x","lines":[{"productId":"0B9E6C1A-3D47-4F2E-8A15-7C3D9E0F2B64","quantity":"1.500000"}],"taxes":[]}',
    );
    expect(read.lines[0]!.productId).toBe(PRODUCT);
    expect(read.lines[0]!.quantity.scale).toBe(6);
  });

  it('rechaza valores del tipo equivocado y JSON que no es un objeto', () => {
    expect(() => CREDIT_NOTE_CODEC.read('[]')).toThrow();
    expect(() => CREDIT_NOTE_CODEC.read('null')).toThrow();
    expect(() => CREDIT_NOTE_CODEC.read('{"reason":5}')).toThrow();
    expect(() =>
      CREDIT_NOTE_CODEC.read('{"lines":[{"quantity":2}]}'),
    ).toThrow();
    expect(() =>
      CREDIT_NOTE_CODEC.read('{"lines":[{"productId":"no-es-uuid"}]}'),
    ).toThrow();
    expect(() =>
      CREDIT_NOTE_CODEC.read('{"lines":[{"invoiceLineNo":1.5}]}'),
    ).toThrow();
    expect(() => CREDIT_NOTE_CODEC.read('{"lines":{}}')).toThrow();
    expect(() =>
      CREDIT_NOTE_CODEC.read('{"lines":[{"quantity":"abc"}]}'),
    ).toThrow();
  });

  it('el códec es genérico: sirve a cualquier forma', () => {
    const codec = contentCodec<{ items: { n: BigDecimal }[] }>([
      ['items', list([['n', 'decimal']])],
    ]);
    const json = codec.write({ items: [{ n: BigDecimal.of('1.10') }] });
    expect(json).toBe('{"items":[{"n":"1.10"}]}');
    expect(codec.read(json).items[0]!.n.toString()).toBe('1.10');
  });
});
