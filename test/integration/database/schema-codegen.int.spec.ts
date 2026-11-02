import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { migratedDatabase } from '../../support/containers.js';

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..', '..', '..');
const codegen = path.join(root, 'node_modules', 'kysely-codegen', 'dist', 'cli', 'bin.js');

describe('src/database/schema.ts', () => {
  it('coincide con lo que genera kysely-codegen sobre una base recién migrada', async () => {
    const db = await migratedDatabase();
    const dir = await mkdtemp(path.join(tmpdir(), 'codegen-'));
    try {
      const out = path.join(dir, 'schema.ts');
      // Mismos argumentos que el script db:codegen de package.json.
      await run(process.execPath, [
        codegen,
        '--dialect', 'postgres',
        '--url', db.databaseUrl,
        '--out-file', out,
        '--exclude-pattern', 'flyway_schema_history',
        '--date-parser', 'string',
      ]);
      const generated = await readFile(out, 'utf8');
      const committed = await readFile(path.join(root, 'src', 'database', 'schema.ts'), 'utf8');
      expect(generated === committed, 'schema.ts desactualizado: ejecuta npm run db:codegen').toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await db.stop();
    }
  });
});
