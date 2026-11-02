# Diseño — API de emisión de comprobantes electrónicos en NestJS (api-emite-facil-v2)

**Fecha:** 2026-10-29
**Estado:** propuesto, pendiente de revisión
**Origen:** API Java/Spring Boot `backend-emite-facil` (repo `api-emite-facil`, rama `dev` al 2026-10-29, último commit `ca53bca`)

## 1. Propósito y alcance

Reemplazar **1:1** la API Java de facturación electrónica para Ecuador por una implementación en NestJS, sin que la aplicación web (`client-factura-facil`) ni los datos existentes noten el cambio.

### Lo que decidió el responsable del producto

| Tema | Decisión |
| --- | --- |
| Objetivo | Reemplazo 1:1: mismo contrato HTTP (`contracts/openapi.yaml`); la web no cambia |
| Base de datos | El mismo esquema PostgreSQL y los datos existentes |
| Transición | Corte directo: Java se apaga cuando NestJS cubre todo; nunca corren a la vez sobre la misma base |
| Infraestructura | La misma: PostgreSQL, RabbitMQ (con outbox) y Redis |
| Criterio de hecho | La suite e2e actual pasa sin cambios en sus `*.spec.ts`, cada respuesta cumple `openapi.yaml` y las pruebas de integración críticas de Java están traducidas a Jest |
| Repositorio | `api-emite-facil-v2` contiene todo lo del API: código, `contracts/`, `infra/`, `docs/`, `e2e/`. El repo Java se archiva tras el corte |
| Enfoque | Traducción fiel por módulos y por etapas, validando lo fiscal byte a byte contra Java |

### Supuestos (confirmados al aprobar el diseño)

- Todo lo que Java escribió sigue siendo válido tras el corte: contraseñas, sesiones y JWT vivos, `.p12` cifrados, API keys, secretos de webhooks y artefactos.
- Las migraciones siguen siendo de Flyway; la base ya tiene `flyway_schema_history` y lo nuevo entra como `V20+`.
- Una sola imagen para API y worker, distinguidos por `EINVOICE_WORKER_ENABLED`.
- Los nombres de las variables de entorno no cambian (`DATABASE_URL`, `RABBITMQ_URL`, `REDIS_URL`, `EINVOICE_*`, `SRI_*`…); la lista completa sale de `application.yml` y `.env.example` de Java.
- Se conservan las convenciones de `AGENTS.md`: documentación, comentarios, commits y textos al usuario en español; identificadores en inglés; commits `tipo(ámbito): descripción`; ramas `dev` → `qa` → `main`; las reglas P0/P1 de revisión siguen vigentes.

### Corrección respecto a la documentación de Java

El README de Java nombra S3/MinIO, pero **no se usa**: los artefactos (XML, RIDE, respuestas del SRI) viven en `document_artifacts.content` (bytea) en PostgreSQL. NestJS hace lo mismo.

### Fuera de alcance

- Mover artefactos a almacenamiento de objetos.
- Nuevos tipos de comprobante (retención, guía de remisión, liquidación de compra).
- Cualquier cambio del contrato HTTP, del esquema o del comportamiento observable.
- Convivencia de Java y NestJS sobre la misma base.

Cada uno de estos, si se quiere, va en su propio diseño después del corte.

## 2. Arquitectura

### Forma general

Un proyecto NestJS con dos modos de ejecución sobre la misma imagen, como hoy:

- `EINVOICE_WORKER_ENABLED=false`: solo HTTP.
- `EINVOICE_WORKER_ENABLED=true`: HTTP más consumidores de RabbitMQ y tareas programadas (relay del outbox, avance de comprobantes, recogida de atrasados, entrega, webhooks, purgas, integridad de artefactos, métricas operativas).

Los consumidores y tareas viven en módulos que `AppModule` solo importa en modo worker (módulo dinámico), de modo que una instancia de API no puede procesar colas.

### Módulos

Uno por módulo Java, con las mismas fronteras y responsabilidades: `tenancy`, `identity`, `apikey`, `taxpayer`, `catalog`, `sequence`, `billing`, `notes`, `xml`, `signature`, `certificate`, `sri`, `orchestration`, `storage`, `delivery`, `webhook`, `compliance`, `observability`, y `common` (lo que en Java es `web`: errores, paginación, `correlationId`, límite de peticiones, utilidades de texto y decimales). Un módulo expone servicios a otros; no lee las tablas de otro módulo.

### Correspondencia Spring → NestJS

