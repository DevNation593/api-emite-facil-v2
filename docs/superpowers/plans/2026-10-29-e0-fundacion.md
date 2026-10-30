# E0 Fundación — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dejar el proyecto NestJS listo para portar módulos: arranca con la configuración de Java, migra con Flyway, habla con PostgreSQL, RabbitMQ y Redis, responde errores idénticos a Spring, expone health, y tiene los casos golden de Java y el CI en verde.

**Architecture:** Proyecto NestJS 12 en ESM con un `createApp()` que monta prefijo `/api/v1`, `correlationId`, filtro de errores `problem+json` y logs JSON. Las conexiones salen de `DATABASE_URL`, `RABBITMQ_URL` y `REDIS_URL` como en Java. Las migraciones las aplica el CLI de Flyway 12.4.0 desde un script compartido por compose, pruebas y despliegue. Un programa Java en `tools/golden-generator/` produce los casos de referencia contra las clases del repo Java.

**Tech Stack:** Node 24, TypeScript 6.0, NestJS 12.3 (Express 5), Kysely 0.29 + pg 8, ioredis 6, amqplib 2, nestjs-pino 5 / pino 10, prom-client 15, class-validator 0.15, Vitest 4, Testcontainers 12, oxlint, Flyway 12.4.0 (imagen `flyway/flyway:12.4.0`).

**Spec:** [docs/superpowers/specs/2026-10-29-api-nestjs-design.md](../specs/2026-10-29-api-nestjs-design.md)

## Global Constraints

- Referencia de comportamiento: el repo Java en `../backend-emite-facil` (rama `dev`, commit `ca53bca`). Ante cualquier duda de comportamiento manda el código Java; las rutas de archivo Java de este plan son relativas a `../backend-emite-facil/src/main/java/com/example/einvoice/`.
- Node `>=24.14 <25` en `engines`; `.nvmrc` = `24`. Proyecto ESM (`"type": "module"`), TypeScript estricto (`"strict": true`), imports relativos con extensión `.js`.
- Variables de entorno con los mismos nombres y valores por defecto que `application.yml` y `.env.example` de Java.
- Documentación, comentarios, mensajes de commit y textos al usuario en español; identificadores en inglés.
- Commits `tipo(ámbito): descripción en español`, terminados con la línea `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Rama `dev`.
- Nunca en logs, errores ni respuestas: contraseñas, contraseñas embebidas en URL, `.p12`, tokens, API keys, clave maestra, secretos de webhooks.
- Una migración copiada de Java (`V1`–`V19`) no se edita jamás.
- Las pruebas de integración necesitan Docker en marcha (Docker Desktop en Windows).
- Prefijo HTTP `/api/v1`; `/actuator/*` va en la raíz, sin prefijo.

## Review Focus

- `DATABASE_URL` o `RABBITMQ_URL` con `@`, `:` o `%` codificados en la contraseña: se decodifican bien, y ningún error de configuración repite la contraseña (Task 3).
- Redis colgado (acepta la conexión pero no responde): ninguna petición ni el health esperan más de `REDIS_TIMEOUT` (Tasks 7 y 8).
- Una factura grande (1 000 líneas, ~400 KB de JSON) no se rechaza con un 413 de Express (Task 5).
- `X-Correlation-ID` con salto de línea, espacios o 65 caracteres: se reemplaza por un UUID, nunca se refleja (Task 5).
- `SIGTERM` con una petición en curso: la petición termina, la readiness pasa a `OUT_OF_SERVICE` y el proceso sale en menos de 10 s (Task 7).

---

### Task 1: Esqueleto del proyecto

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `nest-cli.json`, `vitest.config.ts`, `.oxlintrc.json`, `.prettierrc`, `.gitignore`, `.gitattributes`, `.editorconfig`, `.nvmrc`, `AGENTS.md`
- Create: `src/main.ts`, `src/app.module.ts`, `src/bootstrap.ts`
- Test: `test/unit/bootstrap.spec.ts`

**Interfaces:**
- Produces: `createApp(options?: { imports?: ModuleMetadata['imports'] }): Promise<NestExpressApplication>` en `src/bootstrap.ts` — crea la app sin escuchar; `imports` permite a las pruebas añadir módulos con controladores de prueba. Prefijo global `api/v1` con `exclude: ['actuator/{*path}']`.
- Produces: scripts npm `build`, `start` (`node dist/main.js`), `lint`, `typecheck` (`tsc --noEmit`), `format`, `test` (unit + golden), `test:unit`, `test:golden`, `test:integration`.
- Produces: `vitest.config.ts` con tres proyectos: `unit` (`test/unit/**/*.spec.ts`), `golden` (`test/golden/**/*.spec.ts`), `integration` (`test/integration/**/*.int.spec.ts`, `testTimeout: 120_000`, `fileParallelism: false`).

- [ ] **Step 1: Crear `package.json` y configuración**

Partir de la plantilla `ts-esm` de `@nestjs/schematics` 12 (`npx @nestjs/cli@12 new` en un directorio temporal, opción ESM, y copiar). Dependencias: `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express` `^12.3.2`, `reflect-metadata`, `rxjs`. Dev: `@nestjs/cli`, `@nestjs/testing`, `typescript@^6.0.3`, `vitest@^4`, `vite@^8`, `@types/node@^24`, `supertest`, `@types/supertest`, `oxlint`, `prettier`. `.gitattributes`: `* text=auto eol=lf`, y `*.p12 binary`, `*.pdf binary`. `.gitignore`: `node_modules/`, `dist/`, `coverage/`, `.env`, `tools/golden-generator/target/`.

- [ ] **Step 2: Escribir la prueba que falla**

```ts
// test/unit/bootstrap.spec.ts
import request from 'supertest';
import { Controller, Get, Module } from '@nestjs/common';
import { createApp } from '../../src/bootstrap.js';

@Controller('ping') class PingController { @Get() ping() { return { ok: true }; } }
@Module({ controllers: [PingController] }) class PingModule {}

