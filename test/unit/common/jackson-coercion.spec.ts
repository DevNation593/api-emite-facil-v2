import { readFileSync } from 'node:fs';
import type { ArgumentMetadata } from '@nestjs/common';
import { ApiException } from '../../../src/common/api-exception.js';
import {
  JsonBoolean,
  JsonEnum,
  JsonInteger,
  JsonUuid,
  Max,
  Min,
  NotNull,
} from '../../../src/common/bean-validation.js';
import { validationPipe } from '../../../src/common/validation.js';

// Cada caso de cuerpo de test/golden/http/e2.json se pasa por el pipe de validación con un DTO que
// solo tiene el campo sondeado, y el resultado se compara con lo que respondió Java.
interface Result {
  name: string;
  request: { body?: Record<string, unknown>; rawBody?: string };
  status: number;
  body: Record<string, unknown> & { errorCode?: string; detail?: string; errors?: unknown[] };
}
const { results } = JSON.parse(
  readFileSync(new URL('../../golden/http/e2.json', import.meta.url), 'utf8'),
) as { results: Result[] };

const NOT_JSON = 'El cuerpo de la petición no es JSON válido';
const ID = '0b427a9f-d598-4668-ba21-787c34379f5f';

class FlagsDto {
  @JsonBoolean() accountingRequired?: boolean | null;
  @JsonEnum(['NONE', 'EMPRENDEDOR', 'NEGOCIO_POPULAR']) rimpeRegime?: string | null;
}

class SequenceDto {
  @JsonInteger() @NotNull() @Min(1) @Max(999_999_999) nextValue?: number | null;
}

class PointDto {
  @JsonUuid() @NotNull() establishmentId?: string | null;
}

async function run(metatype: ArgumentMetadata['metatype'], body: unknown): Promise<unknown> {
  return validationPipe.transform(body, { type: 'body', metatype });
}

function sent(r: Result): Record<string, unknown> {
  const body = r.request.rawBody !== undefined ? JSON.parse(r.request.rawBody) : r.request.body;
  // El escenario sustituye los marcadores; aquí basta un UUID cualquiera.
  return JSON.parse(
    JSON.stringify(body)
      .replaceAll('{{establishmentId}}', `{${ID}}`)
      .replaceAll('{establishmentIdUpper}', ID.toUpperCase())
      .replaceAll('{establishmentIdNoDash}', ID.replaceAll('-', ''))
      .replaceAll('{establishmentId}', ID),
  ) as Record<string, unknown>;
}

async function expectLikeJava(
  r: Result,
  metatype: ArgumentMetadata['metatype'],
  field: string,
  expected: (dto: Record<string, unknown>) => void,
): Promise<void> {
  const input = { [field]: sent(r)[field] };
  if (r.status === 400 && r.body.detail === NOT_JSON) {
    await expect(run(metatype, input)).rejects.toMatchObject({
      status: 400,
      errorCode: 'MALFORMED_REQUEST',
      detail: NOT_JSON,
    });
    return;
  }
  const errors = (r.body.errors ?? []) as Array<{ field: string }>;
  const own = errors.filter((e) => e.field === field);
  if (r.status === 400 && own.length > 0) {
    const error = (await run(metatype, input).catch((e: unknown) => e)) as ApiException;
    expect(error).toBeInstanceOf(ApiException);
    expect(error.errors).toEqual(own);
    return;
  }
  expected((await run(metatype, input)) as Record<string, unknown>);
}

const named = (prefix: string) =>
  results.filter((r) => r.name.startsWith(prefix)).map((r) => [r.name, r] as const);

describe('accountingRequired, Boolean de Jackson', () => {
  it.each(named('taxpayer accountingRequired'))('%s', async (_n, r) => {
    await expectLikeJava(r, FlagsDto, 'accountingRequired', (dto) => {
      if (r.status === 201) expect(dto.accountingRequired ?? false).toBe(r.body.accountingRequired);
    });
  });
});

describe('rimpeRegime, enum de Jackson', () => {
  it.each(named('taxpayer rimpeRegime'))('%s', async (_n, r) => {
    await expectLikeJava(r, FlagsDto, 'rimpeRegime', (dto) => {
      if (r.status === 201) expect(dto.rimpeRegime ?? 'NONE').toBe(r.body.rimpeRegime);
      if (r.status === 422) expect(dto.rimpeRegime).toBe('NEGOCIO_POPULAR');
    });
  });
});

describe('nextValue, Integer de Jackson', () => {
  it.each(named('sequence nextValue'))('%s', async (_n, r) => {
    await expectLikeJava(r, SequenceDto, 'nextValue', (dto) => {
      expect(dto.nextValue).toBe(r.body.nextValue);
    });
  });
});

describe('establishmentId, UUID de Jackson', () => {
  it.each(named('emission point establishmentId'))('%s', async (_n, r) => {
    await expectLikeJava(r, PointDto, 'establishmentId', (dto) => {
      if (r.status === 201) expect(dto.establishmentId).toBe(ID);
      else expect(dto.establishmentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  });
});
