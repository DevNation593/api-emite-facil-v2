import { runWithContext } from '../../../src/common/request-context.js';
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