it('monta los controladores bajo /api/v1', async () => {
  const app = await createApp({ imports: [PingModule] });
  await app.init();
  await request(app.getHttpServer()).get('/api/v1/ping').expect(200, { ok: true });
  await app.close();
});
```

- [ ] **Step 3: Ejecutar y comprobar que falla**

Run: `npx vitest run --project unit test/unit/bootstrap.spec.ts`
Expected: FAIL (no existe `src/bootstrap.ts`).

- [ ] **Step 4: Implementar `createApp` y `main.ts`**

`main.ts` llama a `createApp()`, `enableShutdownHooks()` y `listen(port)`; en esta tarea el puerto es `process.env.SERVER_PORT ?? process.env.PORT ?? 8080` (la Task 3 lo pasa a la configuración). Si Vitest no emite metadatos de decoradores (la inyección por tipo falla con `undefined`), añadir `unplugin-swc` a `vitest.config.ts`.

- [ ] **Step 5: Ejecutar pruebas, lint, tipos y build**

Run: `npm run test:unit && npm run lint && npm run typecheck && npm run build`
Expected: todo pasa; existe `dist/main.js`.

- [ ] **Step 6: Escribir `AGENTS.md`**

Copiar `AGENTS.md` de Java y adaptar: stack Node/NestJS, estructura del repo del spec (§2), comandos (`npm ci`, `npm test`, `npm run test:integration`), y la nota de que el comportamiento de referencia es el repo Java hasta el corte. Las "Code Review Rules" se conservan íntegras, cambiando `BigDecimal` por `decimal.js` y `float`/`double` por `number`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "build: esqueleto NestJS 12 en ESM con Vitest"
```

---

### Task 2: Activos copiados del repo Java

**Files:**
- Create (copias exactas): `db/migration/V1__…sql` … `V19__…sql` ← `src/main/resources/db/migration/`; `resources/xsd/**` ← `src/main/resources/xsd/**`; `contracts/openapi.yaml`; `docs/01-…md` … `docs/15-produccion.md`, `docs/DEVELOPMENT.md`, `docs/xsd-source-registry.csv`; `SECURITY.md`; `scripts/verify_xsd_assets.py`; `infra/connection-url.sh`, `infra/postgres/roles.sql`, `infra/backup/*`, `infra/observability/prometheus-alerts.yml`
- Create: `scripts/check-java-assets.mjs`
- Test: el propio script y `python3 scripts/verify_xsd_assets.py resources/xsd`

**Interfaces:**
- Produces: `node scripts/check-java-assets.mjs <ruta-repo-java>` — compara el SHA-256 de cada archivo de `db/migration/` y `resources/xsd/` con su origen; sale con código 1 y lista las diferencias si alguno no coincide o falta.
- Produces: rutas fijas `db/migration/` y `resources/xsd/` que usan las Tasks 4 y 9 y las etapas siguientes.

- [ ] **Step 1: Escribir `scripts/check-java-assets.mjs` y ejecutarlo antes de copiar**

Run: `node scripts/check-java-assets.mjs ../backend-emite-facil`
Expected: FAIL, listando los 19 archivos de migración y los XSD como ausentes.

- [ ] **Step 2: Copiar los activos**

Copiar con `cp -r` preservando bytes (sin convertir finales de línea: `.gitattributes` de la Task 1 ya fija LF para lo nuevo; comprobar que los SQL y XSD de Java ya están en LF con `file`; si alguno está en CRLF, marcarlo `-text` en `.gitattributes` para no alterarlo). `docs/`: copiar tal cual; cada etapa adapta lo que cambie. No copiar `docs/superpowers/` de Java (es su historia y queda en el repo archivado).

- [ ] **Step 3: Verificar**

Run: `node scripts/check-java-assets.mjs ../backend-emite-facil && python3 scripts/verify_xsd_assets.py resources/xsd`
Expected: ambos terminan con código 0.

- [ ] **Step 4: Commit**

```bash
git add db resources contracts docs SECURITY.md scripts infra
git commit -m "chore: migraciones, XSD, contrato, documentación e infra copiados de la API Java"
```

---

### Task 3: Configuración

**Files:**
- Create: `src/config/connection-urls.ts`, `src/config/durations.ts`, `src/config/app-config.ts`, `src/config/config.module.ts`
- Modify: `src/main.ts`, `src/bootstrap.ts`
- Test: `test/unit/config/connection-urls.spec.ts`, `test/unit/config/durations.spec.ts`, `test/unit/config/app-config.spec.ts`

**Interfaces:**
- Produces: `parseDatabaseUrl(value: string): DatabaseConnection` con `DatabaseConnection = { host: string; port: number; database: string; user?: string; password?: string; schema: string | null; params: Record<string, string> }` (`params` sin `currentSchema`).
- Produces: `parseRabbitUrl(value: string): RabbitConnection` con `{ host; port; user?; password?; vhost: string; tls: boolean }`.
- Produces: `parseDuration(value: string): number` (milisegundos).
- Produces: `loadConfig(env: NodeJS.ProcessEnv): AppConfig` y el token de inyección `APP_CONFIG`; `ConfigModule` es global.

```ts
export interface AppConfig {
  port: number;                       // SERVER_PORT ?? PORT ?? 8080
  database: DatabaseConnection & { poolSize: number; poolMinIdle: number }; // DB_POOL_SIZE 5, DB_POOL_MIN_IDLE 1
  rabbit: RabbitConnection;
  redis: { url: string; timeoutMs: number };   // REDIS_URL redis://localhost:6379, REDIS_TIMEOUT 500ms
  workerEnabled: boolean;             // EINVOICE_WORKER_ENABLED, por defecto true
  logFormat: 'text' | 'json';         // json si LOGGING_STRUCTURED_FORMAT_CONSOLE no está vacía
  masterKey: Buffer;                  // EINVOICE_MASTER_KEY, Base64 de 32 bytes, obligatoria
  auth: { jwtSecret: string; webUrl: URL };   // EINVOICE_JWT_SECRET (>= 32 bytes UTF-8), EINVOICE_WEB_URL
  metricsToken: string | null;        // EINVOICE_METRICS_TOKEN; vacía = null
  rateLimit: { requestsPerMinute: number; writesPerMinute: number }; // 1200 / 300
  sri: { enabledEnvironments: Array<'1' | '2'> };  // SRI_ENABLED_ENVIRONMENTS, "" | "1" | "1,2"
  providerRuc: string | null;         // EINVOICE_PROVIDER_RUC; obligatorio si enabledEnvironments incluye '2'
}
```

Las reglas y mensajes de error se toman de `ConnectionUrlsEnvironmentPostProcessor.java`, `AesGcmSecretCipher.java` (constructor), `identity/AuthProperties.java`, `sri/SriProperties.java` y `observability/MetricsTokenFilter.java`. Cada etapa amplía `AppConfig` con lo suyo; aquí solo va lo que se valida al arrancar o usa E0.

- [ ] **Step 1: Escribir las pruebas que fallan**

Traducir los casos de `ConnectionUrlsEnvironmentPostProcessorTest.java` (en `src/test/java/com/example/einvoice/`) a `connection-urls.spec.ts`, más estos, con sus valores exactos:

```ts
expect(parseDatabaseUrl('postgresql://app:p%40ss%3Aw@db:6543/einvoice?sslmode=require&currentSchema=einvoice'))
  .toEqual({ host: 'db', port: 6543, database: 'einvoice', user: 'app', password: 'p@ss:w',
             schema: 'einvoice', params: { sslmode: 'require' } });
expect(parseDatabaseUrl('postgres://db/einvoice').port).toBe(5432);
expect(() => parseDatabaseUrl('postgresql://app:secreta@db:5432')).toThrow(/nombre de la base/);
expect(() => parseDatabaseUrl('mysql://app:secreta@db/x')).toThrow(/debe empezar por postgresql:\/\//);
expect(() => parseDatabaseUrl('postgresql://app:secreta@db/x?currentSchema=a,b')).toThrow(/un solo esquema/);
for (const bad of ['postgresql://app:secreta@db:99999/x', 'postgresql://app:secreta@/x', 'mysql://app:secreta@db/x'])
  expect(() => parseDatabaseUrl(bad)).toThrow(expect.not.objectContaining({ message: expect.stringContaining('secreta') }));
expect(parseRabbitUrl('amqps://u:p@mq/v%2Fh')).toEqual({ host: 'mq', port: 5671, user: 'u', password: 'p', vhost: 'v/h', tls: true });
expect(parseRabbitUrl('amqp://u:p@mq').vhost).toBe('/');
```

`durations.spec.ts`: `'500ms'→500`, `'10s'→10_000`, `'15m'→900_000`, `'6h'→21_600_000`, `'3d'→259_200_000`, `'120000'→120_000`; `'10 s'` y `'1w'` lanzan error.

`app-config.spec.ts`: valores por defecto con un entorno mínimo válido; `EINVOICE_MASTER_KEY` ausente, no Base64 o de 16 bytes → error que nombra la variable; `EINVOICE_JWT_SECRET` de 31 bytes → error; `SRI_ENABLED_ENVIRONMENTS='1,2'` sin `EINVOICE_PROVIDER_RUC` → error; `SERVER_PORT` gana a `PORT`; `EINVOICE_WORKER_ENABLED='false'` → `false`.

- [ ] **Step 2: Ejecutar y comprobar que fallan**

Run: `npx vitest run --project unit test/unit/config`
Expected: FAIL (módulos inexistentes).

- [ ] **Step 3: Implementar los cuatro archivos**

`parseDatabaseUrl` usa `new URL()` dentro de un `try` y, si falla, lanza su propio mensaje sin la URL. `ConfigModule` registra `{ provide: APP_CONFIG, useValue: loadConfig(process.env) }`; `main.ts` usa `config.port`.

- [ ] **Step 4: Ejecutar las pruebas**

Run: `npx vitest run --project unit test/unit/config`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config test/unit/config src/main.ts src/bootstrap.ts
git commit -m "feat(config): configuración con las mismas variables de entorno que la API Java"
```

---

### Task 4: Base de datos y migraciones con Flyway

**Files:**
- Create: `scripts/migrate.sh`, `src/database/database.module.ts`, `src/database/schema.ts` (generado), `test/support/containers.ts`
- Modify: `infra/connection-url.sh` (partes `host`, `port`, `query`), `infra/docker-compose.yml` (servicio `migrate`), `package.json` (scripts `migrate`, `db:codegen`; dependencias `kysely`, `pg`; dev `kysely-codegen`, `testcontainers`, `@testcontainers/postgresql`)
- Test: `test/integration/database/migrations.int.spec.ts`, `test/integration/database/schema-codegen.int.spec.ts`

**Interfaces:**
- Consumes: `AppConfig.database` (Task 3); `db/migration/` (Task 2).
- Produces: `scripts/migrate.sh <migrate|validate|info>` — corre dentro de `flyway/flyway:12.4.0`; arma `FLYWAY_URL=jdbc:postgresql://<host>:<port>/<base>?<query sin currentSchema>`, `FLYWAY_USER`/`FLYWAY_PASSWORD` desde `SPRING_FLYWAY_USER`/`SPRING_FLYWAY_PASSWORD` o, si no están, desde `DATABASE_URL`, `FLYWAY_SCHEMAS=<currentSchema>` si existe, `FLYWAY_LOCATIONS=filesystem:/flyway/sql`, y ejecuta `flyway <comando>`.
- Produces: token `DATABASE` → `Kysely<DB>` (`DB` de `src/database/schema.ts`), pool `pg` con `max: poolSize`, `idleTimeoutMillis: 120_000`, y `SET search_path TO <schema>` (identificador escapado) al conectar si hay `currentSchema`. `params.sslmode` se traduce a la opción `ssl` de `pg` (`require` → `{ rejectUnauthorized: false }`, `verify-full` → `true`, `disable` → `false`). `pg` no mantiene un mínimo de conexiones: `poolMinIdle` se acepta y se ignora (anotarlo en el README). El pool se destruye en `onApplicationShutdown`.
- Produces en `test/support/containers.ts`:
  - `startPostgres(): Promise<{ container: StartedPostgreSqlContainer; network: StartedNetwork; databaseUrl: string; internalUrl: string }>` (`postgres:16`, como `infra/docker-compose.yml`; `internalUrl` usa el alias de red para Flyway).
  - `runFlyway(internalUrl: string, network: StartedNetwork, command?: 'migrate' | 'validate' | 'info'): Promise<{ exitCode: number; output: string }>` — monta `db/migration` en `/flyway/sql` y `scripts/migrate.sh` e `infra/connection-url.sh` en `/scripts`.
  - `migratedDatabase(): Promise<{ databaseUrl: string; stop(): Promise<void> }>` — las dos anteriores juntas.

- [ ] **Step 1: Escribir la prueba que falla**

```ts
// test/integration/database/migrations.int.spec.ts
it('Flyway 12.4.0 aplica V1–V19 sobre una base vacía y valida sus checksums', async () => {
  const pg = await startPostgres();
  expect((await runFlyway(pg.internalUrl, pg.network, 'migrate')).exitCode).toBe(0);
  const rows = await query(pg.databaseUrl,
    'SELECT version, success FROM flyway_schema_history WHERE version IS NOT NULL ORDER BY installed_rank');
  expect(rows.map((r) => r.version)).toEqual(Array.from({ length: 19 }, (_, i) => String(i + 1)));
  expect(rows.every((r) => r.success)).toBe(true);
  expect((await runFlyway(pg.internalUrl, pg.network, 'validate')).exitCode).toBe(0);
});

it('con currentSchema migra y consulta en ese esquema', async () => {
  // DATABASE_URL con ?currentSchema=einvoice: las tablas quedan en einvoice y Kysely las encuentra sin calificar.
  // Comprobar con information_schema.tables que `tenants` está en `einvoice` y no en `public`,
  // y que `db.selectFrom('tenants').select('id').execute()` desde DatabaseModule devuelve [].
});

it('DatabaseModule ejecuta SELECT 1 y cierra el pool al cerrar la app', async () => { /* … */ });
```

