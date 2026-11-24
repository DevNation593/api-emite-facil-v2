# E5 RIDE, archivo y entrega — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Portar lo que ocurre después de `AUTHORIZED` con el comportamiento de Java: XML autorizado y RIDE en PDF como artefactos inmutables, su descarga, la entrega por correo con sus reintentos, el consumidor de `document.deliver`, la recogida de entregas atrasadas y las rutas de artefactos y entregas.

**Architecture:** Módulo nuevo `delivery` (archivo, RIDE, correo, entregas, controlador), como en Java; `storage` gana la descarga. El RIDE se compone con un motor de tablas propio que reproduce la maquetación de `PdfPTable` de OpenPDF (anchos, saltos de línea, altos de fila, cortes de página) sobre `pdfkit`, y se compara posición a posición con el PDF de Java. El consumidor de E4 se generaliza en `QueueConsumer`, del que salen `DocumentWorker` y `DeliveryWorker`. El correo se envía siempre fuera de transacción, tras reservar la entrega con una sola sentencia.

**Tech Stack:** Lo de E4, más `pdfkit` 0.21 y `bwip-js` 4.11 (Code 128) y, solo para pruebas, `pdfjs-dist` 6.5 (leer los PDF) y `@types/pdfkit`.

**Spec:** [docs/superpowers/specs/2026-10-29-api-nestjs-design.md](../specs/2026-10-29-api-nestjs-design.md)

