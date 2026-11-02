import { readFileSync } from 'node:fs';
import { validateSync } from 'class-validator';
import { ApiException } from '../../../src/common/api-exception.js';
import {
  Email,
  JsonList,
  JsonLocalDate,
  JsonObject,
  JsonString,
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
import { recordNumberSource } from '../../../src/common/json-source.js';
import { validationPipe } from '../../../src/common/validation.js';

// Casos generados con Hibernate Validator (tools/golden-generator, familia bean-validation).
interface Case {
  constraint: 'NotBlank' | 'NotNull' | 'Size' | 'Email' | 'NoControlChars' | 'Pattern' | 'Min' | 'Max';
  value: string | number | null;
  valid: boolean;
  message: string | null;
}
const { cases } = JSON.parse(
  readFileSync(new URL('../../golden/bean-validation.json', import.meta.url), 'utf8'),
) as { cases: Case[] };

class Bean {
  @NotBlank() notBlank?: string | null;
  @NotNull() notNull?: string | null;
  @Size({ max: 254 }) size?: string | null;
  @Email() email?: string | null;
  @NoControlChars() noControlChars?: string | null;
  @Pattern('[0-9]{3}') pattern?: string | null;
  @Min(1) min?: number | null;
  @Max(999_999_999) max?: number | null;
}

const property: Record<Case['constraint'], keyof Bean> = {
  NotBlank: 'notBlank',
  NotNull: 'notNull',
  Size: 'size',
  Email: 'email',
  NoControlChars: 'noControlChars',
  Pattern: 'pattern',
  Min: 'min',
  Max: 'max',
};

function messagesFor(constraint: Case['constraint'], value: string | number | null): string[] {
  const bean = new Bean();
  (bean as Record<string, unknown>)[property[constraint]] = value;
  return validateSync(bean)
    .filter((e) => e.property === property[constraint])
    .flatMap((e) => Object.values(e.constraints ?? {}));
}

describe('golden de Bean Validation', () => {
  it('el golden cubre las ocho restricciones', () => {
    expect(new Set(cases.map((c) => c.constraint))).toEqual(new Set(Object.keys(property)));
  });

  it.each(cases.map((c, i) => [i, c.constraint, JSON.stringify(c.value)?.slice(0, 40), c] as const))(
    '#%i %s %s',
    (_i, constraint, _label, c) => {
      const messages = messagesFor(constraint, c.value);
      expect(messages.length === 0).toBe(c.valid);
      expect(messages[0] ?? null).toBe(c.message);
    },
  );
});

describe('semántica propia de los decoradores', () => {
  it('undefined cuenta como null: solo @NotNull y @NotBlank lo rechazan', () => {
    const errors = validateSync(new Bean()).map((e) => e.property).sort();
    expect(errors).toEqual(['notBlank', 'notNull']);
  });
});

describe('listas y objetos anidados', () => {
  class Item {
    @JsonString() @NotNull() @Pattern('[0-9.]+') quantity?: string | null;
  }
  class Nested {
    @JsonString() @NotNull() number?: string | null;
    @JsonLocalDate() @NotNull() issueDate?: string | null;
  }
  class Holder {
    @JsonList(() => Item) @NotNull() @Size({ min: 1, max: 2 }) @NotNullElements() @Valid() lines?: Array<Item | null> | null;
    @JsonList(() => Item) @Valid() optional?: Array<Item | null> | null;
    @JsonObject(() => Nested) @Valid() modifiedDocument?: Nested | null;
  }

  const pipe = (body: unknown) => validationPipe.transform(body, { type: 'body', metatype: Holder });
  const errorsOf = async (body: unknown) => ((await pipe(body).catch((e: unknown) => e)) as ApiException).errors;
  const line = { quantity: '1' };

  it('Size cuenta elementos en una lista', async () => {
    expect(await errorsOf({ lines: [] })).toEqual([{ field: 'lines', message: 'size must be between 1 and 2' }]);
    expect(await errorsOf({ lines: [line, line, line] })).toEqual([
      { field: 'lines', message: 'size must be between 1 and 2' },
    ]);
  });

  it('cada elemento pasa a una instancia del tipo y conserva el texto de sus números', async () => {
    const body = JSON.parse('{"lines":[{"quantity":2.50}]}', recordNumberSource) as unknown;
    const dto = (await pipe(body)) as Holder;
    expect(dto.lines![0]).toBeInstanceOf(Item);
    expect(dto.lines![0]!.quantity).toBe('2.50');
  });

  it('un elemento null se conserva y NotNullElements lo nombra campo[i], como List<@NotNull …>', async () => {
    expect(await errorsOf({ lines: [line, null] })).toEqual([{ field: 'lines[1]', message: 'must not be null' }]);
    const dto = (await pipe({ lines: [line], optional: [null, line] })) as Holder;
    expect(dto.optional).toEqual([null, expect.any(Item)]);
  });

  it('Valid valida dentro y nombra los errores anidados como Spring', async () => {
    expect(await errorsOf({ lines: [line, { quantity: 'x' }] })).toEqual([
      { field: 'lines[1].quantity', message: 'must match "[0-9.]+"' },
    ]);
    expect(await errorsOf({ lines: [line], modifiedDocument: { issueDate: '2026-10-01' } })).toEqual([
      { field: 'modifiedDocument.number', message: 'must not be null' },
    ]);
  });

  it('Valid sobre null no valida nada, como @Valid', async () => {
    const dto = (await pipe({ lines: [line], modifiedDocument: null, optional: null })) as Holder;
    expect(dto.modifiedDocument).toBeNull();
    expect(dto.optional).toBeNull();
  });

  it('las propiedades desconocidas de un objeto anidado se descartan', async () => {
    const dto = (await pipe({ lines: [{ quantity: '1', tenantId: 'x' }], modifiedDocument: { number: '1', issueDate: '2026-10-01', extra: 1 } })) as Holder;
    expect(Object.keys(dto.lines![0]!)).toEqual(['quantity']);
    expect(dto.modifiedDocument).toBeInstanceOf(Nested);
    expect(Object.keys(dto.modifiedDocument!).sort()).toEqual(['issueDate', 'number']);
  });

  it.each([
    ['una lista que es objeto', { lines: {} }],
    ['una lista que es texto', { lines: 'x' }],
    ['una lista que es texto vacío', { lines: '' }],
    ['un elemento número', { lines: [1] }],
    ['un elemento texto', { lines: ['x'] }],
    ['un elemento lista', { lines: [[]] }],
    ['un elemento booleano', { lines: [true] }],
    ['un objeto que es lista', { lines: [line], modifiedDocument: [] }],
    ['un objeto que es texto', { lines: [line], modifiedDocument: 'x' }],
    ['un objeto que es texto vacío', { lines: [line], modifiedDocument: '' }],
    ['un objeto que es número', { lines: [line], modifiedDocument: 1 }],
  ])('%s es JSON no legible', async (_name, body) => {
    await expect(pipe(body)).rejects.toMatchObject({ status: 400, errorCode: 'MALFORMED_REQUEST' });
  });
});

describe('JsonLocalDate, LocalDate de Jackson', () => {
  class Dated {
    @JsonLocalDate() issueDate?: string | null;
  }
  const read = async (json: string) =>
    ((await validationPipe.transform(JSON.parse(`{"issueDate":${json}}`, recordNumberSource), {
      type: 'body',
      metatype: Dated,
    })) as Dated).issueDate;

  it.each([
    ['"2026-11-02"', '2026-11-02'],
    ['" 2026-11-02 "', '2026-11-02'],
    ['""', null],
    ['"   "', null],
    ['null', null],
    ['"2024-02-29"', '2024-02-29'],
    ['"2026-11-02T10:00"', '2026-11-02'],
    ['"2026-11-02T23:59:59.123456789"', '2026-11-02'],
    ['"2026-11-02T10:00:00Z"', '2026-11-02'],
    ['"+12026-01-01"', '+12026-01-01'],
    ['"-0001-12-31"', '-0001-12-31'],
    ['"0000-01-01"', '0000-01-01'],
    ['[2026,11,2]', '2026-11-02'],
    ['[]', null],
    ['0', '1970-01-01'],
    ['20000', '2024-10-04'],
    ['-1', '1969-12-31'],
    ['-719528', '0000-01-01'],
    ['2932897', '+10000-01-01'],
  ])('%s da %j', async (json, expected) => {
    expect(await read(json)).toBe(expected);
  });

  it.each([
    '"2026-11-2"',
    '"02/11/2026"',
    '"2026-02-30"',
    '"2025-02-29"',
    '"12026-01-01"',
    '"+2026-01-01"',
    '"-0000-01-01"',
    '"2026-13-01"',
    '"2026-11-02T24:00"',
    '"2026-11-02T10"',
    '"2026-11-02T10:00:00+05:00"',
    '"2026-11-02T10:00:00ZZ"',
    '"2026-11-02x"',
    '"２０２６-11-02"',
    '1.5',
    '20000.0',
    '1e3',
    'true',
    '{}',
    '[2026,11]',
    '[2026,11,2,1]',
    '[2026,13,1]',
    '[2026,2,30]',
    '[2026.0,11,2]',
    '[2026,11.0,2]',
    '["2026-11-02"]',
    '[2147483648,1,1]',
    '365241780472',
    '99999999999999999999',
  ])('%s es JSON no legible', async (json) => {
    await expect(read(json)).rejects.toMatchObject({ status: 400, errorCode: 'MALFORMED_REQUEST' });
  });
});