- [ ] **Step 2: Ejecutar y comprobar que falla**

Run: `npx vitest run --project integration test/integration/database/migrations.int.spec.ts`
Expected: FAIL (no existen `containers.ts` ni `migrate.sh`).

- [ ] **Step 3: Implementar `connection-url.sh` (nuevas partes), `migrate.sh`, `containers.ts` y `DatabaseModule`**

`migrate.sh` es POSIX `sh` (la imagen de Flyway no trae bash) y nunca imprime la contraseña. Añadir a `infra/docker-compose.yml` el servicio `migrate` (`image: flyway/flyway:12.4.0`, `depends_on: postgres: condition: service_healthy`, `entrypoint: ["sh", "/scripts/migrate.sh", "migrate"]`, volúmenes de `../db/migration`, `../scripts/migrate.sh` y `./connection-url.sh`, `profiles: ["migrate"]`).

- [ ] **Step 4: Ejecutar las pruebas**

Run: `npx vitest run --project integration test/integration/database/migrations.int.spec.ts`
Expected: PASS.

- [ ] **Step 5: Generar `src/database/schema.ts` y fijar la prueba de frescura**

`db:codegen` = `kysely-codegen --dialect postgres --url "$DATABASE_URL" --out-file src/database/schema.ts --exclude-pattern flyway_schema_history`. `schema-codegen.int.spec.ts` migra una base nueva, ejecuta `kysely-codegen` a un archivo temporal y comprueba que es idéntico a `src/database/schema.ts` (mensaje de fallo: "ejecuta npm run db:codegen").

Run: `npx vitest run --project integration test/integration/database`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/migrate.sh infra src/database test/support test/integration/database package.json package-lock.json
git commit -m "feat(database): Kysely y migraciones con Flyway 12.4.0 sobre el esquema de Java"
```

---

### Task 5: Errores `problem+json` y `correlationId`

**Files:**
- Create: `src/common/api-exception.ts`, `src/common/error-codes.ts`, `src/common/problem-details.filter.ts`, `src/common/request-context.ts`, `src/common/correlation-id.middleware.ts`, `src/common/validation.ts`, `src/common/route-methods.ts`, `src/common/common.module.ts`
- Modify: `src/bootstrap.ts`
- Test: `test/unit/common/validation.spec.ts`, `test/unit/common/error-codes.spec.ts`, `test/integration/common/errors.int.spec.ts` (no necesita contenedores; va en `integration` por arrancar la app HTTP), `test/support/failing.controller.ts`

**Interfaces:**
- Produces:
  ```ts
  export class ApiException extends Error {
    constructor(status: number, errorCode: ErrorCode, detail: string,
                errors?: Array<{ field: string; message: string }>, retryAfterSeconds?: number);
    static notFound(): ApiException;   // 404 NOT_FOUND "Recurso no encontrado"
  }
  export type ErrorCode = typeof ERROR_CODES[number];   // en error-codes.ts
  export function currentCorrelationId(): string | undefined;   // request-context.ts
  export function runWithContext<T>(ctx: { correlationId: string }, fn: () => T): T;
  export function toSpringFieldPath(path: Array<string | number>): string;  // ['lines',0,'quantity'] → 'lines[0].quantity'
  export const validationPipe: ValidationPipe;   // whitelist, forbidUnknownValues false; exceptionFactory → 400 VALIDATION_FAILED
  ```
- Produces: el decorador `@AcceptsMultipart()` en `src/common/validation.ts`, que exime a un handler de la comprobación de `Content-Type` JSON; lo usará `/certificates` en E2.

Cuerpo de error exacto, con `Content-Type: application/problem+json` y cabecera `X-Correlation-ID`:

```json
{ "type": "about:blank", "title": "<http.STATUS_CODES[status]>", "status": 0, "detail": "…",
  "instance": "<ruta sin query>", "errorCode": "…", "correlationId": "…", "errors": [ … ] }
```

`errors` solo aparece si hay errores por campo. Valores por defecto (de `web/ApiExceptionHandler.java`): `400 MALFORMED_REQUEST` "La petición está mal formada"; `404 NOT_FOUND` "Recurso no encontrado"; `405 METHOD_NOT_ALLOWED`; `415 UNSUPPORTED_MEDIA_TYPE`; otro 4xx `REQUEST_REJECTED` "La petición no se pudo procesar"; 5xx `INTERNAL_ERROR` "Error interno; use el correlationId para reportarlo". JSON ilegible: `400 MALFORMED_REQUEST` "El cuerpo de la petición no es JSON válido". Validación: `400 VALIDATION_FAILED` "La petición no cumple las reglas de validación". `ERROR_CODES` es la lista del `enum` de `errorCode` del esquema `Problem` de `contracts/openapi.yaml`, más `METHOD_NOT_ALLOWED`, `UNSUPPORTED_MEDIA_TYPE`, `REQUEST_REJECTED` e `INTERNAL_ERROR` si no figuran.

`X-Correlation-ID`: se acepta el de la petición si cumple `^[A-Za-z0-9._-]{1,64}$`; si no, `randomUUID()`. Siempre se devuelve en la respuesta, también en errores. Límite del cuerpo JSON: `10mb`.

- [ ] **Step 1: Escribir las pruebas que fallan**

`test/support/failing.controller.ts` (como `FailingController.java` de las pruebas Java): `GET /api/v1/test/boom` lanza `Error`; `GET /api/v1/test/api-exception` lanza `new ApiException(422, 'WEAK_PASSWORD', 'La contraseña no es válida', [{ field: 'password', message: 'x' }], 30)`; `POST /api/v1/test/echo` recibe un DTO con `name: string` (`@IsNotEmpty`) y `lines: LineDto[]` (`@ValidateNested`, `LineDto.quantity` `@IsPositive`).

```ts
const problem = (status: number, extra: object) => expect.objectContaining({ type: 'about:blank', status, ...extra });

