import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  runFlyway,
  startPostgres,
  type PostgresHandle,
} from '../../support/containers.js';

// Los scripts son bash; en Windows `bash` puede ser el de WSL, sin acceso a este Docker.
describe.skipIf(process.platform === 'win32')(
  'restore.sh con currentSchema',
  () => {
    let pg: PostgresHandle;
    let dir: string;
    let dump: string;

    function script(args: string[], env: Record<string, string> = {}) {
      return spawnSync('bash', args, {
        encoding: 'utf8',
        env: {
          ...process.env,
          PGUSER: pg.container.getUsername(),
          PGPASSWORD: pg.container.getPassword(),
          PGDATABASE: pg.container.getDatabase(),
          BACKUP_CONTAINER: pg.container.getId(),
          ...env,
        },
      });
    }

    async function createDatabase(name: string): Promise<void> {
      const result = await pg.container.exec([
        'psql',
        '-U',
        pg.container.getUsername(),
        '-d',
        pg.container.getDatabase(),
        '-c',
        `CREATE DATABASE ${name}`,
      ]);
      expect(result.exitCode, result.output).toBe(0);
    }

    beforeAll(async () => {
      pg = await startPostgres();
      const migrated = await runFlyway(
        `${pg.internalUrl}?currentSchema=einvoice&sslmode=disable`,
        pg.network,
        'migrate',
      );
      expect(migrated.exitCode, migrated.output).toBe(0);
      dir = mkdtempSync(path.join(tmpdir(), 'respaldo-'));
      const backup = script(['infra/backup/backup.sh', dir]);
      expect(backup.status, backup.stderr).toBe(0);
      dump = path.join(
        dir,
        readdirSync(dir).find((f) => f.endsWith('.dump'))!,
      );
    });

    afterAll(async () => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      await pg?.stop();
    });

    it('comprueba el esquema indicado en BACKUP_SCHEMA', async () => {
      await createDatabase('restaurada');
      const restore = script(['infra/backup/restore.sh', dump, 'restaurada'], {
        BACKUP_SCHEMA: 'einvoice',
      });
      expect(restore.status, restore.stderr).toBe(0);
      expect(restore.stdout).toContain('artefactos cuya huella no coincide: 0');
      expect(restore.stdout).toMatch(/disparadores de inmutabilidad: [1-9]/);
    });

    it('no escribe sobre una base con tablas en ese esquema', () => {
      const restore = script(['infra/backup/restore.sh', dump, 'restaurada'], {
        BACKUP_SCHEMA: 'einvoice',
      });
      expect(restore.status).toBe(1);
      expect(restore.stderr).toContain('ya tiene');
    });

    it('rechaza un BACKUP_SCHEMA que no es un identificador', () => {
      const restore = script(['infra/backup/restore.sh', dump, 'restaurada'], {
        BACKUP_SCHEMA: 'a"; DROP TABLE x; --',
      });
      expect(restore.status).toBe(1);
      expect(restore.stderr).toContain('BACKUP_SCHEMA');
    });
  },
);
