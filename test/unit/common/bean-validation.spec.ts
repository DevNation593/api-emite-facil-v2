import { readFileSync } from 'node:fs';
import { validateSync } from 'class-validator';
import {
  Email,
  Max,
  Min,
  NoControlChars,
  NotBlank,
  NotNull,
  Pattern,
  Size,
} from '../../../src/common/bean-validation.js';

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