it('ruta inexistente', async () => {
  const res = await http.get('/api/v1/no-existe?x=1').set('X-Correlation-ID', 'abc-123');
  expect(res.status).toBe(404);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(res.body).toEqual({ type: 'about:blank', title: 'Not Found', status: 404, detail: 'Recurso no encontrado',
    instance: '/api/v1/no-existe', errorCode: 'NOT_FOUND', correlationId: 'abc-123' });
});
it('método no permitido', async () => {
  const res = await http.delete('/api/v1/test/boom');
  expect(res.status).toBe(405);
  expect(res.headers.allow).toContain('GET');
  expect(res.body).toEqual(problem(405, { errorCode: 'METHOD_NOT_ALLOWED', detail: 'La petición no se pudo procesar' }));
});
it('JSON ilegible', async () => {
  const res = await http.post('/api/v1/test/echo').set('Content-Type', 'application/json').send('{"name":');
  expect(res.body).toEqual(problem(400, { errorCode: 'MALFORMED_REQUEST', detail: 'El cuerpo de la petición no es JSON válido' }));
});
it('Content-Type no JSON', async () => {
  const res = await http.post('/api/v1/test/echo').set('Content-Type', 'text/plain').send('hola');
  expect(res.body).toEqual(problem(415, { errorCode: 'UNSUPPORTED_MEDIA_TYPE' }));
});
it('validación con rutas de campo de Spring', async () => {
  const res = await http.post('/api/v1/test/echo').send({ name: '', lines: [{ quantity: 1 }, { quantity: -1 }] });
  expect(res.body).toEqual(problem(400, { errorCode: 'VALIDATION_FAILED',
    detail: 'La petición no cumple las reglas de validación',
    errors: expect.arrayContaining([expect.objectContaining({ field: 'name' }),
                                    expect.objectContaining({ field: 'lines[1].quantity' })]) }));
});
it('ApiException con errores y Retry-After', async () => {
  const res = await http.get('/api/v1/test/api-exception');
  expect(res.status).toBe(422);
  expect(res.headers['retry-after']).toBe('30');
  expect(res.body).toEqual(problem(422, { title: 'Unprocessable Entity', errorCode: 'WEAK_PASSWORD',
    detail: 'La contraseña no es válida', errors: [{ field: 'password', message: 'x' }] }));
});
it('error inesperado no filtra la causa', async () => {
  const res = await http.get('/api/v1/test/boom');
  expect(res.body).toEqual(problem(500, { errorCode: 'INTERNAL_ERROR',
    detail: 'Error interno; use el correlationId para reportarlo' }));
  expect(JSON.stringify(res.body)).not.toMatch(/at |Error:/);
});
it.each(['a b', 'x'.repeat(65), 'a\nb', ''])('X-Correlation-ID inválido %j se reemplaza', async (value) => {
  const res = await http.get('/api/v1/no-existe').set('X-Correlation-ID', value);
  expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  expect(res.body.correlationId).toBe(res.headers['x-correlation-id']);
});
it('acepta una factura de 1 000 líneas', async () => {
  const lines = Array.from({ length: 1000 }, () => ({ quantity: 1, description: 'x'.repeat(300) }));
  await http.post('/api/v1/test/echo').send({ name: 'grande', lines }).expect(201);
});
```

`error-codes.spec.ts`: lee `contracts/openapi.yaml` (dependencia dev `yaml`) y comprueba que cada valor del `enum` de `Problem.errorCode` está en `ERROR_CODES`. `validation.spec.ts`: `toSpringFieldPath(['lines', 0, 'quantity'])` → `'lines[0].quantity'`; `toSpringFieldPath(['buyer', 'email'])` → `'buyer.email'`.

- [ ] **Step 2: Ejecutar y comprobar que fallan**

Run: `npx vitest run --project unit test/unit/common && npx vitest run --project integration test/integration/common`
Expected: FAIL.

- [ ] **Step 3: Implementar**

El 405 sale de `route-methods.ts`, que al arrancar recorre el router de Express 5 (`app.getHttpAdapter().getInstance().router.stack`) y construye `ruta → métodos`; el manejador de "no encontrado" consulta esa tabla para decidir entre 404 y 405 y fijar `Allow`. El 415 lo produce un guard global: en `POST`/`PUT`/`PATCH` con cuerpo (`content-length > 0` o `transfer-encoding`) y `Content-Type` que no es `application/json` (ni `+json`), salvo handlers con `@AcceptsMultipart()`. La causa de un 500 se registra con `logger.error` (Task 6 la formatea).

- [ ] **Step 4: Ejecutar las pruebas**

Run: `npx vitest run --project unit test/unit/common && npx vitest run --project integration test/integration/common`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/common src/bootstrap.ts test package.json package-lock.json
git commit -m "feat(common): errores problem+json idénticos a Spring y X-Correlation-ID"
```

---

### Task 6: Logs JSON con `severity`

**Files:**
- Create: `src/observability/logging.ts`
- Modify: `src/bootstrap.ts`, `package.json` (`nestjs-pino`, `pino`, `pino-http`, `pino-pretty`)
- Test: `test/unit/observability/logging.spec.ts`

**Interfaces:**
- Consumes: `AppConfig.logFormat` (Task 3), `currentCorrelationId()` (Task 5).
- Produces: `severityOf(level: string): 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR'` y `createPinoLogger(config: AppConfig, destination?: DestinationStream): pino.Logger`; `createApp` pasa esa instancia a `nestjs-pino` (`LoggerModule.forRoot({ pinoHttp: { logger } })`). Todo el código usa el `Logger` de `@nestjs/common`, que queda conectado a pino.

Formato JSON de cada línea: `@timestamp` (ISO), `severity`, `message`, `logger_name` (contexto de Nest), `correlationId` (si hay petición en curso), y para errores `stack_trace`. Rutas censuradas: `req.headers.authorization`, `req.headers.cookie`, `req.headers["x-api-key"]`, `*.password`, `*.p12`, `*.secret`, `*.token`, `*.masterKey`. Formato texto: `pino-pretty` sin colores, una línea por registro, con el `correlationId` entre corchetes como en Java (`[%X{correlationId:-}]`).

- [ ] **Step 1: Escribir la prueba que falla**

```ts
it.each([['fatal','ERROR'],['error','ERROR'],['warn','WARNING'],['info','INFO'],['debug','DEBUG'],['trace','DEBUG']])
  ('%s → %s', (level, severity) => expect(severityOf(level)).toBe(severity));

it('cada línea JSON lleva severity, message y correlationId, y censura secretos', async () => {
  const lines: string[] = [];
  const logger = createPinoLogger({ ...testConfig, logFormat: 'json' }, { write: (l: string) => lines.push(l) });
  runWithContext({ correlationId: 'c-1' }, () => logger.warn({ password: 'secreta', token: 't0k3n' }, 'hola'));
  const entry = JSON.parse(lines[0]);
  expect(entry).toMatchObject({ severity: 'WARNING', message: 'hola', correlationId: 'c-1' });
  expect(entry['@timestamp']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(lines[0]).not.toMatch(/secreta|t0k3n/);
});
```

