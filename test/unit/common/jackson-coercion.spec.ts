import { readFileSync } from 'node:fs';
import type { ArgumentMetadata } from '@nestjs/common';
import { IssueInvoiceDto, PaymentDto } from '../../../src/billing/invoice.dto.js';
import { ApiException } from '../../../src/common/api-exception.js';
import {
  JsonBoolean,
  JsonEnum,
  JsonInteger,
  JsonList,
  JsonLocalDate,
  JsonObject,
  JsonString,
  JsonUuid,
  Max,
  Min,
  NoControlChars,
  NotBlank,
  NotNull,
  NotNullElements,
  Pattern,
  Size,
  Valid,
} from '../../../src/common/bean-validation.js';
import { AMOUNT } from '../../../src/common/decimals.js';
import { recordNumberSource } from '../../../src/common/json-source.js';
import { validationPipe } from '../../../src/common/validation.js';
import { IssueCreditNoteDto, ModifiedDocumentDto } from '../../../src/notes/credit-note.dto.js';

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

/** El cuerpo leído como lo lee el parser de la API, con el texto original de cada número. */
function sent(r: Result): Record<string, unknown> {
  const text = r.request.rawBody ?? JSON.stringify(r.request.body);
  // El escenario sustituye los marcadores; aquí basta un UUID cualquiera.
  return JSON.parse(
    text
      .replaceAll('{{establishmentId}}', `{${ID}}`)
      .replaceAll('{establishmentIdUpper}', ID.toUpperCase())
      .replaceAll('{establishmentIdNoDash}', ID.replaceAll('-', ''))
      .replaceAll('{establishmentId}', ID),
    recordNumberSource,
  ) as Record<string, unknown>;
}

