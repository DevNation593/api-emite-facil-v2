import { readFileSync } from 'node:fs';
import { ApiException } from '../../../src/common/api-exception.js';
import { IntQueryPipe, RequiredUuidQueryPipe, StringQueryPipe } from '../../../src/common/query-params.js';
import { UuidPipe } from '../../../src/common/uuid.pipe.js';

// Respuestas de la API Java (tools/java-probe, test/golden/http/e2.json).
interface Result {
  name: string;
  request: { path: string; query?: string };
  status: number;
  body: { page?: number; size?: number; detail?: string; errorCode?: string } | unknown[];
}
const { results } = JSON.parse(
  readFileSync(new URL('../../golden/http/e2.json', import.meta.url), 'utf8'),
) as { results: Result[] };

const MALFORMED = 'La petición está mal formada';

/** Lo que Express entrega en req.query: un texto, o una lista si el parámetro se repite. */
function queryValue(query: string, name: string): string | string[] | undefined {
  const values = new URLSearchParams(query).getAll(name);
  if (values.length === 0) return undefined;
  return values.length === 1 ? values[0] : values;
}

function malformed(run: () => unknown): void {
  try {
    run();
    expect.unreachable();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiException);
    expect(e).toMatchObject({ status: 400, errorCode: 'MALFORMED_REQUEST', detail: MALFORMED });
  }
}

describe('IntQueryPipe, como la conversión de Spring', () => {
  const cases = results.filter(
    (r) => r.request.path === '/api/v1/customers' && /^(page|size)=/.test(r.request.query ?? '') && !r.request.query!.includes('&q'),
  );

  it('el golden trae los casos de page y size', () => {
    expect(cases.length).toBeGreaterThan(20);
  });

  it.each(cases.map((r) => [r.name, r] as const))('%s', (_name, r) => {
    const name = r.request.query!.startsWith('size') ? 'size' : 'page';
    const pipe = new IntQueryPipe(name === 'size' ? 20 : 0);
    const value = queryValue(r.request.query!, name);
    const body = r.body as { page?: number; size?: number; detail?: string };
    if (r.status === 200) {
      expect(pipe.transform(value)).toBe(body[name]);
    } else if (body.detail === MALFORMED) {
      malformed(() => pipe.transform(value));
    } else {
      // Se convierte; el rango lo rechaza pageRequest.
      const parsed = pipe.transform(value);
      expect(parsed < 0 || parsed > (name === 'size' ? 100 : 100_000) || parsed === 0).toBe(true);
    }
  });
});

describe('StringQueryPipe', () => {
  const pipe = new StringQueryPipe('');

  it('sin valor da el predeterminado', () => {
    expect(pipe.transform(undefined)).toBe('');
  });

  it('repetido se une con comas, como la conversión de String[] a String', () => {
    expect(pipe.transform(['Cliente', 'Sondeo'])).toBe('Cliente,Sondeo');
  });

  it('un texto pasa tal cual', () => {
    expect(pipe.transform(' a ')).toBe(' a ');
  });
});

describe('RequiredUuidQueryPipe, como StringToUUIDConverter', () => {
  const pipe = new RequiredUuidQueryPipe();
  const cases = results.filter((r) => r.request.path === '/api/v1/emission-points' && r.name.startsWith('emission points'));

  it.each(cases.map((r) => [r.name, r] as const))('%s', (_name, r) => {
    const id = '0b427a9f-d598-4668-ba21-787c34379f5f';
    const query = (r.request.query ?? '')
      .replaceAll('{establishmentIdUpper}', id.toUpperCase())
      .replaceAll('{establishmentId}', id);
    const value = queryValue(query, 'establishmentId');
    if (r.status === 400) {
      malformed(() => pipe.transform(value));
    } else {
      expect(pipe.transform(value)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  it('devuelve la forma canónica en minúsculas', () => {
    expect(pipe.transform(' 1-2-3-4-5 ')).toBe('00000001-0002-0003-0004-000000000005');
  });
});

describe('UuidPipe de ruta, como StringToUUIDConverter', () => {
  const pipe = new UuidPipe();
  const cases = results.filter((r) => /^GET \/customers\/id |^GET \/api\/v1\/customers\/x$/.test(r.name));

  it.each(cases.map((r) => [r.name, r] as const))('%s', (_name, r) => {
    const raw = decodeURIComponent(r.request.path.slice('/api/v1/customers/'.length)).replace(
      '{customerId}',
      '0b427a9f-d598-4668-ba21-787c34379f5f',
    );
    if (r.status === 400) malformed(() => pipe.transform(raw));
    else expect(pipe.transform(raw)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
