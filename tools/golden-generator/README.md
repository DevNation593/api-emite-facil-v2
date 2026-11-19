# Generador de casos golden

Genera `test/golden/` con el código real de la API Java (`backend-emite-facil`). Esos archivos son la
referencia byte a byte contra la que se prueban las etapas de autenticación, certificados, facturas y
firma XAdES del port a NestJS.

## Uso

```bash
node tools/golden-generator/run.mjs --java-repo ../backend-emite-facil
```

Para regenerar una sola familia sin tocar el resto de fixtures ni `SOURCE.json`:

```bash
node tools/golden-generator/run.mjs --java-repo ../backend-emite-facil --only bean-validation
```

Familias con `--only` (`bean-validation`, `certificates`, `xsd`, `calculations`, `documents`, `xades`, `xades-verify` y `sri`): `bean-validation` (`bean-validation.json`: `@NotBlank`, `@NotNull`, `@Size`, `@Email` y
`@Pattern(NO_CONTROL_CHARS)`, más `@Pattern("[0-9]{3}")`, `@Min(1)` y `@Max(999_999_999)`, validados con Hibernate Validator y `Locale.ENGLISH`). Es determinista: no
depende de aleatorios.

`certificates` (`certificates/*.p12` y `certificates.json`): archivos PKCS#12 creados con `keytool` (los de
`TestCertificates` más clave EC, contraseña con eñe, formato heredado 3DES/RC2 y un DN con comas, tildes,
`SERIALNUMBER` y correo, una firma RSA-PSS y un archivo con 200 000 iteraciones, que la prueba usa para comprobar que leerlo no detiene el proceso) y el resultado de `Pkcs12Inspector.inspect` en el instante `inspectedAt`. No es
determinista: cada ejecución crea claves nuevas, y un certificado vigente deja de serlo con el tiempo, por
eso la prueba de Node repite la lectura en `inspectedAt`.

`xsd` (`xsd.json` y `xsd/*.xml`): para cada XML de ejemplo del SRI de `resources/xsd` y para variantes de
`InvoiceXmlFixtures.standard()` (razón social de 301 caracteres, salto de línea en el comprador, fecha ISO,
sin `totalConImpuestos`, `codDoc` `04`, versión `2.0.0` validada como 1.1.0, `xsi:schemaLocation` en un hijo,
clave con dígito verificador incorrecto, clave de otro secuencial, `DOCTYPE` con entidad externa, archivo vacío
y `<factura` sin cerrar) anota si `XsdValidator` lo da por válido y, si lo es, las violaciones de
`EnvelopeRules` (o `unreadable`). `file` es la ruta desde la raíz de este repo. Es determinista.

`calculations` (`calculations.json`): ejecuta `InvoiceCalculator.calculate`, `DebitNoteCalculator.calculate` y
`CreditNoteService.proratedDiscount` (privado del paquete: se invoca por reflexión) sobre los casos de
`TaxRoundingTest` y `DebitNoteCalculatorTest`, las entradas rechazadas y casos al azar con la semilla `20261029`
(300 facturas, 100 notas de débito y 100 descuentos prorrateados; cantidad y precio de hasta 6 decimales,
descuento hasta el bruto y las tarifas `0`, `2`, `3`, `4`, `5`, `8` y `10` con su porcentaje del catálogo). Cada
decimal se escribe con `toString()` para conservar la escala, y de una entrada rechazada se guarda el mensaje.
Es determinista.

`documents` (`documents.json` y `documents/*.xml`): el XML de `InvoiceXmlBuilder`, `CreditNoteXmlBuilder` y
`DebitNoteXmlBuilder` y, para las notas, el `contentJson` de `CreditNoteKind` y `DebitNoteKind` (construidos con un
repositorio nulo). Casos: la factura de `InvoiceXmlFixtures.standard()` y sus variantes (RUC del proveedor, RIMPE
emprendedor, negocio popular, agente de retención con contribuyente especial y contabilidad, caracteres especiales,
pago con plazo, sin opcionales, redondeo de escalas), dos notas de crédito (sobre una factura y a mano), una de solo
JSON con caracteres de control (`xml` nulo) y dos notas de débito (con y sin plazo). Cada caso trae sus datos de
entrada con los decimales como cadenas planas con su escala (`toPlainString()`), la ruta de su XML y `contentJson` (nulo en la
factura). Es determinista.

