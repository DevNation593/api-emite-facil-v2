# Sondeo HTTP de la API Java

Genera `test/golden/http/<casos>.json` con lo que la API Java (`backend-emite-facil`) responde a una
lista de peticiones. Fija lo que el código Java no dice a simple vista: la coerción de Jackson (un
`"5"` o un `5.7` donde va un `Integer`), la conversión de parámetros de Spring (`page=0x10` vale 16),
el orden de las propiedades, los `null` y las cabeceras `Allow`.
`test/integration/java-probes.int.spec.ts` repite las mismas peticiones contra NestJS y exige la
misma respuesta.

## Uso

```bash
node tools/java-probe/make-cases.mjs
node tools/java-probe/run.mjs --java-repo ../backend-emite-facil --cases e2
node tools/java-probe/make-cases-e3.mjs
node tools/java-probe/run.mjs --java-repo ../backend-emite-facil --cases e3
```

`make-cases.mjs` escribe `cases/e2.json` y `make-cases-e3.mjs`, `cases/e3.json`. Con `--skip-build`, `run.mjs` reutiliza el jar de `target/`.
Requisitos: Docker en marcha, Java 25 en el `PATH`, Node 24 y las dependencias de Maven del repo Java.

## Cómo funciona

1. Arranca Java como `tools/java-dump` (`java-dump/java-app.mjs`), con correo, SRI y worker apagados.
2. `runScenario` crea por HTTP una persona, su empresa, el emisor `1790012345001`, el establecimiento
   y el punto de emisión `001`, un cliente y un producto.
3. `runProbes` envía cada caso en orden, con `{taxpayerId}` y los demás marcadores sustituidos, y
   guarda el estado, `Content-Type`, `Allow` y el cuerpo normalizados. `normalize` quita
   `correlationId` y cambia los ids del escenario por su marcador, cualquier otro UUID por `{uuid}` y
   las fechas ISO por `{timestamp}`.
4. Falla si Java responde 5xx a algún caso.

Las peticiones van por `node:http`, no por `fetch`: así se ve si una cabecera llega repetida. En un
405, Spring lista los métodos permitidos de un `HashSet`, cuyo orden cambia entre arranques, y por eso
se guardan ordenados. El `Allow` de `OPTIONS` sí es estable y se guarda tal cual.

Un caso es `{ name, method, path, query?, body?, rawBody?, headers?, auth: 'owner' | 'none' }`. Los
casos se ejecutan en orden sobre la misma base, así que los que crean o borran afectan a los
siguientes; el orden es el mismo contra Java y contra NestJS.

## Casos de E3 (comprobantes)

`cases/e3.json` sondea `POST /invoices`, `/credit-notes` y `/debit-notes` y `GET /documents`. Se
diferencia de E2 en cuatro cosas:

- `runScenario(send, hooks)` con `hooks.authorize(documentId)` emite además una factura del producto
  (`Idempotency-Key: sondeo-factura`, total `12.08`) y la pasa a `AUTHORIZED`, porque sin SRI ni
  worker Java la deja en `RESERVED` y una nota solo acepta una factura autorizada. `run.mjs` lo hace
  con `UPDATE fiscal_documents SET state = 'AUTHORIZED'` sobre el PostgreSQL de Java; la prueba
  contra NestJS lo hace con Kysely. Los valores del escenario ganan `invoiceId`.
- Un caso con `capture: "nombre"` guarda el `id` de su respuesta 2xx; los siguientes lo usan como
  `{nombre}`. De cada id salen también `{nombreUpper}` (mayúsculas) y `{nombreNoDash}` (sin guiones).
  `rawBody` también admite marcadores, y una cabecera puede ser una lista (cabecera repetida).
- `normalize` cambia además las claves de acceso (49 dígitos) por `{accessKey}` y la fecha fiscal de
  hoy (`YYYY-MM-DD` en `America/Guayaquil`) por `{today}`, después de las fechas ISO.
- `run.mjs` sube los topes de peticiones de Java (`EINVOICE_RATE_LIMIT_REQUESTS` y `_WRITES`) a
  1 000 000: sin eso, pasados 300 `POST` por minuto Java responde 429 y el golden no sirve. Falla si
  algún caso recibe 429 o 5xx. NestJS debe arrancar con los mismos topes al repetir los casos.

Los `POST` de E3 consumen secuenciales y saldo de la factura: el orden de los casos es parte del
golden. Los que crean un comprobante usan una clave propia `sondeo-<n>-<nombre>`.

## Casos de E4 (reintento e intentos ante el SRI)

`cases/e4.json` (de `make-cases-e4.mjs`) sondea `POST /documents/{id}/retry` y
`GET /documents/{id}/sri-attempts`. Usa `runScenario(send, hooks)` con hooks de E4, que `run.mjs`
implementa por SQL sobre el PostgreSQL de Java y que la prueba contra NestJS implementa con Kysely:

- `hooks.seedAttempts(documentId)` inserta `SEEDED_ATTEMPTS` (exportado por `probe.mjs`): una
  `RECEPTION` cerrada con `RETURNED`/`DEVUELTA`, HTTP 200, dos mensajes (`35` y `43`), `response` no
  nula y `started_at` con microsegundos; y una `AUTHORIZATION` abierta (sin `outcome` ni
  `completed_at`). Los instantes sembrados son texto exacto y `normalize` los conserva en vez de
  cambiarlos por `{timestamp}`, para fijar cuántos decimales muestra la API.
- `hooks.setState(documentId, state)` deja un comprobante en `RETURNED` o `NOT_AUTHORIZED`.
- `hooks.addMember(tenantId, email, role)` crea la membresía de una persona ya registrada.

Con `seedAttempts`, el escenario emite además `retryDocumentId` (RESERVED), `returnedDocumentId`
(RETURNED) y `notAuthorizedDocumentId` (NOT_AUTHORIZED), crea una segunda empresa con su factura
(`otherTenantId`, `otherInvoiceId`) y expone en `scenario.actors` las cabeceras de un `auditor`, un
`biller` y un `stranger` (sin membresía). Un caso elige actor con `auth: 'auditor' | 'biller' |
'stranger'`, además de `'owner'` y `'none'`. Las cabeceras de un caso también admiten marcadores.