async function expectLikeJava(
  r: Result,
  metatype: ArgumentMetadata['metatype'],
  field: string,
  expected: (dto: Record<string, unknown>) => void,
): Promise<void> {
  // El cuerpo entero, no una copia del campo: el texto de los números va ligado a su objeto.
  const input = sent(r);
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

/*
 * E3: cada caso de cuerpo de test/golden/http/e3.json se pasa por el pipe con el DTO de la factura
 * (invoice.dto.ts), con el de la nota de crédito (credit-note.dto.ts) y con un DTO que copia el record
 * de DebitNoteController de Java. Lo que decide la deserialización o Bean Validation (400 MALFORMED_REQUEST, y
 * VALIDATION_FAILED con mensajes de Hibernate) debe salir igual; el resto (reglas de negocio: 202, 401, 404, 409, 422 o un
 * VALIDATION_FAILED propio de Java) debe pasar el pipe, y ahí se comprueba el valor convertido.
 */
const e3 = (
  JSON.parse(readFileSync(new URL('../../golden/http/e3.json', import.meta.url), 'utf8')) as {
    results: Array<Result & { request: { method: string; path: string } }>;
  }
).results;

class ReasonRequest {
  @JsonString() @NotBlank() @Size({ max: 300 }) @NoControlChars() reason?: string | null;
  @JsonString() @NotNull() @Pattern(AMOUNT) value?: string | null;
  @JsonString() @NotNull() @Pattern('[0-9]{1,4}') ivaRateCode?: string | null;
}

class IssueDebitNoteRequest {
  @JsonUuid() @NotNull() taxpayerId?: string | null;
  @JsonString() @NotNull() @Pattern('[0-9]{3}') establishmentCode?: string | null;
  @JsonString() @NotNull() @Pattern('[0-9]{3}') emissionPointCode?: string | null;
  @JsonLocalDate() issueDate?: string | null;
  @JsonUuid() invoiceId?: string | null;
  @JsonObject(() => ModifiedDocumentDto) @Valid() modifiedDocument?: ModifiedDocumentDto | null;
  @JsonUuid() customerId?: string | null;
  @JsonList(() => ReasonRequest) @NotNull() @Size({ min: 1, max: 20 }) @NotNullElements() @Valid()
  reasons?: Array<ReasonRequest | null> | null;
  @JsonList(() => PaymentDto) @NotNull() @Size({ min: 1, max: 1 }) @NotNullElements() @Valid()
  payments?: Array<PaymentDto | null> | null;
}

const DTO: Record<string, ArgumentMetadata['metatype']> = {
  '/api/v1/invoices': IssueInvoiceDto,
  '/api/v1/credit-notes': IssueCreditNoteDto,
  '/api/v1/debit-notes': IssueDebitNoteRequest,
};

// El día de los marcadores {today…}: cualquiera sirve, el golden los conserva sin resolver.
const TODAY = '2026-11-02';
const IDS: Record<string, string> = {
  taxpayerId: '11111111-1111-4111-8111-111111111111',
  customerId: '22222222-2222-4222-8222-222222222222',
  productId: '33333333-3333-4333-8333-333333333333',
  invoiceId: '44444444-4444-4444-8444-444444444444',
};

function e3Body(r: Result): unknown {
  const text = r.request.rawBody ?? JSON.stringify(r.request.body);
  if (text === '' || text === undefined) return undefined;
  const resolved = text
    .replaceAll('{todayYear}', '2026')
    .replaceAll('{todayMonth}', '11')
    .replaceAll('{todayDay}', '2')
    .replaceAll('{todayMinus1}', '2026-11-01')
    .replaceAll('{todayPlus1}', '2026-11-03')
    .replaceAll('{today}', TODAY)
    .replaceAll(/\{(\w+?)(Upper|NoDash)?\}/g, (_m, name: string, variant?: string) => {
      const id = IDS[name] ?? '55555555-5555-4555-8555-555555555555';
      if (variant === 'Upper') return id.toUpperCase();
      if (variant === 'NoDash') return id.replaceAll('-', '');
      return id;
    });
  return JSON.parse(resolved, recordNumberSource) as unknown;
}

type FieldError = { field: string; message: string };
const BEAN_MESSAGE = /^(must |size must )/;
const key = (e: FieldError) => `${e.field}\u0000${e.message}`;
const sorted = (errors: FieldError[]) => [...errors].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

const bodyCases = e3
  .filter((r) => r.request.method === 'POST' && DTO[r.request.path] !== undefined)
  // Un 415 (otro Content-Type) y un JSON ilegible no llegan al pipe: los resuelve json-body.ts.
  .filter((r) => r.status !== 415 && !['{', '{"taxpayerId":'].includes(r.request.rawBody ?? ''))
  .map((r) => [r.name, r] as const);

/** Lo que el pipe deja en el DTO cuando Java aceptó el valor (se deduce del nombre del caso). */
function expectConverted(name: string, dto: Record<string, any>): void {
  const date = /issueDate (\w+)$/.exec(name)?.[1];
  if (date !== undefined) {
    const modified = name.includes('modifiedDocument issueDate');
    const expected: Record<string, string | null> = modified
      ? { numero: '2024-10-04', arreglo: '2026-10-01', futura: '2099-01-01' }
      : {
          conHora: TODAY,
          vacia: null,
          nula: null,
          arreglo: TODAY,
          numero: '2024-10-04',
          anterior: '2026-11-01',
          futura: '2026-11-03',
          muyFutura: '2099-01-01',
        };
    expect(date in expected).toBe(true);
    expect(modified ? dto.modifiedDocument.issueDate : dto.issueDate).toBe(expected[date]);
  }
  const lineNo = /invoiceLineNo (\w+)$/.exec(name)?.[1];
  if (lineNo !== undefined) {
    const expected: Record<string, number | null> = { cero: 0, negativo: -1, inexistente: 99, nulo: null };
    expect(dto.lines[0].invoiceLineNo).toBe(lineNo in expected ? expected[lineNo] : 1);
  }
  const number = /(lines|payments|reasons) (\w+) (?:número (\w+)|cadena con ceros)$/.exec(name);
  if (number !== null) {
    const [, list, field, kind] = number;
    const expected: Record<string, string> = { dos: '2', dosCincuenta: '2.50', dieciochoDigitos: '123456789012.123456' };
    expect(dto[list!][0][field!]).toBe(kind === undefined ? '007' : expected[kind]);
  }
}

describe('cuerpos de E3, como Jackson y Bean Validation', () => {
  it('el golden trae los casos de cuerpo de las tres emisiones', () => {
    expect(bodyCases.length).toBeGreaterThan(300);
  });

  it.each(bodyCases)('%s', async (name, r) => {
    const metatype = DTO[r.request.path];
    const input = e3Body(r);
    if (r.status === 400 && r.body.errorCode === 'MALFORMED_REQUEST') {
      expect(r.body.detail).toBe(NOT_JSON);
      await expect(run(metatype, input)).rejects.toMatchObject({
        status: 400,
        errorCode: 'MALFORMED_REQUEST',
        detail: NOT_JSON,
      });
      return;
    }
    const errors = (r.body.errors ?? []) as FieldError[];
    if (r.status === 400 && r.body.errorCode === 'VALIDATION_FAILED' && errors.every((e) => BEAN_MESSAGE.test(e.message))) {
      const error = (await run(metatype, input).catch((e: unknown) => e)) as ApiException;
      expect(error).toBeInstanceOf(ApiException);
      expect(error.errorCode).toBe('VALIDATION_FAILED');
      expect(sorted(error.errors)).toEqual(sorted(errors));
      return;
    }
    expectConverted(name, (await run(metatype, input)) as Record<string, any>);
  });
});