- [ ] **Step 2: Ejecutar y comprobar que falla**

Run: `npx vitest run --project unit test/unit/observability/logging.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar `logging.ts` y conectarlo en `createApp`**

`correlationId` se añade con `mixin()` de pino leyendo `currentCorrelationId()`. `pino-http` no registra cada petición (`autoLogging: false`), igual que Java.

- [ ] **Step 4: Ejecutar las pruebas (unit y la de errores de la Task 5)**

Run: `npx vitest run --project unit test/unit/observability && npx vitest run --project integration test/integration/common`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/observability src/bootstrap.ts test/unit/observability package.json package-lock.json
git commit -m "feat(observability): logs JSON con severity y correlationId"
```

---

### Task 7: Redis, RabbitMQ y health

**Files:**
- Create: `src/infrastructure/redis.module.ts`, `src/infrastructure/rabbit.module.ts`, `src/observability/health.controller.ts`, `src/observability/health.ts`, `src/observability/lifecycle.ts`
- Modify: `src/app.module.ts`, `src/main.ts`, `test/support/containers.ts` (`startRabbit()`, `startRedis()`, `startStack()`), `package.json` (`ioredis`, `amqplib`, `@types/amqplib`, `@testcontainers/rabbitmq`, `@testcontainers/redis`)
- Test: `test/unit/observability/health.spec.ts`, `test/integration/observability/health.int.spec.ts`, `test/integration/observability/shutdown.int.spec.ts`

**Interfaces:**
- Consumes: `AppConfig.redis`, `AppConfig.rabbit` (Task 3), `DATABASE` (Task 4).
- Produces: token `REDIS` → `Redis` de ioredis con `connectTimeout` y `commandTimeout` = `redis.timeoutMs`, `enableOfflineQueue: false`, `maxRetriesPerRequest: 1`.
- Produces: `RabbitConnection` (clase inyectable) con `channel(): Promise<ConfirmChannel>`, `isOpen(): boolean` y reconexión con espera creciente (1 s → 30 s) si se pierde la conexión. La topología la declara E4.
- Produces: `readiness: { markReady(): void; markOutOfService(): void; state(): 'UP' | 'OUT_OF_SERVICE' }` y `gracefulShutdown(app: INestApplication, timeoutMs = 8_000): Promise<void>` en `lifecycle.ts`; `main.ts` llama a `gracefulShutdown` al recibir `SIGTERM` o `SIGINT` y luego sale del proceso.
- Produces: `startStack(): Promise<{ databaseUrl; rabbitUrl; redisUrl; stop(): Promise<void>; containers: {…} }>` en `test/support/containers.ts` (PostgreSQL migrado + RabbitMQ `rabbitmq:4-management` + Redis `redis:7-alpine`, como el compose).

Respuestas (las de Spring Boot Actuator con `show-details: never` y probes activadas):

| Ruta | Bien | Mal |
| --- | --- | --- |
| `GET /actuator/health` | `200 {"status":"UP","groups":["liveness","readiness"]}` | `503 {"status":"DOWN","groups":["liveness","readiness"]}` si falla `SELECT 1`, la conexión a RabbitMQ o el `PING` a Redis |
| `GET /actuator/health/liveness` | `200 {"status":"UP"}` | — (solo depende de que el proceso responda) |
| `GET /actuator/health/readiness` | `200 {"status":"UP"}` | `503 {"status":"OUT_OF_SERVICE"}` tras `SIGTERM` |

`Content-Type: application/vnd.spring-boot.actuator.v3+json` (como Actuator). Cada comprobación tiene su propio plazo (`redis.timeoutMs` para Redis, 2 s para la base y RabbitMQ) y se ejecutan en paralelo. Cierre: al recibir `SIGTERM`, readiness pasa a `OUT_OF_SERVICE`, el servidor deja de aceptar conexiones, espera a las peticiones en curso hasta 8 s (`timeout-per-shutdown-phase` de Java) y cierra pool, Redis y RabbitMQ.

- [ ] **Step 1: Escribir las pruebas que fallan**

`health.spec.ts` (unitaria, con comprobaciones falsas): todas bien → UP; una lanza → DOWN; una tarda más que su plazo → DOWN en menos de plazo + 100 ms.

```ts
// health.int.spec.ts
it('UP con la pila real y DOWN al parar Redis, sin colgarse', async () => {
  await http.get('/actuator/health').expect(200, { status: 'UP', groups: ['liveness', 'readiness'] });
  await stack.containers.redis.stop();
  const started = Date.now();
  await http.get('/actuator/health').expect(503, { status: 'DOWN', groups: ['liveness', 'readiness'] });
  expect(Date.now() - started).toBeLessThan(2_500);
  await http.get('/actuator/health/liveness').expect(200, { status: 'UP' });
});
it('Redis colgado (acepta y no contesta) no cuelga el health', async () => {
  // REDIS_URL apunta a un net.Server local que acepta conexiones y nunca responde; REDIS_TIMEOUT=500ms.
  // Esperado: 503 DOWN en menos de 2 s.
});
it('las rutas de actuator no llevan el prefijo /api/v1', async () => {
  await http.get('/api/v1/actuator/health').expect(404);
});
```

```ts
// shutdown.int.spec.ts
it('gracefulShutdown deja terminar la petición en curso y pone readiness en OUT_OF_SERVICE', async () => {
  // App en proceso con createApp({ imports: [SlowModule] }) — GET /api/v1/test/slow tarda 3 s — escuchando en un puerto libre.
  // Lanzar la petición lenta, esperar 100 ms y llamar a gracefulShutdown(app) sin await.
  // Esperado: la petición lenta responde 200; /actuator/health/readiness, pedida durante el cierre por una
  // conexión ya abierta, da 503 {"status":"OUT_OF_SERVICE"}; una conexión nueva tras el cierre es rechazada;
  // gracefulShutdown resuelve en menos de 5 s.
});
it('node dist/main.js sale con código 0 en menos de 10 s tras SIGTERM', async () => {
  // Proceso hijo contra la pila de pruebas; esperar a readiness UP, enviar SIGTERM, medir hasta 'exit'.
  // En Windows, child.kill('SIGTERM') termina el proceso sin señal: marcar esta prueba con it.skipIf(process.platform === 'win32').
});
```

