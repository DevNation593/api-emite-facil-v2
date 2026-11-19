/*
 * Espera entre reintentos (ante el SRI o al entregar), como orchestration/RetryPolicy.java: se duplica en
 * cada intento hasta un máximo, con una variación de ±20 % para que los reintentos no coincidan.
 */

const JITTER = 0.2;

/**
 * @param attempt número del intento que acaba de fallar, desde 1
 * @param jitter01 valor en [0, 1) que elige la variación: 0 da un 20 % menos y casi 1 un 20 % más
 */
export function retryDelayMs(attempt: number, baseMs: number, maxMs: number, jitter01: number): number {
  const doublings = Math.max(0, attempt - 1);
  let millis = maxMs;
  // Más de 40 duplicaciones desbordan cualquier base razonable: ya es el máximo. El desplazamiento se hace
  // en 64 bits con signo, como el `long` de Java, para descartar igual que allí un resultado desbordado.
  if (doublings < 40) {
    const base = BigInt(baseMs);
    const candidate = BigInt.asIntN(64, base << BigInt(doublings));
    if (candidate > 0n && candidate >> BigInt(doublings) === base) {
      millis = Math.min(Number(candidate), maxMs);
    }
  }
  const factor = 1 - JITTER + 2 * JITTER * jitter01;
  // Math.round de Java (redondeo hacia arriba en .5), que en positivos coincide con el de JavaScript.
  return Math.round(millis * factor);
}
