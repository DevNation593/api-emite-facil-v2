import { retryDelayMs } from '../../../src/orchestration/retry-policy.js';

// Traducción de orchestration/RetryPolicyTest.java.
const BASE = 15_000;
const MAX = 3_600_000;

it('growsExponentiallyUpToTheMaximum', () => {
  const expectedSeconds = [15, 30, 60, 120, 240, 480, 960, 1920, 3600, 3600];
  expectedSeconds.forEach((seconds, index) => {
    expect(retryDelayMs(index + 1, BASE, MAX, 0.5), `intento ${index + 1}`).toBe(seconds * 1000);
  });
  expect(retryDelayMs(1000, BASE, MAX, 0.5)).toBe(MAX);
  expect(retryDelayMs(0, BASE, MAX, 0.5)).toBe(BASE);
});

/** Tiempo total que se insiste con un máximo de intentos dado, con las esperas más cortas posibles. */
function shortestHorizon(maxAttempts: number): number {
  let total = 0;
  for (let attempt = 1; attempt < maxAttempts; attempt++) total += retryDelayMs(attempt, BASE, MAX, 0);
  return total;
}

it('defaultAttemptsCoverTheDayTheSriMayTake', () => {
  // Valor por defecto de SRI_RETRY_MAX.
  expect(shortestHorizon(40)).toBeGreaterThan(24 * 3_600_000);
  // Con 30, el valor inicial, no se llegaba.
  expect(shortestHorizon(30)).toBeLessThan(24 * 3_600_000);
});

it('jitterStaysWithinTwentyPercent', () => {
  expect(retryDelayMs(1, BASE, MAX, 0)).toBe(12_000);
  const high = retryDelayMs(1, BASE, MAX, 0.999);
  expect(high).toBeGreaterThan(17_900);
  expect(high).toBeLessThan(18_000);
  expect(retryDelayMs(20, BASE, MAX, 0.999)).toBeLessThan(72 * 60_000);
});

it('no desborda: una base enorme con muchas duplicaciones se queda en el máximo', () => {
  expect(retryDelayMs(39, 2 ** 40, 2 ** 50, 0.5)).toBe(2 ** 50);
  expect(retryDelayMs(64, 1, MAX, 0.5)).toBe(MAX);
});