- [ ] **Step 2: Ejecutar y comprobar que fallan**

Run: `npm run build && npx vitest run --project unit test/unit/observability/health.spec.ts && npx vitest run --project integration test/integration/observability`
Expected: FAIL.

- [ ] **Step 3: Implementar módulos, health y cierre ordenado**

`main.ts` marca `readiness.markReady()` después de `listen()` y registra el manejador de `SIGTERM`/`SIGINT` que aplica el orden de cierre descrito.

- [ ] **Step 4: Ejecutar las pruebas**

Run: `npm run build && npx vitest run --project unit test/unit/observability && npx vitest run --project integration test/integration/observability`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test package.json package-lock.json
git commit -m "feat(observability): health de Actuator con PostgreSQL, RabbitMQ y Redis, y cierre ordenado"
```

---

### Task 8: Límite de peticiones en Redis

**Files:**
- Create: `src/common/rate-limiter.ts`, `src/observability/metrics.ts`
- Test: `test/unit/common/rate-limiter.spec.ts`, `test/integration/common/rate-limiter.int.spec.ts`

**Interfaces:**
- Consumes: `REDIS` (Task 7), `AppConfig.rateLimit` (Task 3).
- Produces: token `METRICS_REGISTRY` → `Registry` de prom-client (el endpoint `/actuator/prometheus` llega en E6).
- Produces:
  ```ts
  export class RateLimiter {
    constructor(redis: Redis, limits: AppConfig['rateLimit'], registry: Registry, clock?: () => number);
    check(subject: string, write: boolean): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  }
  ```
  El guard que lo aplica al usuario autenticado se escribe en E1.

Comportamiento (de `web/RateLimiter.java`): ventana de 60 s; claves `einvoice:rl:w:<d>:<ventana>` y `einvoice:rl:r:<d>:<ventana>` con `<d>` = primeros 16 bytes del SHA-256 del sujeto en hex minúscula (32 caracteres) y `<ventana>` = `floor(segundos / 60)`; `INCR` y, si devuelve 1, `EXPIRE 120`; una escritura que supera `writesPerMinute` se rechaza sin contar en el cupo general; luego se compara `r:` con `requestsPerMinute`; `retryAfterSeconds = 60 - segundos % 60`. Si Redis falla: se deja pasar, se incrementa el contador `einvoice_ratelimit_unavailable_total` y durante 10 s no se vuelve a consultar Redis (cada petición pasa y suma al contador).

- [ ] **Step 1: Escribir las pruebas que fallan**

Traducir `RateLimiterTest.java` a `rate-limiter.spec.ts` con un Redis falso en memoria y reloj fijo, incluyendo: la escritura 301 se rechaza con `retryAfterSeconds` correcto y no gasta cupo de lectura; la lectura 1201 se rechaza; Redis que lanza → `allowed: true`, contador +1, y durante los 10 s siguientes no se llama a Redis; a los 10 s se vuelve a llamar.

`rate-limiter.int.spec.ts` con Redis real: tras un `check('usuario-1', true)` existen exactamente las claves `einvoice:rl:w:<d>:<v>` y `einvoice:rl:r:<d>:<v>` con TTL entre 1 y 120, y `<d>` es `sha256('usuario-1')` truncado a 32 caracteres hex; con un Redis colgado y `REDIS_TIMEOUT=500ms`, `check` resuelve `allowed: true` en menos de 1 s.

- [ ] **Step 2: Ejecutar y comprobar que fallan**

Run: `npx vitest run --project unit test/unit/common/rate-limiter.spec.ts && npx vitest run --project integration test/integration/common/rate-limiter.int.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar `RateLimiter` y `METRICS_REGISTRY`**

- [ ] **Step 4: Ejecutar las pruebas**

