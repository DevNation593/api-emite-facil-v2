import { parseDuration } from '../../../src/config/durations.js';

describe('parseDuration', () => {
  it.each([
    ['500ms', 500],
    ['10s', 10_000],
    ['15m', 900_000],
    ['6h', 21_600_000],
    ['3d', 259_200_000],
    ['120000', 120_000],
  ])('%s -> %i ms', (value, ms) => {
    expect(parseDuration(value)).toBe(ms);
  });

  it.each(['10 s', '1w', '', 's', '-5s', '1.5s'])('rechaza %j', (value) => {
    expect(() => parseDuration(value)).toThrow();
  });
});