**Rama:** la de E5, sobre `feat/e4-firma-sri` (`0e0084a`, PR #7 aún abierta). Si esa rama cambia, se integran sus cambios aquí; no se toca desde aquí.

## Global Constraints

- Referencia de comportamiento: `D:/Proyectos Personales/backend-emite-facil` (commit `ca53bca`, solo lectura). Ante cualquier duda manda el código Java; las rutas Java son relativas a `src/main/java/com/example/einvoice/`.
- Las reglas de `AGENTS.md` aplican: textos y commits en español, identificadores en inglés, imports con extensión `.js`, y P0/P1 de revisión.
- Mismos textos de error, `errorCode`, estados HTTP, cabeceras, nombres de propiedades y su orden que Java; los `null` se serializan.
- La entrega tiene estado propio (`PENDING`, `SENDING`, `SENT`, `FAILED`) y nunca cambia el estado fiscal, su `version`, sus eventos ni sus artefactos.
- Artefactos: solo inserción, uno por tipo y comprobante. E5 escribe `XML_AUTHORIZED` y `RIDE_PDF`. El XML firmado va dentro del XML autorizado byte a byte.
- El correo se envía fuera de toda transacción. Cada cambio de estado de una entrega es una sola sentencia SQL; dos procesos nunca envían la misma entrega a la vez.
- Dentro de una transacción con el comprobante bloqueado no se pide otra conexión al pool (5): se pasa `trx`.
- `DELIVERY_EMAIL_ENABLED` es `false` por defecto: se archiva, no se crea ninguna entrega ni se contacta ningún servidor.
- La dirección del receptor y el contenido del correo no van a la auditoría, al `outbox`, a RabbitMQ ni a los logs. `last_error` es el texto corto que Java escribe: nunca el servidor, el puerto ni el mensaje de una excepción imprevista.
- `tenantId` solo sale de `TenantAccess` en la API y del mensaje en el worker; toda consulta filtra por él. Un documento ajeno responde igual que uno inexistente.
- Importes con `BigDecimal` (`src/common/big-decimal.ts`); `number` solo para coordenadas del PDF.
- Sin migraciones nuevas: `deliveries` y los tipos de artefacto ya existen (V6).
- Las pruebas de integración necesitan Docker y van sin otras suites en paralelo.

## Review Focus

- Dos eventos del mismo comprobante a la vez, o un proceso que muere entre que el servidor acepta el mensaje y la anotación: un solo correo en el primer caso; en el segundo, otro envío solo al vencer `send-lease` (Task 9).
- Un nombre de emisor, cliente o artículo con saltos de línea, `NUL`, emoji, japonés o una palabra de 300 letras: el RIDE y el correo salen, nada se inyecta en las cabeceras y ninguna letra válida se pierde (Tasks 3 y 4).
- Un RIDE cuyo pie cae justo al final de la página: pasa entero a la siguiente y el encabezado del detalle se repite, como en Java (Task 4).
- El cliente corta la descarga, o la respuesta falla con las cabeceras ya enviadas: la petición termina (no queda abierta) y el proceso sigue (Task 2).
- El servidor SMTP no contesta, corta a mitad, rechaza con 4xx o 5xx, o exige autenticación que falla: la entrega nunca queda en `SENDING` para siempre y el resultado (temporal o definitivo) es el de Java (Task 8).

---

### Task 1: Sondeo de las rutas de E5 en la API Java

**Files:**
- Create: `tools/java-probe/make-cases-e5.mjs`, `tools/java-probe/cases/e5.json` (generado), `test/golden/http/e5.json` (generado)
- Modify: `tools/java-probe/probe.mjs`, `tools/java-probe/probe.d.mts`, `tools/java-probe/run.mjs`, `tools/java-probe/README.md`

**Interfaces:**
- Consumes: `runScenario(send, hooks)`, `runProbes`, `normalize`, `SEEDED_ATTEMPTS` (E4).
- Produces: `SEEDED_ARTIFACTS: Array<{ kind: string; content: string }>` (los cinco tipos, con contenido de texto fijo; `RIDE_PDF` empieza por `%PDF-`) y `SEEDED_DELIVERIES: Array<{ recipient; status; attemptCount; lastError; createdAt; sentAt; requestedBy: 'owner' | null }>` (una `SENT` automática con microsegundos, una `FAILED` pedida por el usuario con `lastError`, una `PENDING`, una `SENDING`), exportadas por `probe.mjs`.
- Produces: `hooks.seedArtifacts(documentId: string): Promise<void>` y `hooks.seedDeliveries(documentId: string): Promise<void>`. Con `hooks.seedArtifacts`, el escenario de E4 añade los valores `archivedDocumentId` (la factura `invoiceId`, AUTHORIZED, con los artefactos y entregas sembrados), `bareDocumentId` (AUTHORIZED sin artefactos ni correo de cliente), `mailedDocumentId` (AUTHORIZED, de un cliente con correo `cliente@example.test`) y `limitDocumentId` (AUTHORIZED con 10 entregas).
- Produces: un caso puede llevar `checkHeaders: string[]`; su resultado gana `headers: Record<string, string | string[] | null>` con esas cabeceras normalizadas. `sendRaw` no cambia.
- Produces: `run.mjs --cases e5` arranca Java con `DELIVERY_EMAIL_ENABLED=true`, `DELIVERY_EMAIL_FROM=facturas@example.test`, `SPRING_MAIL_HOST=127.0.0.1`, `SPRING_MAIL_PORT=9` y `SMTP_STARTTLS=false`; con el worker apagado nadie envía.

Casos (como mínimo):
- `GET /documents/{id}/artifacts/{kind}` de los cinco tipos, con `checkHeaders` de `etag`, `content-disposition`, `content-length`, `cache-control`, `pragma`, `expires`, `x-content-type-options`, `x-frame-options`, `x-xss-protection`, `accept-ranges`, `vary`; `HEAD`; con `If-None-Match` igual, débil, `*`, distinto, en lista y sin comillas; con `If-Match` igual y distinto; con `Range`; con `Accept` `application/json`, `text/html` y `application/pdf;q=0`; tipo desconocido (`pdf`, `RIDE`, `ride%20`, vacío), id mal formado con tipo desconocido, id desconocido, artefacto aún no generado, de otra empresa, rol `AUDITOR`, sin autenticación, barra final, `POST`, `OPTIONS`.
- Las mismas cabeceras de seguridad en una respuesta JSON 200, en un 404, en un 401 y en `/actuator/health`.
- `GET /documents/{id}/deliveries`: con lo sembrado (orden, precisión de las fechas, `automatic`), sin entregas, id mal formado, desconocido, ajeno, `AUDITOR`.
- `POST /documents/{id}/deliveries`: sin cuerpo; `{}`; `null`; `{"email":null}`; `""`; `" "`; `"\u00a0"`; un correo; con espacios alrededor; un número, un booleano, un objeto y una lista en `email`; propiedad desconocida; `[]`; texto suelto; JSON ilegible; `text/plain` con y sin cuerpo; sobre RESERVED, sin correo, sobre el límite; direcciones no válidas (las de `DeliveryApiIT` y `DeliveryPropertiesTest`); rol `AUDITOR` y `BILLER`; ajeno; sin autenticación; `PUT` y `DELETE` (405).
- Cuerpo ilegible en `GET /documents/{id}`, `GET .../deliveries`, `DELETE /customers/{id}` y `DELETE /products/{id}` (Java no lee el cuerpo).

- [ ] **Step 1: Escribir los casos y generar**

Run: `node tools/java-probe/make-cases-e5.mjs && node tools/java-probe/run.mjs --java-repo "D:/Proyectos Personales/backend-emite-facil" --cases e5`
Expected: código 0; `test/golden/http/e5.json` tiene un resultado por caso y ningún 5xx ni 429.

- [ ] **Step 2: Comprobar que E4 no cambia**

Run: lo mismo con `--skip-build --cases e4` y comparar `results` con el golden actual; restaurar el archivo.
Expected: `results` idénticos.

- [ ] **Step 3: Commit**

```bash
git add tools test/golden/http
git commit -m "test(tools): sondeo HTTP de la API Java para fijar respuestas de E5"
```

---

### Task 2: Cabeceras de seguridad, cuerpos que no se leen y respuestas cortadas

**Files:**
- Create: `src/common/security-headers.middleware.ts`
- Modify: `src/bootstrap.ts`, `src/common/json-body.ts`, `src/common/problem-details.filter.ts`
- Test: `test/unit/common/json-body.spec.ts`, `test/integration/common/errors.int.spec.ts`, `test/integration/common/security-headers.int.spec.ts`

**Interfaces:**
- Produces: `securityHeadersMiddleware(req, res, next)`, el primero de la cadena después de `inFlightMiddleware`, que pone las cabeceras por defecto de Spring Security con los valores del golden de la Task 1 en toda respuesta (también 401, 404 y `/actuator/health`). Una cabecera que el manejador ya puso no se pisa; un 304 las lleva como las lleve Java.
- Produces: `json-body.ts` no lee el cuerpo de `GET`, `HEAD`, `DELETE` ni `OPTIONS` (ningún manejador de Java con esos métodos declara `@RequestBody`), además de `BODYLESS_ROUTES`.
- Produces: `ProblemDetailsFilter` con `res.headersSent`: registra la causa y, si la respuesta no terminó, la destruye (`res.destroy()`): terminarla con `end()` haría pasar por completa una descarga cortada.

- [ ] **Step 1: Escribir las pruebas que fallan**

`security-headers.int.spec.ts`: las seis cabeceras en 200 JSON, 401, 404 y health, con los valores del golden. `errors.int.spec.ts`: un controlador de prueba que escribe media respuesta y lanza → el cliente recibe la conexión cortada (error de red, no un 200 completo) en menos de 2 s, y la siguiente petición responde. `json-body.spec.ts`: `DELETE` y `GET` con cuerpo `{` siguen sin error y con `req.body` sin definir; `PUT` con `{` sigue dando 400.

- [ ] **Step 2: Ejecutar y comprobar que fallan**

Run: `npx vitest run --project unit test/unit/common/json-body.spec.ts && npx vitest run --project integration test/integration/common`
Expected: FAIL.

- [ ] **Step 3: Implementar**

- [ ] **Step 4: Ejecutar las pruebas del Step 2, `npm test`, `npm run lint && npm run typecheck`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "fix(common): cabeceras de Spring Security, cuerpos que Java no lee y respuestas cortadas"
```

---

### Task 3: Configuración de entrega, XML autorizado y correo

**Files:**
- Create: `src/delivery/delivery-config.ts`, `src/delivery/authorized-xml.ts`, `src/delivery/delivery-email.ts`, `src/billing/ride-envelope.ts`, `tools/golden-generator/src/golden/DeliveryCases.java`, `test/golden/delivery.json` (generado)
- Modify: `src/config/app-config.ts`, `src/common/java-time.ts`, `src/billing/fiscal-document.repository.ts`, `tools/golden-generator/run.mjs`, `tools/golden-generator/src/golden/GoldenGenerator.java`, `tools/golden-generator/README.md`, `.env.example`
- Test: `test/golden/delivery.spec.ts`, `test/unit/delivery/delivery-config.spec.ts`, `test/unit/delivery/authorized-xml.spec.ts`, `test/unit/delivery/delivery-email.spec.ts`, `test/unit/config/app-config.spec.ts`

**Interfaces:**
- Produces: `interface DeliveryConfig { email: { enabled: boolean; from: string | null }; retryBackoffMs; retryMaxBackoffMs; retryMaxAttempts; sendLeaseMs; maxPerDocument }` (todos `number`), `createDeliveryConfig(input: DeliveryConfig): DeliveryConfig` con las comprobaciones y mensajes de `delivery/DeliveryProperties.java`, y `validAddress(address: string | null): boolean` (port de `validAddress` con `InternetAddress(address, true)` de Jakarta Mail; las reglas exactas las fija el golden).
- Produces: `AppConfig.delivery: DeliveryConfig`. Variables: `DELIVERY_EMAIL_ENABLED` (`true|on|yes|1` y `false|off|no|0`, sin distinguir mayúsculas, como el conversor de Spring; otra cosa detiene el arranque), `DELIVERY_EMAIL_FROM` y los nombres relajados `EINVOICE_DELIVERY_RETRY_BACKOFF` (1m), `EINVOICE_DELIVERY_RETRY_MAX_BACKOFF` (6h), `EINVOICE_DELIVERY_RETRY_MAX_ATTEMPTS` (12), `EINVOICE_DELIVERY_SEND_LEASE` (10m) y `EINVOICE_DELIVERY_MAX_PER_DOCUMENT` (10).
- Produces: `interface RideEnvelope { envelope: DocumentEnvelope; authorizationNumber: string | null; authorizedAt: string | null }` con `authorizedAt` como `YYYY-MM-DDTHH:MM:SS.ffffff` en UTC; `FiscalDocumentRepository.rideEnvelope(db, tenantId, documentId): Promise<RideEnvelope | null>` y `paymentMethodNames(db): Promise<Map<string, string>>` con el SQL de Java.
- Produces en `java-time.ts`: `ecuadorOffsetDateTime(utc: string): string` (`2012-03-05T16:57:34.997-05:00`: segundos siempre, fracción sin ceros finales) y `ecuadorDateTime(utc: string): string` (`dd/MM/yyyy HH:mm:ss`).
- Produces: `buildAuthorizedXml(authorizationNumber: string | null, authorizedAt: string | null, environment: SriEnvironment, signedXml: Buffer): Buffer` y `buildDeliveryEmail(from, ride, displayName, fileStem, recipient, ridePdf, authorizedXml): DeliveryEmail`, `interface DeliveryEmail { from; fromName; to; subject; text; attachments: Array<{ filename; contentType; content: Buffer }> }`, `headerSafe(value: string | null, max: number): string`, como `AuthorizedXmlBuilder` y `DeliveryEmailFactory`.

El XML firmado se decodifica y vuelve a codificar en UTF-8 como en Java; un byte que no sea UTF-8 válido se trata como lo fije el golden.

Familia `delivery` del generador: `addresses` (al menos 80 direcciones: las de las pruebas de Java, puntos, guiones, literales de dominio, no ASCII, 254 y 255 caracteres, `@` repetida, barras invertidas, grupos), `headers` (`headerSafe` por reflexión: controles, espacios Unicode, emoji, cortes en un par sustituto), `emails` (factura, notas, sin total, sin nombre comercial, nombre con saltos de línea, nombre de 400 letras), `authorizedXml` (pruebas y producción, `]]>`, BOM, UTF-8 no válido, fechas con y sin fracción; y los errores).

- [ ] **Step 1: Añadir la familia `delivery` y generarla**

Run: `node tools/golden-generator/run.mjs --java-repo "D:/Proyectos Personales/backend-emite-facil" --only delivery`
Expected: código 0; solo aparece `delivery.json`.

- [ ] **Step 2: Escribir las pruebas que fallan**

`delivery.spec.ts`: cada caso del golden da lo mismo. Traducir `AuthorizedXmlBuilderTest`, `DeliveryEmailFactoryTest` y `DeliveryPropertiesTest` completos. `app-config.spec.ts`: valores por defecto, habilitado sin remitente o con uno no válido no arranca.

- [ ] **Step 3: Ejecutar y comprobar que fallan**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 4: Implementar**

- [ ] **Step 5: Ejecutar `npm test && npm run lint && npm run typecheck`**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src test tools .env.example
git commit -m "feat(delivery): configuración, XML autorizado y redacción del correo como Java"
```

