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
 * Los intentos que `hooks.seedAttempts` siembra en un comprobante. El instante de cada uno es el
 * texto que la API debe devolver (Java serializa un `Instant` con 0, 3, 6 o 9 decimales según los
 * que tenga) y `normalize` lo conserva tal cual para fijar esa precisión. Van del más antiguo al más
 * reciente; la API los lista del más reciente al más antiguo.
 */
export const SEEDED_ATTEMPTS = [
  {
    operation: 'RECEPTION',
    environment: '1',
    startedAt: '2001-01-15T10:20:30.123456Z',
    completedAt: '2001-01-15T10:20:30.500Z',
    outcome: 'RETURNED',
    sriStatus: 'DEVUELTA',
    httpStatus: 200,
    errorDetail: null,
    response: '<respuesta>cruda del SRI que no sale por la API</respuesta>',
    messages: [
      { identifier: '35', message: 'ARCHIVO NO CUMPLE ESTRUCTURA XML', additionalInfo: 'Elemento inválido: razónSocial', type: 'ERROR' },
      { identifier: '43', message: 'CLAVE ACCESO REGISTRADA', additionalInfo: 'Ya existe el comprobante', type: 'ERROR' },
    ],
  },
  {
    operation: 'AUTHORIZATION',
    environment: '1',
    startedAt: '2001-01-15T10:20:31Z',
    completedAt: null,
    outcome: null,
    sriStatus: null,
    httpStatus: null,
    errorDetail: null,
    response: null,
    messages: [],
  },
];

/**
 * Los artefactos que `hooks.seedArtifacts` guarda en un comprobante, con contenido de texto fijo: así el
 * ETag (su SHA-256) y el cuerpo de la descarga son los mismos en Java y en NestJS.
 */
export const SEEDED_ARTIFACTS = [
  { kind: 'XML_UNSIGNED', content: '<factura id="comprobante">sin firmar ñ</factura>' },
  { kind: 'XML_SIGNED', content: '<factura id="comprobante">firmada ñ</factura>' },
  { kind: 'SRI_AUTHORIZATION', content: '<RespuestaAutorizacionComprobante/>' },
  { kind: 'XML_AUTHORIZED', content: '<autorizacion><estado>AUTORIZADO</estado></autorizacion>' },
  { kind: 'RIDE_PDF', content: '%PDF-1.5 ride de sondeo' },
];

/**
 * Las entregas que `hooks.seedDeliveries` inserta, de la más antigua a la más reciente (la API las lista al
 * revés). `requestedBy: 'owner'` es quien creó el comprobante; nulo, la entrega automática. Los instantes
 * se conservan como los de `SEEDED_ATTEMPTS`.
 */
export const SEEDED_DELIVERIES = [
  {
    recipient: 'cliente@example.test',
    status: 'SENT',
    attemptCount: 2,
    lastError: null,
    createdAt: '2001-02-03T04:05:06.123456Z',
    sentAt: '2001-02-03T04:06:07.500Z',
    requestedBy: null,
  },
  {
    recipient: 'otra@example.test',
    status: 'FAILED',
    attemptCount: 1,
    lastError: 'SMTP 550: 550 5.1.1 El buzón no existe',
    createdAt: '2001-02-03T04:05:07Z',
    sentAt: null,
    requestedBy: 'owner',
  },
  {
    recipient: 'pendiente@example.test',
    status: 'PENDING',
    attemptCount: 0,
    lastError: null,
    createdAt: '2001-02-03T04:05:08.120Z',
    sentAt: null,
    requestedBy: 'owner',
  },
  {
    recipient: 'enviando@example.test',
    status: 'SENDING',
    attemptCount: 3,
    lastError: 'Sin respuesta del servidor de correo: ConnectException',
    createdAt: '2001-02-03T04:05:09.000001Z',
    sentAt: null,
    requestedBy: 'owner',
  },
];

/** Diez entregas pedidas por el usuario: el tope por comprobante. */
export const LIMIT_DELIVERIES = Array.from({ length: 10 }, () => ({ ...SEEDED_DELIVERIES[2] }));

/** Los roles de los miembros que el escenario siembra con `hooks.addMember`. */
const MEMBER_ROLES = ['AUDITOR', 'BILLER'];