| Java (Spring) | NestJS |
| --- | --- |
| `@RestController`, prefijo `/api/v1` | `@Controller` con `setGlobalPrefix('api/v1')` |
| Spring Security, `UserIdentityResolver`, `TenantAccessResolver` | Un middleware entre el de correlación y el del cuerpo hace la autenticación (JWT o API key) y el límite de peticiones: reproduce el orden "401 primero" de Java y no parsea cuerpos sin autenticar. Empresa activa y rol, en guards. El 415 pasa a un interceptor en E1 |
| `ApiExceptionHandler` | Filtro de excepciones global (sección 5) |
| Bean Validation | `ValidationPipe` + DTO con `class-validator`, mismos mensajes y mismos nombres de campo |
| `@Transactional` | Transacción Kysely explícita; los servicios que en Java exigen `Propagation.MANDATORY` reciben la transacción como parámetro obligatorio |
| `JdbcClient` / JPA | Kysely; tipos generados de la base con `kysely-codegen` |
| `@Scheduled` | `@nestjs/schedule` |
| Spring AMQP | `amqplib` con la misma topología (sección 4) |
| Spring Data Redis | `ioredis` |
| Actuator / Micrometer | `/actuator/health` y `/actuator/prometheus` en las mismas rutas, mismos nombres de métricas (`prom-client`), mismo token de métricas |
| `CorrelationIdFilter` | Middleware con `AsyncLocalStorage` |

### Stack

- Node 24 LTS (soportado hasta abril de 2028; es el del CI actual de la e2e), TypeScript 6 en modo estricto, NestJS 12 y npm. NestJS 12 se publica como ESM, así que el proyecto es ESM (`"type": "module"`) y las pruebas usan **Vitest**, como la plantilla oficial de Nest 12 para ESM. Donde este documento dice "Jest", léase Vitest.
- Dinero y cantidades: `decimal.js` en todo el código fiscal; `number` está prohibido para importes (regla P1 de `AGENTS.md`). Una regla de lint lo vigila en los módulos `billing`, `notes`, `xml`, `catalog`.
- Fechas: Luxon; la fecha fiscal se calcula en `America/Guayaquil`, como `FiscalClock`.

### Estructura del repositorio

```text
src/<módulo>/              código NestJS por módulo
src/main.ts                arranque (API o API+worker)
db/migration/              V1…V19 copiados sin cambios; lo nuevo como V20+
resources/xsd/             XSD y XML de ejemplo, con docs/xsd-source-registry.csv
contracts/openapi.yaml     copiado sin cambios
test/unit/                 pruebas unitarias
test/integration/          pruebas con Testcontainers
test/golden/               casos generados con Java (JSON y binarios) y sus pruebas
tools/golden-generator/    programa Java que produce test/golden/ a partir del código Java
e2e/                       suite Playwright; solo cambia el arranque de la API
infra/ docs/ scripts/      copiados y adaptados a Node
```

### Migraciones

Las aplica el CLI oficial de Flyway (imagen Docker), como paso previo al arranque en `infra/`, en CI y en las pruebas de integración. Así `flyway_schema_history` es la misma tabla antes y después del corte y no hay conversión. Una migración publicada no se edita.

## 3. Compatibilidad de datos

Regla: **lo que Java escribió, NestJS lo lee igual; lo que NestJS escribe, Java lo habría leído igual.**

| Dato | Formato que se conserva | En Node |
| --- | --- | --- |
| Contraseñas | Argon2id PHC, parámetros de `Argon2PasswordEncoder.defaultsForSpringSecurity_v5_8()` (m=16384, t=2, p=1, sal 16, hash 32); longitud 12–128 puntos de código; no igual al correo; comparación contra un hash señuelo si la cuenta no existe | `argon2` |
| JWT de acceso | HS256 con `EINVOICE_JWT_SECRET`, mismo `iss` y `aud`, `sub`=usuario, `jti`, `sid`, `email`, `email_verified`, misma duración | `jose` |
| Tokens de renovación, verificación y recuperación | SHA-256 en hex minúscula | `crypto` |
| API keys | `efk_<publicId 12>_<secreto 43 base64url>`; se guarda SHA-256 hex del secreto; comparación en tiempo constante; mismo patrón de validación | `crypto` |
| `.p12`, su contraseña, secretos de webhook | AES-256-GCM en sobre: versión (1) \| IV envoltura (12) \| clave de datos envuelta (48) \| IV datos (12) \| datos+etiqueta; clave maestra `einvoice.crypto.master-key` (Base64, 32 bytes); AAD `certificate\|<tenant>\|<taxpayer>\|<cert>\|p12` o `…\|password`, y el de webhooks igual que `WebhookSubscriptionService.secretContext` | `crypto` |
| `content` de comprobantes (JSON) | Todo decimal como **cadena** con su escala; campo desconocido al leer = error; mismo orden y nombres de propiedades | Serializador propio sobre `decimal.js` |
| Outbox | Tabla `outbox_events`, mismo `event_type` y `payload` | Kysely |
| Mensajes RabbitMQ | Mismos exchanges (`fiscal.events`, `fiscal.dlx`), colas (`document.issue`, `document.deliver`, `webhook.deliver` y sus `.dlq`), claves de enrutamiento y cuerpos | `amqplib` |
| Artefactos | `document_artifacts` con SHA-256 hex, solo inserción, uno por tipo y documento | Kysely, `bytea` |
| Redis | Mismas claves y ventanas de `AuthAttemptLimiter` y `RateLimiter`; si Redis falla se deja pasar y se registra | `ioredis` |
| Fechas | `timestamptz` en UTC | Luxon |

