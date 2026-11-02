// Sondeo HTTP compartido: la herramienta lo ejecuta contra Java para generar el golden y la prueba
// de integración lo ejecuta contra NestJS para compararlo. Solo depende de `send`, que hace una
// petición y devuelve { status, headers, body } con las cabeceras en minúsculas.
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';

/**
 * `send` sobre node:http contra `base` (http://host:puerto). A diferencia de fetch, conserva las
 * cabeceras tal como llegan: una cabecera repetida queda como lista de sus valores.
 */
export function sendRaw(base, { method, path, headers, body }) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: url.hostname, port: url.port, method, path, headers, timeout: 30_000 },
      (res) => {
        const received = {};
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          const name = res.rawHeaders[i].toLowerCase();
          const value = res.rawHeaders[i + 1];
          received[name] = name in received ? [received[name], value].flat() : value;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: received, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error(`sin respuesta: ${method} ${path}`)));
    req.on('error', reject);
    req.end(body);
  });
}

const PASSWORD = 'una contraseña larga';

/** El RUC del emisor del escenario. Es único en la plataforma: cada base sondeada es nueva. */
export const SCENARIO_RUC = '1790012345001';

async function expectJson(send, name, request, expected) {
  const res = await send(request);
  if (res.status !== expected) {
    throw new Error(`escenario, ${name}: se esperaba ${expected} y llegó ${res.status} ${res.body}`);
  }
  return res.body === '' ? undefined : JSON.parse(res.body);
}

function jsonRequest(method, path, body, headers = {}) {
  return {
    method,
    path,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

/**
 * Crea lo que los casos necesitan: una persona con su sesión, una empresa, un emisor, un
 * establecimiento, un punto de emisión, un cliente y un producto. Devuelve sus valores.
 */
export async function runScenario(send) {
  const email = `sondeo-${randomUUID()}@example.test`;
  const ip = { 'x-forwarded-for': '198.51.100.7' };
  await expectJson(send, 'registro', jsonRequest('POST', '/api/v1/auth/register', { email, password: PASSWORD }, ip), 202);
  const tokens = await expectJson(
    send,
    'ingreso',
    jsonRequest('POST', '/api/v1/auth/login', { email, password: PASSWORD }, ip),
    200,
  );
  const auth = { authorization: `Bearer ${tokens.accessToken}` };
  const tenant = await expectJson(
    send,
    'empresa',
    jsonRequest('POST', '/api/v1/tenants', { name: 'Empresa de sondeo' }, auth),
    201,
  );
  const owner = { ...auth, 'x-tenant-id': tenant.id };
  const taxpayer = await expectJson(
    send,
    'emisor',
    jsonRequest(
      'POST',
      '/api/v1/taxpayers',
      {
        ruc: SCENARIO_RUC,
        legalName: 'Emisor de Sondeo S.A.',
        headOfficeAddress: 'Av. Amazonas 100',
        defaultEnvironment: '1',
      },
      owner,
    ),
    201,
  );
  const establishment = await expectJson(
    send,
    'establecimiento',
    jsonRequest(
      'POST',
      `/api/v1/taxpayers/${taxpayer.id}/establishments`,
      { code: '001', address: 'Av. Amazonas 100' },
      owner,
    ),
    201,
  );
  const point = await expectJson(
    send,
    'punto de emisión',
    jsonRequest('POST', '/api/v1/emission-points', { establishmentId: establishment.id, code: '001' }, owner),
    201,
  );
  const customer = await expectJson(
    send,
    'cliente',
    jsonRequest('POST', '/api/v1/customers', { idType: '05', idNumber: '1712345678', name: 'Cliente de Sondeo' }, owner),
    201,
  );
  const product = await expectJson(
    send,
    'producto',
    jsonRequest(
      'POST',
      '/api/v1/products',
      { sku: 'SKU-SONDEO', name: 'Producto de Sondeo', unitPrice: '10.50', ivaRateCode: '4' },
      owner,
    ),
    201,
  );
  return {
    headers: owner,
    values: {
      email,
      tenantId: tenant.id,
      taxpayerId: taxpayer.id,
      establishmentId: establishment.id,
      emissionPointId: point.id,
      customerId: customer.id,
      productId: product.id,
    },
  };
}

const PLACEHOLDER =
  /\{(tenantId|taxpayerId|establishmentId|establishmentIdUpper|establishmentIdNoDash|emissionPointId|customerId|productId)\}/g;

/** Los valores del escenario y las variantes de un id que prueban la conversión de UUID. */
function placeholders(values) {
  return {
    ...values,
    establishmentIdUpper: values.establishmentId.toUpperCase(),
    establishmentIdNoDash: values.establishmentId.replaceAll('-', ''),
  };
}

function fill(value, values) {
  if (typeof value === 'string') return value.replace(PLACEHOLDER, (_, name) => values[name]);
  if (Array.isArray(value)) return value.map((item) => fill(item, values));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, values)]));
  }
  return value;
}

/** La petición de un caso, con los valores del escenario en la ruta, la consulta y el cuerpo. */
export function caseRequest(probe, scenario) {
  const values = placeholders(scenario.values);
  const path = fill(probe.path, values) + (probe.query === undefined ? '' : `?${fill(probe.query, values)}`);
  const headers = { ...(probe.auth === 'owner' ? scenario.headers : {}), ...(probe.headers ?? {}) };
  let body;
  if (probe.rawBody !== undefined) {
    body = probe.rawBody;
    headers['content-type'] ??= 'application/json';
  } else if ('body' in probe) {
    body = JSON.stringify(fill(probe.body, values));
    headers['content-type'] ??= 'application/json';
  }
  return { method: probe.method, path, headers, body };
}

const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/g;

/**
 * Quita lo que cambia en cada ejecución: `correlationId`, los valores del escenario (por su
 * marcador), cualquier otro UUID y las fechas ISO. Conserva el orden de las propiedades.
 */
export function normalize(value, scenario) {
  if (typeof value === 'string') {
    let text = value;
    for (const [name, known] of Object.entries(scenario.values)) text = text.replaceAll(known, `{${name}}`);
    return text.replace(UUID, '{uuid}').replace(TIMESTAMP, '{timestamp}');
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, scenario));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'correlationId')
        .map(([key, item]) => [key, normalize(item, scenario)]),
    );
  }
  return value;
}

/** Ejecuta los casos en orden y devuelve su resultado normalizado. */
export async function runProbes(send, cases, scenario) {
  const results = [];
  for (const probe of cases) {
    const res = await send(caseRequest(probe, scenario));
    let body = res.body;
    try {
      body = body === '' ? '' : JSON.parse(body);
    } catch {
      // Un cuerpo que no es JSON se compara como texto.
    }
    const { name, ...request } = probe;
    let allow = res.headers.allow ?? null;
    // En un 405 Spring lista los métodos de un HashSet: el orden cambia entre arranques. Se compara
    // ordenado. El de OPTIONS sí es estable y se deja como llega.
    if (res.status === 405 && typeof allow === 'string') {
      allow = allow.split(', ').sort().join(', ');
    }
    results.push({
      name,
      request,
      status: res.status,
      contentType: res.headers['content-type'] ?? null,
      allow,
      body: normalize(body, scenario),
    });
  }
  return results;
}