---

### Task 4: RIDE de la factura

**Files:**
- Create: `src/delivery/pdf-table.ts` (motor de tablas), `src/delivery/ride-layout.ts`, `src/delivery/invoice-ride.ts`, `test/support/pdf-inspect.ts`, `tools/golden-generator/src/golden/RideCases.java`, `test/golden/ride.json` y `test/golden/ride/*.pdf` (generados)
- Modify: `package.json`, `src/common/big-decimal.ts`, `tools/golden-generator/run.mjs`, `tools/golden-generator/src/golden/GoldenGenerator.java`, `tools/golden-generator/README.md`
- Test: `test/golden/ride.spec.ts`, `test/unit/delivery/invoice-ride.spec.ts`, `test/unit/delivery/pdf-table.spec.ts`

**Interfaces:**
- Consumes: `InvoiceXmlData` (E3), `Issuer`, `Recipient` (E3), `ecuadorDateTime` (Task 3).
- Produces en `pdf-table.ts`: `type FontStyle = { bold: boolean; size: number; color: string; underline?: boolean }`; `type Cell` (texto en tramos, tabla anidada o código de barras; `align`, `paddingTop/Right/Bottom/Left`, `fill`, `bottomBorder: { color; width } | null`, `colspan`, `noWrap`, `verticalMiddle`); `class PdfTable { constructor(widths: number[]); headerRows: number; keepTogether: boolean; add(cell: Cell): void }`; `renderDocument(title: string, blocks: Array<PdfTable | { spacer: number }>): Promise<Buffer>`, que maqueta en A4 (595 × 842) con márgenes de 28.
- Produces en `ride-layout.ts`: las piezas de `delivery/RideLayout.java` con sus mismos nombres (`header`, `recipient`, `additionalInfo`, `paymentsTable`, `payment`, `infoTable`, `detailTable`, `totalsTable`, `subtotalRows`, `vatRows`, `total`, `grandTotal`, `footer`, `text`, `amount`, `percent`, `rateLabel`, `clean`…).
- Produces en `invoice-ride.ts`: `interface RideData { invoice: InvoiceXmlData; authorizationNumber; authorizedAt; customerEmail; customerPhone; issuerPhone; paymentMethodNames: ReadonlyMap<string, string> }` y `buildInvoiceRide(data: RideData): Promise<Buffer>`. Sin autorización lanza `Error('Solo un comprobante autorizado tiene RIDE')`.
- Produces en `big-decimal.ts`: `stripTrailingZeros(): BigDecimal` (con escala mínima 0, que es lo único que usa el RIDE).
- Produces en `pdf-inspect.ts` (pruebas): `inspectPdf(pdf: Buffer): Promise<{ pages: Array<{ lines: Array<{ x; y; size; bold; color; text }>; rects: Array<{ x; y; width; height; color }> }>; title: string }>` con `pdfjs-dist`, y `pdfText(pdf: Buffer): Promise<string>` (espacios normalizados, como el `text` de `RidePdfBuilderTest`).

