import { randomInt } from 'node:crypto';
import { createServer } from 'node:net';
import { HttpSriGateway } from '../../../src/sri/http-sri-gateway.js';
import { createSriConfig, type SriConfigInput } from '../../../src/sri/sri-config.js';
import { authorized, errorMsg, fault, received, returned } from '../../support/sri-soap-samples.js';
import { Reply, SriStub } from '../../support/sri-stub.js';

// Traducción de sri/HttpSriGatewayTest.java, contra el SRI simulado.
const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';

let stub: SriStub;
beforeAll(async () => {
  stub = await SriStub.start();
});
afterAll(async () => {
  await stub.close();
});

function gateway(readTimeoutMs = 5_000, test?: SriConfigInput['test']): HttpSriGateway {
  const endpoints = test ?? { reception: stub.receptionUrl, authorization: stub.authorizationUrl };
  return new HttpSriGateway(
    createSriConfig({
      enabledEnvironments: ['1'],
      allowCustomEndpoints: true,
      test: endpoints,
      production: endpoints,
      connectTimeoutMs: 2_000,
      readTimeoutMs,
      authorizationDelayMs: 0,
      retryBackoffMs: 1_000,
      retryMaxBackoffMs: 60_000,
      retryMaxAttempts: 5,
    }),
  );
}

const accessKey = () => Array.from({ length: 49 }, () => randomInt(10)).join('');

const invoice = (key: string) =>
  Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?><factura id="comprobante" version="1.1.0">' +
      `<infoTributaria><claveAcceso>${key}</claveAcceso><razonSocial>Ñandú &amp; Cía.</razonSocial>` +
      '</infoTributaria></factura>',
    'utf8',
  );

/** Lee la petición SOAP con un DOM sencillo: nombre con prefijo, espacio de nombres y texto. */
function soapParts(body: Buffer) {
  const text = body.toString('utf8');
  const operation = /<soapenv:Body><ec:(\w+)>(?:<(\w+)>([^<]*)<\/\w+>)<\/ec:\w+><\/soapenv:Body>/.exec(text)!;
  return {
    envelopeNs: /<soapenv:Envelope xmlns:soapenv="([^"]+)"/.exec(text)![1],
    operationNs: /xmlns:ec="([^"]+)"/.exec(text)![1],
    operation: operation[1],
    payload: operation[2],
    payloadText: operation[3],
  };
}

it('receptionSendsTheSignedXmlAsBase64InTheOfficialEnvelope', async () => {
  const key = accessKey();
  const xml = invoice(key);

  const result = await gateway().receive('TEST', xml);

  expect(result.outcome).toBe('RECEIVED');
  expect(result.httpStatus).toBe(200);
  const request = stub.lastReception(key)!;
  expect(request.contentType).toBe('text/xml; charset=UTF-8');
  expect(request.soapAction).toBe('""');
  const soap = soapParts(request.body);
  expect(soap.envelopeNs).toBe(SOAP);
  expect(soap.operationNs).toBe('http://ec.gob.sri.ws.recepcion');
  expect(soap.operation).toBe('validarComprobante');
  expect(soap.payload).toBe('xml');
  expect(Buffer.from(soap.payloadText!, 'base64').equals(xml)).toBe(true);
  expect(stub.lastReceptionXml(key)!.equals(xml)).toBe(true);
});

it('authorizationSendsTheAccessKey', async () => {
  const key = accessKey();

  const result = await gateway().authorize('TEST', key);

  expect(result.outcome).toBe('AUTHORIZED');
  expect(result.authorizationNumber).toBe(key);
  expect(result.httpStatus).toBe(200);
  expect(result.rawResponse!.toString('utf8')).toBe(authorized(key));
  const soap = soapParts(stub.lastAuthorization(key)!.body);
  expect(soap.operationNs).toBe('http://ec.gob.sri.ws.autorizacion');
  expect(soap.operation).toBe('autorizacionComprobante');
  expect(soap.payload).toBe('claveAccesoComprobante');
  expect(soap.payloadText).toBe(key);
});

it('accessKeyThatIsNotFortyNineDigitsNeverReachesTheSri', async () => {
  const result = await gateway().authorize('TEST', '1</claveAccesoComprobante><x>');
  expect(result.outcome).toBe('FAILED');
  expect(result.httpStatus).toBeNull();
  expect(result.errorDetail).toBe('La clave de acceso debe tener 49 dígitos');
});

it('returnedIsParsedWithItsMessages', async () => {
  const key = accessKey();
  stub.onReception(key, Reply.xml(returned(key, errorMsg('35', 'DOCUMENTO INVÁLIDO'))));

  const result = await gateway().receive('TEST', invoice(key));

  expect(result.outcome).toBe('RETURNED');
  expect(result.messages.map((m) => m.message)).toEqual(['DOCUMENTO INVÁLIDO']);
  expect(result.rawResponse!.length).toBeGreaterThan(0);
});

it('http500IsAFailureThatKeepsTheStatus', async () => {
  const key = accessKey();
  stub.onReception(key, Reply.status(500, fault()));
  stub.onAuthorization(key, Reply.status(503, 'Service Unavailable'));

  const reception = await gateway().receive('TEST', invoice(key));
  const authorization = await gateway().authorize('TEST', key);

  expect(reception.outcome).toBe('FAILED');
  expect(reception.httpStatus).toBe(500);
  expect(reception.errorDetail).toBe('El SRI respondió HTTP 500');
  expect(authorization.outcome).toBe('FAILED');
  expect(authorization.httpStatus).toBe(503);
  expect(authorization.rawResponse!.toString('utf8')).toBe('Service Unavailable');
});

