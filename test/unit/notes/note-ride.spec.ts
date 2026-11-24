import { buildCreditNoteRide, buildDebitNoteRide } from '../../../src/notes/note-ride.js';
import { pdfText } from '../../support/pdf-inspect.js';
import { accessKeyOf, creditContent, creditEnvelope, debitContent, debitEnvelope } from './note-fixtures.js';

// Traducción de notes/NoteRideTest.java. El aspecto lo compara test/golden/ride.spec.ts.
const AUTHORIZED_AT = '2026-10-19T20:15:30.000000';

function expectAll(text: string, parts: string[]): void {
  for (const part of parts) expect(text).toContain(part);
}

it('creditNoteShowsModifiedDocumentAndReason', async () => {
  const key = accessKeyOf('04');
  const text = await pdfText(
    await buildCreditNoteRide(
      { envelope: creditEnvelope(), authorizationNumber: key, authorizedAt: AUTHORIZED_AT },
      creditContent(),
    ),
  );

  expectAll(text, [
    'NOTA DE CRÉDITO',
    '001-002-000000007',
    'COMPROBANTE MODIFICADO',
    'FACTURA',
    '001-001-000000123',
    '01/10/2026',
    'Razón de modificación',
    'Devolución de mercadería',
    'Servicio de consultoría',
    'Subtotal IVA 15%',
    'VALOR MODIFICACIÓN',
    '37.00',
    key,
  ]);
});

it('debitNoteShowsReasonsAndPayment', async () => {
  const key = accessKeyOf('05');
  const text = await pdfText(
    await buildDebitNoteRide(
      { envelope: debitEnvelope(), authorizationNumber: key, authorizedAt: AUTHORIZED_AT },
      debitContent('Intereses de mora'),
      new Map([['01', 'SIN UTILIZACION DEL SISTEMA FINANCIERO']]),
    ),
  );

  expectAll(text, [
    'NOTA DE DÉBITO',
    'COMPROBANTE MODIFICADO',
    'FACTURA',
    '001-001-000000123',
    '01/10/2026',
    'Intereses de mora',
    '10.00',
    'Gastos de cobranza',
    '5.00',
    'TOTAL',
    '17.25',
    'FORMA DE PAGO',
    'SIN UTILIZACION DEL SISTEMA FINANCIERO',
    key,
  ]);
  expect(text).not.toContain('Razón de modificación');
});

it('unauthorizedNoteHasNoRide', async () => {
  const envelope = creditEnvelope();
  await expect(
    buildCreditNoteRide({ envelope, authorizationNumber: accessKeyOf('04'), authorizedAt: null }, creditContent()),
  ).rejects.toThrow('Solo un comprobante autorizado tiene RIDE');
});
