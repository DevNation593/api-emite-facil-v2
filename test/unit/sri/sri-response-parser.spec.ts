import { codeOf, matchesLabel, sriEnvironmentOf } from '../../../src/sri/sri-environment.js';
import { parseAuthorization, parseReception } from '../../../src/sri/sri-response-parser.js';
import { hasMessage } from '../../../src/sri/sri-results.js';
import * as samples from '../../support/sri-soap-samples.js';
import { errorMsg, msg } from '../../support/sri-soap-samples.js';

// Traducción de sri/SriResponseParserTest.java.
const KEY = '0503201201176001321000110010030009900641234567814';
const bytes = (xml: string) => Buffer.from(xml, 'utf8');

it('receivedHasNoMessages', () => {
  const result = parseReception(bytes(samples.received()));
  expect(result.outcome).toBe('RECEIVED');
  expect(result.sriStatus).toBe('RECIBIDA');
  expect(result.messages).toEqual([]);
  expect(result.errorDetail).toBeNull();
});

it('returnedCarriesEveryMessage', () => {
  const result = parseReception(
    bytes(
      samples.returned(
        KEY,
        msg('35', 'DOCUMENTO INVÁLIDO', 'Se encontró el siguiente error en la estructura', 'ERROR'),
        errorMsg('45', 'SECUENCIAL REGISTRADO'),
      ),
    ),
  );
  expect(result.outcome).toBe('RETURNED');
  expect(result.sriStatus).toBe('DEVUELTA');
  expect(result.messages).toEqual([
    {
      identifier: '35',
      message: 'DOCUMENTO INVÁLIDO',
      additionalInfo: 'Se encontró el siguiente error en la estructura',
      type: 'ERROR',
    },
    { identifier: '45', message: 'SECUENCIAL REGISTRADO', additionalInfo: null, type: 'ERROR' },
  ]);
  expect(hasMessage(result, '35')).toBe(true);
  expect(hasMessage(result, '70')).toBe(false);
});

it('authorizedCarriesNumberDateAndEnvironment', () => {
  const result = parseAuthorization(bytes(samples.authorized(KEY)));
  expect(result.outcome).toBe('AUTHORIZED');
  expect(result.sriStatus).toBe('AUTORIZADO');
  expect(result.consultedAccessKey).toBe(KEY);
  expect(result.authorizationNumber).toBe(KEY);
  expect(result.authorizedAt).toBe('2012-03-05T16:57:34.997-05:00');
  expect(result.environmentLabel).toBe('PRUEBAS');
  expect(result.messages).toEqual([
    {
      identifier: '60',
      message: 'ESTE PROCESO FUE REALIZADO EN EL AMBIENTE DE PRUEBAS',
      additionalInfo: null,
      type: 'ADVERTENCIA',
    },
  ]);
});

it('rejectedIsNotAuthorized', () => {
  const result = parseAuthorization(bytes(samples.notAuthorized(KEY, 'RECHAZADO', errorMsg('46', 'RUC no existe'))));
  expect(result.outcome).toBe('NOT_AUTHORIZED');
  expect(result.sriStatus).toBe('RECHAZADO');
  expect(result.messages.map((m) => m.identifier)).toEqual(['46']);
  expect(result.authorizationNumber).toBeNull();
});

it('noAutorizadoIsNotAuthorized', () => {
  const result = parseAuthorization(
    bytes(samples.notAuthorized(KEY, 'NO AUTORIZADO', errorMsg('46', 'RUC no existe'))),
  );
  expect(result.outcome).toBe('NOT_AUTHORIZED');
  expect(result.sriStatus).toBe('NO AUTORIZADO');
});

it('oneAuthorizedWinsOverEarlierRejections', () => {
  const body = samples.authorizations(
    KEY,
    samples.autorizacion('NO AUTORIZADO', null, '2012-03-05T10:00:00-05:00', 'PRUEBAS', errorMsg('39', 'FIRMA INVALIDA')),
    samples.autorizacion('AUTORIZADO', KEY, '2012-03-05T12:00:00-05:00', 'PRUEBAS'),
    samples.autorizacion('NO AUTORIZADO', null, '2012-03-05T11:00:00-05:00', 'PRUEBAS', errorMsg('52', 'ERROR EN DIFERENCIAS')),
  );
  const result = parseAuthorization(bytes(body));
  expect(result.outcome).toBe('AUTHORIZED');
  expect(result.authorizedAt).toBe('2012-03-05T12:00-05:00');
  expect(result.messages).toEqual([]);
});

