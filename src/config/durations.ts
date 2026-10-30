const UNIT_MS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

/**
 * Duraciones como las lee Spring Boot en application.yml y .env.example:
 * `500ms`, `10s`, `15m`, `6h`, `3d`; un entero sin unidad son milisegundos.
 */
export function parseDuration(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(value);
  if (!match) {
    throw new Error(
      `"${value}" no es una duración válida (formas admitidas: 500ms, 10s, 15m, 6h, 3d o milisegundos)`,
    );
  }
  const unit = (match[2] ?? 'ms') as keyof typeof UNIT_MS;
  return Number(match[1]) * UNIT_MS[unit];
}
