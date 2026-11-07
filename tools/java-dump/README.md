# Volcado con datos de Java

Genera `test/fixtures/java-e1/` con datos escritos por la API Java (`backend-emite-facil`). La prueba
`test/integration/identity/java-compat.int.spec.ts` carga ese volcado y comprueba que NestJS sigue
aceptando lo que Java dejó: la contraseña Argon2, el token de renovación, la API key y su empresa, el
access token firmado por Java, el historial de Flyway, el emisor, el cliente y el producto, el
certificado cifrado con AES-GCM, que NestJS descifra y lee, y los comprobantes de E3: NestJS los
muestra como Java, reconoce el reintento de cada emisión con la clave y el cuerpo que usó Java (misma
huella de la petición) y cuenta la nota de crédito de Java en el saldo de la factura.

## Uso

```bash
node tools/java-dump/run.mjs --java-repo ../backend-emite-facil
```

Con `--skip-build` reutiliza el jar que ya esté en `target/` del repo Java en vez de empaquetarlo.

Requisitos: Docker en marcha, Java 25 en el `PATH`, Node 24 y acceso a las dependencias de Maven del
repo Java.

## Pasos

Si uno falla, termina con código distinto de cero, nombra el paso y muestra el final del log de Java.

1. `mvnw -q -DskipTests -Djacoco.skip=true package` en el repo Java (solo escribe su `target/`).
2. Levanta PostgreSQL 16, RabbitMQ y Redis efímeros con Testcontainers.
3. Arranca el jar con secretos generados en la ejecución, sin SMTP (correo apagado), sin ambientes del
   SRI, sin worker y con `EINVOICE_AUTH_SESSIONTTL=87600h`, para que la sesión del volcado no caduque y
   la prueba de renovación siga valiendo con el tiempo. Java aplica sus propias migraciones al arrancar.
   No hereda variables `SPRING_*`, `EINVOICE_*`, `SRI_*`, `DELIVERY_*` ni `SMTP_*` del entorno.
4. Por HTTP: registra una cuenta (con el correo en mayúsculas), ingresa, crea una empresa, una API
   key, un emisor con su establecimiento y punto de emisión, un cliente y un producto, y carga un
   certificado RSA 2048 creado con el `keytool` de esa JVM y vigente diez años. Comprueba la key contra
   `GET /api/v1/tenants/current`.
5. Emite por HTTP, cada uno con su `Idempotency-Key`: una factura de dos líneas con tarifas distintas
   (15 % con descuento y 0 %, de un segundo producto) y dos pagos (uno a 30 días), con una cantidad y
   un importe escritos como números JSON (`3` y `20.00`); la pasa a `AUTHORIZED` por SQL, con
   `authorization_number` igual a su clave de acceso y un `authorized_at` con microsegundos (`.123456`),
   porque sin SRI ni worker Java la deja en `RESERVED`; y emite sobre ella una nota de crédito (una
   unidad de la línea 1) y una nota de débito (dos motivos con tarifas distintas), más una nota de
   crédito sobre una factura escrita a mano. Lee `GET /api/v1/documents/{id}` de cada uno y
   `GET /api/v1/documents`.
6. Detiene Java y vuelca la base con `pg_dump --no-owner --no-privileges` en `dump.sql`.
7. Escribe `meta.json`: el commit y la versión de Java, el correo y la contraseña, `userId`,
   `tenantId`, los dos tokens con el `iat` y el `exp` del access token, la API key, los ids del
   emisor, el cliente, el producto y el certificado con su huella, `invoiceId`, `creditNoteId`,
   `manualCreditNoteId` y `debitNoteId`, lo que Java respondió al crearlos (`views`), y
   `EINVOICE_JWT_SECRET` y `EINVOICE_MASTER_KEY`. `requests.json` guarda la ruta, la clave y el texto
   exacto del cuerpo de cada emisión, y `views.json`, lo que Java respondió al leer los comprobantes.

Todo son valores de prueba generados en esa ejecución: no sirven fuera de estos fixtures. Cada
ejecución produce valores distintos; la prueba lee los suyos de `meta.json`.

En Windows, Java abre un socket Unix en `TEMP` para sus selectores y falla si la ruta supera 108 bytes:
por eso el jar arranca con `-Djdk.net.unixdomain.tmpdir` apuntando al `target/` del repo Java. También
arranca con `-Duser.language=en`: sin `Accept-Language`, Spring escribe los mensajes de validación en el
idioma de la JVM, y la imagen de producción corre en inglés.

## Código compartido

`java-app.mjs` empaqueta el jar, levanta los contenedores, arranca Java con su entorno limpio y la
detiene matando el árbol de procesos. Lo usan `run.mjs` y `tools/java-probe/run.mjs`.
