# Volcado con datos de Java

Genera `test/fixtures/java-e1/` con datos escritos por la API Java (`backend-emite-facil`). La prueba
`test/integration/identity/java-compat.int.spec.ts` carga ese volcado y comprueba que NestJS sigue
aceptando lo que Java dejó: la contraseña Argon2, el token de renovación, la API key y su empresa, el
access token firmado por Java y el historial de Flyway.

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
4. Por HTTP: registra una cuenta (con el correo en mayúsculas y entre espacios), ingresa, crea una
   empresa y una API key, y comprueba la key contra `GET /api/v1/tenants/current`.
5. Detiene Java y vuelca la base con `pg_dump --no-owner --no-privileges` en `dump.sql`.
6. Escribe `meta.json`: el commit y la versión de Java, el correo y la contraseña, `userId`,
   `tenantId`, los dos tokens con el `iat` y el `exp` del access token, la API key, y
   `EINVOICE_JWT_SECRET` y `EINVOICE_MASTER_KEY`.

Todo son valores de prueba generados en esa ejecución: no sirven fuera de estos fixtures. Cada
ejecución produce valores distintos; la prueba lee los suyos de `meta.json`.

En Windows, Java abre un socket Unix en `TEMP` para sus selectores y falla si la ruta supera 108 bytes:
por eso el jar arranca con `-Djdk.net.unixdomain.tmpdir` apuntando al `target/` del repo Java.