Se conservan sin cambios: migraciones V1–V19, nombres de tablas y columnas, disparadores de solo inserción y roles de `infra/postgres/roles.sql`.

### Concurrencia y transacciones

Las consultas SQL de Java se trasladan casi literalmente a Kysely: `SELECT … FOR UPDATE` en secuenciales y comprobantes, comprobante + evento de outbox en la misma transacción, mismos `ON CONFLICT` de idempotencia, mismo control por `version`.

## 4. Flujo de emisión

Es el de `docs/05-electronic-document-flow.md` de Java, sin cambios de comportamiento.

### Petición (`POST /invoices`, `/credit-notes`, `/debit-notes`), una transacción

Guard → `Idempotency-Key` obligatoria → validación del DTO → cálculo (`decimal.js`, HALF_UP, escala del XSD) → bloqueo del secuencial (`FOR UPDATE`) → clave de acceso (módulo 11) → generación y validación XSD del XML **con el secuencial aún bloqueado** → inserción en `RESERVED` con líneas, totales, pagos, evento de estado, auditoría, registro de idempotencia y `DOCUMENT_RESERVED` en `outbox_events` → commit. Si algo falla no queda nada. Los tres tipos comparten el camino del modelo genérico (`DocumentKind`); cada tipo aporta cálculo, XML y RIDE.

### Worker (`DocumentPipeline.advance`), reentrante y con bloqueo del comprobante

Camino normal: `RESERVED → GENERATED → SIGNED → SENDING → RECEIVED → AUTHORIZED`.
Fallos: `XSD_INVALID`, `SIGNATURE_FAILED`, `RETURNED`, `NOT_AUTHORIZED`.
Artefactos: `XML_UNSIGNED`, `XML_SIGNED`, `SRI_AUTHORIZATION` (y los de entrega).
Cada llamada al SRI queda en `sri_attempts` con el estado literal.

### Reglas que impiden duplicados (P0)

- Ninguna llamada SOAP dentro de una transacción: registrar intento → confirmar → llamar → aplicar resultado en otra transacción comprobando `version`.
- Recepción sin respuesta clara (timeout, corte, 5xx, ilegible): el comprobante sigue en `SENDING`; el siguiente avance consulta la autorización por clave y solo si el SRI no la conoce vuelve a `SIGNED` y reenvía **el mismo XML**. La clave de acceso nunca cambia.
- `DEVUELTA` con código 43 o 70 se trata como recibida.
- `RECIBIDA` no es `AUTORIZADO`.
- `SRI_ENABLED_ENVIRONMENTS` vacío: no se transmite; el comprobante queda en `SIGNED`.
- Reintentos con `RetryPolicy` (duplica hasta un máximo, ±20 %); `DueDocumentScheduler` recoge lo atrasado.

### Después de `AUTHORIZED`

Evento a `document.deliver` → RIDE y XML autorizado → archivo → correo. La entrega tiene estado propio (`PENDING`, `SENDING`, `SENT`, `FAILED`) y no toca el estado fiscal. Los webhooks salen por `webhook.deliver` en `RECEIVED`, `AUTHORIZED`, `RETURNED`, `NOT_AUTHORIZED` y entrega; van firmados, como mucho dos a la vez por empresa, sin seguir redirecciones, sin leer el cuerpo de la respuesta y comprobando antes de cada llamada que la dirección es pública.

### Piezas técnicas