Reglas de maquetación de OpenPDF que fija el golden: interlínea igual al cuerpo mayor de la línea; la línea base queda a `paddingTop + cuerpo` del borde superior y el alto de la celda termina en la última línea base más `paddingBottom`; salto de línea en espacio o guion, sin partir una palabra salvo que sola no quepa en la línea; alto de fila el de su celda más alta; fondos, luego rayas y luego textos; una fila que no cabe pasa a la página siguiente y las `headerRows` se repiten; `keepTogether` mueve la tabla entera. Sin interletraje (OpenPDF no lo aplica; `pdfkit` sí, y hay que anularlo). Una fila que no cabe en una página vacía lanza un error: los topes de la API (textos de 300, 20 pagos) lo hacen imposible.

Familia `ride` del generador: `ride.json` con los datos de cada caso y un PDF por caso: estándar; todas las leyendas; plazos; misma dirección; otras tarifas (6, 7 y 8 %); caracteres raros y palabra de 300 letras; correo largo; sin datos opcionales; 20 pagos; emisor con nombres de 300 letras; y facturas de 1, 10, 15, 16, 17, 18, 19, 20, 30, 40, 45, 60 y 300 líneas (el pie cae a ambos lados del final de página). Anota también `amount`, `percent`, `rateLabel` y `clean` sobre valores de borde, y los módulos del Code 128 de varias claves.

