# E3 Comprobantes — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Portar la emisión de facturas, notas de crédito y notas de débito hasta `RESERVED` (cálculo, secuencial, clave de acceso, XML validado contra su XSD, idempotencia, outbox, reemisión) y su consulta, con el comportamiento de Java, de modo que un comprobante emitido por Java se lea igual en NestJS y un reintento con su `Idempotency-Key` devuelva el mismo comprobante después del corte.

**Architecture:** Tres módulos Nest nuevos, como en Java: `xml` (tipos de comprobante, escritor, validación XSD y reglas del sobre), `billing` (repositorio de comprobantes, idempotencia, outbox, `DocumentIssuer`, factura y consulta) y `notes` (notas de crédito y débito). Cada tipo es un `DocumentKind` registrado en `DocumentKinds`. Una emisión es una sola transacción Kysely en la que todo, incluidas las lecturas de emisor, cliente, producto y catálogo, usa la misma `trx`. Los importes usan un `BigDecimal` sobre `decimal.js` que conserva la escala como Java, porque el JSON de `content` y algunos mensajes de error la muestran. Lo que no se puede leer en el código (coerciones de Jackson, orden de errores, huella de la petición) se fija contra la API Java real con `tools/java-probe` y `tools/java-dump`, como en E2.

**Tech Stack:** Lo de E2, más `xmllint-wasm` 5 (validación XSD, sin red) y `saxes` 6 (lectura SAX que rechaza `DOCTYPE`).

**Spec:** [docs/superpowers/specs/2026-10-29-api-nestjs-design.md](../specs/2026-10-29-api-nestjs-design.md)

**Rama:** `feat/e3-comprobantes`, sobre `dev` (E0, E1 y E2 ya están mezcladas).

## Global Constraints

- Referencia de comportamiento: `../backend-emite-facil` (commit `ca53bca`). Ante cualquier duda manda el código Java; las rutas Java son relativas a `src/main/java/com/example/einvoice/`.
- Las reglas de `AGENTS.md` aplican: textos y commits en español, identificadores en inglés, imports con extensión `.js`, y P0/P1 de revisión.
- Mismos textos de error, `errorCode`, estados HTTP, nombres de propiedades y su orden que Java. Los records de Java serializan en el orden en que declaran sus componentes, y los `null` se serializan. Las validaciones corren en el orden de Java; cuando el orden de dos comprobaciones no se ve en el código (anotaciones frente a cabecera), lo fija `test/golden/http/e3.json`.
- `tenantId` solo sale de `TenantAccess`. Toda consulta de `fiscal_documents` y de sus tablas hijas filtra por él; un comprobante, emisor, cliente o producto de otra empresa responde igual que uno inexistente: 404 `NOT_FOUND`.
- Importes y cantidades con `BigDecimal` (Task 2), nunca `number`. Redondeo HALF_UP; dos decimales en importes y seis en cantidad y precio unitario, como el XSD. IVA y formas de pago salen de la base (`CatalogRepository`), nunca de constantes; `IVA_TAX_CODE = '2'` ya existe.
- Una emisión es una transacción: si algo falla, incluido el XML, no queda comprobante, ni secuencial consumido, ni evento en `outbox_events`, ni registro de idempotencia. Nada se publica en RabbitMQ: solo se escribe `DOCUMENT_RESERVED` en el outbox. El relay, la firma y el SRI son E4; en E3 los comprobantes se quedan en `RESERVED`.
- Ni el XML ni `content` ni datos del cliente van a logs, al outbox ni a la auditoría. El payload del outbox es `{"documentId":"<id>"}`.
- Todo XML se lee con `saxes` (Task 3), que rechaza `DOCTYPE` y no resuelve entidades. La validación XSD solo lee archivos de `resources/xsd` y nunca accede a la red.
- Sin migraciones nuevas: `fiscal_documents`, sus tablas hijas, `idempotency_records`, `outbox_events` y `state_events` ya existen (V3–V19). `state_events` es de solo inserción.
- Los códigos de error que Java devuelve y `openapi.yaml` no declara van en `JAVA_ONLY_ERROR_CODES`.
- Las pruebas de integración necesitan Docker en marcha.

## Review Focus

- Emisiones simultáneas con un pool pequeño (`DB_POOL_SIZE=2`, 10 peticiones a la vez sobre el mismo punto): todas terminan en 202 con secuenciales distintos y consecutivos y ninguna se queda esperando una segunda conexión, porque cada lectura de la emisión va por la `trx` abierta (Task 7).
- Cantidades e importes enviados como número JSON (`2`, `2.50`, `1e2`, `123456789012.123456`) o con ceros a la izquierda (`"007"`): se validan y se guardan con el texto que se envió, y la huella de la petición es la que calcula Java, de modo que el mismo cuerpo con la misma clave es la misma petición en las dos APIs (Tasks 1, 7 y 12).
- Textos que el XML no puede llevar o que el XSD rechaza (un `U+0001` guardado en el nombre del cliente, un salto de línea, 301 caracteres en la razón social, un sustituto suelto `"\ud800"` en el motivo de una nota de crédito) responden 422 `DOCUMENT_XML_INVALID` con un detalle de hasta 500 caracteres, nunca 500, y no consumen el secuencial (Tasks 7 y 10).
- La fecha fiscal en el cambio de día: a las 22:30 de Guayaquil (03:30 UTC del día siguiente) la fecha de hoy es la de Guayaquil; `issueDate` igual a ella se admite y la del día siguiente es 422 `INVALID_ISSUE_DATE` (Task 7).
- `authorizedAt` de un comprobante cuya `authorized_at` tiene microsegundos o fracción cero sale como lo escribe Jackson (`ISO_INSTANT`: 0, 3 o 6 decimales y `Z`), no con los milisegundos de `Date` (Task 8).

---

### Task 1: Sondeo de las rutas de E3 en la API Java

**Files:**
- Create: `tools/java-probe/cases/e3.json`, `test/golden/http/e3.json` (generado)
- Modify: `tools/java-probe/probe.mjs`, `tools/java-probe/probe.d.mts`, `tools/java-probe/run.mjs`, `tools/java-probe/make-cases.mjs` (si genera los casos), `tools/java-probe/README.md`

**Interfaces:**
- Consumes: `startJavaApp` (devuelve `postgres`), `runScenario`, `runProbes`, `normalize`, `caseRequest`.
- Produces: `runScenario(send, hooks?: { authorize(documentId: string): Promise<void> })`. Con `hooks`, el escenario además emite una factura del producto (cantidad `"1"`, pago `"11.50"`, `Idempotency-Key: sondeo-factura`) y la pasa a `AUTHORIZED` con `hooks.authorize`; `values` gana `invoiceId`. `run.mjs` implementa `authorize` con `UPDATE fiscal_documents SET state = 'AUTHORIZED' WHERE id = $1` sobre el `postgres` de Java; Task 12 lo hace con Kysely contra NestJS.
- Produces en `normalize`: las claves de acceso (49 dígitos) pasan a `{accessKey}` y la fecha fiscal de hoy (`YYYY-MM-DD` en `America/Guayaquil`) a `{today}`, después de las fechas ISO. `{invoiceId}` entra en `PLACEHOLDER`.

Casos (como mínimo; un caso que crea un comprobante usa una clave propia, `sondeo-<nombre>`):
- Cabecera `Idempotency-Key`: ausente, vacía, de espacios, de 100 y 101 caracteres, con `/`, repetida (dos cabeceras), y ausente con un cuerpo inválido (fija qué error gana).
- Coerciones de cada campo que no es texto, en los tres `POST`: `taxpayerId`, `customerId`, `productId`, `invoiceId` y `replacesDocumentId` con número, booleano, objeto, mayúsculas y sin guiones; `issueDate` con `"2026-11-2"`, `"02/11/2026"`, `"2026-11-02T10:00:00"`, `""`, `20000`, `[2026,11,2]` y `null`; `invoiceLineNo` con `1`, `"1"`, `1.0`, `1.5`, `true` y `"x"`; `quantity`, `unitPrice`, `discount`, `amount`, `term` y `value` como número (`2`, `2.50`, `1e2`, `123456789012.123456`) y como `"007"`.
- Listas: `lines`, `payments` y `reasons` como objeto, texto, `null`, `[]`, `[null]` y por encima del máximo (501 líneas, 21 pagos, 201 líneas de nota, 21 motivos, 2 pagos de nota de débito); `modifiedDocument` como texto y con `code` `"04"`.
- Una propiedad desconocida en el cuerpo y en una línea.
- Repetición: el mismo cuerpo y la misma clave (202, mismo id), el mismo cuerpo con las propiedades en otro orden, con `"quantity": 2` frente a `"quantity": "2"`, y un cuerpo distinto con la misma clave (409).
- Consulta de `/documents`: `page` y `size` como en E2; `documentType` con `01`, `04`, `1`, `02`, `ab`, vacío y repetido; `page=-1&documentType=02` (fija qué error gana).
- Rutas: `{id}` mal formado en `GET /documents/{id}`.
- Una respuesta 2xx de cada ruta: `POST /invoices`, `POST /credit-notes` sobre `{invoiceId}` y a mano, `POST /debit-notes` sobre `{invoiceId}` y a mano, `GET /documents` y `GET /documents/{id}` de cada uno de esos cinco comprobantes.