/** Registra a una persona y devuelve su correo y la cabecera con su sesión. */
async function signUp(send, label) {
  const email = `sondeo-${label}${randomUUID()}@example.test`;
  const ip = { 'x-forwarded-for': '198.51.100.7' };
  await expectJson(send, 'registro', jsonRequest('POST', '/api/v1/auth/register', { email, password: PASSWORD }, ip), 202);
  const tokens = await expectJson(
    send,
    'ingreso',
    jsonRequest('POST', '/api/v1/auth/login', { email, password: PASSWORD }, ip),
    200,
  );
  return { email, auth: { authorization: `Bearer ${tokens.accessToken}` } };
}

/** Una empresa con su emisor, establecimiento, punto de emisión, cliente y producto. */
async function createWorld(send, auth, { ruc, name, sku }) {
  const tenant = await expectJson(send, 'empresa', jsonRequest('POST', '/api/v1/tenants', { name }, auth), 201);
  const owner = { ...auth, 'x-tenant-id': tenant.id };
  const taxpayer = await expectJson(
    send,
    'emisor',
    jsonRequest(
      'POST',
      '/api/v1/taxpayers',
      { ruc, legalName: 'Emisor de Sondeo S.A.', headOfficeAddress: 'Av. Amazonas 100', defaultEnvironment: '1' },
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
    jsonRequest('POST', '/api/v1/products', { sku, name: 'Producto de Sondeo', unitPrice: '10.50', ivaRateCode: '4' }, owner),
    201,
  );
  return { owner, tenant, taxpayer, establishment, point, customer, product };
}

/** Emite la factura de 12.08 (un producto de 10.50 con IVA del 15 %) y devuelve su id. */
async function issueInvoice(send, world, key, customerId = world.customer.id) {
  // 10.50 con IVA del 15 % (código 4): subtotal 10.50, IVA 1.58 (1.575 redondeado) y total 12.08.
  const issued = await expectJson(
    send,
    'factura',
    jsonRequest(
      'POST',
      '/api/v1/invoices',
      {
        taxpayerId: world.taxpayer.id,
        establishmentCode: '001',
        emissionPointCode: '001',
        customerId,
        lines: [{ productId: world.product.id, quantity: '1' }],
        payments: [{ methodCode: '01', amount: INVOICE_TOTAL }],
      },
      { ...world.owner, 'idempotency-key': key },
    ),
    202,
  );
  return issued.id;
}

/**
 * Crea lo que los casos necesitan: una persona con su sesión, una empresa, un emisor, un
 * establecimiento, un punto de emisión, un cliente y un producto. Devuelve sus valores.
 * Con `hooks`, además emite una factura del producto y la pasa a AUTHORIZED con `hooks.authorize`
 * (la emisión deja el comprobante en RESERVED; una nota solo acepta una factura autorizada); sus
 * valores ganan `invoiceId`.
 * Con `hooks.seedAttempts`, el escenario sigue con lo que necesita E4: siembra los intentos
 * `SEEDED_ATTEMPTS` en `invoiceId`; emite tres facturas más que quedan en RESERVED
 * (`retryDocumentId`), RETURNED (`returnedDocumentId`) y NOT_AUTHORIZED (`notAuthorizedDocumentId`,
 * las dos últimas con `hooks.setState`); crea una segunda empresa con su factura (`otherTenantId`,
 * `otherInvoiceId`) y, con `hooks.addMember`, dos miembros de la primera con rol AUDITOR y BILLER
 * (`scenario.actors.auditor` y `.biller`) y una persona sin membresía (`.stranger`).
 * Con `hooks.seedArtifacts`, añade lo de E5, cuatro facturas autorizadas más: `archivedDocumentId` (con los
 * artefactos y las entregas sembrados), `bareDocumentId` (sin artefactos ni correo de cliente),
 * `mailedDocumentId` (de un cliente con correo) y `limitDocumentId` (con el máximo de entregas).
 */
export async function runScenario(send, hooks) {
  // El día fiscal se fija una vez: con él se rellenan los casos y se normalizan las respuestas.
  const today = fiscalToday();
  const { email, auth } = await signUp(send, '');
  const world = await createWorld(send, auth, {
    ruc: SCENARIO_RUC,
    name: 'Empresa de sondeo',
    sku: 'SKU-SONDEO',
  });
  const values = {
    email,
    tenantId: world.tenant.id,
    taxpayerId: world.taxpayer.id,
    establishmentId: world.establishment.id,
    emissionPointId: world.point.id,
    customerId: world.customer.id,
    productId: world.product.id,
  };
  const scenario = { headers: world.owner, values, today };
  if (hooks !== undefined) {
    values.invoiceId = await issueInvoice(send, world, 'sondeo-factura');
    await hooks.authorize(values.invoiceId);
  }
  if (hooks?.seedAttempts !== undefined) {
    await hooks.seedAttempts(values.invoiceId);
    values.retryDocumentId = await issueInvoice(send, world, 'sondeo-reintento');
    values.returnedDocumentId = await issueInvoice(send, world, 'sondeo-devuelta');
    await hooks.setState(values.returnedDocumentId, 'RETURNED');
    values.notAuthorizedDocumentId = await issueInvoice(send, world, 'sondeo-no-autorizada');
    await hooks.setState(values.notAuthorizedDocumentId, 'NOT_AUTHORIZED');

    const second = await signUp(send, 'otra-');
    const otherWorld = await createWorld(send, second.auth, {
      ruc: '1790012346001',
      name: 'Otra empresa de sondeo',
      sku: 'SKU-OTRA',
    });
    values.otherTenantId = otherWorld.tenant.id;
    values.otherInvoiceId = await issueInvoice(send, otherWorld, 'sondeo-factura-ajena');

    const actors = {};
    for (const role of MEMBER_ROLES) {
      const member = await signUp(send, `${role.toLowerCase()}-`);
      await hooks.addMember(world.tenant.id, member.email, role);
      actors[role.toLowerCase()] = { ...member.auth, 'x-tenant-id': world.tenant.id };
    }
    // Una persona registrada que no pertenece a la empresa del escenario.
    const stranger = await signUp(send, 'ajena-');
    actors.stranger = { ...stranger.auth, 'x-tenant-id': world.tenant.id };
    scenario.actors = actors;
  }
  if (hooks?.seedArtifacts !== undefined) {
    values.archivedDocumentId = await issueInvoice(send, world, 'sondeo-archivada');
    await hooks.authorize(values.archivedDocumentId);
    await hooks.seedArtifacts(values.archivedDocumentId);
    await hooks.seedDeliveries(values.archivedDocumentId, SEEDED_DELIVERIES);
    values.bareDocumentId = await issueInvoice(send, world, 'sondeo-sin-artefactos');
    await hooks.authorize(values.bareDocumentId);
    const mailed = await expectJson(
      send,
      'cliente con correo',
      jsonRequest(
        'POST',
        '/api/v1/customers',
        { idType: '05', idNumber: '1710034065', name: 'Cliente con correo', email: 'cliente@example.test' },
        world.owner,
      ),
      201,
    );
    values.mailedDocumentId = await issueInvoice(send, world, 'sondeo-con-correo', mailed.id);
    await hooks.authorize(values.mailedDocumentId);
    values.limitDocumentId = await issueInvoice(send, world, 'sondeo-tope', mailed.id);
    await hooks.authorize(values.limitDocumentId);
    await hooks.seedDeliveries(values.limitDocumentId, LIMIT_DELIVERIES);
  }
  return scenario;
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
  const actor = probe.auth === 'owner' ? scenario.headers : scenario.actors?.[probe.auth];
  const headers = { ...(actor ?? {}), ...fill(probe.headers ?? {}, values) };
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
const SEEDED_INSTANTS = new Set(
  [
    ...SEEDED_ATTEMPTS.flatMap((attempt) => [attempt.startedAt, attempt.completedAt]),
    ...SEEDED_DELIVERIES.flatMap((delivery) => [delivery.createdAt, delivery.sentAt]),
  ].filter((instant) => instant !== null),
);
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
      // Los instantes sembrados se conservan: fijan cuántos decimales muestra la API.
      .replace(TIMESTAMP, (instant) => (SEEDED_INSTANTS.has(instant) ? instant : '{timestamp}'))
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
    const { name, capture, checkHeaders, ...request } = probe;
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
      // Solo en los casos que lo piden: las cabeceras que fijan (null si la respuesta no la trae).
      ...(checkHeaders === undefined
        ? {}
        : { headers: Object.fromEntries(checkHeaders.map((header) => [header, res.headers[header] ?? null])) }),
    });
  }
  return results;
}