- [ ] **Step 1: Añadir la familia `ride`, generarla e instalar dependencias**

Run: `node tools/golden-generator/run.mjs --java-repo "D:/Proyectos Personales/backend-emite-facil" --only ride && npm i pdfkit bwip-js && npm i -D @types/pdfkit pdfjs-dist`
Expected: código 0.

- [ ] **Step 2: Escribir las pruebas que fallan**

`ride.spec.ts`: para cada caso, mismo número de páginas, mismo título, las mismas líneas de texto en el mismo orden, con la misma letra, cuerpo y color y a menos de 0,15 puntos; los mismos rectángulos de color; las barras del código a menos de 0,15 puntos. Traducir `RidePdfBuilderTest` completo. `pdf-table.spec.ts`: salto en guion, palabra que no cabe, fila que no cabe en una página, `keepTogether`.

- [ ] **Step 3: Ejecutar y comprobar que fallan**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 4: Implementar**

- [ ] **Step 5: Ejecutar `npm test && npm run lint && npm run typecheck && npm audit --omit=dev --audit-level=high`**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src test tools package.json package-lock.json
git commit -m "feat(delivery): RIDE de la factura con la maquetación de Java"
```

---

### Task 5: RIDE de las notas y `DocumentKind.buildRide`

**Files:**
- Create: `src/notes/note-ride.ts`
- Modify: `src/billing/document-kind.ts`, `src/billing/invoice-kind.ts`, `src/billing/json-content-kind.ts`, `src/notes/credit-note-kind.ts`, `src/notes/debit-note-kind.ts`, `src/notes/notes.module.ts`, `tools/golden-generator/src/golden/RideCases.java`
- Test: `test/golden/ride.spec.ts`, `test/unit/notes/note-ride.spec.ts`, `test/unit/notes/note-kinds.spec.ts`, `test/integration/delivery/ride-data.int.spec.ts`

**Interfaces:**
- Consumes: Tasks 3 y 4.
- Produces: `buildCreditNoteRide(ride: RideEnvelope, content: CreditNoteContent): Promise<Buffer>` y `buildDebitNoteRide(ride, content: DebitNoteContent, paymentMethodNames: ReadonlyMap<string, string>): Promise<Buffer>`.
- Produces: `DocumentKind<C>.buildRide(db: Kysely<DB> | Transaction<DB>, ride: RideEnvelope, content: C): Promise<Buffer>` (la factura y la nota de débito leen los nombres de las formas de pago con `db`).

El golden `ride` gana una nota de crédito y una de débito con los datos de `CreditNoteXmlBuilderTest` y `DebitNoteXmlBuilderTest`, y otra de cada una sin datos opcionales y con `providerRuc`.

- [ ] **Step 1: Ampliar y regenerar el golden `ride`; escribir las pruebas que fallan**

Traducir `NoteRideTest`, lo que `NoteKindsTest` comprueba del RIDE y `RideDataIT` completo (con el stub del SRI).

- [ ] **Step 2: Ejecutar y comprobar que fallan**

Run: `npm test && npx vitest run --project integration test/integration/delivery/ride-data.int.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar**