- [ ] **Step 1: Ampliar el escenario y la normalización, y comprobar que E2 no cambia**

Run: `node tools/java-probe/run.mjs --java-repo ../backend-emite-facil --skip-build --cases e2 && git diff --exit-code test/golden/http/e2.json`
Expected: código 0 y sin diferencias.

- [ ] **Step 2: Escribir los casos y generar**

Run: `node tools/java-probe/run.mjs --java-repo ../backend-emite-facil --skip-build --cases e3`
Expected: código 0; `test/golden/http/e3.json` tiene un resultado por caso y ningún 500.

- [ ] **Step 3: Commit**

```bash
git add tools test/golden/http
git commit -m "test(tools): sondeo HTTP de la API Java para fijar respuestas de E3"
```

---

### Task 2: Decimales con escala, listas anidadas y pendientes de E2

**Files:**
- Create: `src/common/big-decimal.ts`, `scripts/check-fiscal-numbers.mjs`
- Modify: `src/common/bean-validation.ts`, `src/common/validation.ts`, `src/common/java-time.ts`, `src/common/error-codes.ts`, `src/catalog/customer.service.ts`, `src/catalog/product.service.ts`, `test/golden/access-key.spec.ts`, `package.json`
- Test: `test/unit/common/big-decimal.spec.ts`, `test/unit/common/bean-validation.spec.ts`, `test/unit/common/jackson-coercion.spec.ts`, `test/unit/common/java-formats.spec.ts`, `test/unit/common/error-codes.spec.ts`, `test/unit/scripts/check-fiscal-numbers.spec.ts`, `test/integration/catalog/customer-api.int.spec.ts`, `test/integration/catalog/product-api.int.spec.ts`

**Interfaces:**
- Produces en `big-decimal.ts`: `class BigDecimal`, inmutable, sobre un `Decimal` propio (precisión 1000, HALF_UP) más su `scale`:
  - `static of(text: string): BigDecimal`: `new BigDecimal(String)` para texto plano (`-?[0-9]+(\.[0-9]+)?`); la escala es la cantidad de decimales escritos. Es lo que se usa con el texto de la petición y con los `numeric` que devuelve `pg`.
  - `static parse(value: string, maxIntegerDigits: number, maxFractionDigits: number): BigDecimal`: `Decimals.parse` (mismas reglas y mensajes que `parseDecimal`).
  - `static readonly ZERO` (escala 0); `add` y `subtract` (escala: la mayor), `multiply` (suma de escalas), `movePointLeft(n)`, `setScale(scale)` y `divide(divisor, scale)` con HALF_UP, `compareTo` y `signum` (`-1 | 0 | 1`).
  - `toString()`: `BigDecimal.toString()` de Java. Sin exponente en el rango que usa la API (escala de 0 a 12); fuera de él lanza `Error`. `toFixed(scale)` es `Decimals.format`.
- Produces en `bean-validation.ts`, con la conversión y el rechazo que muestre `e3.json`: `JsonLocalDate()` (deja `YYYY-MM-DD`), `JsonObject(type: () => new () => object)`, `JsonList(type: () => new () => object)` (cada elemento a una instancia; `null` se conserva), `NotNullElements()` (mensaje `must not be null` en `campo[i]`, como `List<@NotNull …>`) y `Valid()` (validación anidada). `SpringValidationPipe` nombra los errores anidados `lines[0].quantity` y `modifiedDocument.number`. `Size` cuenta elementos en una lista (`size must be between 1 and 500`).
- Produces en `java-time.ts`: `isoInstant(utc: string): string`, que recibe `YYYY-MM-DDTHH:MM:SS.ffffff` en UTC y devuelve el `ISO_INSTANT` de Jackson: la fracción con 0, 3 o 6 dígitos según haga falta, y `Z`.
- Produces en `error-codes.ts`, en `JAVA_ONLY_ERROR_CODES`: `DOCUMENT_XML_INVALID`, `REPLACED_DOCUMENT_OTHER_TYPE`, `MODIFIED_DOCUMENT_REQUIRED`, `MODIFIED_DOCUMENT_NOT_INVOICE`, `MODIFIED_INVOICE_OTHER_ISSUER`, `MODIFIED_INVOICE_NOT_AUTHORIZED`, `INVALID_MODIFIED_DOCUMENT_DATE`, `CREDIT_LINE_UNKNOWN`, `CREDIT_LINE_EXCEEDS_INVOICE` y `CREDIT_EXCEEDS_INVOICE`.

- Produces: `scripts/check-fiscal-numbers.mjs`, la regla de lint del spec contra `number` en el código fiscal: `npm run lint` la ejecuta después de `oxlint`. Recorre `src/billing`, `src/notes`, `src/xml` y `src/catalog` y falla, con archivo y línea, ante `parseFloat`, `Number.parseFloat`, `Math.round`, `.toFixed(` sobre algo que no sea `BigDecimal` o `Decimal`, `new Decimal(` fuera de `src/common/big-decimal.ts`, y una propiedad o parámetro llamado `quantity`, `unitPrice`, `discount`, `amount`, `subtotal`, `total`, `totalTax`, `totalDiscount`, `rate`, `base`, `value`, `term` o `taxAmount` con tipo `number`. Con `// fiscal-number-ok: <motivo>` en la línea anterior se admite una excepción.

Pendientes de E2 que entran aquí: en la búsqueda de clientes y productos, `pageRequest` se valida antes que `escapeLike` (Java mira `page`/`size` antes que `q`), y la prueba golden de la clave de acceso exige que entre los casos haya restos 10 y 11 reales del módulo 11, no solo que el último dígito coincida.

- [ ] **Step 1: Escribir las pruebas que fallan**

```ts
expect(BigDecimal.of('2.50').toString()).toBe('2.50');
expect(BigDecimal.of('007').toString()).toBe('7');
expect(BigDecimal.of('00.50').toString()).toBe('0.50');
expect(BigDecimal.of('1.5').multiply(BigDecimal.of('9.333333')).toString()).toBe('13.9999995');
expect(BigDecimal.of('13.9999995').setScale(2).toString()).toBe('14.00');
expect(BigDecimal.of('1.00').multiply(BigDecimal.of('1')).divide(BigDecimal.of('3'), 2).toString()).toBe('0.33');
expect(BigDecimal.of('23.00').subtract(BigDecimal.of('0')).toString()).toBe('23.00');
expect(BigDecimal.of('0.30').multiply(BigDecimal.of('15.00')).movePointLeft(2).setScale(2).toString()).toBe('0.05');
expect(isoInstant('2026-11-02T15:15:30.123456')).toBe('2026-11-02T15:15:30.123456Z');
expect(isoInstant('2026-11-02T15:15:30.120000')).toBe('2026-11-02T15:15:30.120Z');
expect(isoInstant('2026-11-02T15:15:30.000000')).toBe('2026-11-02T15:15:30Z');
```

Las coerciones de `bean-validation.spec.ts` y `jackson-coercion.spec.ts` recorren los casos de cuerpo de `e3.json` que no dependen de la base: entrada → valor convertido o rechazo. `check-fiscal-numbers.spec.ts` pasa al script un directorio temporal con `total: number` y con `parseFloat(x)` y exige que falle nombrando ambas líneas, y con `total: BigDecimal` que pase. En las pruebas de clientes y productos: `?page=-1&q=<101 caracteres>` responde el error de la página.

- [ ] **Step 2: Ejecutar y comprobar que fallan**

Run: `npm test && npx vitest run --project integration test/integration/catalog`
Expected: FAIL.

- [ ] **Step 3: Implementar**

