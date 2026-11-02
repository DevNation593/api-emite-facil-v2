import { DateTime } from 'luxon';

export const FISCAL_ZONE = 'America/Guayaquil';

/** La fecha de emisión es la fecha local de Ecuador, no la del instante en UTC (YYYY-MM-DD). */
export function fiscalDateOf(instant: Date): string {
  return DateTime.fromJSDate(instant, { zone: FISCAL_ZONE }).toISODate()!;
}