- [ ] **Step 4: Ejecutar las pruebas del Step 2, lint y tipos**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test tools
git commit -m "feat(notes): RIDE de las notas de crédito y de débito"
```

---

### Task 6: Descarga de artefactos

**Files:**
- Create: `src/storage/artifact.controller.ts`
- Modify: `src/storage/artifact-store.ts`, `src/storage/storage.module.ts`, `src/app.module.ts`
- Test: `test/integration/storage/artifact-api.int.spec.ts`, `test/integration/storage/artifact-store.int.spec.ts`, `test/integration/orchestration/document-processing.int.spec.ts`, `test/integration/orchestration/authorization-pipeline.int.spec.ts`

**Interfaces:**
- Produces: `ArtifactStore.findForDownload(db, tenantId, documentId, kind): Promise<{ content: Buffer; sha256: string; documentType: string; number: string } | null>` con el SQL de Java.
- Produces: `GET /documents/{id}/artifacts/{kind}` como `storage/ArtifactController.java`: 400 `MALFORMED_REQUEST` "Tipo de artefacto desconocido"; 404 igual para ajeno y no generado; `Content-Type`, `ETag: "<sha256>"`, `Content-Disposition: attachment; filename="factura-001-001-000000001-ride.pdf"`, `Content-Length` y el 304/412 condicional que fije el golden de la Task 1. Escribe con `@Res()`: la negociación de `Accept` no aplica.

- [ ] **Step 1: Escribir las pruebas que fallan**

Traducir `ArtifactStoreIT` completo y las descargas de `DocumentProcessingIT.signedXmlIsDownloadableAndStateIsVisible` y `AuthorizationPipelineIT.artifactIsDownloadable`.

- [ ] **Step 2: Ejecutar y comprobar que fallan**

Run: `npx vitest run --project integration test/integration/storage test/integration/orchestration/document-processing.int.spec.ts test/integration/orchestration/authorization-pipeline.int.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar**

- [ ] **Step 4: Ejecutar las pruebas del Step 2, lint y tipos**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(storage): descarga de los artefactos de un comprobante"
```

---

### Task 7: Archivo del comprobante autorizado

**Files:**
- Create: `src/delivery/document-archiver.ts`, `src/delivery/delivery.module.ts`
- Modify: `src/app.module.ts`
- Test: `test/integration/delivery/document-archiver.int.spec.ts`

**Interfaces:**
- Consumes: `FiscalDocumentRepository`, `ArtifactStore`, `DocumentKinds`, `buildAuthorizedXml`, `DocumentKind.buildRide`.
- Produces: `class DocumentArchiver { constructor(db, documents, artifacts, kinds); archive(tenantId: string, documentId: string): Promise<boolean> }` como `delivery/DocumentArchiver.java`, en una transacción con el comprobante bloqueado y todas las consultas sobre `trx`. `ApiException.notFound()` si no existe; `false` si no está `AUTHORIZED`.
- Produces: `DeliveryModule` (se carga siempre, también sin worker).

- [ ] **Step 1: Escribir las pruebas que fallan**

Traducir `DocumentArchiverIT` completo, más: cuatro archivados simultáneos del mismo comprobante con `DB_POOL_SIZE=2` terminan sin agotar el pool.

- [ ] **Step 2: Ejecutar y comprobar que fallan**

Run: `npx vitest run --project integration test/integration/delivery/document-archiver.int.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar**

- [ ] **Step 4: Ejecutar la prueba, lint y tipos**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(delivery): archivo del XML autorizado y del RIDE"
```

---

### Task 8: Envío por SMTP

**Files:**
- Create: `src/delivery/delivery-mailer.ts`, `src/delivery/smtp-delivery-mailer.ts`, `src/common/smtp-transport.ts`, `test/support/scripted-smtp.ts`
- Modify: `src/identity/auth-mailer.ts` (usa `smtp-transport.ts`), `tools/golden-generator/src/golden/DeliveryCases.java`
- Test: `test/integration/delivery/smtp-delivery-mailer.int.spec.ts` (sin contenedores), `test/unit/delivery/smtp-delivery-mailer.spec.ts`

**Interfaces:**
- Produces: `type MailResult = { sent: true; messageId: string } | { sent: false; permanent: boolean; error: string }`, `interface DeliveryMailer { send(email: DeliveryEmail): Promise<MailResult> }`.
- Produces: `createSmtpTransport(mail: AppConfig['mail'], timeouts?: { connectionMs: number; socketMs: number }): Transporter`, con los plazos 10 s y 30 s.
- Produces: `class SmtpDeliveryMailer implements DeliveryMailer`, cuyo constructor lanza el mensaje de Java si falta `SPRING_MAIL_HOST`. Nunca lanza al enviar. Solo los códigos de la respuesta a `MAIL FROM`, `RCPT TO` y `DATA` deciden (`SMTP <código>: <primera línea>`, 300 caracteres; 5xx definitivo); todo lo demás es temporal, "Sin respuesta del servidor de correo: <clase>", con la clase de la causa raíz que Java anotaría según el golden.
- Produces: `ScriptedSmtp` (port de `support/SmtpStub.java`): `start()`, `port`, `onRecipient(email, ...replies)`, `messages(email)`, `raw(email)`, `connections()`, `close()`, y `SmtpReply.accept()`, `.rejectRecipient(code, text)`, `.failData(code, text)`, `.dropConnection()`, `.delayed(ms, reply)`.

La familia `delivery` gana `mailer`: el `Result` de `SmtpDeliveryMailer` de Java contra `SmtpStub` para aceptar, 4xx y 5xx en `RCPT TO` y en `DATA`, texto de varias líneas y de 400 letras, corte, plazo vencido, puerto cerrado, host inexistente, STARTTLS exigido y no ofrecido, y dirección no válida.

- [ ] **Step 1: Ampliar y regenerar `delivery`; escribir las pruebas que fallan**

Cada resultado del golden (salvo el `messageId`), la estructura del mensaje (tres partes, en orden, con nombre y tipo; asunto, remitente con nombre, un solo destinatario; `Content-Type: text/plain; charset=UTF-8`) y que un adjunto llega byte a byte.

- [ ] **Step 2: Ejecutar y comprobar que fallan**

Run: `npx vitest run --project integration test/integration/delivery/smtp-delivery-mailer.int.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar**

