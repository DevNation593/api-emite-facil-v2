import { XmlWriter } from '../../../src/xml/xml-writer.js';

/*
 * `date` escribe como `DateTimeFormatter.ofPattern("dd/MM/yyyy")` de Java: el año es el de la era (el año 0
 * es el 1 antes de Cristo), con cuatro cifras como mínimo y con «+» si pasa de cuatro. Nunca lanza para una
 * fecha que Jackson lee; es el XSD el que rechaza lo que no admite.
 */
function written(isoDate: string): string {
  const w = new XmlWriter();
  w.openRoot('r', '1.0.0');
  w.date('f', isoDate);
  w.close('r');
  return /<f>(.*)<\/f>/.exec(w.toBuffer().toString('utf8'))![1]!;
}

it.each([
  ['2026-11-02', '02/11/2026'],
  ['0999-01-31', '31/01/0999'],
  ['0001-01-01', '01/01/0001'],
  ['0000-12-31', '31/12/0001'],
  ['-0001-06-15', '15/06/0002'],
  ['-12345-01-01', '01/01/+12346'],
  ['+10000-01-01', '01/01/+10000'],
  ['+999999999-12-31', '31/12/+999999999'],
])('%s se escribe %s', (iso, expected) => {
  expect(written(iso)).toBe(expected);
});

it('un texto que no es una fecha es un error de programación, no un dato del XML', () => {
  expect(() => written('02/11/2026')).toThrow('Fecha no válida: 02/11/2026');
});