it('de un cuerpo de error se conservan 64 KiB', async () => {
  const key = accessKey();
  stub.onAuthorization(key, { ...Reply.bytes(100 * 1024), status: 500 });
  const result = await gateway().authorize('TEST', key);
  expect(result.httpStatus).toBe(500);
  expect(result.rawResponse!.length).toBe(64 * 1024);
});

it('htmlWith200IsAFailure', async () => {
  const key = accessKey();
  stub.onReception(key, Reply.xml('<html><body>Mantenimiento</body></html>'));

  const result = await gateway().receive('TEST', invoice(key));

  expect(result.outcome).toBe('FAILED');
  expect(result.httpStatus).toBe(200);
  expect(result.errorDetail).toBeTruthy();
});

it('slowAnswerTimesOut', async () => {
  const key = accessKey();
  stub.onReception(key, Reply.delayed(4_000, Reply.xml(received())));
  const start = performance.now();

  const result = await gateway(300).receive('TEST', invoice(key));

  expect(result.outcome).toBe('FAILED');
  expect(result.httpStatus).toBeNull();
  expect(result.errorDetail).toMatch(/^Sin respuesta del SRI: /);
  expect(performance.now() - start).toBeLessThan(3_500);
});

it('droppedConnectionIsAFailure', async () => {
  const key = accessKey();
  stub.onAuthorization(key, Reply.dropConnection());

  const result = await gateway().authorize('TEST', key);

  expect(result.outcome).toBe('FAILED');
  expect(result.errorDetail).toBe('Sin respuesta del SRI: IOException');
});

it('nothingListeningIsAFailureThatDoesNotLeakTheAddress', async () => {
  // Un puerto libre que nadie escucha.
  const port = await new Promise<number>((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port: free } = server.address() as { port: number };
      server.close(() => resolve(free));
    });
  });
  const nowhere = {
    reception: `http://127.0.0.1:${port}/recepcion`,
    authorization: `http://127.0.0.1:${port}/autorizacion`,
  };

  const result = await gateway(2_000, nowhere).receive('TEST', invoice(accessKey()));

  expect(result.outcome).toBe('FAILED');
  expect(result.errorDetail).toBe('Sin respuesta del SRI: ConnectException');
  expect(result.errorDetail).not.toContain('127.0.0.1');
  expect(result.errorDetail).not.toContain(String(port));
});

it('oversizedAnswerIsAFailure', async () => {
  const key = accessKey();
  stub.onAuthorization(key, Reply.bytes(3 * 1024 * 1024));

  const result = await gateway().authorize('TEST', key);

  expect(result.outcome).toBe('FAILED');
  expect(result.errorDetail).toBe('La respuesta del SRI es demasiado grande');
  expect(result.rawResponse).toBeNull();
});

it('una redirección es un fallo con su estado y no se sigue', async () => {
  const key = accessKey();
  const target = accessKey();
  stub.onReception(
    key,
    Reply.withHeaders(Reply.status(302, ''), { Location: `${stub.receptionUrl}?siguiente=${target}` }),
  );

  const result = await gateway().receive('TEST', invoice(key));

  expect(result).toMatchObject({ outcome: 'FAILED', httpStatus: 302, errorDetail: 'El SRI respondió HTTP 302' });
  expect(stub.receptionCalls(key)).toBe(1);
  expect(stub.receptionCalls('sin-clave')).toBe(0);
});

it('una respuesta con DOCTYPE es FAILED sin resolver la entidad', async () => {
  const key = accessKey();
  stub.onAuthorization(key, Reply.xml(`<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>${authorized(key)}`));

  const result = await gateway().authorize('TEST', key);

  expect(result).toMatchObject({
    outcome: 'FAILED',
    httpStatus: 200,
    errorDetail: 'La respuesta del SRI no es un XML legible',
  });
});

it('el cuerpo lento también cuenta en el plazo total', async () => {
  const key = accessKey();
  // Cabeceras al momento, pero el cuerpo no termina: el plazo total (conexión + lectura) lo corta.
  const server = createServer((socket) => {
    socket.once('data', () => {
      socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/xml\r\nContent-Length: 100000\r\n\r\n<a>');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    const start = performance.now();
    const result = await new HttpSriGateway(
      createSriConfig({
        enabledEnvironments: ['1'],
        allowCustomEndpoints: true,
        test: { reception: `http://127.0.0.1:${port}/r`, authorization: `http://127.0.0.1:${port}/a` },
        production: { reception: `http://127.0.0.1:${port}/r`, authorization: `http://127.0.0.1:${port}/a` },
        connectTimeoutMs: 200,
        readTimeoutMs: 300,
        authorizationDelayMs: 0,
        retryBackoffMs: 1,
        retryMaxBackoffMs: 1,
        retryMaxAttempts: 1,
      }),
    ).authorize('TEST', key);
    expect(result).toMatchObject({
      outcome: 'FAILED',
      httpStatus: null,
      errorDetail: 'Sin respuesta del SRI: tiempo de espera agotado',
    });
    expect(performance.now() - start).toBeLessThan(2_000);
  } finally {
    server.close();
  }
});