- [ ] **Step 4: Ejecutar las pruebas del Step 2 y `npm run lint && npm run typecheck`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(common): decimales con escala, listas anidadas y fechas como Jackson para E3"
```

---

### Task 3: Tipos de comprobante, validación XSD y reglas del sobre

**Files:**
- Create: `src/xml/document-type.ts`, `src/xml/secure-sax.ts`, `src/xml/xsd-validator.ts`, `src/xml/envelope-rules.ts`, `src/xml/xml.module.ts`, `src/billing/document-xml-check.ts`, `tools/golden-generator/src/golden/XsdCases.java`, `test/golden/xsd.json` y `test/golden/xsd/*.xml` (generados)
- Modify: `tools/golden-generator/src/golden/GoldenGenerator.java`, `tools/golden-generator/run.mjs`, `tools/golden-generator/README.md`, `package.json`
- Test: `test/golden/xsd.spec.ts`, `test/unit/xml/document-schemas.spec.ts`, `test/unit/xml/envelope-rules.spec.ts`, `test/unit/xml/xsd-validator.spec.ts`, `test/unit/billing/document-xml-check.spec.ts`

**Interfaces:**
- Produces en `document-type.ts`: `interface DocumentType { name; code; folder; filePrefix; rootElement; infoElement }` con los seis de `xml/DocumentType.java` en `DOCUMENT_TYPES` (`INVOICE`, `PURCHASE_LIQUIDATION`, `CREDIT_NOTE`, `DEBIT_NOTE`, `REMISSION_GUIDE`, `RETENTION_RECEIPT`), y `documentTypeOf(code: string): DocumentType`, que lanza `Error('Tipo de comprobante desconocido: <code>')`. `interface DocumentSchema { name; type: DocumentType; version }` con los trece de `xml/DocumentSchema.java` en `DOCUMENT_SCHEMAS`, `documentSchemaOf(type, version)`, `xsdFile(schema)` y `sampleFile(schema)` (rutas absolutas bajo `resources/xsd/`, con la regla de `resourceDir`/`xsdResource`/`sampleResource`).
- Produces en `secure-sax.ts`: `readXml(xml: Buffer, handler: XmlHandler): void` sobre `saxes` con espacios de nombres, donde `XmlHandler = { open?(uri, local, attributes: ReadonlyMap<string, string>); text?(text); close?(uri, local) }` y los atributos van por `{uri}local`. Lanza `XmlRejectedError` (con `line`) ante un `DOCTYPE` y `XmlMalformedError` (con `line` y el mensaje de `saxes`) ante cualquier error de sintaxis o entidad no predefinida. No resuelve entidades ni abre archivos.
- Produces: `class XsdValidator` con `validate(xml: Buffer, schema: DocumentSchema): Promise<ValidationResult>`, `ValidationResult = { valid: boolean; errors: string[] }`. Nunca lanza por contenido. Primero pasa `readXml`: un `DOCTYPE` da `DOCTYPE no permitido (línea N)` y un XML ilegible, `<mensaje> (línea N)`. Luego valida con `xmllint-wasm`, con solo estos archivos en su sistema de archivos virtual: el XSD del esquema, `xmldsig-core-schema.xsd` de `resources/xsd/common/` y un `XMLSchema.dtd` vacío (equivale a `ClasspathSchemaResolver`). Cada error de libxml2 es `<mensaje> (línea N)`. Los XSD se leen una vez y se guardan en memoria. `XmlModule` exporta `XsdValidator`.
- Produces: `type EnvelopeViolation = 'ROOT_MISMATCH' | 'COD_DOC_MISMATCH' | 'VERSION_MISMATCH' | 'ID_MISSING' | 'SCHEMA_LOCATION_PRESENT' | 'ACCESS_KEY_INVALID' | 'ACCESS_KEY_MISMATCH'` y `checkEnvelope(xml: Buffer, schema: DocumentSchema): Set<EnvelopeViolation>`, con la lógica de `xml/EnvelopeRules.java` (cabeceras solo en su lugar exacto, `xsi:schemaLocation` en cualquier elemento, la guía de remisión sin fecha). Un XML ilegible lanza `Error('XML de comprobante ilegible: …')`.
- Produces en `document-xml-check.ts`: `class DocumentXmlCheck` con `problem(xml: Buffer, schema: DocumentSchema): Promise<string | null>`: más de `320 * 1024` bytes da `El XML supera el tamaño máximo de envío de 320 KB`; si el XSD falla, sus errores unidos con `"; "`; si el sobre falla, las violaciones ordenadas y unidas con `", "`.

Los mensajes de libxml2 y `saxes` no son los de Xerces. Java solo los muestra en el detalle de `DOCUMENT_XML_INVALID`, y ninguna prueba de Java fija ese texto, así que la diferencia se acepta y se anota en `docs/route-inventory.md` (Task 12). Lo que sí debe coincidir con Java es si un XML es válido y qué violaciones del sobre tiene.

La familia `xsd` del generador anota, para cada XML, el resultado de `XsdValidator.validate` y, si es válido, de `EnvelopeRules.check` (o `unreadable` si lanza). Formato: `{ cases: [{ name, file, schema, valid, violations: string[] | 'unreadable' | null }] }`. Casos: cada XML de ejemplo de `resources/xsd` con su esquema, y variantes de `InvoiceXmlFixtures.standard()`: razón social de 301 caracteres, salto de línea en `razonSocialComprador`, `fechaEmision` `2026-10-07`, sin `totalConImpuestos`, `codDoc` `04`, `version="2.0.0"` validado como 1.1.0, `xsi:schemaLocation` en un hijo, clave con dígito verificador incorrecto, clave de otro secuencial, `DOCTYPE` con una entidad externa, archivo vacío y `<factura` sin cerrar. `run.mjs` admite `--only xsd`.

- [ ] **Step 1: Añadir la familia `xsd` al generador y generarla**

Run: `node tools/golden-generator/run.mjs --java-repo ../backend-emite-facil --only xsd`
Expected: código 0. Aparecen `xsd.json` y los XML, y no cambia ningún otro golden.

- [ ] **Step 2: Escribir las pruebas que fallan**

`xsd.spec.ts`: cada caso da el mismo `valid` y las mismas violaciones que Java. Traducir `DocumentSchemasTest` (un XSD que importa `http://example.invalid/x.xsd` o un archivo fuera de `resources/xsd` no valida y no abre conexiones), `ClasspathSchemaResolverTest`, `EnvelopeRulesTest`, `DocumentXmlCheckTest`, `InvoiceXsdIT` y `DocumentSamplesXsdIT`. En `xsd-validator.spec.ts`, además: 200 validaciones seguidas de `factura-estandar/unsigned.xml` tardan menos de 100 ms cada una en el percentil 95.

- [ ] **Step 3: Ejecutar y comprobar que fallan**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 4: Implementar y añadir `xmllint-wasm` y `saxes`**

Si el percentil 95 supera los 100 ms, parar y avisar antes de cambiar de biblioteca: la validación corre con el secuencial bloqueado.

- [ ] **Step 5: Ejecutar pruebas, lint y tipos**

Run: `npm test && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src test tools package.json package-lock.json
git commit -m "feat(xml): validación XSD sin red y reglas del sobre compatibles con Java"
```

---

### Task 4: Cálculo de importes

**Files:**
- Create: `src/billing/tax-math.ts`, `src/billing/invoice-calculator.ts`, `src/notes/debit-note-calculator.ts`, `src/notes/prorated-discount.ts`, `tools/golden-generator/src/golden/CalculationCases.java`, `test/golden/calculations.json` (generado)
- Modify: `tools/golden-generator/src/golden/GoldenGenerator.java`, `tools/golden-generator/run.mjs`, `tools/golden-generator/README.md`
- Test: `test/golden/calculations.spec.ts`, `test/unit/billing/tax-rounding.spec.ts`, `test/unit/notes/debit-note-calculator.spec.ts`

**Interfaces:**
- Consumes: `BigDecimal`, `IVA_TAX_CODE`.
- Produces en `tax-math.ts`: `money(value: BigDecimal): BigDecimal` (escala 2, HALF_UP) y `percentage(base: BigDecimal, rate: BigDecimal): BigDecimal` (`money(base × rate / 100)`; la tarifa viene como `15.00`).
- Produces en `invoice-calculator.ts`: `InvoiceLineInput = { quantity; unitPrice; discount; ivaRateCode: string; ivaRate }`, `LineAmounts = { subtotal; taxAmount }`, `TaxTotal = { taxCode: string; rateCode: string; rate; base; amount }`, `InvoiceTotals = { lines: LineAmounts[]; subtotal; totalDiscount; taxes: TaxTotal[]; totalTax; total }` (todo importe es `BigDecimal`) y `calculateInvoice(lines: InvoiceLineInput[]): InvoiceTotals`, que lanza `InvalidLineError` con los mensajes de `billing/InvoiceCalculator.java`.
- Produces en `debit-note-calculator.ts`: `type NoteTax = TaxTotal`, `DebitInput = { reason: string; value; ivaRateCode: string; ivaRate }`, `DebitReason = { reason; value; taxCode; taxRateCode; taxRate; taxAmount }` y `calculateDebitNote(inputs: DebitInput[]): { reasons: DebitReason[]; taxes: NoteTax[]; subtotal; totalTax; total }`, que lanza `InvalidLineError` con los mensajes de `notes/DebitNoteCalculator.java`.
- Produces: `proratedDiscount(originalDiscount: BigDecimal, originalQuantity: BigDecimal, quantity: BigDecimal): BigDecimal` = `originalDiscount × quantity ÷ originalQuantity`, a dos decimales HALF_UP (`CreditNoteService.proratedDiscount`).

El IVA de cada tarifa se calcula sobre la suma de las bases de esa tarifa, no sumando el de cada línea, y las tarifas se ordenan por `rateCode` como entero. Los acumuladores parten de `money(ZERO)`, de modo que los totales tienen siempre escala 2.

La familia `calculations` del generador ejecuta `InvoiceCalculator.calculate`, `DebitNoteCalculator.calculate` y `CreditNoteService.proratedDiscount` (privado del paquete: por reflexión, como `AccessKeyCases`) sobre los casos de `TaxRoundingTest` y `DebitNoteCalculatorTest` y sobre 300 casos al azar con la semilla `20261029`: cantidad y precio de hasta 6 decimales, descuento hasta el bruto y tarifas `0`, `2`, `3`, `4`, `5`, `8` y `10` con su porcentaje del catálogo. Escribe cada decimal con `toString()`, para conservar la escala, y el mensaje cuando la entrada se rechaza. `run.mjs` admite `--only calculations`.

- [ ] **Step 1: Añadir la familia `calculations` al generador y generarla**

Run: `node tools/golden-generator/run.mjs --java-repo ../backend-emite-facil --only calculations`
Expected: código 0; solo aparece `calculations.json`.

- [ ] **Step 2: Escribir las pruebas que fallan**

`calculations.spec.ts`: cada caso da los mismos importes con la misma escala (`toString()`), o el mismo mensaje. Traducir `TaxRoundingTest` y `DebitNoteCalculatorTest`. Casos con valor exacto:

```ts
const line = (quantity: string, unitPrice: string, discount = '0', code = '4', rate = '15.00') => ({
  quantity: BigDecimal.of(quantity), unitPrice: BigDecimal.of(unitPrice), discount: BigDecimal.of(discount),
  ivaRateCode: code, ivaRate: BigDecimal.of(rate),
});
const three = calculateInvoice([line('1', '0.10'), line('1', '0.10'), line('1', '0.10')]);
expect(three.lines.map((l) => l.taxAmount.toString())).toEqual(['0.02', '0.02', '0.02']);
expect(three.taxes[0].amount.toString()).toBe('0.05'); // sobre la base 0.30, no 3 × 0.02
expect(three.total.toString()).toBe('0.35');
expect(proratedDiscount(BigDecimal.of('1.00'), BigDecimal.of('3'), BigDecimal.of('1')).toString()).toBe('0.33');
expect(() => calculateInvoice([line('0', '1')])).toThrow('La cantidad debe ser mayor que cero');
```

- [ ] **Step 3: Ejecutar y comprobar que fallan**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 4: Implementar**

- [ ] **Step 5: Ejecutar pruebas, lint y tipos**

Run: `npm test && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src test tools
git commit -m "feat(billing): cálculo de factura y notas con el redondeo de Java"
```

---

### Task 5: XML y contenido de los tres tipos

**Files:**
- Create: `src/xml/xml-writer.ts`, `src/xml/invoice-xml.ts`, `src/billing/document-envelope.ts`, `src/billing/json-content.ts`, `src/notes/credit-note-content.ts`, `src/notes/debit-note-content.ts`, `tools/golden-generator/src/golden/DocumentCases.java`, `test/golden/documents.json` y `test/golden/documents/*.xml` (generados)
- Modify: `tools/golden-generator/src/golden/GoldenGenerator.java`, `tools/golden-generator/run.mjs`, `tools/golden-generator/README.md`
- Test: `test/golden/documents.spec.ts`, `test/golden/xades-unsigned.spec.ts`, `test/unit/xml/invoice-xml.spec.ts`, `test/unit/notes/credit-note-xml.spec.ts`, `test/unit/notes/debit-note-xml.spec.ts`, `test/unit/billing/json-content.spec.ts`

**Interfaces:**
- Consumes: `BigDecimal`, `DocumentType`, `DocumentSchema`, `XsdValidator`, `checkEnvelope`, `TaxTotal`, `NoteTax`, `DebitReason`.
- Produces en `xml-writer.ts`: `class XmlWriter` con los métodos de `xml/XmlWriter.java`: `openRoot(name, version)`, `infoTributaria(fields: InfoTributaria)`, `providerInfo(ruc: string | null)`, `open`, `close`, `element`, `optional`, `date(name, isoDate: string)` (`dd/MM/yyyy`), `money(name, value: BigDecimal)`, `scaled(name, value, scale)` y `toBuffer(): Buffer` (UTF-8, con la declaración `<?xml version="1.0" encoding="UTF-8"?>`); `rimpeLegend(regime: string): string | null`; `NORMAL_EMISSION = '1'` y `CURRENCY = 'DOLAR'`. Un carácter que XML 1.0 no admite, incluido un sustituto suelto, lanza `XmlCharacterError` con `Carácter no admitido en XML: U+<hex en minúsculas, sin ceros a la izquierda>`; un régimen desconocido lanza `XmlCharacterError` con `Régimen RIMPE desconocido: <regime>`. Ambos equivalen al `IllegalArgumentException` de Java.
- Produces en `invoice-xml.ts`: `InvoiceXmlData` (los campos de `xml/InvoiceXmlData.java`, con fechas `YYYY-MM-DD` y decimales `BigDecimal`), `buildInvoiceXml(data: InvoiceXmlData): Buffer` e `INVOICE_SCHEMA` (`INVOICE_1_1_0`).
- Produces en `document-envelope.ts`: `DocumentEnvelope = { type: DocumentType; environment; issuer: Issuer; accessKey; establishmentCode; emissionPointCode; sequence: number; issueDate: string; recipient: Recipient; totals: Totals | null; modified: ModifiedDocument | null; providerRuc: string | null }`, con `Issuer`, `Recipient`, `Totals` y `ModifiedDocument` como los records de `billing/DocumentEnvelope.java`, y `documentNumber(envelope): string` (`001-002-000000123`).
- Produces en `json-content.ts`: `contentCodec<C>(shape: ContentShape): { write(content: C): string; read(json: string): C }`. La forma enumera las propiedades en el orden del record y su tipo (`string`, `integer`, `uuid`, `decimal`, `list(shape)`). `write` produce el JSON de `JsonContentKind`: todas las propiedades, `null` incluido, y cada decimal como cadena con `toString()`. `read` lanza `Error` ante una propiedad desconocida, deja `null` la que falta y lee cada decimal con `BigDecimal.of`.
- Produces en `credit-note-content.ts`: `CreditNoteContent = { reason: string; lines: CreditNoteLine[]; taxes: NoteTax[] }`, `CreditNoteLine` (los campos de `CreditNoteContent.Line`, con `invoiceLineNo: number | null` y `productId: string | null`), `CREDIT_NOTE_CODEC` y `buildCreditNoteXml(envelope, content): Buffer` (versión 1.1.0).
- Produces en `debit-note-content.ts`: `DebitNoteContent = { reasons: DebitReason[]; taxes: NoteTax[]; payments: NotePayment[] }`, `NotePayment = { methodCode; amount; term: BigDecimal | null; timeUnit: string | null }`, `DEBIT_NOTE_CODEC` y `buildDebitNoteXml(envelope, content): Buffer` (versión 1.0.0).

Los tres generadores siguen elemento a elemento `xml/InvoiceXmlBuilder.java`, `notes/CreditNoteXmlBuilder.java` y `notes/DebitNoteXmlBuilder.java`: sin espacios entre elementos y con los mismos bytes para los mismos datos. El orden de las propiedades del JSON no llega a la base (`content` es `jsonb`), pero sí a la huella del golden.

La familia `documents` del generador escribe, por caso, el XML y, para las notas, `contentJson` (con `CreditNoteKind` y `DebitNoteKind` construidos con un repositorio nulo). Formato: `{ cases: [{ name, type: '01' | '04' | '05', data | { envelope, content }, xml, contentJson }] }`, con los decimales como cadenas con su escala. Casos: la factura de `InvoiceXmlFixtures.standard()`, con RUC del proveedor, RIMPE emprendedor, negocio popular, agente de retención con contribuyente especial y obligado a llevar contabilidad, caracteres especiales (`& < > " '`, `ñ`, `é` y `😀`), un pago con plazo y sin los opcionales; una nota de crédito sobre una factura (con `invoiceLineNo` y `productId`) y otra a mano (con ambos `null` y descuento `0`); una nota de débito con dos motivos de tarifas distintas, con plazo y sin él. `run.mjs` admite `--only documents`.

- [ ] **Step 1: Añadir la familia `documents` al generador y generarla**

Run: `node tools/golden-generator/run.mjs --java-repo ../backend-emite-facil --only documents`
Expected: código 0; solo aparecen `documents.json` y sus XML.

- [ ] **Step 2: Escribir las pruebas que fallan**

`documents.spec.ts`: cada caso produce los mismos bytes de XML; en las notas, `write(content)` produce el mismo `contentJson`, y `write(read(contentJson))` lo devuelve igual. `xades-unsigned.spec.ts`: `buildInvoiceXml` con los datos de los casos estándar y con RUC del proveedor de `documents.json` produce el `unsigned.xml` de `test/golden/xades/factura-estandar` y `factura-con-ruc-proveedor`, que la firma de E4 usará como entrada. Traducir `InvoiceXmlBuilderTest`, `CreditNoteXmlBuilderTest`, `DebitNoteXmlBuilderTest` (incluido que el resultado pasa el XSD y el sobre con Task 3, y `staysUnderSizeLimitFor500Lines`) y, de `NoteKindsTest`, `contentSurvivesTheJsonRoundTrip`. En `json-content.spec.ts`: una propiedad desconocida al leer lanza; una propiedad que falta queda `null`.

- [ ] **Step 3: Ejecutar y comprobar que fallan**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 4: Implementar**

- [ ] **Step 5: Ejecutar pruebas, lint y tipos**

Run: `npm test && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src test tools
git commit -m "feat(xml): XML de factura y notas y su contenido JSON, byte a byte como Java"
```

---

### Task 6: Repositorio de comprobantes, idempotencia, outbox y tipos

**Files:**
- Create: `src/billing/fiscal-document.repository.ts`, `src/billing/idempotency-store.ts`, `src/billing/outbox-writer.ts`, `src/billing/document-kind.ts`, `src/billing/invoice-kind.ts`, `src/billing/json-content-kind.ts`, `src/notes/credit-note-kind.ts`, `src/notes/debit-note-kind.ts`
- Test: `test/integration/database/billing-schema.int.spec.ts`, `test/integration/database/generic-documents.int.spec.ts`, `test/integration/billing/json-content-kind.int.spec.ts`, `test/integration/billing/fiscal-document-repository.int.spec.ts`, `test/unit/billing/document-kinds.spec.ts`, `test/unit/billing/invoice-kind.spec.ts`, `test/unit/notes/note-kinds.spec.ts`

**Interfaces:**
- Consumes: `DocumentEnvelope`, `BigDecimal`, `TaxTotal`, `contentCodec`, `CREDIT_NOTE_CODEC`, `DEBIT_NOTE_CODEC`, `buildInvoiceXml`, `buildCreditNoteXml`, `buildDebitNoteXml`, `isoInstant`.
- Produces: `class FiscalDocumentRepository`, cuyos métodos reciben `db: Kysely<DB> | Transaction<DB>` como primer parámetro y filtran por `tenantId`, con el SQL y el orden de `billing/FiscalDocumentRepository.java`:
  - escritura (exigen `trx`): `insert(trx, document: NewDocument): Promise<string>`, `insertInvoiceBody(trx, tenantId, documentId, body: InvoiceBody)`, `recordStateChange(trx, tenantId, documentId, previous: string | null, next: string, reason: string | null)` (con `clock_timestamp()`), `schedule(trx, tenantId, documentId, delayMs: number | null, attemptCount: number)` y `linkReplacement(trx, tenantId, documentId, replacedId)`;
  - lectura: `lockForProcessing(trx, tenantId, id): Promise<ProcessingState | null>` (`FOR UPDATE`), `find(db, tenantId, id): Promise<DocumentRow | null>`, `envelope(db, tenantId, id): Promise<DocumentEnvelope | null>`, `content(db, tenantId, id): Promise<string | null>`, `invoiceBody(db, tenantId, id): Promise<InvoiceBody>`, `page(db, tenantId, documentType: string | null, page, size): Promise<DocumentRow[]>`, `count(db, tenantId, documentType): Promise<number>`, `links(db, tenantId, id): Promise<Links>`, `replacementOf(db, tenantId, id): Promise<string | null>`, `creditedTotal(db, tenantId, invoiceId): Promise<BigDecimal>`, `lines`, `taxes` y `payments`.
  - Tipos: `NewDocument`, `NewLine`, `NewPayment`, `DocumentRow`, `LineRow`, `PaymentRow`, `Links` y `ProcessingState`, con los componentes de los records de Java. Los `numeric` llegan como `BigDecimal.of` del texto de `pg`, que trae la escala de la columna, igual que JDBC. `DocumentRow.authorizedAt` es `string | null`, ya con `isoInstant` (se lee `to_char(authorized_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`).
- Produces: `class IdempotencyStore` con `begin(trx, tenantId, key, requestHash): Promise<string | null>` y `complete(trx, tenantId, key, documentId)`, con el SQL de `billing/IdempotencyStore.java` (`ON CONFLICT … DO NOTHING`; una clave con otra huella, o sin documento, da 409 `IDEMPOTENCY_KEY_REUSED` "La clave de idempotencia ya se usó con una petición distinta").
- Produces: `class OutboxWriter` con `write(trx, tenantId, aggregateId, eventType: string, identifiers: Record<string, string>)`.
- Produces en `document-kind.ts`: `interface DocumentKind<C> { type: DocumentType; schema: DocumentSchema; displayName: string; fileStem: string; auditReserved: string; contentJson(content: C): string | null; reloaded(content: C): C; saveDetails(trx, tenantId, documentId, content: C): Promise<void>; loadContent(db, tenantId, documentId): Promise<C>; buildXml(envelope: DocumentEnvelope, content: C): Buffer }` (el RIDE llega en E5) y `class DocumentKinds` con `register(kind)`, que lanza `Error('Hay dos implementaciones para el tipo de comprobante <name>')` ante un tipo repetido, y `find(code: string): DocumentKind<unknown> | null`.
- Produces: `class InvoiceKind implements DocumentKind<InvoiceBody>`, con `InvoiceBody = { lines: NewLine[]; taxes: TaxTotal[]; payments: NewPayment[] }` e `invoiceXmlData(envelope, body): InvoiceXmlData`; `abstract class JsonContentKind<C>` sobre un codec, cuyo `loadContent` lanza `Error('El comprobante <id> no existe o no tiene contenido propio')`; `CreditNoteKind` y `DebitNoteKind`, con nombres, raíces de archivo, acciones de auditoría y esquemas de `notes/CreditNoteKind.java` y `notes/DebitNoteKind.java`.

`BillingModule` y `NotesModule` llegan en las Tasks 7 y 10; aquí las clases se prueban instanciadas a mano.

- [ ] **Step 1: Escribir las pruebas que fallan**

Traducir completos `BillingSchemaIT`, `GenericDocumentsMigrationIT`, `JsonContentKindIT`, `DocumentKindsTest`, `InvoiceKindTest` y, de `NoteKindsTest`, `registryFindsBothNotes`, `creditNoteIdentity`, `debitNoteIdentity` y `xmlIsTheOneOfTheBuilders`. En `fiscal-document-repository.int.spec.ts`: el sobre insertado vuelve igual por `envelope`; una lectura con el `tenantId` de otra empresa no encuentra nada; `creditedTotal` sin notas es `0` (escala 0) y con una nota de `5.00` es `5.00`.

- [ ] **Step 2: Ejecutar y comprobar que fallan**

Run: `npm test && npx vitest run --project integration test/integration/database test/integration/billing`
Expected: FAIL.

- [ ] **Step 3: Implementar**

- [ ] **Step 4: Ejecutar las pruebas del Step 2 y `npm run lint && npm run typecheck`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(billing): repositorio de comprobantes, idempotencia, outbox y tipos de comprobante"
```

---

### Task 7: Emisión de facturas

**Files:**
- Create: `src/billing/catalog-lines.ts`, `src/billing/final-consumer-limit.ts`, `src/billing/document-issuer.ts`, `src/billing/request-hash.ts`, `src/billing/idempotency-key.ts`, `src/billing/invoice.service.ts`, `src/billing/invoice.dto.ts`, `src/billing/invoice.controller.ts`, `src/billing/billing.module.ts`
- Modify: `src/app.module.ts`, `src/config/app-config.ts`, `src/catalog/catalog.repository.ts`, `src/catalog/customer.service.ts`, `src/catalog/product.service.ts`, `src/common/request-context.ts`, `src/observability/logging.ts`
- Test: `test/integration/billing/invoice-api.int.spec.ts`, `test/integration/billing/invoice-idempotency.int.spec.ts`, `test/integration/billing/sequence-concurrency.int.spec.ts`, `test/integration/billing/document-issuer.int.spec.ts`, `test/integration/billing/issuer-snapshot.int.spec.ts`, `test/integration/tenancy/tenant-isolation.int.spec.ts`, `test/support/scenario.ts`

**Interfaces:**
- Consumes: todo lo de las Tasks 2–6, `SequenceService.reserve`, `AccessKeyParts`, `nextNumericCode`, `fiscalDateOf`, `TaxpayerService.findForTenant`, `AuditLog.recordFor`, `CatalogRepository`.
- Produces en `catalog.repository.ts`: `ivaRate(db, rateCode): Promise<BigDecimal | null>` (con la escala 2 de la columna; `ProductService` sigue usándolo solo para saber si existe).
- Produces: `CustomerService.get(access, id, db = this.db)` y `ProductService.get(access, id, db = this.db)`: la emisión les pasa su `trx`.
- Produces en `app-config.ts`: `FINAL_CONSUMER_LIMIT = '50.00'` y `REDELIVERY_LEASE_MS = parseDuration('5m')`, constantes como los plazos de `einvoice.auth.*` (en Java no se leen del entorno).
- Produces en `request-context.ts`: `setDocumentId(id: string): void`; el `mixin` de `logging.ts` añade `documentId` cuando está.
- Produces: `class CatalogLines` con `resolve(trx, access, lines: LineCommand[]): Promise<CatalogLine[]>` y `ivaRate(trx, rateCode): Promise<BigDecimal>` (422 `TAX_RATE_UNKNOWN`), y las funciones `calculateStorable(inputs): InvoiceTotals` (422 `INVALID_LINE` con el mensaje del cálculo y 422 `AMOUNT_TOO_LARGE`) y `requireStorable(...amounts: BigDecimal[])`, con `MAX_AMOUNT = 999999999999.99`. `LineCommand = { productId; quantity: BigDecimal; unitPrice: BigDecimal | null; discount: BigDecimal | null }`, `CatalogLine = { product: ProductView; input: InvoiceLineInput }`.
- Produces: `class FinalConsumerLimit` con `check(trx, identificationType: string, total: BigDecimal): Promise<void>`.
- Produces en `document-issuer.ts`: `class DocumentIssuer` con `issue<C>(access, idempotencyKey: string, requestHash: string, request: IssueRequest, prepare: (trx: Transaction<DB>, context: IssueContext) => Promise<Preparation<C>>): Promise<string>`, `IssueRequest = { taxpayerId; establishmentCode; emissionPointCode; issueDate: string | null; currency: string | null; replacesDocumentId: string | null }`, `IssueContext = { taxpayer: TaxpayerRow; issueDate: string }`, `Preparation<C> = { kind: DocumentKind<C>; customerId: string; recipient: Recipient; totals: Totals | null; modified: ModifiedDocument | null; content: C }` y `recipientOf(customer: CustomerView): Recipient`. Su constructor recibe `now: () => Date` (por omisión, la hora real) para probar el cambio de día.
- Produces: `requestHash(view: unknown): string` (SHA-256 en hexadecimal minúsculo de `JSON.stringify(view)`) y, en `invoice.dto.ts`, `invoiceRequestView(dto: IssueInvoiceDto): object`, con las propiedades de `IssueInvoiceRequest`, `LineRequest` y `PaymentRequest` en el orden de los records de Java y los `null` incluidos: es lo que serializa Jackson en `InvoiceController.requestHash`.
- Produces en `idempotency-key.ts`: `IDEMPOTENCY_HEADER = 'Idempotency-Key'` y `requireIdempotencyKey(key: string | undefined): void`, con los códigos y textos de `InvoiceController.requireIdempotencyKey`.
- Produces: `IssuedResponse = { id; state; statusUrl }` (`/api/v1/documents/<id>`) e `issuedResponse(db, access, id): Promise<IssuedResponse>`, que lee el estado actual tras confirmar. `BillingModule` exporta `FiscalDocumentRepository`, `DocumentIssuer`, `DocumentKinds`, `CatalogLines`, `FinalConsumerLimit`, `IdempotencyStore` y `OutboxWriter`.
- Produces en `scenario.ts`: `billingScenario(http, db): Promise<BillingScenario>` (emisor con establecimiento `001` y punto `001`, cliente con cédula y producto de `10.00` con IVA `4`), `invoiceJson(s, quantity, paymentAmount)`, `issueInvoice(http, token, body, key?)` y `setState(db, documentId, state)`, como `BillingScenario` y los ayudantes de `AbstractIntegrationTest`.

`DocumentIssuer.issue` sigue `billing/DocumentIssuer.java` paso a paso, en una sola `this.db.transaction()`: `requireBilling`, `begin` de idempotencia (si devuelve un id, termina ahí), emisor (`findForTenant` con la `trx`; si no, 404), punto de emisión con el SQL de `emissionPoint`, `EMISSION_POINT_DISABLED`, `UNSUPPORTED_CURRENCY`, fecha (`fiscalDateOf(now())`, `INVALID_ISSUE_DATE` si es futura), `prepare`, reserva del secuencial, clave de acceso (`emissionType` `'1'`), XML con el contenido tal como se leerá (`kind.reloaded` cuando `contentJson` no es `null`) y `DocumentXmlCheck.problem` (un `XmlCharacterError` o un problema dan 422 `DOCUMENT_XML_INVALID` con el detalle recortado a 500 caracteres; sin detalle, "El XML del comprobante no es válido"), inserción en `RESERVED`, `saveDetails`, evento de estado `null → RESERVED`, auditoría `kind.auditReserved` con `{ sequence, environment }`, outbox `DOCUMENT_RESERVED`, `schedule(REDELIVERY_LEASE_MS, 0)`, `complete` de idempotencia y `setDocumentId`. En esta tarea `replacesDocumentId` aún no se usa; lo implementa la Task 9.

`InvoiceService.prepare` sigue `billing/InvoiceService.java`: cliente, líneas, cálculo, pagos (cero con total distinto de cero, forma de pago vigente en la fecha de emisión, plazo con su unidad, en ese orden por pago), suma de pagos y límite de consumidor final. `PaymentCommand` deja `timeUnit` en `null` si viene en blanco y si no lo recorta. El controlador sigue `InvoiceController.issue`: `requireIdempotencyKey` dentro del método (después de la validación del DTO, salvo que `e3.json` muestre otro orden), huella, emisión y 202.

- [ ] **Step 1: Escribir las pruebas que fallan**

Traducir completos `InvoiceIdempotencyIT`, `SequenceConcurrencyIT` (20 emisiones simultáneas dan los secuenciales 1 a 20 y 20 claves de acceso distintas) e `IssuerSnapshotIT`; `InvoiceApiIT` salvo `listsDocumentsOfTheTenant`, `listFiltersByDocumentType`, `unknownDocumentTypeIs400` y `remissionGuideHasNullTotal`, que van a la Task 8; y `DocumentIssuerIT` salvo `replacementMustBeOfTheSameType`, que va a la Task 9. En `issuedXmlEqualsTheWorkerXml`, el XML que recibió `DocumentXmlCheck` es igual, byte a byte, al que se construye después con `envelope` y `loadContent` del comprobante guardado. De `TenantIsolationIT`: `cannotIssueWithForeignTaxpayerCustomerOrProduct`, y `headerOfForeignTenantDoesNotGrantAccess` si E1 no lo tradujo. Añadir las pruebas del Review Focus:

```ts
it('con un pool de 2 conexiones, 10 emisiones simultáneas terminan todas', ...); // DB_POOL_SIZE=2
it('a las 22:30 de Guayaquil la fecha de hoy es la de Guayaquil', ...);          // now = 2026-11-03T03:30:00Z
// issueDate 2026-11-02 → 202; 2026-11-03 → 422 INVALID_ISSUE_DATE; sin issueDate → issue_date 2026-11-02
it('un carácter que XML no admite en el cliente es 422 y no consume el secuencial', ...);
// UPDATE customers SET name = E'Mar\u0001ía' → detail 'Carácter no admitido en XML: U+1'
// legal_name del emisor con 301 caracteres → 422 DOCUMENT_XML_INVALID con detail de 500 caracteres o menos
it('el log de la emisión lleva el documentId', ...);
```

Las respuestas de cantidades como número y de propiedades desconocidas son las de `e3.json`.

- [ ] **Step 2: Ejecutar y comprobar que fallan**

Run: `npx vitest run --project integration test/integration/billing test/integration/tenancy/tenant-isolation.int.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar**

- [ ] **Step 4: Ejecutar las pruebas del Step 2, las de `test/integration/catalog` y `npm run lint && npm run typecheck`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(billing): emisión de facturas con idempotencia, XML validado y outbox"
```

---

### Task 8: Consulta de comprobantes

**Files:**
- Create: `src/billing/document.controller.ts`, `src/billing/document-views.ts`
- Modify: `src/billing/billing.module.ts`, `src/common/query-params.ts`
- Test: `test/integration/billing/document-api.int.spec.ts`, `test/integration/tenancy/tenant-isolation.int.spec.ts`, `test/integration/catalog/customer-api.int.spec.ts`

**Interfaces:**
- Consumes: `FiscalDocumentRepository`, `DocumentKinds`, `pageRequest`, `IntQueryPipe`, `UuidPipe`, `BigDecimal.toFixed`.
- Produces en `query-params.ts`: `OptionalStringQueryPipe`, que deja `null` si el parámetro no viene, con la conversión de Spring para valores vacíos o repetidos que muestre `e3.json`.
- Produces en `document-views.ts`: `DocumentSummary`, `DocumentView`, `CustomerView`, `TaxView`, `LineView`, `PaymentView`, `ModifiedDocumentView` y `ReasonView` con las propiedades de los records de `billing/DocumentController.java`, en su orden, y `documentView(row, links, envelope, parts): DocumentView`. `parts` = `{ taxes; lines; payments; reason; reasons }`; la factura (y cualquier tipo sin `DocumentKind` de nota, como la guía `06`) los saca de las tablas hijas. Las ramas de `04` y `05` llegan en las Tasks 10 y 11.
- Produces: `GET /documents` (`page`, `size`, `documentType`) y `GET /documents/{id}`, con `TenantAccessGuard` y sin control de rol.

Formatos de `DocumentController.java`: importes a 2 decimales (`null` sigue `null`), cantidad y precio a 6, `sequence` a nueve dígitos, `number` = establecimiento-punto-secuencial, `creditedTotal` solo en facturas, `authorizedAt` con `isoInstant`. El listado valida `page` y `size` antes de `documentType`, que si no es un código conocido da 400 `MALFORMED_REQUEST` "Tipo de comprobante desconocido", y se ordena por `created_at DESC, sequence DESC, id`.

- [ ] **Step 1: Escribir las pruebas que fallan**

De `InvoiceApiIT`: `listsDocumentsOfTheTenant`, `listFiltersByDocumentType`, `unknownDocumentTypeIs400` y `remissionGuideHasNullTotal`. De `TenantIsolationIT`: `documentOfAnotherTenantIsNotFound`. De `CustomerApiIT`: `removingCustomerAndProductPreservesIssuedInvoice`. Añadir la del Review Focus:

```ts
// UPDATE fiscal_documents SET state = 'AUTHORIZED', authorization_number = …, authorized_at = $1
// '2026-11-02 10:15:30.123456-05' → authorizedAt '2026-11-02T15:15:30.123456Z'
// '2026-11-02 10:15:30-05'        → authorizedAt '2026-11-02T15:15:30Z'
```

- [ ] **Step 2: Ejecutar y comprobar que fallan**

Run: `npx vitest run --project integration test/integration/billing/document-api.int.spec.ts test/integration/tenancy/tenant-isolation.int.spec.ts test/integration/catalog/customer-api.int.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar**

- [ ] **Step 4: Ejecutar las pruebas del Step 2 y `npm run lint && npm run typecheck`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(billing): listado y detalle de comprobantes"
```

---

### Task 9: Reemisión

**Files:**
- Modify: `src/billing/document-issuer.ts`
- Test: `test/integration/billing/invoice-reissue.int.spec.ts`, `test/integration/billing/document-issuer.int.spec.ts`

**Interfaces:**
- Consumes: `FiscalDocumentRepository.lockForProcessing`, `replacementOf`, `linkReplacement`, `AuditLog.recordFor`.
- Produces: `DocumentIssuer.issue` con `request.replacesDocumentId`, como `requireReplaceable` de `billing/DocumentIssuer.java`: después del `begin` de idempotencia y antes del emisor bloquea el comprobante que se reemplaza (ajeno o inexistente: 404); solo `RETURNED`, `NOT_AUTHORIZED` o `XSD_INVALID` (409 `REPLACED_DOCUMENT_NOT_REJECTED`), del mismo emisor (409 `REPLACED_DOCUMENT_OTHER_ISSUER`) y sin reemplazo previo (409 `DOCUMENT_ALREADY_REPLACED`). Tras `prepare`, un tipo distinto da 409 `REPLACED_DOCUMENT_OTHER_TYPE` "El comprobante que se reemplaza es de otro tipo". Tras el outbox, `linkReplacement` y la auditoría `DOCUMENT_REPLACED` sobre el reemplazado con `{ replacedBy }`.

Java lleva el comprobante a `RETURNED`, `NOT_AUTHORIZED` o `XSD_INVALID` con el SRI simulado y el worker; en E3 se pone el estado por SQL (`setState`). Las comprobaciones de artefactos de `aRejectedDocumentIsReplacedByANewOneAndBothSayIt` se añaden en E4, cuando existan.

- [ ] **Step 1: Escribir las pruebas que fallan**

Traducir `InvoiceReissueIT` completo, con los estados puestos por SQL, y de `DocumentIssuerIT`, `replacementMustBeOfTheSameType` (con `DocumentIssuer` y un `DocumentKind` de prueba de tipo `04`). Añadir: dos reemisiones simultáneas del mismo comprobante dejan una sola en 202 y la otra en 409 `DOCUMENT_ALREADY_REPLACED`.

- [ ] **Step 2: Ejecutar y comprobar que fallan**

Run: `npx vitest run --project integration test/integration/billing/invoice-reissue.int.spec.ts test/integration/billing/document-issuer.int.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar**

- [ ] **Step 4: Ejecutar las pruebas del Step 2 y `npm run lint && npm run typecheck`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(billing): reemisión de comprobantes devueltos, no autorizados o con XML inválido"
```

---

### Task 10: Notas de crédito

**Files:**
- Create: `src/notes/modified-invoices.ts`, `src/notes/credit-note.service.ts`, `src/notes/credit-note.dto.ts`, `src/notes/credit-note.controller.ts`, `src/notes/notes.module.ts`
- Modify: `src/app.module.ts`, `src/billing/document-views.ts`, `src/billing/document.controller.ts`, `test/support/scenario.ts`
- Test: `test/integration/notes/credit-note-api.int.spec.ts`, `test/integration/notes/notes-view.int.spec.ts`

**Interfaces:**
- Consumes: `DocumentIssuer`, `CatalogLines`, `calculateStorable`, `proratedDiscount`, `CreditNoteKind`, `FiscalDocumentRepository`, `CustomerService.get`, `requestHash`, `requireIdempotencyKey`, `issuedResponse`.
- Produces en `modified-invoices.ts`: `class ModifiedInvoices` con `lockForNote(trx, access, invoiceId, taxpayerId): Promise<ModifiedInvoice>`, `ModifiedInvoice = { id; number; issueDate; total: BigDecimal; customerId; buyer: Recipient; lines: LineRow[] }`, `modifiedDocumentOf(invoice)` y `writtenModifiedDocument(written: WrittenInvoice)`, `WrittenInvoice = { number; issueDate }`, y las funciones `requireOneModifiedDocument(invoiceId, written, customerId)` y `requireNotLater(modifiedDate, noteDate)`. Códigos, textos y orden de `notes/ModifiedInvoices.java`.
- Produces: `class CreditNoteService` con `issue(access, idempotencyKey, requestHash, command: IssueCreditNoteCommand): Promise<string>`, que sigue `notes/CreditNoteService.java`: `requireOneModifiedDocument` y la forma de las líneas (400 `VALIDATION_FAILED` "La petición no cumple las reglas de validación" con sus errores por línea) antes de `DocumentIssuer.issue`; sobre una factura de la plataforma, la bloquea, copia sus líneas y su comprador, y comprueba el saldo con `creditedTotal` (en el mensaje, el saldo con `toString()`, escala 2); a mano, el cliente y las líneas del catálogo. `reason` llega recortado (`strip`).
- Produces en `credit-note.dto.ts`: `IssueCreditNoteDto`, `CreditLineDto`, `ModifiedDocumentDto` (que la Task 11 reutiliza) y `creditNoteRequestView(dto)`, con el orden de los records de `CreditNoteController.java` para la huella.
- Produces: `NotesModule`, que importa `BillingModule` y registra `CreditNoteKind` (y en la Task 11 `DebitNoteKind`) en `DocumentKinds` al iniciar. `document-views.ts` gana la rama `04`: `reason`, líneas del contenido con `invoiceLineNo` y sin pagos.

- [ ] **Step 1: Escribir las pruebas que fallan**

Traducir completo `CreditNoteApiIT` (la factura modificada se autoriza con `setState`; `concurrentNotesNeverExceedTheInvoice` lanza notas simultáneas sobre la misma factura y exige que la suma no supere su total), y de `NotesViewIT`, `creditNoteViewShowsModifiedDocumentReasonAndLines` e `invoiceViewShowsCreditedTotal`. Valores exactos del contenido de una nota sobre la factura de cantidad 2 del escenario, devolviendo 1:

```ts
// content->'lines'->0: quantity '1', unitPrice '10.000000', discount '0.00', taxRate '15.00',
// subtotal '10.00', taxAmount '1.50', invoiceLineNo 1
// reason "Devolución \ud800" → 422 DOCUMENT_XML_INVALID 'Carácter no admitido en XML: U+d800', sin secuencial consumido
```

- [ ] **Step 2: Ejecutar y comprobar que fallan**

Run: `npx vitest run --project integration test/integration/notes`
Expected: FAIL.

- [ ] **Step 3: Implementar**

- [ ] **Step 4: Ejecutar las pruebas del Step 2 y `npm run lint && npm run typecheck`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(notes): notas de crédito sobre facturas de la plataforma y escritas a mano"
```

---

### Task 11: Notas de débito

**Files:**
- Create: `src/notes/debit-note.service.ts`, `src/notes/debit-note.dto.ts`, `src/notes/debit-note.controller.ts`
- Modify: `src/notes/notes.module.ts`, `src/billing/document-views.ts`, `src/billing/document.controller.ts`
- Test: `test/integration/notes/debit-note-api.int.spec.ts`, `test/integration/notes/notes-view.int.spec.ts`

**Interfaces:**
- Consumes: `DocumentIssuer`, `ModifiedInvoices`, `CatalogLines.ivaRate`, `requireStorable`, `calculateDebitNote`, `FinalConsumerLimit`, `CatalogRepository.paymentMethodValidOn`, `DebitNoteKind`, `ModifiedDocumentDto`, `requestHash`, `requireIdempotencyKey`, `issuedResponse`.
- Produces: `class DebitNoteService` con `issue(access, idempotencyKey, requestHash, command: IssueDebitNoteCommand): Promise<string>`, que sigue `notes/DebitNoteService.java`: `requireOneModifiedDocument`; dentro de la emisión, comprador y documento modificado, `requireNotLater`, tarifas de cada motivo en su orden (422 `TAX_RATE_UNKNOWN`), cálculo (422 `INVALID_LINE`), `requireStorable(subtotal, total)`, plazo con su unidad, forma de pago vigente, pago igual al total (422 `PAYMENTS_MISMATCH` "El pago no coincide con el total del comprobante") y límite de consumidor final. Los totales del sobre llevan `totalDiscount` `0` (escala 0).
- Produces en `debit-note.dto.ts`: `IssueDebitNoteDto`, `ReasonDto`, `DebitPaymentDto` y `debitNoteRequestView(dto)`. `NotesModule` registra `DebitNoteKind`. `document-views.ts` gana la rama `05`: `reasons`, impuestos y pagos del contenido, sin líneas.

- [ ] **Step 1: Escribir las pruebas que fallan**

Traducir completo `DebitNoteApiIT` y, de `NotesViewIT`, `debitNoteViewShowsReasonsAndPayments`.

- [ ] **Step 2: Ejecutar y comprobar que fallan**

Run: `npx vitest run --project integration test/integration/notes`
Expected: FAIL.

- [ ] **Step 3: Implementar**

- [ ] **Step 4: Ejecutar las pruebas del Step 2 y `npm run lint && npm run typecheck`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(notes): notas de débito con motivos, IVA por tarifa y un pago"
```

---

### Task 12: Respuestas iguales a las de Java y comprobantes emitidos por Java

**Files:**
- Modify: `test/integration/java-probes.int.spec.ts`, `tools/java-dump/run.mjs`, `tools/java-dump/README.md`, `test/fixtures/java-e1/*` (regenerados), `test/integration/identity/java-compat.int.spec.ts`, `README.md`, `docs/route-inventory.md`

**Interfaces:**
- Consumes: `runScenario` con `hooks.authorize`, `runProbes`, `normalize`, y la API de NestJS completa de E3.

`java-dump` emite además por la API Java, cada uno con su `Idempotency-Key`: una factura de dos líneas con tarifas distintas y dos pagos (uno con plazo), que luego pasa a `AUTHORIZED` por SQL con `authorization_number` y un `authorized_at` con microsegundos; una nota de crédito sobre ella; una nota de crédito a mano; y una nota de débito sobre ella. Guarda en `requests.json` cada clave con su cuerpo exacto y en `views.json` lo que Java responde a `GET /documents/{id}` de cada uno y a `GET /documents`. `meta.json` gana `invoiceId`, `creditNoteId`, `manualCreditNoteId` y `debitNoteId`.

- [ ] **Step 1: Escribir las pruebas que fallan**

`java-probes.int.spec.ts` ejecuta también los casos de `e3.json`, con `hooks.authorize` sobre la base de NestJS, y exige el mismo resultado normalizado. En `java-compat.int.spec.ts`:

```ts
it('los comprobantes que emitió Java se ven igual', ...);           // GET de NestJS == views.json, sin correlationId
it('el reintento con la clave que registró Java devuelve el mismo comprobante', ...); // 202 y el mismo id: misma huella
it('una nota de crédito nueva cuenta la que emitió Java en el saldo', ...);          // CREDIT_EXCEEDS_INVOICE con el saldo restante
```

- [ ] **Step 2: Regenerar los datos y ejecutar**

Run: `node tools/java-dump/run.mjs --java-repo ../backend-emite-facil --skip-build && npx vitest run --project integration test/integration/java-probes.int.spec.ts test/integration/identity/java-compat.int.spec.ts`
Expected: la generación termina con código 0 y las pruebas pasan. Si aparece una diferencia, se corrige en NestJS, no en el golden.

- [ ] **Step 3: Actualizar la documentación**

README: estado E3. `docs/route-inventory.md`: marcar como portadas las 5 rutas de E3 (45 en total) y anotar en "Diferencias" que Java devuelve los diez códigos nuevos de `JAVA_ONLY_ERROR_CODES` sin que `openapi.yaml` los declare, y que el detalle de `DOCUMENT_XML_INVALID` por XSD o XML ilegible trae el mensaje de libxml2 o de `saxes` en lugar del de Xerces.

- [ ] **Step 4: Ejecutar toda la suite**

Run: `npm run lint && npm run typecheck && npm test && npm run build && npm run test:integration && npm audit --omit=dev --audit-level=high`
Expected: todo pasa.

- [ ] **Step 5: Commit**

```bash
git add tools test src README.md docs
git commit -m "test(e3): respuestas iguales a las de Java y comprobantes emitidos por Java"
```
