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

Familias con `--only`: `bean-validation` (`bean-validation.json`: `@NotBlank`, `@NotNull`, `@Size`, `@Email` y
`@Pattern(NO_CONTROL_CHARS)`, más `@Pattern("[0-9]{3}")`, `@Min(1)` y `@Max(999_999_999)`, validados con Hibernate Validator y `Locale.ENGLISH`). Es determinista: no
depende de aleatorios.

`certificates` (`certificates/*.p12` y `certificates.json`): archivos PKCS#12 creados con `keytool` (los de
`TestCertificates` más clave EC, contraseña con eñe, formato heredado 3DES/RC2 y un DN con comas, tildes,
`SERIALNUMBER` y correo) y el resultado de `Pkcs12Inspector.inspect` en el instante `inspectedAt`. No es
determinista: cada ejecución crea claves nuevas, y un certificado vigente deja de serlo con el tiempo, por
eso la prueba de Node repite la lectura en `inspectedAt`.

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
