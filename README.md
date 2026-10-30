# Facturación electrónica Ecuador — API NestJS (api-emite-facil-v2)

Reemplazo 1:1 de la API Java/Spring Boot de facturación electrónica del SRI de Ecuador, reescrita en NestJS 12 (Express 5) con TypeScript estricto. Mantiene el mismo contrato HTTP (`contracts/openapi.yaml`), el mismo esquema de base de datos (`db/migration`, V1–V19 copiadas de Java), las mismas variables de entorno y el mismo comportamiento: manda el código Java.

> **Estado: etapa E0 (fundación) del plan.** Hay configuración por entorno, base de datos (Kysely + PostgreSQL), conexiones a RabbitMQ y Redis, límite de peticiones, observabilidad (`/actuator/*`, métricas) y pruebas golden generadas con la API Java. Los módulos de negocio llegan en las etapas siguientes. **La API Java sigue siendo la que está en producción hasta el cambio definitivo (etapa E7).**

- Diseño: [docs/superpowers/specs/2026-10-29-api-nestjs-design.md](docs/superpowers/specs/2026-10-29-api-nestjs-design.md)
- Plan de la etapa E0: [docs/superpowers/plans/2026-10-29-e0-fundacion.md](docs/superpowers/plans/2026-10-29-e0-fundacion.md)

## Requisitos

- Node `>=24.14 <25` (ver `.nvmrc`) y npm.
- Docker (Docker Desktop en Windows): para la infraestructura local y para las pruebas de integración.

## Arranque en local

1. Copiar `.env.example` a `.env` (no se versiona) y reemplazar cada `change-me`. Además de lo que trae activo, la API exige `EINVOICE_MASTER_KEY` (32 bytes en Base64: `openssl rand -base64 32`) y `EINVOICE_JWT_SECRET` (al menos 32 bytes).
2. Levantar PostgreSQL, RabbitMQ y Redis:

   ```bash
   docker compose --env-file .env -f infra/docker-compose.yml up -d
   ```

3. Aplicar las migraciones con Flyway:

   ```bash
   docker compose --env-file .env -f infra/docker-compose.yml --profile migrate run --rm migrate
   # o, con las mismas variables del entorno: npm run migrate
   ```

   Flyway corre dentro de la red de compose, donde `localhost` es el propio contenedor y la base se llama `postgres`. Por eso, si `DATABASE_URL` apunta a `localhost`, hay que definir `MIGRATE_DATABASE_URL` con la misma URL pero con el host `postgres` (por ejemplo `postgresql://app:change-me@postgres:5432/einvoice`). Sin ella se usa `DATABASE_URL` y la migración no llega a la base.

4. Compilar y arrancar:

   ```bash
   npm ci
   npm run build
   node --env-file=.env dist/main.js   # o npm run start con las variables ya exportadas
   ```

   Comprobación: `curl -s localhost:8080/actuator/health` devuelve `{"status":"UP","groups":["liveness","readiness"]}`.

### Notas de operación

- **Readiness:** `/actuator/health/readiness` responde 200 solo cuando el servidor ya está escuchando (`main.ts` lo marca como listo); antes responde 503.
- **`DB_POOL_MIN_IDLE`** se acepta por compatibilidad con Java pero se ignora: `pg` no mantiene un mínimo de conexiones inactivas.
- La configuración es solo por variables de entorno (sin archivos). Nunca se registran contraseñas, tokens, claves ni certificados.

## Pruebas

| Comando | Qué corre |
| --- | --- |
| `npm run lint` / `npm run typecheck` | oxlint (con tipos) y `tsc --noEmit` |
| `npm run test:unit` | pruebas unitarias |
| `npm run test:golden` | casos de referencia versionados en `test/golden` (no necesitan Java) |
| `npm test` | unitarias y golden |
| `npm run test:integration` | PostgreSQL, RabbitMQ y Redis reales con Testcontainers: **necesita Docker en marcha**. Compilar antes (`npm run build`): la prueba de SIGTERM arranca `dist/main.js` (se omite en Windows) |

Los casos golden se regeneran solo con el repo Java presente: `node tools/golden-generator/run.mjs --java-repo <ruta>`. El CI no los regenera.

## Imagen

```bash
docker build -t einvoice-api .
```

Dos etapas sobre `node:24-bookworm-slim`; la final solo lleva `dist/`, las dependencias de producción, `resources/` y `contracts/`, y corre como el usuario `node` (sin root). Escucha en `PORT` (8080 por defecto).

## CI

`.github/workflows/ci.yml`: `api` (lint, tipos, unitarias, golden, integración, `npm audit`), `xsd-assets` (verifica los XSD) e `image` (construye y comprueba que no corre como root).
