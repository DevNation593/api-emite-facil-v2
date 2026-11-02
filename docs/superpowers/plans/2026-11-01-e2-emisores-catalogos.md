# E2 Emisores y catálogos — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Portar emisores, establecimientos, puntos de emisión, catálogos del SRI, clientes, productos, secuenciales y certificados de firma con el comportamiento de Java, de modo que un certificado cargado por Java siga sirviendo para firmar en NestJS.

**Architecture:** Un módulo Nest por módulo Java (`catalog`, `taxpayer`, `sequence`, `certificate`). Los servicios escriben con Kysely en transacciones explícitas y auditan con `AuditLog` dentro de ellas. Las violaciones de unicidad se traducen por el nombre de la restricción, como `DataIntegrityViolationException` en Java. La coerción de Jackson y los parámetros de consulta de Spring no se adivinan: se capturan de la API Java real con una herramienta de sondeo y se reproducen hasta que las respuestas coinciden.

**Tech Stack:** Lo de E1, más `decimal.js` 10, `luxon` 3 y `node-forge` 1 (dev: `@types/luxon`, `@types/node-forge`).

**Spec:** [docs/superpowers/specs/2026-10-29-api-nestjs-design.md](../specs/2026-10-29-api-nestjs-design.md)

**Rama:** `feat/e2-emisores-catalogos`, sobre `feat/e1-identidad` (el PR #2 aún no está mezclado).

## Global Constraints

- Referencia de comportamiento: `../backend-emite-facil` (commit `ca53bca`). Ante cualquier duda manda el código Java; las rutas Java son relativas a `src/main/java/com/example/einvoice/`.
- Las reglas de `AGENTS.md` aplican: textos y commits en español, identificadores en inglés, imports con extensión `.js`, y P0/P1 de revisión.
- Mismos textos de error, `errorCode`, estados HTTP, nombres de propiedades y su orden que Java. Los records de Java serializan en el orden en que declaran sus componentes, y los `null` se serializan.
- `tenantId` solo sale de `TenantAccess`. Toda consulta de datos de empresa filtra por él; un recurso de otra empresa responde igual que uno inexistente: 404 `NOT_FOUND` "Recurso no encontrado".
- Importes y precios con `decimal.js`, nunca `number`. Las tarifas, los tipos de identificación y las formas de pago salen de la base, nunca de constantes.
- Nunca en logs, errores, auditoría ni respuestas: el `.p12`, su contraseña, la clave maestra ni el contenido cifrado. La auditoría de clientes no guarda datos personales (solo `idType`).
- Una violación de unicidad se reconoce por `code === '23505'` y el nombre exacto de la restricción: `taxpayers_ruc_key`, `establishments_taxpayer_id_code_key`, `emission_points_establishment_id_code_key`, `customers_identification_key`, `products_sku_key`.
- Las pruebas de integración necesitan Docker en marcha.

## Review Focus

- Un JSON con el tipo equivocado donde Java espera algo que no es texto (`"nextValue": "5"`, `5.7` o `true`; `"taxpayerId": "x"`; `"accountingRequired": "si"`; `"rimpeRegime": "emprendedor"`) responde lo mismo que Jackson en Java (Tasks 1 y 2).
- Parámetros de consulta raros (`page=abc`, `page=-1`, `page=1&page=2`, `size=0`, `q` de 101 caracteres, `q=%`, `establishmentId` ausente o mal formado) responden lo mismo que Spring, y `%` y `_` se buscan como texto literal (Tasks 1, 2 y 5).
- El campo `p12` con saltos de línea, sin relleno `=` o con caracteres de Base64 URL: `Buffer.from(…, 'base64')` acepta todo eso y el decodificador de Java no. Se responde como Java (Tasks 1 y 8).
- Certificados reales que no son el caso de prueba: clave EC, contraseña con `ñ`, PKCS#12 heredado (3DES y RC2, como los que exporta Windows) y DN con comas, tildes, `SERIALNUMBER` y correo. El resultado y el texto de `subject` e `issuer` son los de Java (Task 7).
- La edición de un cliente o producto que otra petición acaba de borrar da 409 `CATALOG_CHANGED` y nunca lo revive (Task 5).

---

### Task 1: Sondeo de la API Java por HTTP

**Files:**
- Create: `tools/java-dump/java-app.mjs`, `tools/java-probe/run.mjs`, `tools/java-probe/probe.mjs`, `tools/java-probe/probe.d.mts`, `tools/java-probe/cases/e2.json`, `tools/java-probe/README.md`, `test/golden/http/e2.json` (generado)
- Modify: `tools/java-dump/run.mjs`, `tools/java-dump/README.md`

**Interfaces:**
- Produces en `java-app.mjs`: `startJavaApp({ javaRepo, skipBuild, env }): Promise<{ base: string; postgres; stop(): Promise<void>; logTail(): string }>`, con el arranque, la espera de la readiness, el directorio de sockets de Windows y el `taskkill /T` que hoy están en `java-dump/run.mjs`. `java-dump/run.mjs` pasa a usarlo sin cambiar lo que genera.
- Produces en `probe.mjs`: `runScenario(send): Promise<Scenario>`, `runProbes(send, cases, scenario): Promise<ProbeResult[]>` y `normalize(value, scenario)`, con `send(req: { method; path; headers; body?: string }) => Promise<{ status; headers; body: string }>`. `probe.d.mts` declara sus tipos para TypeScript.
- Produces: `test/golden/http/e2.json` = `{ source: { javaCommit, generatedAt }, results: [{ name, request, status, contentType, allow?, body }] }`.

`runScenario` registra e ingresa una persona, crea una empresa, un emisor con RUC `1790012345001`, el establecimiento `001`, el punto de emisión `001`, un cliente y un producto, y devuelve sus ids y el token. Cada caso de `cases/e2.json` es `{ name, method, path, query?, body?, rawBody?, auth: 'owner' | 'none' }`, con `{taxpayerId}`, `{establishmentId}`, `{emissionPointId}`, `{customerId}` y `{productId}` en la ruta, la consulta o el cuerpo. `normalize` quita `correlationId`, cambia cada valor del escenario por su marcador, cualquier otro UUID por `{uuid}` y las fechas ISO por `{timestamp}`.

Casos (uno por línea de `cases/e2.json`, como mínimo):
- Cuerpos: cada campo no textual con texto, número decimal, booleano, objeto, array y `null` (`nextValue`, `taxpayerId`, `establishmentId`, `accountingRequired`, `rimpeRegime` en minúsculas y con un valor desconocido); `nextValue` de `1e3`, `2147483648` y `"0x10"`.
- `p12` con salto de línea, sin relleno, con `-` y `_`, vacío tras decodificar y con longitud `4n+1`.
- Consulta: `page` y `size` con `abc`, `-1`, `1.5`, ` 2`, `+2`, `0x10`, vacíos, repetidos y fuera de rango; `q` repetido, con `%`, `_`, `\`, 100 y 101 caracteres y un carácter de control; `establishmentId` y `taxpayerId` ausentes, vacíos, mal formados y en mayúsculas.
- Rutas: `{id}` mal formado en cada ruta con id; `PUT /customers` sin id; `PATCH /taxpayers/{taxpayerId}` sin cuerpo.
- Una respuesta 2xx de cada ruta de E2, para fijar la forma, el orden de las propiedades y los `null`.

- [ ] **Step 1: Extraer `java-app.mjs` y comprobar que `java-dump` sigue igual**

Run: `node tools/java-dump/run.mjs --java-repo ../backend-emite-facil --skip-build && npx vitest run --project integration test/integration/identity/java-compat.int.spec.ts`
Expected: código 0 y PASS.

- [ ] **Step 2: Escribir `probe.mjs`, `run.mjs` y los casos, y generar**

Run: `node tools/java-probe/run.mjs --java-repo ../backend-emite-facil --skip-build --cases e2`
Expected: código 0; `test/golden/http/e2.json` tiene un resultado por caso y ningún 500.

- [ ] **Step 3: Commit**

```bash
git add tools test/golden/http
git commit -m "test(tools): sondeo HTTP de la API Java para fijar respuestas de E2"
```

---

### Task 2: Utilidades comunes de E2

**Files:**
- Create: `src/common/decimals.ts`, `src/common/pagination.ts`, `src/common/like-terms.ts`, `src/common/query-params.ts`, `src/database/unique-violation.ts`
- Modify: `src/common/bean-validation.ts`, `src/common/error-codes.ts`, `src/apikey/api-key.service.ts`, `tools/golden-generator/src/golden/ValidationCases.java`, `tools/golden-generator/run.mjs`, `test/golden/bean-validation.json` (generado), `package.json`
- Test: `test/unit/common/decimals.spec.ts`, `test/unit/common/pagination.spec.ts`, `test/unit/common/like-terms.spec.ts`, `test/unit/common/query-params.spec.ts`, `test/unit/common/bean-validation.spec.ts`, `test/unit/common/error-codes.spec.ts`

**Interfaces:**
- Produces en `bean-validation.ts`: `Pattern(regexp: string)` (mensaje `must match "<regexp>"`, coincidencia completa), `Min(value: number)`, `Max(value: number)`, y las coerciones de Jackson `JsonUuid()`, `JsonInteger()`, `JsonBoolean()` y `JsonEnum(values: readonly string[])`. Lo que cada una admite, convierte o rechaza (y con qué respuesta) es lo que muestre `test/golden/http/e2.json`.
- Produces en `decimals.ts`: `QUANTITY_OR_PRICE = '[0-9]{1,12}(\\.[0-9]{1,6})?'`, `AMOUNT = '[0-9]{1,12}(\\.[0-9]{1,2})?'`, `parseDecimal(value: string, maxIntegerDigits: number, maxFractionDigits: number): Decimal`, que lanza `Error` como `Decimals.parse`, y `formatDecimal(value: Decimal.Value, scale: number): string`, con HALF_UP y sin exponente.
- Produces en `pagination.ts`: `MAX_PAGE_SIZE = 100`, `MAX_PAGE = 100_000`, `pageRequest(page: number, size: number): { page: number; size: number; offset: number }`, que fuera de rango lanza 400 `MALFORMED_REQUEST` "page debe estar entre 0 y 100000 y size entre 1 y 100", y `type PageResponse<T> = { items: T[]; page: number; size: number; total: number }`.
- Produces en `like-terms.ts`: `escapeLike(term: string | undefined): string`. Con más de 100 caracteres (unidades UTF-16, como `length()`) o algún carácter de control, lanza 400 `MALFORMED_REQUEST` "El término de búsqueda admite hasta 100 caracteres y ninguno de control". Si no, hace `strip` y escapa `\`, `%` y `_`.
- Produces en `query-params.ts` los pipes de consulta: `IntQueryPipe(defaultValue: number)`, `StringQueryPipe(defaultValue: string)` y `RequiredUuidQueryPipe`, con la conversión de Spring que muestre el golden. Un valor que no se convierte da 400 `MALFORMED_REQUEST` "La petición está mal formada".
- Produces: `isUniqueViolation(error: unknown, constraint: string): boolean`. `api-key.service.ts` pasa a usarla.
- Produces en `error-codes.ts`: `CATALOG_CHANGED`, en una lista aparte `JAVA_ONLY_ERROR_CODES`. Java lo devuelve y `openapi.yaml` no lo declara; `error-codes.spec.ts` exige que la lista del contrato más esa lista sumen `ErrorCode`.

- [ ] **Step 1: Ampliar `bean-validation.json` con `@Pattern`, `@Min` y `@Max`**

`ValidationCases.java` añade `@Pattern(regexp = "[0-9]{3}")`, `@Min(1)` y `@Max(999_999_999)` con valores válidos, en el límite y fuera. `run.mjs` ya admite `--only bean-validation`.

Run: `node tools/golden-generator/run.mjs --java-repo ../backend-emite-facil --only bean-validation`
Expected: código 0; solo cambia `bean-validation.json`.

- [ ] **Step 2: Escribir las pruebas que fallan**

Traducir `DecimalsTest`. Casos con valor exacto:

```ts
expect(formatDecimal('1.5', 6)).toBe('1.500000');
expect(formatDecimal('0.0000005', 6)).toBe('0.000001'); // HALF_UP
expect(formatDecimal('1E+3', 2)).toBe('1000.00');
expect(() => parseDecimal('-1', 12, 6)).toThrow();
expect(() => parseDecimal('1e3', 12, 6)).toThrow();
expect(escapeLike(' 50%_a\\b ')).toBe('50\\%\\_a\\\\b');
expect(() => escapeLike('a'.repeat(101))).toThrow(ApiException);
expect(pageRequest(2, 20)).toEqual({ page: 2, size: 20, offset: 40 });
expect(() => pageRequest(0, 101)).toThrow(ApiException);
```

`query-params.spec.ts` y las coerciones de `bean-validation.spec.ts` recorren los casos de consulta y de cuerpo de `test/golden/http/e2.json` que no dependen de la base: entrada → valor convertido o rechazo.

- [ ] **Step 3: Ejecutar y comprobar que fallan**

Run: `npx vitest run --project unit test/unit/common`
Expected: FAIL.

- [ ] **Step 4: Implementar y añadir `decimal.js` a las dependencias**

- [ ] **Step 5: Ejecutar pruebas, lint y tipos**

Run: `npm test && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src test tools package.json package-lock.json
git commit -m "feat(common): decimales, paginación, búsqueda y coerciones de Jackson de E2"
```

---

### Task 3: Catálogos del SRI

**Files:**
- Create: `src/catalog/catalog.repository.ts`, `src/catalog/catalog.controller.ts`, `src/catalog/catalog.module.ts`
- Modify: `src/app.module.ts`
- Test: `test/integration/catalog/catalog.int.spec.ts`

**Interfaces:**
- Consumes: `DATABASE`, `formatDecimal`.
- Produces: `class CatalogRepository` cuyos métodos reciben `db: Kysely<DB> | Transaction<DB>` como primer parámetro: `identificationTypes(db): Promise<CodeName[]>`, `identificationType(db, code): Promise<IdentificationType | null>`, `isFinalConsumerNumber(db, idNumber): Promise<boolean>`, `paymentMethods(db): Promise<PaymentMethod[]>`, `paymentMethodValidOn(db, code, date: string): Promise<boolean>`, `taxRates(db): Promise<TaxRate[]>` e `ivaRate(db, rateCode): Promise<Decimal | null>`. `IVA_TAX_CODE = '2'`. `CatalogModule` exporta `CatalogRepository`.
- Produces: `CodeName = { code; name }`, `IdentificationType = { code; name; idNumberPattern; finalConsumer }`, `PaymentMethod = { code; name; validFrom: string; validTo: string | null }` (fechas `YYYY-MM-DD`, como `LocalDate`), `TaxRate = { taxCode; rateCode; description; rate: Decimal }`.

Consultas y orden de `catalog/CatalogRepository.java`: los patrones de identificación son regex de Java que se comparan completos (`^(?:…)$`); las tarifas se ordenan por `tax_code` y por `CAST(rate_code AS integer)`. `GET /catalogs/tax-rates` responde `rate` con 2 decimales. Las rutas exigen identidad (persona o API key), no empresa: sin `TenantAccessGuard`.

- [ ] **Step 1: Escribir las pruebas que fallan**

Traducir `CatalogIT` completo.

- [ ] **Step 2: Ejecutar y comprobar que fallan**

Run: `npx vitest run --project integration test/integration/catalog/catalog.int.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar**

- [ ] **Step 4: Ejecutar las pruebas del Step 2 y `npm run lint && npm run typecheck`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(catalog): catálogos de identificación, formas de pago y tarifas"
```

---

### Task 4: Emisores, establecimientos y puntos de emisión

**Files:**
- Create: `src/taxpayer/taxpayer.service.ts`, `src/taxpayer/taxpayer.controller.ts`, `src/taxpayer/taxpayer.dto.ts`, `src/taxpayer/establishment.service.ts`, `src/taxpayer/establishment.controller.ts`, `src/taxpayer/emission-point.controller.ts`, `src/taxpayer/taxpayer.module.ts`
- Modify: `src/app.module.ts`
- Test: `test/integration/taxpayer/taxpayer-api.int.spec.ts`, `test/integration/taxpayer/taxpayer-fiscal-data.int.spec.ts`, `test/integration/taxpayer/establishment-api.int.spec.ts`, `test/integration/taxpayer/emission-point-api.int.spec.ts`, `test/integration/tenancy/tenant-isolation.int.spec.ts`

**Interfaces:**
- Consumes: `TenantAccess`, `AuditLog`, `UuidPipe`, `RequiredUuidQueryPipe`, `isUniqueViolation`, `Pattern`, `JsonBoolean`, `JsonEnum`, `JsonUuid`.
- Produces: `class TaxpayerService` con `create(access, input: CreateTaxpayerInput): Promise<TaxpayerView>`, `list(access)`, `get(access, id)`, `changePhone(access, id, phone: string | null)` y `findForTenant(db, tenantId, id): Promise<TaxpayerRow | null>`. `TaxpayerView` = las propiedades de `TaxpayerResponse`, en su orden.
- Produces: `class EstablishmentService` con `createEstablishment`, `listEstablishments`, `createEmissionPoint` y `listEmissionPoints`. `EstablishmentView = { id; taxpayerId; code; address }`, `EmissionPointView = { id; establishmentId; code; enabled }`. `TaxpayerModule` exporta ambos servicios.
- Produces: `RimpeRegime = 'NONE' | 'EMPRENDEDOR' | 'NEGOCIO_POPULAR'`.

Reglas, textos y auditoría de `taxpayer/TaxpayerService.java` y `taxpayer/EstablishmentService.java`: `NEGOCIO_POPULAR` da 422 `RIMPE_REGIME_UNSUPPORTED` antes de mirar el ambiente; `defaultEnvironment` distinto de `"1"` da 422 `PRODUCTION_NOT_ENABLED`; `legalName`, `headOfficeAddress` y `address` pasan por `strip`, y `tradeName` y `phone` por `blankToNull` (en blanco es `null`; si no, `strip`). Los listados se ordenan por `legal_name` y por `code`. El `PATCH` audita `TAXPAYER_UPDATED` con `{ field: 'phone' }`.

- [ ] **Step 1: Escribir las pruebas que fallan**

Traducir completos `TaxpayerApiIT`, `TaxpayerFiscalDataIT`, `EstablishmentApiIT` y `EmissionPointApiIT`. De `TenantIsolationIT`: `taxpayerOfAnotherTenantIsNotFound`, `listNeverIncludesAnotherTenant`, `cannotCreateEstablishmentUnderForeignTaxpayer`, `cannotListEstablishmentsOfForeignTaxpayer`, `cannotCreateEmissionPointUnderForeignEstablishment` y `cannotListEmissionPointsOfForeignEstablishment`. Añadir: un `tenantId` en el cuerpo se ignora; si la auditoría falla, el emisor no queda creado.

- [ ] **Step 2: Ejecutar y comprobar que fallan**

Run: `npx vitest run --project integration test/integration/taxpayer test/integration/tenancy/tenant-isolation.int.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar**

- [ ] **Step 4: Ejecutar las pruebas del Step 2 y `npm run lint && npm run typecheck`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(taxpayer): emisores, establecimientos y puntos de emisión"
```

---

### Task 5: Clientes y productos

**Files:**
- Create: `src/catalog/customer.service.ts`, `src/catalog/customer.controller.ts`, `src/catalog/customer.dto.ts`, `src/catalog/product.service.ts`, `src/catalog/product.controller.ts`, `src/catalog/product.dto.ts`
- Modify: `src/catalog/catalog.module.ts`
- Test: `test/integration/catalog/customer-api.int.spec.ts`, `test/integration/catalog/product-api.int.spec.ts`, `test/integration/tenancy/tenant-isolation.int.spec.ts`

**Interfaces:**
- Consumes: `CatalogRepository`, `AuditLog`, `pageRequest`, `escapeLike`, `parseDecimal`, `formatDecimal`, `IntQueryPipe`, `StringQueryPipe`, `isUniqueViolation`.
- Produces: `class CustomerService` con `create`, `update`, `delete`, `search(access, term, page)` y `get(access, id)`. `CustomerView = { id; idType; idNumber; name; email; address; phone }`.
- Produces: `class ProductService` con los mismos métodos. `ProductView = { id; sku; name; unitPrice: string; ivaRateCode }`, con `unitPrice` a 6 decimales.
- Produces: `CustomerService.get` y `ProductService.get` devuelven también `version: string`, que E3 no usa y la vista no expone.

Reglas y textos de `catalog/CustomerService.java` y `catalog/ProductService.java`, con estos permisos: clientes, `requireBilling`; productos, `requireProductCreation`. La búsqueda y su orden son los de `CustomerRepository.search` y `ProductRepository.search`, con `ESCAPE '\'`, y `total` sale de un `count(*)` con el mismo filtro. Borrar es archivar (`deleted_at = now()`).

El control de versión sustituye a `@Version` de JPA: se lee la fila sin bloquearla y se escribe con `UPDATE … SET …, version = version + 1 WHERE id = :id AND tenant_id = :tenant AND version = :leída AND deleted_at IS NULL`. Si no cambia ninguna fila, la respuesta es 409 `CATALOG_CHANGED` con "El cliente cambió. Recargue la lista e inténtelo de nuevo" o "El producto cambió. Recargue la lista e inténtelo de nuevo".

- [ ] **Step 1: Escribir las pruebas que fallan**

Traducir completos `CustomerApiIT` y `ProductApiIT`, salvo `removingCustomerAndProductPreservesIssuedInvoice`, que llega en E3 porque necesita una factura emitida. `staleCustomerEditCannotRestoreADeletedCustomer` y `staleProductEditCannotRestoreADeletedProduct` se traducen así: leer la fila y su `version`, borrarla por la API, aplicar la actualización con la versión leída y exigir el 409 y que el `GET` siga dando 404. De `TenantIsolationIT`: `customersAndProductsOfAnotherTenantAreNotFound`.

- [ ] **Step 2: Ejecutar y comprobar que fallan**

Run: `npx vitest run --project integration test/integration/catalog test/integration/tenancy/tenant-isolation.int.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar**

- [ ] **Step 4: Ejecutar las pruebas del Step 2 y `npm run lint && npm run typecheck`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(catalog): clientes y productos con búsqueda, edición y borrado lógico"
```

---

### Task 6: Clave de acceso y secuenciales

**Files:**
- Create: `src/sequence/access-key.ts`, `src/sequence/access-key-parts.ts`, `src/sequence/fiscal-clock.ts`, `src/sequence/numeric-code.ts`, `src/sequence/sequence.service.ts`, `src/sequence/sequence.controller.ts`, `src/sequence/sequence.module.ts`
- Modify: `src/app.module.ts`, `package.json`
- Test: `test/golden/access-key.spec.ts`, `test/unit/sequence/access-key.spec.ts`, `test/unit/sequence/access-key-parts.spec.ts`, `test/integration/sequence/sequence-api.int.spec.ts`, `test/integration/sequence/sequence-service.int.spec.ts`

**Interfaces:**
- Produces: `buildAccessKey(base48: string): string` y `isValidAccessKey(key: string | null): boolean`.
- Produces: `class AccessKeyParts` con constructor `({ issueDate: string /* YYYY-MM-DD */, documentType, ruc, environment, establishment, emissionPoint, sequence: number, numericCode, emissionType })`, `toBase48()` y `toAccessKey()`. Las mismas validaciones y textos que `sequence/AccessKeyParts.java`.
- Produces: `fiscalDateOf(instant: Date): string` (fecha `YYYY-MM-DD` en `America/Guayaquil`, con Luxon) y `nextNumericCode(): string` (8 dígitos con `crypto.randomInt`).
- Produces: `class SequenceService` con `reserve(trx: Transaction<DB>, tenantId, emissionPointId, environment, documentType, issueDate: string): Promise<number>` y `set(access, emissionPointId, environment, documentType, nextValue): Promise<SequenceView>`. `SequenceView = { emissionPointId; environment; documentType; nextValue: number }`. `SequenceModule` exporta `SequenceService`.

SQL, orden de los pasos y textos de `sequence/SequenceService.java`. `reserve` exige una transacción (`trx.isTransaction`): sin ella lanza `Error`, como `Propagation.MANDATORY`. Al llegar a `next_value >= 1_000_000_000` da 422 `SEQUENCE_EXHAUSTED`, y una fecha anterior a `last_issue_date` da 422 `INVALID_ISSUE_DATE`. `set` audita `SEQUENCE_SET` con `{ environment, documentType, nextValue }` y responde 200.

- [ ] **Step 1: Escribir las pruebas que fallan**

Golden: cada caso de `access-key.json` da su `base48` y su `accessKey`. Traducir `AccessKeyTest`, `AccessKeyPartsTest`, `SequenceApiIT` y `SequenceServiceIT`. `concurrentReservationsNeverRepeat` lanza 20 reservas en transacciones paralelas y exige 20 números distintos y consecutivos. `usedSequenceCannotBeReset` inserta el comprobante por SQL, porque la emisión llega en E3.

- [ ] **Step 2: Ejecutar y comprobar que fallan**

Run: `npm test && npx vitest run --project integration test/integration/sequence`
Expected: FAIL.

- [ ] **Step 3: Implementar y añadir `luxon` a las dependencias**

- [ ] **Step 4: Ejecutar las pruebas del Step 2 y `npm run lint && npm run typecheck`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test package.json package-lock.json
git commit -m "feat(sequence): clave de acceso y secuenciales por punto de emisión"
```

---

### Task 7: Cifrado de secretos e inspección de PKCS#12

**Files:**
- Create: `src/certificate/secret-cipher.ts`, `src/certificate/x500-name.ts`, `src/certificate/pkcs12-inspector.ts`, `tools/golden-generator/src/golden/CertificateCases.java`, `test/golden/certificates.json` y `test/golden/certificates/*.p12` (generados)
- Modify: `tools/golden-generator/src/golden/GoldenGenerator.java`, `tools/golden-generator/run.mjs`, `tools/golden-generator/README.md`, `package.json`
- Test: `test/golden/aes-gcm.spec.ts`, `test/golden/certificates.spec.ts`, `test/unit/certificate/secret-cipher.spec.ts`

**Interfaces:**
- Produces: `class AesGcmSecretCipher` con `constructor(masterKey: Buffer, randomBytes?: (n: number) => Buffer)`, `encrypt(plaintext: Buffer, context: Buffer): Buffer` y `decrypt(ciphertext: Buffer, context: Buffer): Buffer`, con el formato de `certificate/AesGcmSecretCipher.java`. Un fallo lanza `SecretCipherException` sin material secreto en el mensaje. `SECRET_CIPHER` es su token de inyección.
- Produces: `x500Name(name: forge.pki.Certificate['subject']): string`, que reproduce `X500Principal.getName()` (RFC 2253 de Java): RDN en orden inverso; solo `CN`, `C`, `L`, `ST`, `O`, `OU`, `STREET`, `DC` y `UID` con nombre, y el resto como OID con `#` y el DER en hexadecimal; con los escapes de Java.
- Produces: `inspectPkcs12(p12: Buffer, password: string, now: Date): SigningMaterial`, con `SigningMaterial = { privateKey: crypto.KeyObject; certificate: forge.pki.Certificate; certificateDer: Buffer }`, y `class CertificateRejectedException extends Error { errorCode; message }`, con los códigos y textos de `certificate/Pkcs12Inspector.java`.

La familia `certificates` del generador lee con `Pkcs12Inspector.inspect` cada `.p12` que crea `keytool` y anota el resultado y el instante de la lectura. Un `.p12` vigente deja de serlo con el tiempo, así que la prueba repite la lectura en ese mismo instante. Formato: `{ inspectedAt, cases: [{ name, file, password, result: { subject, issuer, serialNumber, fingerprintSha256, validFrom, validTo } | { errorCode, message } }] }`. Los casos son los de `TestCertificates` (válido, sin `KeyUsage`, firma y cifrado, caducado, futuro, 1024 bits, dos claves de firma, sin clave privada y clave cambiada) y además:
- clave EC;
- contraseña `clave-con-ñ`;
- PKCS#12 heredado, con `-J-Dkeystore.pkcs12.legacy`;
- DN `CN=José Pérez\, Ñandú, OU=Firma, O=Pruebas S.A., L=Quito, ST=Pichincha, C=EC, SERIALNUMBER=0912345678, EMAILADDRESS=jose@example.ec`;
- contraseña equivocada;
- bytes basura.

`run.mjs` admite `--only certificates`.

`node-forge` lee el PKCS#12 (`pkcs12FromAsn1`) y Node `crypto` hace lo demás. La clave y el certificado se emparejan por `localKeyId`. Si un certificado no trae clave RSA, forge falla al leerlo: se mira el OID de su `subjectPublicKeyInfo` para responder `CERTIFICATE_KEY_UNSUPPORTED`, como Java. Si forge no deriva bien la clave PBES2 de una contraseña no ASCII (la trata como bytes Latin-1), esas bolsas se descifran con `crypto.pbkdf2Sync` sobre el UTF-8 de la contraseña y `crypto.createDecipheriv`. `serialNumber` es el decimal del entero, `fingerprintSha256` el SHA-256 en hexadecimal minúsculo del DER, y `validFrom` y `validTo` instantes UTC.

- [ ] **Step 1: Añadir la familia `certificates` al generador y generarla**

Run: `node tools/golden-generator/run.mjs --java-repo ../backend-emite-facil --only certificates`
Expected: código 0. Aparecen `certificates.json` y los `.p12`, y no cambia ningún otro golden.

- [ ] **Step 2: Escribir las pruebas que fallan**

`aes-gcm.spec.ts`: cada caso de `aes-gcm.json` se descifra a su `plaintext`. Además, con la clave de datos (descifrada de la envoltura) y los dos IV del propio caso como aleatorios, `encrypt` produce los mismos bytes. `certificates.spec.ts`: cada caso da el mismo resultado leído en `inspectedAt`. Traducir `AesGcmSecretCipherTest` y, de `Pkcs12InspectorTest`, `validityIsJudgedAtTheGivenInstant`.

- [ ] **Step 3: Ejecutar y comprobar que fallan**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 4: Implementar y añadir `node-forge` y `@types/node-forge`**

- [ ] **Step 5: Ejecutar pruebas, lint y tipos**

Run: `npm test && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src test tools package.json package-lock.json
git commit -m "feat(certificate): cifrado AES-GCM e inspección de PKCS#12 compatibles con Java"
```

---

### Task 8: Carga y custodia de certificados

**Files:**
- Create: `src/certificate/certificate.service.ts`, `src/certificate/certificate.controller.ts`, `src/certificate/certificate.module.ts`, `test/support/test-certificates.ts`
- Modify: `src/app.module.ts`
- Test: `test/integration/certificate/certificate-api.int.spec.ts`

**Interfaces:**
- Consumes: `AesGcmSecretCipher`, `inspectPkcs12`, `AuditLog`, `TaxpayerService.findForTenant`, `RequiredUuidQueryPipe`, `JsonUuid`.
- Produces: `class CertificateService` con `upload(access, taxpayerId, p12: Buffer, password: string): Promise<CertificateView>`, `list(access, taxpayerId)` y `signingMaterial(tenantId, taxpayerId, now: Date): Promise<SigningMaterial>`, que E4 usa para firmar. `CertificateView = { id; taxpayerId; subject; issuer; serialNumber; fingerprintSha256; validFrom: string; validTo: string; status }`. Exporta `secretContext(tenantId, taxpayerId, certificateId, field: 'p12' | 'password'): Buffer`.
- Produces en `test-certificates.ts`: `testP12(kind: 'valid' | 'anotherValid' | 'expired' | 'shortKey'): Buffer` y `TEST_P12_PASSWORD`. Crea `.p12` vigentes en el momento de la prueba con `crypto.generateKeyPairSync` y forge, y los guarda en caché por proceso.

SQL, orden y textos de `certificate/CertificateService.java` y `certificate/CertificateController.java`. El emisor se bloquea (`FOR UPDATE`) antes de leer el archivo. El anterior pasa de `ACTIVE` a `REPLACED` en la misma transacción. La auditoría registra `{ taxpayerId, fingerprintSha256, validTo }`. `p12` se decodifica con la regla del decodificador básico de Java que fija `test/golden/http/e2.json`, y si no es Base64 válido responde 400 `MALFORMED_REQUEST` "El campo p12 debe venir en Base64". Al terminar, los `Buffer` del archivo y de la contraseña se rellenan con ceros. El DTO no se registra en ningún log.

- [ ] **Step 1: Escribir las pruebas que fallan**

Traducir `CertificateApiIT` completo. `CertificateRotationIT` llega en E4, porque necesita firmar. `secretNeverLeavesTheServer` revisa la respuesta, `audit_events` y los logs capturados. `ciphertextIsBoundToItsIssuerAndField` intercambia por SQL `encrypted_p12` entre dos certificados y exige que `signingMaterial` falle.

- [ ] **Step 2: Ejecutar y comprobar que fallan**

Run: `npx vitest run --project integration test/integration/certificate`
Expected: FAIL.

- [ ] **Step 3: Implementar**

- [ ] **Step 4: Ejecutar las pruebas del Step 2 y `npm run lint && npm run typecheck`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(certificate): carga, rotación y custodia cifrada de certificados"
```

---

### Task 9: Respuestas iguales a las de Java y datos de Java

**Files:**
- Create: `test/integration/java-probes.int.spec.ts`
- Modify: `tools/java-dump/run.mjs`, `tools/java-dump/README.md`, `test/fixtures/java-e1/*` (regenerados), `test/integration/identity/java-compat.int.spec.ts`, `README.md`, `docs/route-inventory.md`

**Interfaces:**
- Consumes: `runScenario`, `runProbes` y `normalize` de `tools/java-probe/probe.mjs`, y `CertificateService.signingMaterial`.

`java-dump` crea además, por la API Java, un emisor, un establecimiento, un punto de emisión, un cliente, un producto y un certificado. El certificado lo genera con `keytool` (RSA 2048, `KeyUsage=digitalSignature`, vigente 3650 días), para que el volcado no caduque. `meta.json` gana `taxpayerId`, `certificateId`, `certificateFingerprint`, `customerId` y `productId`.

- [ ] **Step 1: Escribir las pruebas que fallan**

`java-probes.int.spec.ts` arranca NestJS, ejecuta `runScenario` y `runProbes` con los casos de `e2.json` y exige que cada resultado normalizado sea igual al de `test/golden/http/e2.json`: estado, `Content-Type`, `Allow` y cuerpo con sus propiedades en el mismo orden. En `java-compat.int.spec.ts`:

```ts
it('el emisor, el cliente y el producto de Java se leen igual', ...);
it('el certificado que cargó Java se descifra y su clave corresponde al certificado', async () => {
  const material = await service.signingMaterial(meta.tenantId, meta.taxpayerId, new Date());
  expect(fingerprint(material.certificateDer)).toBe(meta.certificateFingerprint);
});
```

- [ ] **Step 2: Regenerar los datos y ejecutar**

Run: `node tools/java-dump/run.mjs --java-repo ../backend-emite-facil --skip-build && npx vitest run --project integration test/integration/java-probes.int.spec.ts test/integration/identity/java-compat.int.spec.ts`
Expected: la generación termina con código 0 y las pruebas pasan. Si una diferencia aparece, se corrige en NestJS, no en el golden.

- [ ] **Step 3: Actualizar la documentación**

README: estado E2. `docs/route-inventory.md`: marcar como portadas las 24 rutas de E2 (40 en total) y anotar en "Diferencias" que Java devuelve `CATALOG_CHANGED` sin que `openapi.yaml` lo declare.

- [ ] **Step 4: Ejecutar toda la suite**

Run: `npm run lint && npm run typecheck && npm test && npm run build && npm run test:integration && npm audit --omit=dev --audit-level=high`
Expected: todo pasa.

- [ ] **Step 5: Commit**

```bash
git add tools test src README.md docs
git commit -m "test(e2): respuestas iguales a las de Java y certificados cargados por Java"
```