it('latestRejectionIsReported', () => {
  const body = samples.authorizations(
    KEY,
    samples.autorizacion('NO AUTORIZADO', null, '2012-03-05T11:00:00-05:00', 'PRUEBAS', errorMsg('52', 'ERROR EN DIFERENCIAS')),
    samples.autorizacion('NO AUTORIZADO', null, '2012-03-05T10:00:00-05:00', 'PRUEBAS', errorMsg('39', 'FIRMA INVALIDA')),
  );
  const result = parseAuthorization(bytes(body));
  expect(result.outcome).toBe('NOT_AUTHORIZED');
  expect(result.messages.map((m) => m.identifier)).toEqual(['52']);
});

it('noAuthorizationsMeansNotFound', () => {
  const result = parseAuthorization(bytes(samples.notFound(KEY)));
  expect(result.outcome).toBe('NOT_FOUND');
  expect(result.consultedAccessKey).toBe(KEY);
  expect(result.sriStatus).toBeNull();
});

it('unknownStateIsProcessing', () => {
  const result = parseAuthorization(bytes(samples.processing(KEY)));
  expect(result.outcome).toBe('PROCESSING');
  expect(result.sriStatus).toBe('EN PROCESO');
});

it('dateWithoutOffsetIsReadAsEcuadorTime', () => {
  const body = samples.authorizations(KEY, samples.autorizacion('AUTORIZADO', KEY, '2026-10-11T09:30:00', 'PRUEBAS'));
  expect(parseAuthorization(bytes(body)).authorizedAt).toBe('2026-10-11T09:30-05:00');
});

const garbage: Array<[string, string]> = [
  ['vacío', ''],
  ['html', '<html><body>503 Service Unavailable</body></html>'],
  ['doctype', `<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>${samples.received()}`],
  ['sin respuesta', '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body/></soap:Envelope>'],
  ['fault', samples.fault()],
  ['texto', 'no es xml'],
];

it.each(garbage)('garbageNeverThrows: %s', (_name, body) => {
  const reception = parseReception(bytes(body));
  expect(reception.outcome).toBe('FAILED');
  expect(reception.errorDetail).toBeTruthy();
  const authorization = parseAuthorization(bytes(body));
  expect(authorization.outcome).toBe('FAILED');
  expect(authorization.errorDetail).toBeTruthy();
});

it('un DOCTYPE con entidad externa no se resuelve', () => {
  const result = parseReception(bytes(`<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>${samples.received()}`));
  expect(result).toMatchObject({ outcome: 'FAILED', errorDetail: 'La respuesta del SRI no es un XML legible' });
});

it('unknownReceptionStateIsAFailure', () => {
  const result = parseReception(bytes(samples.receptionWithState('EN COLA')));
  expect(result.outcome).toBe('FAILED');
  expect(result.sriStatus).toBe('EN COLA');
});

it('authorizedWithoutNumberOrReadableDateIsAFailure', () => {
  const withoutNumber = samples.authorizations(
    KEY,
    samples.autorizacion('AUTORIZADO', null, samples.AUTHORIZATION_DATE, 'PRUEBAS'),
  );
  const badDate = samples.authorizations(KEY, samples.autorizacion('AUTORIZADO', KEY, 'ayer por la tarde', 'PRUEBAS'));
  const badNumber = samples.authorizations(
    KEY,
    samples.autorizacion('AUTORIZADO', 'ABC', samples.AUTHORIZATION_DATE, 'PRUEBAS'),
  );
  for (const body of [withoutNumber, badDate, badNumber]) {
    const result = parseAuthorization(bytes(body));
    expect(result.outcome).toBe('FAILED');
    expect(result.sriStatus).toBe('AUTORIZADO');
    expect(result.errorDetail).toBeTruthy();
  }
});

it('longTextsAndLongListsAreBounded', () => {
  const many = Array.from({ length: 150 }, () => msg('35', 'x'.repeat(5000), 'y'.repeat(5000), 'ERROR'));
  const result = parseReception(bytes(samples.returned(KEY, ...many)));
  expect(result.messages).toHaveLength(100);
  expect(result.messages[0]!.message).toHaveLength(2000);
  expect(result.messages[0]!.additionalInfo).toHaveLength(2000);
});

it('environmentLabels', () => {
  expect(matchesLabel('TEST', 'PRUEBAS')).toBe(true);
  expect(matchesLabel('PRODUCTION', 'PRODUCCIÓN')).toBe(true);
  expect(matchesLabel('PRODUCTION', 'produccion')).toBe(true);
  expect(matchesLabel('TEST', 'PRODUCCIÓN')).toBe(false);
  expect(matchesLabel('PRODUCTION', 'PRUEBAS')).toBe(false);
  expect(matchesLabel('TEST', null)).toBe(false);
  expect(sriEnvironmentOf('1')).toBe('TEST');
  expect(sriEnvironmentOf('2')).toBe('PRODUCTION');
  expect(() => sriEnvironmentOf('3')).toThrow('Ambiente desconocido: 3');
  expect(codeOf('TEST')).toBe('1');
  expect(codeOf('PRODUCTION')).toBe('2');
});
