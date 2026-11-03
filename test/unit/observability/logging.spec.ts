import { runWithContext, setDocumentId } from '../../../src/common/request-context.js';
import { createPinoLogger, severityOf } from '../../../src/observability/logging.js';
import { testConfig } from '../../support/test-env.js';

it.each([
  ['fatal', 'ERROR'],
  ['error', 'ERROR'],
  ['warn', 'WARNING'],
  ['info', 'INFO'],
  ['debug', 'DEBUG'],
  ['trace', 'DEBUG'],
])('%s → %s', (level, severity) => {
  expect(severityOf(level)).toBe(severity);
});

function jsonLogger() {
  const lines: string[] = [];
  const logger = createPinoLogger(
    { ...testConfig, logFormat: 'json' },
    { write: (l: string) => void lines.push(l) },
  );
  return { logger, lines };
}

it('cada línea JSON lleva severity, message y correlationId, y censura secretos', () => {
  const { logger, lines } = jsonLogger();
  runWithContext({ correlationId: 'c-1' }, () =>
    logger.warn({ password: 'secreta', token: 't0k3n' }, 'hola'),
  );
  const entry = JSON.parse(lines[0]!);
  expect(entry).toMatchObject({ severity: 'WARNING', message: 'hola', correlationId: 'c-1' });
  expect(entry['@timestamp']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(lines[0]).not.toMatch(/secreta|t0k3n/);
});

it('no emite level, pid ni hostname y omite correlationId fuera de una petición', () => {
  const { logger, lines } = jsonLogger();
  logger.info('arranque');
  const entry = JSON.parse(lines[0]!);
  expect(entry).not.toHaveProperty('level');
  expect(entry).not.toHaveProperty('pid');
  expect(entry).not.toHaveProperty('hostname');
  expect(entry).not.toHaveProperty('correlationId');
});

it('censura cabeceras sensibles', () => {
  const { logger, lines } = jsonLogger();
  logger.info(
    { req: { headers: { authorization: 'Bearer abc', 'x-api-key': 'k3y', cookie: 'sid=1' } } },
    'x',
  );
  expect(lines[0]).not.toMatch(/Bearer abc|k3y|sid=1/);
});

it('modo texto: una línea sin colores con el correlationId entre corchetes', () => {
  const lines: string[] = [];
  const logger = createPinoLogger(
    { ...testConfig, logFormat: 'text' },
    { write: (l: string) => void lines.push(l) },
  );
  runWithContext({ correlationId: 'c-9' }, () => logger.info('hola'));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('[c-9]');
  expect(lines[0]).toContain('hola');
  // eslint-disable-next-line no-control-regex
  expect(lines[0]).not.toMatch(/\u001b\[/);
  expect(lines[0]!.trimEnd().split('\n')).toHaveLength(1);
});

describe('censura por clave a cualquier profundidad', () => {
  it('anidado a 3 niveles', () => {
    const { logger, lines } = jsonLogger();
    logger.info({ a: { b: { password: 'secreta' } } }, 'x');
    expect(lines[0]).not.toContain('secreta');
    expect(JSON.parse(lines[0]!).a.b.password).toBe('[Redacted]');
  });

  it('dentro de arrays', () => {
    const { logger, lines } = jsonLogger();
    logger.info({ items: [{ token: 't0k3n' }, { ok: 1 }] }, 'x');
    expect(lines[0]).not.toContain('t0k3n');
    expect(JSON.parse(lines[0]!).items).toEqual([{ token: '[Redacted]' }, { ok: 1 }]);
  });

  it('claves en cualquier combinación de mayúsculas', () => {
    const { logger, lines } = jsonLogger();
    logger.info({ Authorization: 'Bearer x', X_: 1, 'X-API-Key': 'k3y', masterKey: 'mk' }, 'x');
    expect(lines[0]).not.toMatch(/Bearer x|k3y|"mk"/);
  });

  it('un objeto circular no lanza', () => {
    const { logger, lines } = jsonLogger();
    const circular: Record<string, unknown> = { password: 'secreta' };
    circular['self'] = circular;
    expect(() => logger.info({ circular }, 'x')).not.toThrow();
    expect(lines[0]).not.toContain('secreta');
  });

  it('no muta el objeto del llamador', () => {
    const { logger } = jsonLogger();
    const payload = { a: { password: 'secreta' }, items: [{ token: 't0k3n' }] };
    logger.info(payload, 'x');
    expect(payload).toEqual({ a: { password: 'secreta' }, items: [{ token: 't0k3n' }] });
  });

  it('censura las propiedades propias de un Error, en err y en otras claves', () => {
    const { logger, lines } = jsonLogger();
    const failure = () =>
      Object.assign(new Error('fallo upstream'), {
        config: { headers: { Authorization: 'Bearer s3cr3t' } },
      });
    logger.error({ upstream: failure() }, 'a');
    logger.error({ err: failure() }, 'b');
    for (const line of lines) expect(line).not.toContain('s3cr3t');
    expect(lines[0]).toContain('fallo upstream');
    const viaErr = JSON.parse(lines[1]!);
    expect(viaErr.stack_trace).toContain('fallo upstream');
    expect(viaErr.message).toBe('b');
  });

  it('un objeto de 1000 niveles no lanza', () => {
    const { logger, lines } = jsonLogger();
    const root: Record<string, unknown> = {};
    let node = root;
    for (let i = 0; i < 1000; i++) node = (node['n'] = {}) as Record<string, unknown>;
    expect(() => logger.info(root, 'x')).not.toThrow();
    expect(lines[0]).toContain('[Truncado]');
  });
});

describe('censura por subcadena de la clave', () => {
  const names = [
    'accessToken',
    'refreshToken',
    'newPassword',
    'currentPassword',
    'apiKey',
    'api_key',
    'webhookSecret',
    'set-cookie',
    'proxy-authorization',
    'jwtSecret',
    'metricsToken',
    'privateKey',
    'private-key',
    'X-API-KEY',
    'certificateP12',
    'EINVOICE_MASTER_KEY_masterKey',
  ];

  it.each(names)('%s', (name) => {
    const { logger, lines } = jsonLogger();
    logger.info({ [name]: 'valor-secreto-123', nested: { [name]: 'valor-secreto-123' } }, 'x');
    expect(lines[0]).not.toContain('valor-secreto-123');
    expect(JSON.parse(lines[0]!)[name]).toBe('[Redacted]');
  });

  it('no censura claves sin relación', () => {
    const { logger, lines } = jsonLogger();
    logger.info({ tenantId: 't-1', status: 'ok' }, 'x');
    expect(JSON.parse(lines[0]!)).toMatchObject({ tenantId: 't-1', status: 'ok' });
  });
});

describe('URL con credenciales en cualquier propiedad', () => {
  it('redis: { url } enmascara la clave y conserva el resto', () => {
    const { logger, lines } = jsonLogger();
    logger.info({ redis: { url: 'redis://:clave-xyz@cache:6379/0' } }, 'x');
    expect(lines[0]).not.toContain('clave-xyz');
    expect(JSON.parse(lines[0]!).redis.url).toBe('redis://:[Redacted]@cache:6379/0');
  });

  it.each(['target', 'origin', 'dsn'])('bajo el nombre %s y con usuario', (name) => {
    const { logger, lines } = jsonLogger();
    logger.info({ [name]: 'postgresql://app:clave-xyz@db:5432/einvoice?sslmode=require' }, 'x');
    expect(lines[0]).not.toContain('clave-xyz');
    expect(JSON.parse(lines[0]!)[name]).toBe(
      'postgresql://app:[Redacted]@db:5432/einvoice?sslmode=require',
    );
  });

  it('clave con arroba sin codificar y valores dentro de arrays', () => {
    const { logger, lines } = jsonLogger();
    logger.info({ urls: ['amqp://u:cl@ve-xyz@mq:5672'] }, 'x');
    expect(lines[0]).not.toMatch(/cl@ve|ve-xyz/);
  });

  it('el mensaje de un Error con la URL no la filtra', () => {
    const { logger, lines } = jsonLogger();
    logger.error({ err: new Error('fallo en redis://:clave-xyz@cache:6379') }, 'x');
    expect(lines[0]).not.toContain('clave-xyz');
  });

  it('una URL sin credenciales queda igual', () => {
    const { logger, lines } = jsonLogger();
    logger.info({ url: 'https://example.com/a?b=c@d' }, 'x');
    expect(JSON.parse(lines[0]!).url).toBe('https://example.com/a?b=c@d');
  });
});

it('una línea de una emisión lleva el documentId que fijó el emisor', () => {
  const { logger, lines } = jsonLogger();
  runWithContext({ correlationId: 'c-2' }, () => {
    logger.info('antes');
    setDocumentId('6f1c1d2e-0000-4000-8000-000000000001');
    logger.info('después');
  });
  setDocumentId('fuera de una petición no se guarda');
  logger.info('fuera');
  const [before, after, outside] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(before).not.toHaveProperty('documentId');
  expect(after).toMatchObject({ correlationId: 'c-2', documentId: '6f1c1d2e-0000-4000-8000-000000000001' });
  expect(outside).not.toHaveProperty('documentId');
});
