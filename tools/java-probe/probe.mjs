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

/** El total de la factura del escenario: un producto de 10.50 con IVA del 15 %. */
const INVOICE_TOTAL = '12.08';

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
 * Con `hooks`, además emite una factura del producto y la pasa a AUTHORIZED con `hooks.authorize`
 * (la emisión deja el comprobante en RESERVED; una nota solo acepta una factura autorizada); sus
 * valores ganan `invoiceId`.
 */
export async function runScenario(send, hooks) {
  // El día fiscal se fija una vez: con él se rellenan los casos y se normalizan las respuestas.
  const today = fiscalToday();
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
  const values = {
    email,
    tenantId: tenant.id,
    taxpayerId: taxpayer.id,
    establishmentId: establishment.id,
    emissionPointId: point.id,
    customerId: customer.id,
    productId: product.id,
  };
  if (hooks !== undefined) {
    // 10.50 con IVA del 15 % (código 4): subtotal 10.50, IVA 1.58 (1.575 redondeado) y total 12.08.
    const issued = await expectJson(
      send,
      'factura',
      jsonRequest(
        'POST',
        '/api/v1/invoices',
        {
          taxpayerId: taxpayer.id,
          establishmentCode: '001',
          emissionPointCode: '001',
          customerId: customer.id,
          lines: [{ productId: product.id, quantity: '1' }],
          payments: [{ methodCode: '01', amount: INVOICE_TOTAL }],
        },
        { ...owner, 'idempotency-key': 'sondeo-factura' },
      ),
      202,
    );
    await hooks.authorize(issued.id);
    values.invoiceId = issued.id;
  }
  return { headers: owner, values, today };
}

const PLACEHOLDER = /\{([A-Za-z0-9]+)\}/g;
const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Los valores del escenario (y los que un caso captura) y, de cada id, sus variantes en mayúsculas
 * (`{xxxUpper}`) y sin guiones (`{xxxNoDash}`), que prueban la conversión de UUID.
 */
function placeholders(values) {
  const all = { ...values };
  for (const [name, value] of Object.entries(values)) {
    if (!UUID_ONLY.test(value)) continue;
    all[`${name}Upper`] = value.toUpperCase();
    all[`${name}NoDash`] = value.replaceAll('-', '');
  }
  return all;
}

function fill(value, values) {
  if (typeof value === 'string') return value.replace(PLACEHOLDER, (match, name) => values[name] ?? match);
  if (Array.isArray(value)) return value.map((item) => fill(item, values));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, values)]));
  }
  return value;
}

/** La petición de un caso, con los valores del escenario en la ruta, la consulta y el cuerpo. */
export function caseRequest(probe, scenario) {
  const values = { ...placeholders(scenario.values), ...dateValues(scenario.today ?? fiscalToday()) };
  const path = fill(probe.path, values) + (probe.query === undefined ? '' : `?${fill(probe.query, values)}`);
  const headers = { ...(probe.auth === 'owner' ? scenario.headers : {}), ...(probe.headers ?? {}) };
  let body;
  if (probe.rawBody !== undefined) {
    body = fill(probe.rawBody, values);
    headers['content-type'] ??= 'application/json';
  } else if ('body' in probe) {
    body = JSON.stringify(fill(probe.body, values));
    headers['content-type'] ??= 'application/json';
  }
  return { method: probe.method, path, headers, body };
}

const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/g;
const ACCESS_KEY = /(?<!\d)\d{49}(?!\d)/g;

/** La fecha fiscal de hoy (YYYY-MM-DD en America/Guayaquil): la de un comprobante sin `issueDate`. */
function fiscalToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil' }).format(new Date());
}

/** `today` más `days` días, como YYYY-MM-DD. */
function shiftDay(today, days) {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Marcadores de fecha, fijados con el día de la ejecución: `{today}`, `{todayYear}`, `{todayMonth}` y
 * `{todayDay}` (sin ceros, para escribir [año, mes, día]), `{todayMinus1}` y `{todayPlus1}`.
 */
function dateValues(today) {
  const [year, month, day] = today.split('-').map(Number);
  return {
    today,
    todayYear: String(year),
    todayMonth: String(month),
    todayDay: String(day),
    todayMinus1: shiftDay(today, -1),
    todayPlus1: shiftDay(today, 1),
  };
}

/**
 * Quita lo que cambia en cada ejecución: `correlationId`, los valores del escenario (por su
 * marcador), cualquier otro UUID y las fechas ISO. Conserva el orden de las propiedades.
 */
export function normalize(value, scenario) {
  if (typeof value === 'string') {
    let text = value;
    for (const [name, known] of Object.entries(scenario.values)) {
      text = text.replaceAll(known, `{${name}}`);
      // Un id sin guiones también sale en el `instance` de una petición con la ruta sin guiones.
      if (UUID_ONLY.test(known)) text = text.replaceAll(known.replaceAll('-', ''), `{${name}NoDash}`);
    }
    return text
      .replace(UUID, '{uuid}')
      .replace(TIMESTAMP, '{timestamp}')
      .replace(ACCESS_KEY, '{accessKey}')
      .replaceAll(scenario.today ?? fiscalToday(), '{today}');
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, scenario));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'correlationId')
        .map(([key, item]) => [key, key === 'errors' && Array.isArray(item) ? fieldErrors(item) : normalize(item, scenario)]),
    );
  }
  return value;
}

/**
 * Los errores de campo de Java salen de un conjunto de Hibernate y de un Map.of, cuyo orden cambia
 * entre arranques de la JVM: se comparan ordenados y con las claves en un orden fijo.
 */
function fieldErrors(errors) {
  return errors
    .map((error) => ({ field: error.field, message: error.message }))
    .sort((a, b) => (a.field + a.message < b.field + b.message ? -1 : a.field + a.message > b.field + b.message ? 1 : 0));
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
    // Un caso con `capture` guarda el id que devolvió, para que los siguientes lo usen como `{nombre}`.
    if (probe.capture !== undefined && res.status >= 200 && res.status < 300 && typeof body?.id === 'string') {
      scenario.values[probe.capture] = body.id;
    }
    const { name, capture, ...request } = probe;
    let allow = res.headers.allow ?? null;
    // Spring lista los métodos permitidos de un conjunto cuyo orden cambia entre arranques, en el
    // 405 y en OPTIONS: se comparan ordenados, conservando el separador (", " o ",").
    if (typeof allow === 'string') {
      const separator = allow.includes(', ') ? ', ' : ',';
      allow = allow.split(separator).sort().join(separator);
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
