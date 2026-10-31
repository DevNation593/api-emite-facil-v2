import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/app-config.js';
import { createDatabase } from '../../../src/database/database.module.js';
import { migratedDatabase } from '../../support/containers.js';
import { testEnv } from '../../support/test-env.js';

// La fecha fiscal alimenta la clave de acceso: una columna `date` debe volver como
// 'YYYY-MM-DD' exacto, sin pasar por Date (medianoche local) en ningún huso.
describe('columnas date', () => {
  let db: Awaited<ReturnType<typeof migratedDatabase>>;
  const originalTz = process.env['TZ'];
  beforeAll(async () => {
    db = await migratedDatabase();
  });
  afterAll(async () => {
    if (originalTz === undefined) delete process.env['TZ'];
    else process.env['TZ'] = originalTz;
    await db.stop();
  });

  it.each(['America/Guayaquil', 'UTC', 'Pacific/Kiritimati'])(
    'vuelve como cadena exacta con TZ=%s',
    async (tz) => {
      process.env['TZ'] = tz;
      const kysely = createDatabase(
        loadConfig({ ...testEnv, DATABASE_URL: db.databaseUrl }).database,
      );
      try {
        const { rows } = await sql<{ d: unknown; ts: unknown }>`
          SELECT DATE '2026-03-01' AS d, TIMESTAMPTZ '2026-03-01T00:00:00Z' AS ts`.execute(kysely);
        expect(rows[0]?.d).toBe('2026-03-01');
        // Los timestamp siguen llegando como Date: solo cambia el OID 1082.
        expect(rows[0]?.ts).toBeInstanceOf(Date);
      } finally {
        await kysely.destroy();
      }
    },
  );
});