- [ ] **Step 4: Ejecutar la prueba, `test/integration/identity/auth-mailer.int.spec.ts`, `npm test`, lint y tipos**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test tools
git commit -m "feat(delivery): envío por SMTP con los fallos clasificados como Java"
```

---

### Task 9: Entregas y reintentos

**Files:**
- Create: `src/delivery/delivery.repository.ts`, `src/delivery/delivery.service.ts`, `test/support/delivery-scenario.ts`
- Modify: `src/delivery/delivery.module.ts`, `src/orchestration/webhook-recorder.ts`, `test/support/test-app.ts`
- Test: `test/integration/delivery/delivery.int.spec.ts`, `test/integration/delivery/delivery-retry.int.spec.ts`

**Interfaces:**
- Consumes: Tasks 3, 7 y 8, `retryDelayMs` (E4), `WEBHOOK_RECORDER`.
- Produces: `WebhookRecorder.delivered(trx, tenantId, documentId): Promise<void>` (`NoWebhooks` no hace nada).
- Produces: `class DeliveryRepository` sin estado, con `db` como primer parámetro y el SQL de Java: `ensureAutomatic`, `create`, `pending`, `claim(db, deliveryId, leaseMs): Promise<{ recipient; attemptCount } | null>`, `markSent(db, id, messageId): Promise<boolean>`, `markRetry`, `markFailed`, `list`, `find`, `count`. `DeliveryRow = { id; channel; recipient; status; attemptCount; lastError; createdAt; sentAt; requestedBy }` con las fechas ya en el texto de `isoInstant`.
- Produces: `class DeliveryService { constructor(db, archiver, documents, deliveries, artifacts, config, mailer: DeliveryMailer | null, webhooks, kinds, random = Math.random); process(tenantId, documentId): Promise<number> }` como `delivery/DeliveryService.java`. Con el correo habilitado y `mailer` nulo, el constructor lanza el mensaje de Java. Un fallo imprevisto se anota como "Fallo inesperado: <nombre del error>" y el detalle va solo al log.
- Produces: `startTestApp` acepta `DELIVERY_EMAIL_ENABLED` y los plazos por `env` y, por defecto, los fija como `AbstractIntegrationTest` (apagado salvo que la prueba lo pida).

- [ ] **Step 1: Escribir las pruebas que fallan**

Traducir `DeliveryIT` y `DeliveryRetryIT` completos con `ScriptedSmtp`. Añadir la del Review Focus: el servidor acepta el mensaje y la anotación falla (conexión a la base cortada) → la entrega queda en `SENDING`, no se repite antes de `send-lease` y sí después.

- [ ] **Step 2: Ejecutar y comprobar que fallan**

Run: `npx vitest run --project integration test/integration/delivery/delivery.int.spec.ts test/integration/delivery/delivery-retry.int.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar**

- [ ] **Step 4: Ejecutar las pruebas del Step 2, lint y tipos**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(delivery): entregas por correo con reserva, reintentos y fallos definitivos"
```

---

### Task 10: Consumidor de entregas y atrasados

**Files:**
- Create: `src/orchestration/queue-consumer.ts`, `src/delivery/delivery-worker.ts`, `src/delivery/due-delivery-scheduler.ts`
- Modify: `src/orchestration/document-worker.ts`, `src/orchestration/worker-schedule.ts`, `src/orchestration/worker.module.ts`, `src/delivery/delivery.module.ts`
- Test: `test/unit/orchestration/worker-schedule.spec.ts`, `test/unit/orchestration/worker.module.spec.ts`, `test/integration/delivery/due-delivery-scheduler.int.spec.ts`, `test/integration/delivery/delivery-routing.int.spec.ts`, `test/integration/orchestration/pipeline-end-to-end.int.spec.ts`, `test/integration/notes/notes-pipeline.int.spec.ts`

**Interfaces:**
- Produces: `class QueueConsumer { constructor(rabbit, queue: string, prefetch: number, handle: (event: DocumentEvent) => Promise<string>, retryDelaysMs?) }` con todo lo que hoy hace `DocumentWorker` (reapertura, reintentos, DLQ, cierre); `handle` devuelve el texto del log de éxito. `DocumentWorker` y `DeliveryWorker` lo extienden. El texto del log de `DeliveryWorker` es "Documento <id>: <n> correo(s) enviado(s) tras el evento <tipo>".
- Produces: `class DueDeliveryScheduler { constructor(db, outbox, redeliveryLeaseMs?); enqueueDue(): Promise<number> }` con el SQL de Java (lotes de 100, un evento `DELIVERY_DUE` por comprobante).
- Produces: `WorkerSchedule(due, dueDeliveries, relay)`: `tick` llama a `due.enqueueDue()`, `dueDeliveries.enqueueDue()` y publica. Los avisos (E6) irán entre ambos, con su propio `try`.

- [ ] **Step 1: Escribir las pruebas que fallan**

Traducir `DueDeliverySchedulerIT`, `DeliveryRoutingIT`, `WorkerScheduleTest` (sin avisos) y de `PipelineEndToEndIT` `issuedInvoiceIsEmailedWithoutAnyManualStep` y `emailIsRetriedByTheSchedulerAfterATemporaryFailure`; `NotesPipelineIT` pasa a exigir RIDE y correo. Añadir: un mensaje ilegible en `document.deliver` acaba en `document.deliver.dlq`; apagar la aplicación con un correo lento en curso espera a que termine.

- [ ] **Step 2: Ejecutar y comprobar que fallan**

Run: `npm test && npx vitest run --project integration test/integration/delivery test/integration/orchestration/pipeline-end-to-end.int.spec.ts test/integration/notes/notes-pipeline.int.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar**