| Pieza | Java | Node |
| --- | --- | --- |
| Firma XAdES-BES | `XadesBesSigner` a mano sobre XMLDSig del JDK (Anexo 14) | Port directo: `node-forge` (PKCS#12, RSA-SHA1, certificado), `xml-crypto` (C14N), estructura XAdES escrita a mano |
| Verificación de firma | `XadesVerifier` | Port directo |
| Validación XSD | `XsdValidator` + `ClasspathSchemaResolver` | `xmllint-wasm` con XSD y `xmldsig-core-schema.xsd` precargados; sin red |
| Reglas fuera del XSD | `EnvelopeRules`, `DocumentXmlCheck` | Port directo |
| Parser XML | `SecureXml` (sin `DOCTYPE` ni entidades) | Parser que rechaza `DOCTYPE` y entidades antes de procesar |
| SOAP SRI | `SriSoapRequests`, `HttpSriGateway`, `SriResponseParser` | Mismas plantillas, `fetch` con timeouts, port del parser |
| RIDE | OpenPDF, `RideLayout` | `pdfkit` + `bwip-js` (Code 128), mismo diseño |
| Correo | Spring Mail | `nodemailer`, misma configuración SMTP |

## 5. Errores, logs y seguridad

### Cuerpo de error

El mismo `ProblemDetail` (RFC 9457) que produce Spring, con `Content-Type: application/problem+json`:

```json
{
  "type": "about:blank",
  "title": "Unprocessable Content",
  "status": 422,
  "detail": "…",
  "instance": "/api/v1/…",
  "errorCode": "…",
  "correlationId": "…",
  "errors": [{ "field": "lines[0].quantity", "message": "…" }]
}
```

- `ApiException` en TypeScript: estado, `errorCode`, detalle, errores por campo y `Retry-After`.
- Validación: `400 VALIDATION_FAILED`, con nombres de campo en la notación de Spring (`lines[0].quantity`).
- JSON ilegible: `400 MALFORMED_REQUEST`. Inesperado: `500 INTERNAL_ERROR`, causa solo en el log.
- Por defecto, mismos códigos y detalles que `defaultErrorCode`/`defaultDetail` de Java (404, 405…).
- Los `errorCode` de negocio se extraen del código Java a un catálogo en `common`.
- Un recurso de otra empresa da `404`; autenticación no revela si existe un correo o una API key.

### Logs

JSON con `severity` (como `CloudLoggingSeverity`), `correlationId` y `documentId`. Nunca: `.p12`, contraseñas, tokens, API keys completas, secretos de webhooks, clave maestra ni XML completos.

### Seguridad

Las reglas P0/P1 de `AGENTS.md` y los límites aceptados de `SECURITY.md` y `docs/10-security.md` de Java se copian y aplican igual. `tenantId` nunca sale del cuerpo, la ruta ni un mensaje sin comprobarlo contra el usuario o la API key autenticados.

## 6. Pruebas

### Capa 1 — Golden contra Java (`test/golden/`)

`tools/golden-generator/` es un programa Java que se compila contra las clases del repo Java (`backend-emite-facil/target/classes` y sus dependencias) **sin modificar ese repo**. Con hora congelada y aleatorios fijos (por reflexión si una clase no permite inyectarlos) produce entradas y resultados exactos, que se guardan en `test/golden/` y se versionan, de modo que siguen disponibles tras archivar Java. Usa un certificado de prueba autofirmado generado para ello.

Casos:

- Clave de acceso y dígito verificador.
- Cálculo de impuestos, redondeos y prorrateo de notas de crédito.
- XML sin firmar de factura, nota de crédito y nota de débito.
- Firma XAdES-BES completa (RSA PKCS#1 v1.5 es determinista: mismo `SignedInfo` → misma firma).
- AES-GCM: NestJS descifra blobs cifrados por Java y, con la misma clave de datos e IV fijos, cifra produciendo los mismos bytes (lo que prueba que Java leería lo que escribe NestJS).
- Argon2id: NestJS verifica hashes generados por Java y, con la misma sal, produce el mismo hash.
- JWT: NestJS valida tokens emitidos por Java, y un token emitido por NestJS con los mismos datos tiene la misma cabecera y los mismos claims (el orden de las propiedades JSON no se exige: no afecta a la verificación).
- JSON de `content` de los tres tipos.
- Cuerpos SOAP y parseo de respuestas del SRI.
- Firma de webhooks.

### Capa 2 — Unitarias (Jest)

Se traducen las unitarias de Java: `AccessKeyTest`, `AccessKeyPartsTest`, `TaxRoundingTest`, `DebitNoteCalculatorTest`, `RetryPolicyTest`, `WebhookUrlPolicyTest`, `WebhookSignerTest`, `SriResponseParserTest`, `EnvelopeRulesTest`, `DocumentXmlCheckTest`, `PasswordsTest`, `ApiKeyCredentialTest`, `AesGcmSecretCipherTest`, `Pkcs12InspectorTest`, `RateLimiterTest`, `DecimalsTest` y las demás que prueben lógica pura.

### Capa 3 — Integración (Jest + Testcontainers)

PostgreSQL, RabbitMQ y Redis en contenedores, más los stubs portados de SRI, SMTP y receptor de webhooks. Pruebas críticas que se traducen obligatoriamente:

`TenantIsolationIT`, `SecurityIT`, `AuthApiIT`, `AuthRateLimitIT`, `ApiKeyAuthenticationIT`, `CertificateApiIT`, `SequenceConcurrencyIT`, `InvoiceIdempotencyIT`, `CreditNoteApiIT`, `DebitNoteApiIT`, `InvoiceReissueIT`, `OutboxRelayIT`, `ReceptionPipelineIT`, `AuthorizationPipelineIT`, `RecoveryIT`, `NotesPipelineIT`, `PipelineEndToEndIT`, `AuditImmutabilityIT`, `ArtifactImmutabilityIT`, `DeliveryRetryIT`, `WebhookStrictPolicyIT`, `WebhookFairnessIT`, `ProductionActivationIT`, `OperationalMetricsIT`, `DatabaseRolesIT`, `OpenApiContractIT`.

`OpenApiContractIT` valida cada respuesta de las pruebas de API contra `contracts/openapi.yaml`.

**Prueba sobre datos de Java:** una base creada por Flyway y llenada por la API Java (dump versionado en `test/fixtures/`) sobre la que NestJS arranca, inicia sesión con un usuario existente, firma con un certificado existente, autentica una API key existente y lista y descarga comprobantes existentes.

### Capa 4 — E2E

La suite Playwright de `e2e/`, sin cambios en `tests/*.spec.ts`. Solo cambia `e2e/scripts/servers.ts` (y lo que dependa de él) para arrancar `node dist/main.js` en lugar de `java -jar`.

### CI

Lint, tipos, unitarias, golden, integración, e2e y `npm audit`. Un pull request no entra si falla cualquiera.

## 7. Etapas

Cada etapa deja software que funciona y se prueba solo; su plan detallado se escribe justo antes de empezarla en `docs/superpowers/plans/`.

| Etapa | Alcance | Endpoints | Hecha cuando |
| --- | --- | --- | --- |
| **E0 Fundación** | Repo y CI, esqueleto Nest, configuración con los mismos nombres, Kysely + `kysely-codegen`, Flyway CLI, `infra/docker-compose.yml`, `/actuator/health`, filtro de errores, `correlationId`, logs JSON, límite de peticiones en Redis, generador golden, inventario de rutas (controladores Java vs. `openapi.yaml`) | — | Health con PostgreSQL, RabbitMQ y Redis; Flyway (12.4.0, la misma versión que Java) migra una base vacía y valida sus checksums; errores idénticos a Spring; casos golden de clave de acceso, AES-GCM, Argon2, JWT y firma XAdES generados; CI verde. El dump con datos de Java se genera en E1, la primera etapa que lo usa |
| **E1 Identidad y multiempresa** | Registro, ingreso, renovación, cierre, verificación, recuperación y cambio de contraseña, `/auth/me`, empresas, membresías y roles, API keys, autenticación por middleware y guards de empresa y rol (las invitaciones se eliminaron en `V15`: no hay rutas de equipo) | `/auth/*`, `/tenants*`, `/api-keys*` | Golden Argon2 y JWT; `AuthApiIT`, `AuthRateLimitIT`, `TenantIsolationIT`, `ApiKeyAuthenticationIT`, `SecurityIT` de esas rutas; ingreso con usuario creado por Java |
| **E2 Emisores y catálogos** | Emisores, establecimientos, puntos de emisión, catálogos, clientes, productos, certificados, secuencial | `/taxpayers*` (sin producción), `/emission-points*`, `/catalogs/*`, `/customers*`, `/products*`, `/certificates` | Golden AES-GCM; `CertificateApiIT`, `TaxpayerApiIT`, `CatalogIT`, `CustomerApiIT`, `ProductApiIT`, `SequenceApiIT` |
| **E3 Comprobantes** | Cálculo, clave de acceso, secuenciales, XML y XSD de los tres tipos, idempotencia, outbox, consulta, reemisión | `/invoices`, `/credit-notes`, `/debit-notes`, `/documents`, `/documents/{id}` | Golden de clave, impuestos, XML y `content`; `SequenceConcurrencyIT`, `InvoiceIdempotencyIT`, `CreditNoteApiIT`, `DebitNoteApiIT`, `InvoiceReissueIT` |
| **E4 Firma y SRI** | XAdES-BES y verificación, SOAP, relay del outbox, worker, reintentos, conciliación, recogida de atrasados, DLQ | `/documents/{id}/retry`, `/documents/{id}/sri-attempts` | Golden de firma byte a byte; `OutboxRelayIT`, `ReceptionPipelineIT`, `AuthorizationPipelineIT`, `RecoveryIT`, `NotesPipelineIT` |
| **E5 RIDE, archivo y entrega** | RIDE PDF, XML autorizado, artefactos, correo y reintentos | `/documents/{id}/artifacts/{kind}`, `/documents/{id}/deliveries` | `DeliveryRetryIT`, `ArtifactImmutabilityIT`, `PipelineEndToEndIT`; revisión visual del RIDE frente al de Java |
| **E6 Webhooks y operación** | Suscripciones, avisos, prueba, secreto, historial y purga, activación de producción, auditoría, métricas, integridad | `/webhooks/*`, `/taxpayers/{id}/production-*` | `WebhookStrictPolicyIT`, `WebhookFairnessIT`, `ProductionActivationIT`, `OperationalMetricsIT`, `AuditImmutabilityIT`; `OpenApiContractIT` sobre todas las rutas |
| **E7 Corte** | E2E completa, prueba sobre dump de Java, Dockerfile e `infra/` en Node, docs actualizados, guía de corte | — | `npm run e2e` verde sin tocar los `*.spec.ts`; ensayo del corte en local con datos de Java |

Orden: E0 → E1 → E2 → E3 → E4 → E5 → E6 → E7. La firma XAdES de E4 se adelanta en paralelo a E3 en cuanto existan sus casos golden (E0): es el principal riesgo técnico.

## 8. Corte

1. Detener los workers de Java (`EINVOICE_WORKER_ENABLED=true`).
2. Esperar a que `outbox_events` no tenga pendientes y las colas `document.issue`, `document.deliver` y `webhook.deliver` estén vacías; revisar las DLQ.
3. Detener la API Java.
4. Ejecutar Flyway (no debe haber migraciones pendientes salvo las `V20+` que NestJS haya añadido).
5. Arrancar NestJS (API y workers) con las mismas variables de entorno.
6. Comprobar health, un ingreso, una emisión de prueba en ambiente de pruebas y las métricas.

Vuelta atrás: como el esquema es el mismo, detener NestJS y arrancar Java de nuevo, siempre que NestJS no haya aplicado migraciones `V20+` incompatibles. Por eso hasta el corte NestJS no añade migraciones salvo necesidad justificada en su plan.

## 9. Riesgos

| Riesgo | Mitigación |
| --- | --- |
| La firma en Node no sale idéntica a la de Java (C14N, espacios, orden de atributos, codificación del certificado) | Golden byte a byte desde E0; adelantar la firma; si `xml-crypto` no reproduce la C14N exacta, implementar la canonicalización necesaria a mano para la forma fija del comprobante |
| `xmllint-wasm` valida distinto que el validador de Java | Correr todos los XML de ejemplo y golden por ambos; casos inválidos conocidos deben fallar igual |
| Diferencias de redondeo | `decimal.js` con HALF_UP explícito; golden de cálculo con casos límite |
| Mensajes de validación o nombres de campo distintos rompen la web | Golden de respuestas de error por endpoint, tomados de las IT de Java; e2e |
| Rutas en controladores Java que no están en `openapi.yaml` (los controladores declaran 56 mapeos frente a 44 rutas con varios métodos) | Inventario en E0; toda ruta de Java se porta, esté o no en el contrato, y se anota la diferencia |
| Comportamiento implícito de Spring (Jackson, fechas, nulos, orden de propiedades) | `OpenApiContractIT` y comparación de respuestas JSON en las IT traducidas |

## 10. Preguntas abiertas

Ninguna bloquea E0. Se resuelven antes de la etapa indicada:

- E7: fecha del corte y si se hace con datos de producción reales o aún solo con datos de prueba.