Run: el mismo comando del Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/common/rate-limiter.ts src/observability/metrics.ts test
git commit -m "feat(common): límite de peticiones en Redis con las mismas claves que Java"
```

---

### Task 9: Generador de casos golden

**Files:**
- Create: `tools/golden-generator/src/golden/GoldenGenerator.java` y una clase por familia (`AccessKeyCases.java`, `AesGcmCases.java`, `Argon2Cases.java`, `JwtCases.java`, `ApiKeyCases.java`, `XadesCases.java`), `tools/golden-generator/run.mjs`, `tools/golden-generator/README.md`
- Create (generados y versionados): `test/golden/SOURCE.json`, `test/golden/access-key.json`, `test/golden/aes-gcm.json`, `test/golden/argon2.json`, `test/golden/jwt.json`, `test/golden/api-key.json`, `test/golden/xades/certificado-prueba.p12`, `test/golden/xades/<caso>/{unsigned.xml,signed.xml,meta.json}`
- Test: `test/golden/golden-files.spec.ts`

**Interfaces:**
- Produces: `node tools/golden-generator/run.mjs --java-repo <ruta>`: en el repo Java ejecuta `mvnw -q -DskipTests -Djacoco.skip=true test-compile` y `mvnw -q dependency:build-classpath -Dmdep.includeScope=test -Dmdep.outputFile=<tmp>`; compila `tools/golden-generator/src` con `javac` contra `target/classes`, `target/test-classes` y ese classpath (separador `path.delimiter`); lo ejecuta con la salida en `test/golden/`. No modifica nada en el repo Java.
- Produces (formato que consumen E1–E4; todo binario en Base64):
  - `SOURCE.json`: `{ javaRepoCommit, javaVersion, generatedAt }`.
  - `access-key.json`: `{ cases: [{ issueDate: 'YYYY-MM-DD', documentType, ruc, environment, establishment, emissionPoint, sequence: number, numericCode, emissionType, base48, accessKey }], validity: [{ key, valid: boolean }] }` — al menos 50 casos con semilla fija, incluidos casos cuyo módulo 11 da 10 y 11, y en `validity` claves válidas, con un dígito cambiado, de 48 y 50 dígitos y con letras. Fuente: `sequence/AccessKeyParts.java`, `sequence/AccessKey.java`.
  - `aes-gcm.json`: `{ masterKey, cases: [{ context: string, plaintext, ciphertext }] }` — contextos `certificate|<uuid>|<uuid>|<uuid>|p12`, `…|password` (de `CertificateService.secretContext`) y el de `WebhookSubscriptionService.secretContext`; textos de 1 byte, 32 bytes y un `.p12` real. Fuente: `certificate/AesGcmSecretCipher.java`.
  - `argon2.json`: `{ cases: [{ password, hash }] }` — incluye 12 y 128 caracteres, tildes, ñ y un emoji. Fuente: `identity/Passwords.java`.
  - `jwt.json`: `{ secret, issuer, audience, cases: [{ userId, sessionId, email, emailVerified, issuedAtEpochSeconds, ttlSeconds: 900, token }] }` — emitidos con `AccessTokens.issue` y un `InstantSource` fijo. Fuente: `identity/AccessTokens.java`.
  - `api-key.json`: `{ cases: [{ value, publicId, secretHash }] }` de `ApiKeyCredential.generate()`.
  - `xades/<caso>/meta.json`: `{ signingTime: ISO-8601 con -05:00, p12: 'certificado-prueba.p12', p12Password }`; `unsigned.xml` de `InvoiceXmlBuilder.build(…)`; `signed.xml` de `new XadesBesSigner().sign(unsigned, material, signingTime)`. Casos: `factura-estandar` (`InvoiceXmlFixtures.standard()`) y `factura-con-ruc-proveedor` (`InvoiceXmlFixtures.builder()` con `providerRuc = "1790012345001"`). El `.p12` es `TestCertificates.valid()` con su contraseña `clave-de-prueba-p12`. Antes de escribir, el generador comprueba con `new XadesVerifier().verify(signed)` que la firma es válida y aborta si no.

Los identificadores aleatorios de la firma (`Signature<n>`, `…-SignedProperties<n>`…) y los de AES, Argon2 y JWT no necesitan ser reproducibles: las pruebas de Node los leen del resultado esperado y los inyectan (spec §6).

- [ ] **Step 1: Escribir la prueba que falla**

```ts
// test/golden/golden-files.spec.ts
const read = (f: string) => JSON.parse(readFileSync(new URL(f, import.meta.url), 'utf8'));
it('access-key: 50+ casos y claves de 49 dígitos', () => {
  const { cases, validity } = read('./access-key.json');
  expect(cases.length).toBeGreaterThanOrEqual(50);
  for (const c of cases) { expect(c.base48).toMatch(/^\d{48}$/); expect(c.accessKey).toBe(c.base48 + c.accessKey.at(-1)); }
  expect(validity.some((v: { valid: boolean }) => !v.valid)).toBe(true);
});
it('xades: cada caso tiene XML sin firmar, firmado y metadatos', () => {
  for (const name of ['factura-estandar', 'factura-con-ruc-proveedor']) {
    const signed = readFileSync(new URL(`./xades/${name}/signed.xml`, import.meta.url), 'utf8');
    expect(signed).toContain('<ds:Signature');
    expect(signed).toContain('xades:SignedProperties');
  }
});
// …y una comprobación de forma por cada archivo del Interfaces block.
```

- [ ] **Step 2: Ejecutar y comprobar que falla**

Run: `npm run test:golden`
Expected: FAIL (no existen los archivos).

- [ ] **Step 3: Implementar el generador y `run.mjs`**

Comprobar los nombres reales de los métodos usados (`InvoiceXmlFixtures.builder()…`, `Pkcs12Inspector.inspect(p12, password, now)`, `AccessTokens(AuthProperties, InstantSource)`) en el repo Java antes de escribir cada familia.

- [ ] **Step 4: Generar y verificar**

Run: `node tools/golden-generator/run.mjs --java-repo ../backend-emite-facil && npm run test:golden`
Expected: el generador termina con código 0 y la prueba pasa.

- [ ] **Step 5: Commit**

```bash
git add tools/golden-generator test/golden
git commit -m "test(golden): casos de referencia generados con la API Java"
```

---

### Task 10: CI, imagen y README

**Files:**
- Create: `.github/workflows/ci.yml`, `Dockerfile`, `.dockerignore`, `README.md`, `.env.example`
- Test: el propio CI y `docker build`

**Interfaces:**
- Consumes: scripts npm de la Task 1, `scripts/verify_xsd_assets.py` (Task 2).

CI (`on: push, pull_request`, `permissions: contents: read`):
- `api`: `actions/setup-node@v6` con Node 24 y caché npm; `npm ci`, `npm run lint`, `npm run typecheck`, `npm run test:unit`, `npm run test:golden`, `npm run test:integration` (Docker del runner), `npm audit --omit=dev --audit-level=high`.
- `xsd-assets`: `python3 scripts/verify_xsd_assets.py resources/xsd`.
- `image`: `docker build -t einvoice-api:ci .` y `test "$(docker run --rm --entrypoint id einvoice-api:ci -u)" != "0"` (como el job de Java).
- El job `e2e` de Java no se copia aún: llega en E7.

`Dockerfile`: dos etapas sobre `node:24-bookworm-slim`; la primera `npm ci && npm run build`; la final copia `dist/`, `package*.json`, `resources/`, `contracts/`, hace `npm ci --omit=dev`, `ENV NODE_ENV=production LOGGING_STRUCTURED_FORMAT_CONSOLE=logstash`, `USER node`, `EXPOSE 8080`, `CMD ["node", "dist/main.js"]`. `.env.example`: copia del de Java (mismas variables).

README: qué es este repo (reemplazo 1:1 de la API Java, estado por etapa), cómo arrancar en local (`docker compose --env-file .env -f infra/docker-compose.yml up -d`, `docker compose … --profile migrate run --rm migrate`, `npm ci`, `npm run start`), cómo probar (unit, golden, integración con Docker en marcha) y enlace al spec y al plan.

- [ ] **Step 1: Escribir `Dockerfile`, `.dockerignore`, `.env.example`, `ci.yml` y `README.md`**

- [ ] **Step 2: Verificar la imagen en local**

Run: `docker build -t einvoice-api:ci . && docker run --rm --entrypoint id einvoice-api:ci -u`
Expected: build correcto; imprime un uid distinto de `0`.

- [ ] **Step 3: Verificar la suite completa en local**

Run: `npm run lint && npm run typecheck && npm test && npm run test:integration && npm audit --omit=dev --audit-level=high`
Expected: todo pasa.

- [ ] **Step 4: Arranque manual contra el compose**

Run: con `.env` local, `docker compose --env-file .env -f infra/docker-compose.yml up -d`, `docker compose --env-file .env -f infra/docker-compose.yml --profile migrate run --rm migrate`, `npm run build && node --env-file=.env dist/main.js`, y en otra terminal `curl -s localhost:8080/actuator/health`.
Expected: `{"status":"UP","groups":["liveness","readiness"]}`.

- [ ] **Step 5: Commit**

```bash
git add .github Dockerfile .dockerignore .env.example README.md
git commit -m "ci: lint, tipos, pruebas, auditoría, XSD e imagen sin root"
```
