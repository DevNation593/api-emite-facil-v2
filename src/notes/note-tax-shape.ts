import type { ContentShape } from '../billing/json-content.js';

/** Forma JSON de `NoteTax` (taxCode, rateCode, rate, base, amount), en el orden del record de Java. */
export const NOTE_TAX_SHAPE: ContentShape = [
  ['taxCode', 'string'],
  ['rateCode', 'string'],
  ['rate', 'decimal'],
  ['base', 'decimal'],
  ['amount', 'decimal'],
];
