import { createHash } from 'node:crypto';
import type { Transaction } from 'kysely';
import type { DB } from '../../../src/database/schema.js';
import { mediaTypeOf, pathNameOf } from '../../../src/storage/artifact-kind.js';
import { ArtifactStore } from '../../../src/storage/artifact-store.js';
import { expectConstraintViolation, insertDocument, newScenario, type Scenario } from '../../support/billing-data.js';
import { startDb, type DbHandle } from '../../support/db-handle.js';

// Traducción de storage/ArtifactImmutabilityIT.java más las comprobaciones de ArtifactStore. El XML sin
// firmar se guarda con ArtifactStore.save (el procesador que lo genera llega en la Task 6).
const artifacts = new ArtifactStore();

let handle: DbHandle;
beforeAll(async () => {
  handle = await startDb();
}, 300_000);
afterAll(async () => {
  await handle?.stop();
});

const inTransaction = <T>(work: (trx: Transaction<DB>) => Promise<T>) => handle.db.transaction().execute(work);
const UNSIGNED = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><factura id="comprobante"/>', 'utf8');

let s: Scenario;
let document: string;
beforeEach(async () => {
  s = await newScenario(handle.pgc);
  document = await insertDocument(handle.pgc, s, 1, { state: 'GENERATED' });
  await inTransaction((trx) => artifacts.save(trx, s.tenant, document, 'XML_UNSIGNED', UNSIGNED));
});

const sha = async () => (await artifacts.find(handle.db, s.tenant, document, 'XML_UNSIGNED'))!.sha256;

it('artifactsCannotBeUpdatedDeletedOrTruncated', async () => {
  const before = await sha();
  const other = Buffer.from('<otra/>', 'utf8');

  await expectConstraintViolation(
    handle.pgc.query('UPDATE document_artifacts SET content = $1 WHERE document_id = $2', [other, document]),
  );
  await expectConstraintViolation(
    handle.pgc.query('UPDATE document_artifacts SET sha256 = $1 WHERE document_id = $2', ['0'.repeat(64), document]),
  );
  await expectConstraintViolation(handle.pgc.query('DELETE FROM document_artifacts WHERE document_id = $1', [document]));
  await expectConstraintViolation(handle.pgc.query('TRUNCATE document_artifacts'));

  expect(await sha()).toBe(before);
  expect((await artifacts.find(handle.db, s.tenant, document, 'XML_UNSIGNED'))!.content.equals(other)).toBe(false);
});

it('newKindsAreAccepted', async () => {
  const insert =
    'INSERT INTO document_artifacts (tenant_id, document_id, kind, sha256, content) VALUES ($1, $2, $3, $4, $5)';
  const content = Buffer.from('x', 'utf8');
  const hash = createHash('sha256').update(content).digest('hex');

  await handle.pgc.query(insert, [s.tenant, document, 'XML_AUTHORIZED', hash, content]);
  await handle.pgc.query(insert, [s.tenant, document, 'RIDE_PDF', hash, content]);

  expect(await artifacts.find(handle.db, s.tenant, document, 'XML_AUTHORIZED')).not.toBeNull();
  expect(await artifacts.find(handle.db, s.tenant, document, 'RIDE_PDF')).not.toBeNull();
  await expectConstraintViolation(handle.pgc.query(insert, [s.tenant, document, 'RIDE_HTML', hash, content]));
});

it('save devuelve el SHA-256 en hexadecimal minúsculo y find lo devuelve con el contenido', async () => {
  const signed = Buffer.from('<firmado/>', 'utf8');
  const hash = await inTransaction((trx) => artifacts.save(trx, s.tenant, document, 'XML_SIGNED', signed));
  expect(hash).toBe(createHash('sha256').update(signed).digest('hex'));
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  const stored = await artifacts.find(handle.db, s.tenant, document, 'XML_SIGNED');
  expect(stored).toEqual({ content: signed, sha256: hash });
  expect(await artifacts.exists(handle.db, s.tenant, document, 'XML_SIGNED')).toBe(true);
  expect(await artifacts.exists(handle.db, s.tenant, document, 'SRI_AUTHORIZATION')).toBe(false);
  expect(await artifacts.find(handle.db, s.tenant, document, 'SRI_AUTHORIZATION')).toBeNull();
});

it('un segundo artefacto del mismo tipo falla y deja el primero', async () => {
  const before = await sha();
  await expectConstraintViolation(
    inTransaction((trx) => artifacts.save(trx, s.tenant, document, 'XML_UNSIGNED', Buffer.from('<otro/>'))),
  );
  expect(await sha()).toBe(before);
  const count = await handle.pgc.query('SELECT count(*)::int AS n FROM document_artifacts WHERE document_id = $1', [
    document,
  ]);
  expect(count.rows[0]).toEqual({ n: 1 });
});

it('con la empresa de otra no se encuentra ni se puede guardar', async () => {
  const other = await newScenario(handle.pgc);
  expect(await artifacts.find(handle.db, other.tenant, document, 'XML_UNSIGNED')).toBeNull();
  expect(await artifacts.exists(handle.db, other.tenant, document, 'XML_UNSIGNED')).toBe(false);
  await expectConstraintViolation(
    inTransaction((trx) => artifacts.save(trx, other.tenant, document, 'XML_SIGNED', Buffer.from('<x/>'))),
  );
});

it('save exige una transacción', async () => {
  await expect(
    artifacts.save(handle.db as unknown as Transaction<DB>, s.tenant, document, 'XML_SIGNED', Buffer.from('<x/>')),
  ).rejects.toThrow('transacción');
});

it('cada tipo tiene su nombre en la ruta y su tipo de contenido, como ArtifactKind', () => {
  expect(pathNameOf('XML_UNSIGNED')).toBe('xml-unsigned');
  expect(pathNameOf('XML_SIGNED')).toBe('xml-signed');
  expect(pathNameOf('SRI_AUTHORIZATION')).toBe('sri-authorization');
  expect(pathNameOf('XML_AUTHORIZED')).toBe('xml-authorized');
  expect(pathNameOf('RIDE_PDF')).toBe('ride');
  expect(mediaTypeOf('XML_SIGNED')).toBe('application/xml');
  expect(mediaTypeOf('RIDE_PDF')).toBe('application/pdf');
});