- [ ] **Step 4: Ejecutar las pruebas del Step 2, lint y tipos**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(delivery): consumidor de entregas y recogida de atrasadas"
```

---

### Task 11: Rutas de entregas y sondeo

**Files:**
- Create: `src/delivery/delivery.controller.ts`, `src/delivery/delivery.dto.ts`
- Modify: `src/delivery/delivery.module.ts`, `src/common/validation.ts` (cuerpo opcional), `src/common/error-codes.ts` si falta algún código
- Test: `test/integration/delivery/delivery-api.int.spec.ts`, `test/integration/java-probes.int.spec.ts`

**Interfaces:**
- Consumes: Task 9, `OutboxWriter`, `AuditLog.recordFor`, `UuidPipe`, `TenantAccessGuard`.
- Produces: `GET` y `POST /documents/{id}/deliveries` como `delivery/DeliveryController.java`, con `DeliveryView` en el orden `id, channel, recipient, status, attemptCount, lastError, createdAt, sentAt, automatic`.
- Produces: `@OptionalBody()` en `validation.ts`: un cuerpo ausente o `null` llega como `null` (`@RequestBody(required = false)`); lo demás sigue las reglas de siempre.
- Produces: `java-probes.int.spec.ts` repite `e5.json` en su propia base, con los hooks de la Task 1 sobre Kysely, el correo habilitado y los topes altos.

- [ ] **Step 1: Escribir las pruebas que fallan**

Traducir `DeliveryApiIT` completo y añadir el juego `e5` al sondeo.

- [ ] **Step 2: Ejecutar y comprobar que fallan**

Run: `npx vitest run --project integration test/integration/delivery/delivery-api.int.spec.ts test/integration/java-probes.int.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar**

- [ ] **Step 4: Ejecutar las pruebas del Step 2, lint y tipos**

Expected: PASS; todos los casos de `e2` a `e5` iguales a Java.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(delivery): consulta y petición de entregas de un comprobante"
```

---

### Task 12: Datos de Java, revisión visual y documentación

**Files:**
- Modify: `test/integration/identity/java-compat.int.spec.ts`, `README.md`, `docs/route-inventory.md`, `docs/05-electronic-document-flow.md`, `docs/DEVELOPMENT.md`, `docs/13-deployment.md`, `docs/10-security.md` donde describan Java

**Interfaces:**
- Consumes: todo lo anterior.

En `java-compat.int.spec.ts`, sobre la base que creó Java: una factura y las notas de Java llegan a `AUTHORIZED`, se archivan y se entregan; su RIDE y su XML autorizado se descargan.

Documentación: en `docs/route-inventory.md`, las 3 rutas de E5 pasan a portadas (50 en total) y `GET /webhooks/subscriptions/{id}/deliveries` pasa a E6 (necesita las suscripciones y las entregas de webhooks); en "Diferencias" se anota lo que E5 deje distinto de Java. README con el estado E5.

- [ ] **Step 1: Escribir las pruebas de datos de Java y ejecutarlas**

Run: `npx vitest run --project integration test/integration/identity/java-compat.int.spec.ts`
Expected: PASS.

- [ ] **Step 2: Revisión visual**

Generar el RIDE de la factura con todas las leyendas, el de 300 líneas y el de las dos notas; abrirlos junto a los de `test/golden/ride/` y anotar el resultado en el resumen de la etapa.

- [ ] **Step 3: Actualizar la documentación**

- [ ] **Step 4: Ejecutar toda la suite**

Run: `npm run lint && npm run typecheck && npm test && npm run build && npm run test:integration && npm audit --omit=dev --audit-level=high`
Expected: todo pasa.

- [ ] **Step 5: Commit**

```bash
git add test README.md docs
git commit -m "test(e5): datos de Java archivados y entregados y documentación de la etapa"
```