`xades` (`xades/certificado-prueba.p12` y `xades/<caso>/{unsigned.xml,signed.xml,meta.json}`): comprobantes firmados
con `XadesBesSigner` y aceptados por `XadesVerifier` (si no, el generador aborta). Casos: la factura estándar y con
RUC del proveedor, la nota de crédito `nota-credito-sobre-factura` y la de débito `nota-debito-dos-tarifas` de
`documents`, una factura con caracteres especiales (`& < > " '`, `ñ`, `é`, `😀`, tabulador, controles C1, U+2028 y
`\r`, `\r\n` y `\n` en la dirección, sin pasar por el XSD) y una de 500 líneas. `meta.json` guarda la hora de firma,
el `.p12`, su contraseña y `numbers`: los ocho números de los `Id` en el orden en que el firmante los pide. El
`.p12` es RSA 2048 con vigencia de 3650 días desde el 01/01/2026, para que el golden no caduque. Además,
`xades/serializacion-jdk/` guarda un XML de borde (atributos desordenados, declaraciones repetidas, CDATA,
comentarios, finales de línea y una muestra de caracteres como referencias) leído con `SecureXml` y escrito con el
`Transformer` de `XadesBesSigner.serialize` (privado: se invoca por reflexión). No es determinista: cada ejecución
crea otra clave y otros números.

`xades-verify` (`xades-verify.json` y `xades-verify/*.xml`): el resultado de `XadesVerifier.verify` (`valid` y
`errors`, en orden) para cada `signed.xml` de `xades` y para variantes de la factura estándar firmada: importe,
`SigningTime`, certificado de `KeyInfo`, número de serie, emisor, exponente o valor de la firma cambiados, firma con
otra clave, firma fuera de la raíz, dos firmas, una cuarta referencia, la transformación del comprobante cambiada,
C14N exclusiva, digest SHA-256, RSA-SHA256, raíz o `KeyInfo` sin id, sin `SigningCertificate`, certificado
ilegible, sin `SignatureMethod`, con un comentario o un espacio en el comprobante, sin firmar, ilegible, vacío y con
`DOCTYPE`. Necesita `xades/` ya generado (con `--only xades-verify` se reutiliza el que hay). `file` es la ruta
desde `test/golden`. No es determinista: la firma con otra clave y el certificado sustituto cambian en cada ejecución.

`sri` (`sri.json`): las peticiones de `SriSoapRequests` (privada del paquete: se invoca por reflexión) en Base64 —la
de recepción de tres `signed.xml` de `xades` y la de autorización de claves válidas e inválidas, con el mensaje de
error— y el resultado de `SriResponseParser.reception` y `SriResponseParser.authorization` para cada cuerpo: las
muestras de `SriSoapSamples`, `Fault`, HTML, cuerpo vacío, texto, `DOCTYPE` con entidad, dos respuestas, sin
envoltorio, con prefijo, con BOM, entidades y CDATA, comentarios, XML mal formado, textos de más de 2000 caracteres,
estados largos, 150 mensajes, un emoji partido en el límite, números de autorización de 9, 10, 50 dígitos y en
cifras arábigas, ambientes `PRUEBAS`, `PRODUCCIÓN` y `produccion` y fechas con y sin desplazamiento, con fracción y
de formatos que Java no acepta. Cada resultado lleva todos sus campos; las fechas, con `OffsetDateTime.toString()`.
Necesita `xades/` ya generado. Es determinista.

El generador corre con `-Dline.separator=\n`: el `Transformer` del JDK escribe cada salto de línea de un texto con
el separador del sistema, y se fija el de Linux, donde corre la API, para que el XML firmado no dependa del sistema
en que se genera (`XadesCases` aborta si no está fijado).

Requisitos: Java 25 (`java`, `javac`) en el `PATH`, Node 24 y acceso a las dependencias de Maven del repo
Java (el repo debe poder ejecutar su `mvnw`).

Pasos que ejecuta `run.mjs`; si uno falla, termina con código distinto de cero y nombra el paso:

1. `mvnw -q -DskipTests -Djacoco.skip=true test-compile` en el repo Java (solo escribe su `target/`).
2. `mvnw -q dependency:build-classpath -Dmdep.includeScope=test` para obtener el classpath.
3. `javac` de `src/golden/*.java` contra `target/classes`, `target/test-classes` y ese classpath, en un
   directorio temporal que se borra al terminar.
4. Ejecuta `golden.GoldenGenerator`, que escribe en `test/golden/`.

El repo Java no se modifica. `SOURCE.json` registra su commit, la versión de Java y la fecha de generación.

## Qué es reproducible

Los valores de entrada (fechas, RUC, secuenciales, UUID, clave maestra) salen de la semilla fija
`20261029`; las claves de acceso son idénticas en cada ejecución. Lo aleatorio por naturaleza cambia
en cada ejecución y las pruebas de Node lo leen del resultado esperado: IV de AES-GCM, sal de Argon2,
`jti` del JWT, API keys e identificadores de la firma XAdES (`Signature<n>`…).

## Reflexión

`WebhookSubscriptionService.secretContext` es privado del paquete y `AesGcmCases` lo invoca por
reflexión, para no copiar el formato de su contexto. `AccessKeyCases.remainder` recalcula el resto del
módulo 11 solo para buscar los casos de borde (10 y 11); las claves guardadas salen siempre de
`AccessKey.build`.

## Cuándo regenerar

Solo si cambia el comportamiento de la API Java de referencia. Revisar el diff de `test/golden/` antes de
confirmarlo: los archivos no deterministas siempre cambian.
