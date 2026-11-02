# E1 Identidad y multiempresa — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Portar cuentas, sesiones, empresas, roles y API keys con el comportamiento de Java, de modo que un usuario, una sesión o una API key creados por Java sigan funcionando en NestJS.

**Architecture:** La autenticación y el límite de peticiones corren en un middleware entre correlación y cuerpo (ruling R12), para reproducir "401 primero" y no parsear cuerpos sin autenticar. La empresa activa y el rol se resuelven en guards, antes que los pipes, igual que los resolvers de argumentos de Java. Los servicios escriben con Kysely en transacciones explícitas y la auditoría exige la transacción como parámetro.

**Tech Stack:** Lo de E0, más `argon2` 0.45, `jose` 6, `nodemailer` 8 (dev: `smtp-server`), `@nestjs/schedule` 12.

**Spec:** [docs/superpowers/specs/2026-10-29-api-nestjs-design.md](../specs/2026-10-29-api-nestjs-design.md)

**Rama:** `feat/e1-identidad`, sobre `feat/e0-fundacion` (el PR #1 aún no está mezclado).

## Global Constraints

- Referencia de comportamiento: `../backend-emite-facil` (commit `ca53bca`). Ante cualquier duda manda el código Java; las rutas Java son relativas a `src/main/java/com/example/einvoice/`.
- Las reglas de `AGENTS.md` aplican: textos y commits en español, identificadores en inglés, imports con extensión `.js`, y P0/P1 de revisión.
- Mismos textos de error, `errorCode` y estados HTTP que Java. Mismos nombres de variables de entorno, de métricas y de claves Redis.
- Nunca en logs, errores ni respuestas: contraseñas, tokens, enlaces de correo, API keys completas ni sus hashes. Los logs de Java citan `user=<id>`, nunca el correo.
- `tenantId` solo sale de `TenantAccess`. Toda consulta de datos de empresa filtra por él.
- Una transacción nunca envía correo ni llama a la red: los correos salen después del commit.
- Fechas de respuesta en ISO-8601 UTC; los `null` se serializan (Java no los omite). Una `timestamptz` pierde los microsegundos al pasar por `Date`: es aceptado.
- Las pruebas de integración necesitan Docker en marcha.

## Review Focus

- Correo con mayúsculas y espacios (`"  Ana@Ejemplo.COM "`) en registro y login: es la misma cuenta, nunca dos (Task 4).
- Dos renovaciones simultáneas con el mismo token de renovación: una gana y la otra se trata como reutilización y cierra la sesión, sin 500 (Task 4).
- SMTP caído o sin configurar: el registro responde 202 y la cuenta queda creada (Tasks 3 y 4).
- Un `Authorization: Bearer` inválido en una ruta pública da 401, como Spring, y con Redis caído el login sigue funcionando (Tasks 4 y 5).
- Base caída al comprobar una API key: 503, nunca 401, que el sistema externo leería como una key inválida (Task 5).

---

### Task 1: Validación con la semántica de Bean Validation

**Files:**
- Create: `tools/golden-generator/src/golden/ValidationCases.java`, `test/golden/bean-validation.json` (generado), `src/common/bean-validation.ts`, `src/common/java-text.ts`, `src/common/uuid.pipe.ts`
- Modify: `tools/golden-generator/src/golden/GoldenGenerator.java`, `src/common/validation.ts`
- Test: `test/unit/common/bean-validation.spec.ts`, `test/unit/common/java-text.spec.ts`, `test/integration/common/errors.int.spec.ts`

**Interfaces:**
- Produces en `bean-validation.ts`: decoradores de propiedad `@NotBlank()`, `@NotNull()`, `@Size({ max })`, `@Email()`, `@NoControlChars()`, y `@JsonString()`.
- Produces en `java-text.ts`: `strip(value: string): string` (como `String.strip`: `Character.isWhitespace`, sin NBSP) y `codePointLength(value: string): number`.
- Produces en `uuid.pipe.ts`: `UuidPipe`, que da 400 `MALFORMED_REQUEST` "La petición está mal formada" si el valor no tiene la forma 8-4-4-4-12 hexadecimal.
- Produces: `validationPipe` pasa a ser una subclase de `ValidationPipe` con las reglas del Step 4.

Mensajes en inglés, los de Hibernate Validator con locale por defecto (la imagen Java corre sin `LANG`). Spring usa el locale de `Accept-Language`: esa variación no se porta, porque el proxy de la web (`src/server/proxy.ts`) solo reenvía `accept`, `content-type` e `idempotency-key`. Un sistema externo con API key que envíe `Accept-Language: es` recibiría en Java los mensajes en español y aquí en inglés.

- [ ] **Step 1: Añadir la familia `bean-validation.json` al generador**

`ValidationCases.java` valida con `jakarta.validation.Validator` (`Locale.ENGLISH` fijado) un bean propio con `@NotBlank`, `@NotNull`, `@Size(max = 254)`, `@Email` y `@Pattern(regexp = TextRules.NO_CONTROL_CHARS)`. Formato: `{ cases: [{ constraint, value, valid, message }] }`, con `value` null cuando aplique. Entradas de `@Email`: `a@b`, `a@b.c`, `a.b@c.d`, `a..b@c.d`, `.a@b.c`, `a@-b.c`, `a@b-.c`, `a b@c.d`, `"a b"@c.d`, `ñ@ejemplo.ec`, `a@[192.168.0.1]`, `a@ejemplo.ec.`, sin arroba, cadena vacía, local de 65 caracteres y dominio de 256. Entradas de `@NotBlank`: vacía, `" "`, `"\t"`, `"　"` (U+3000), `" "` (NBSP), `"a"`.

Run: `node tools/golden-generator/run.mjs --java-repo ../backend-emite-facil`
Expected: código 0. Solo cambian los archivos con salidas aleatorias y aparece `bean-validation.json`.

- [ ] **Step 2: Escribir las pruebas que fallan**

`bean-validation.spec.ts` recorre `bean-validation.json` y exige, por caso, el mismo `valid` y el mismo `message`. `java-text.spec.ts`: `strip(' a ')` da `'a'`, `strip('　a')` da `'a'`, `strip(' a')` conserva el NBSP, `codePointLength('😀')` da 1.

En `errors.int.spec.ts`, sobre `POST /api/v1/test/echo` (el DTO de prueba usa los decoradores nuevos):

```ts
it.each([undefined, '[]', '"x"', '5'])('cuerpo %j que no es un objeto', async (body) => {
  const res = await http.post('/api/v1/test/echo').set('Content-Type', 'application/json').send(body);
  expect(res.body).toMatchObject({ status: 400, errorCode: 'MALFORMED_REQUEST' });
});
it('objeto donde va un texto es JSON no legible, como Jackson', async () => {
  const res = await http.post('/api/v1/test/echo').send({ name: { a: 1 }, lines: [] });
  expect(res.body).toMatchObject({ status: 400, errorCode: 'MALFORMED_REQUEST',
    detail: 'El cuerpo de la petición no es JSON válido' });
});
it('número donde va un texto se convierte, como Jackson', async () => {
  await http.post('/api/v1/test/echo').send({ name: 5, lines: [] }).expect(201);
});
```

- [ ] **Step 3: Ejecutar y comprobar que fallan**

Run: `npx vitest run --project unit test/unit/common && npx vitest run --project integration test/integration/common/errors.int.spec.ts`
Expected: FAIL.

- [ ] **Step 4: Implementar**

`@Email` porta las reglas de `AbstractEmailValidator` de Hibernate hasta que el golden pase. `@NotBlank` usa el recorte de Java (`<= U+0020`), no `trim()` de JS. La subclase del pipe, para `metadata.type === 'body'` con DTO: valor ausente o que no sea objeto plano lanza `400 MALFORMED_REQUEST` con el detalle "El cuerpo de la petición no es JSON válido"; en una propiedad con `@JsonString()`, objeto o array lanza lo mismo, y número o booleano se convierte a texto antes de validar.

- [ ] **Step 5: Ejecutar pruebas, lint y tipos**

Run: `npm test && npx vitest run --project integration test/integration/common && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tools test src
git commit -m "feat(common): validación con la semántica y los mensajes de Bean Validation"
```

---

### Task 2: Contraseñas, tokens, API keys y dirección del cliente

**Files:**
- Create: `src/identity/passwords.ts`, `src/identity/access-tokens.ts`, `src/identity/client-address.ts`, `src/apikey/api-key-credential.ts`
- Modify: `src/config/app-config.ts`, `test/support/test-env.ts`, `package.json`, `Dockerfile` (solo si `argon2` no carga en la imagen)
- Test: `test/golden/passwords.spec.ts`, `test/golden/access-tokens.spec.ts`, `test/golden/api-key.spec.ts`, `test/unit/identity/passwords.spec.ts`, `test/unit/identity/access-tokens.spec.ts`, `test/unit/identity/client-address.spec.ts`, `test/unit/apikey/api-key-credential.spec.ts`, `test/unit/config/app-config.spec.ts`

**Interfaces:**
- Produces: `AppConfig.auth` gana `accessTokenTtlMs`, `sessionTtlMs`, `verificationTtlMs`, `resetTtlMs`, `maxLoginFailures`, `lockoutMs`, `publicRequestsPerMinute`, `trustedProxyHops`. `AppConfig` gana `mail: { host: string | null; port: number; user: string | null; password: string | null; startTls: boolean; from: string | null }`.
- Produces: `authLink(webUrl: URL, path: string, token: string): string` en `app-config.ts`, que da `<webUrl><path>#token=<token>`.
- Produces: `class Passwords` con `hash(password): Promise<string>`, `matches(password, hash: string | null): Promise<boolean>`, `requireAcceptable(field, password, email: string | null): void`.
- Produces: `class AccessTokens` con `constructor(config: AppConfig['auth'], clock?: () => Date)`, `issue(userId, sessionId, email, emailVerified, jti?: string): Promise<{ value: string; expiresAt: Date }>` y `verify(token: string): Promise<AccessClaims | null>`, con `AccessClaims = { sub: string; sid: string; email?: string; emailVerified?: boolean }`.
- Produces: `clientAddress(headers: string | string[] | undefined, remoteAddress: string | undefined, hops: number): string`.
- Produces en `api-key-credential.ts`: `generateApiKey(): { value; publicId; secretHash }`, `parseApiKey(header: string | null): { publicId; secret } | null`, `hashApiKeySecret(secret): string`, `apiKeySecretMatches(secret, hash): boolean`.

Valores de `application.yml`: 15m, 12h, 24h, 1h, 5 fallos, 15m, 20 peticiones, `EINVOICE_TRUSTED_PROXY_HOPS` 1. Reglas y mensajes de `identity/AuthProperties.java`. SMTP: `SPRING_MAIL_HOST`, `SPRING_MAIL_PORT`, `SPRING_MAIL_USERNAME`, `SPRING_MAIL_PASSWORD`, `SMTP_STARTTLS` (true), `DELIVERY_EMAIL_FROM`.

- [ ] **Step 1: Escribir las pruebas que fallan**

Golden: `matches` acepta cada `argon2.json`; con la sal del hash de Java, `argon2` produce la misma cadena PHC; `verify` acepta cada token de `jwt.json` con el reloj en `issuedAtEpochSeconds + 1`, comprueba su HMAC con `secret` y da sus claims; `issue` con los mismos datos y `jti` da cabecera y claims iguales al decodificarlos; cada `api-key.json` cumple `parseApiKey(value)` y `hashApiKeySecret(secret) === secretHash`.

Traducir `AccessTokensTest`, `PasswordsTest`, `ApiKeyCredentialTest`, `ClientAddressTest` y `AuthPropertiesTest`. Casos con valor exacto:

```ts
expect(await tokens.verify(expiradoHace(30))).not.toBeNull(); // Spring tolera 60 s de desfase
expect(await tokens.verify(expiradoHace(61))).toBeNull();
expect(await tokens.verify(firmadoConOtroIss)).toBeNull();
expect(await tokens.verify(paraOtraAudiencia)).toBeNull();
expect(await tokens.verify(sinExp)).toBeNull();
expect(await tokens.verify(conSubVacio)).toBeNull();
expect(await tokens.verify(firmadoConHS512)).toBeNull();
expect(clientAddress('1.1.1.1, 2.2.2.2', '9.9.9.9', 1)).toBe('2.2.2.2'); // lo de la izquierda lo escribe quien llama
expect(clientAddress('1.1.1.1, 2.2.2.2', '9.9.9.9', 2)).toBe('1.1.1.1');
expect(clientAddress(undefined, '::ffff:9.9.9.9', 1)).toBe('9.9.9.9');
```

- [ ] **Step 2: Ejecutar y comprobar que fallan**

Run: `npm test`
Expected: FAIL (módulos inexistentes).

- [ ] **Step 3: Implementar los cuatro módulos y ampliar `AppConfig`**

`argon2` con `type: argon2id`, `memoryCost: 16384`, `timeCost: 2`, `parallelism: 1`, sal de 16 y hash de 32. `Passwords` compara contra un hash señuelo si no hay hash propio. `jose` con `algorithms: ['HS256']`, `issuer` y `audience` `einvoice-api`, `clockTolerance: 60`.

- [ ] **Step 4: Comprobar que `argon2` carga en la imagen**

Run: `docker build -t einvoice-api:ci . && docker run --rm --entrypoint node einvoice-api:ci -e "import('argon2').then(a=>a.hash('x')).then(console.log)"`
Expected: imprime un hash `$argon2id$...`. La etapa final usa `--ignore-scripts`: si falta el binario, ajustar el `Dockerfile`.

- [ ] **Step 5: Ejecutar pruebas, lint y tipos**

Run: `npm test && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src test package.json package-lock.json Dockerfile
git commit -m "feat(identity): contraseñas, tokens y API keys compatibles con Java"
```

---

### Task 3: Límite de intentos y correos de la cuenta

**Files:**
- Create: `src/identity/auth-attempt-limiter.ts`, `src/identity/auth-mailer.ts`, `test/support/smtp-stub.ts`
- Test: `test/unit/identity/auth-mailer.spec.ts`, `test/integration/identity/auth-attempt-limiter.int.spec.ts`, `test/integration/identity/auth-mailer.int.spec.ts`

**Interfaces:**
- Consumes: `REDIS`, `AppConfig.auth`, `AppConfig.mail`.
- Produces: `class AuthAttemptLimiter` con `ipRetryAfter(ip): Promise<number>`, `lockedFor(email): Promise<number>`, `recordFailure(email): Promise<number>`, `recordSuccess(email): Promise<void>`.
- Produces: `type AuthMail = { to; subject; text; kind }`, las funciones puras `verificationMail(to, link, ttlMs)`, `passwordResetMail(...)`, `alreadyRegisteredMail(to, resetLink, ttlMs)`, y `class AuthMailer` con `send(mail: AuthMail): void`, que no espera ni lanza.
- Produces en `smtp-stub.ts`: `startSmtpStub(): Promise<{ port; messages(): Array<{ from; to; subject; text }>; stop() }>`, sobre `smtp-server` y `mailparser`.

Claves Redis de `identity/AuthAttemptLimiter.java`: `einvoice:auth:ip:<d>:<ventana>` (TTL 120), `einvoice:auth:fail:<d>` y `einvoice:auth:lock:<d>` (TTL `lockout`), con `<d>` = 32 hex del SHA-256. Fallo de Redis: devuelve 0 y descansa 10 s. Reutiliza el acotado por tiempo de `RateLimiter`; extrae el helper a `src/infrastructure/redis.module.ts` en vez de duplicarlo.

Textos y remitente exactos de `identity/AuthMailer.java`: nombre visible "Facturación electrónica", y `describe` da `1 hora`, `24 horas`, `15 minutos`. Sin host o sin remitente: un `warn` al arrancar y otro por correo, sin el enlace. Fallo de envío: `warn` con el tipo, nunca el enlace. Conexión con STARTTLS exigido salvo `SMTP_STARTTLS=false`, y plazos de 10 s, 30 s y 30 s.

- [ ] **Step 1: Escribir las pruebas que fallan**

Unitarias: el texto exacto de los tres correos; `describe` para 1 h, 24 h y 15 min. Integración con Redis real: las claves y TTL exactos; el fallo número 5 bloquea y devuelve 900; `recordSuccess` borra los fallos; la petición 21 de una IP en la ventana da `retryAfter > 0`; con Redis colgado devuelve 0 en menos de 1 s. Con SMTP de prueba: llega con remitente y texto; con un servidor caído `send` no lanza y el log no contiene el enlace.

- [ ] **Step 2: Ejecutar y comprobar que fallan**

Run: `npx vitest run --project unit test/unit/identity/auth-mailer.spec.ts && npx vitest run --project integration test/integration/identity`
Expected: FAIL.

- [ ] **Step 3: Implementar**

- [ ] **Step 4: Ejecutar las pruebas del Step 2 y `npm run lint && npm run typecheck`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test package.json package-lock.json
git commit -m "feat(identity): límite de intentos y correos de la cuenta"
```

---

### Task 4: Cuentas y sesiones

**Files:**
- Create: `src/identity/auth.service.ts`, `src/identity/auth.controller.ts`, `src/identity/auth.dto.ts`, `src/identity/identity.module.ts`, `test/support/test-app.ts`
- Modify: `src/app.module.ts`
- Test: `test/integration/identity/auth-api.int.spec.ts`, `test/integration/identity/auth-rate-limit.int.spec.ts`

**Interfaces:**
- Consumes: Tasks 1 a 3, `DATABASE`, `METRICS_REGISTRY`.
- Produces: `class AuthService` con `register`, `login(email, password, clientIp)`, `refresh`, `logout`, `verifyEmail`, `resendVerification(userId)`, `requestPasswordReset(email, clientIp)`, `resetPassword`, `changePassword(userId, currentSession, current, next)`. `Tokens = { accessToken; expiresIn; refreshToken; refreshExpiresAt: Date }`.
- Produces: `startTestApp(stack, env?): Promise<{ app; http; smtp; close() }>` en `test/support/test-app.ts`, y `registerAndLogin(http, email?): Promise<{ accessToken; refreshToken; userId }>`.

Esta tarea expone las rutas públicas: `register` (202), `login`, `refresh`, `logout` (204), `email-verification` (204), `password-reset/request` (202), `password-reset` (204). Las rutas `resend`, `password` y `me` llegan en la Task 5. Contrato, SQL y errores de `identity/AuthController.java` y `identity/AuthService.java`. Los DTO llevan `@JsonString()` en cada texto; límites 254, 1024 y 200.

- [ ] **Step 1: Escribir las pruebas que fallan**

Traducir de `AuthApiIT` y `AuthRateLimitIT` todo lo que no necesite sesión: `theLoginAnswersWithBothTokensAndTheirLifetimes`, `registeringAnEmailThatAlreadyHasAnAccountRevealsNothingAndChangesNothing`, `aWrongPasswordAndAnUnknownEmailLookTheSame`, `eachRenewalChangesTheRefreshTokenAndAReusedOneClosesTheSession`, `loggingOutClosesTheSession`, `aForgottenPasswordIsReplacedWithTheEmailedLinkAndEverySessionCloses`, `askingToResetThePasswordOfAnUnknownEmailLooksTheSameAndSendsNothing`, `repeatedFailuresLockTheEmailForAWhile`, `weakPasswordsAreRefused`, `noMoreThanAFewEmailsPerHourReachTheSameInbox`, `anAddressThatInsistsWaitsAndTheOthersDoNot`. Añadir:

```ts
it('el correo se normaliza: registro y login con mayúsculas y espacios son la misma cuenta', ...);
it('dos renovaciones simultáneas: una entrega tokens y la otra da 401 y cierra la sesión', async () => {
  const [a, b] = await Promise.all([refresh(token), refresh(token)]);
  expect([a.status, b.status].sort()).toEqual([200, 401]);
  expect((await refresh(ganador(a, b).body.refreshToken)).status).toBe(401);
});
it('con SMTP caído el registro responde 202 y la cuenta existe', ...);
it('con Redis caído el login funciona', ...);
it('el correo no se escribe en los logs ni aparece el token del enlace', ...);
it('cuenta einvoice_auth_logins_total por resultado en METRICS_REGISTRY', ...);
```

- [ ] **Step 2: Ejecutar y comprobar que fallan**

Run: `npx vitest run --project integration test/integration/identity/auth-api.int.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar**

`normalize` = `strip` + `toLowerCase`. `login` hace el trabajo de Argon2 fuera de la transacción. En `refresh`, la transacción **confirma** el cierre por `TOKEN_REUSED` y después lanza `INVALID_REFRESH_TOKEN`: lanzar dentro desharía el cierre. `AuthService` acumula los correos de la transacción y los envía tras el commit. Contador `einvoice_auth_logins_total` con etiqueta `result`: `success`, `failure` y `locked`.

- [ ] **Step 4: Ejecutar pruebas, lint y tipos**

Run: `npm test && npx vitest run --project integration test/integration/identity && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(identity): registro, ingreso, renovación y recuperación de la contraseña"
```

---

### Task 5: Autenticación de cada petición

**Files:**
- Create: `src/identity/authentication.middleware.ts`, `src/identity/request-identity.ts`, `src/identity/current-user.guard.ts`, `src/apikey/api-key.service.ts`, `src/common/json-content-type.interceptor.ts`
- Modify: `src/bootstrap.ts`, `src/common/common.module.ts`, `src/identity/auth.controller.ts`, `src/identity/identity.module.ts`, `src/app.module.ts`
- Test: `test/integration/identity/security.int.spec.ts`, `test/integration/apikey/api-key-authentication.int.spec.ts`

**Interfaces:**
- Consumes: `AccessTokens`, `parseApiKey`, `apiKeySecretMatches`, `RateLimiter` (importa `RateLimiterModule` una sola vez).
- Produces en `request-identity.ts`: `type RequestIdentity = { kind: 'user'; userId; sessionId } | { kind: 'apiKey'; apiKeyId; tenantId; createdBy }` y `identityOf(req): RequestIdentity`.
- Produces: `@CurrentUser()` y `UseGuards(CurrentUserGuard)`. `UserIdentity = { userId; sessionId; email: string | null; emailVerified: boolean }`.
- Produces: `class ApiKeyService` con `authenticate(header): Promise<{ apiKeyId; tenantId; createdBy } | null>` y `touch(id): Promise<void>`. La Task 7 añade el resto.

Orden en `bootstrap.ts`: in-flight → correlación → autenticación → cuerpo → rutas. Reglas del middleware, de `identity/SecurityConfig.java` y `apikey/ApiKeyAuthenticationFilter.java`:

1. Con `X-Api-Key` presente, aunque vacía: si además hay `Authorization`, 400 `CREDENTIALS_AMBIGUOUS` "Envíe X-Api-Key o Authorization, no las dos". Key inválida: 401. Fallo de base: 503 `INTERNAL_ERROR` "No se pudo comprobar la API key; vuelva a intentar en un momento". Un fallo en `touch` solo se registra.
2. Con `Authorization: Bearer`: se verifica siempre, también en rutas públicas; inválido da 401. Otro esquema se ignora.
3. Sin identidad: pasan `POST` a las siete rutas `PUBLIC_AUTH` y cualquier método sobre `/actuator/health` y sus subrutas (`EndpointRequest.to("health")` no distingue el método). El resto da 401 `UNAUTHENTICATED` "Se requiere un token de acceso válido", incluidas las rutas inexistentes (reemplaza a R13).
4. Con identidad: `RateLimiter.check(subject, write)`, con `subject` = `sub` o `apikey:<id>` y `write` = método distinto de GET, HEAD y OPTIONS. Rechazo: 429 `RATE_LIMITED` "Demasiadas peticiones en poco tiempo; espere unos segundos", con `Retry-After`.

`CurrentUserGuard`: con API key, 403 `API_KEY_NOT_ALLOWED` "Esta operación solo la hace una persona, no una API key"; sin fila en `users`, 401. El 415 pasa de guard a interceptor (R12).

- [ ] **Step 1: Escribir las pruebas que fallan**

Traducir `SecurityIT` y, de `AuthApiIT`, `anAccountIsCreatedConfirmedAndUsed`, `changingThePasswordKeepsThisSessionAndClosesTheOthers` y `theConfirmationLinkCanBeSentAgainOnlyWithASession`. De `ApiKeyAuthenticationIT`: `invalidKeysAllAnswerTheSame`, `emptyHeaderIsRejected`, `surroundingWhitespaceIsIgnored`, `bothCredentialsAreAmbiguous`, `personOnlyEndpointsRejectKeys`, `keyValueNeverReachesTheLogs`, y las dos de `ApiKeyDatabaseFailureIT`. Las keys de prueba se insertan por SQL hasta la Task 7. Añadir:

```ts
it.each([
  ['JSON malformado', () => http.post('/api/v1/tenants').set('Content-Type', 'application/json').send('{')],
  ['ruta inexistente', () => http.get('/api/v1/no-existe')],
  ['ruta fuera de la API', () => http.get('/nada')],
  ['método incorrecto', () => http.delete('/api/v1/tenants')],
  ['text/plain', () => http.post('/api/v1/tenants').set('Content-Type', 'text/plain').send('x')],
])('sin credenciales, %s da 401', async (_n, call) => {
  expect((await call()).status).toBe(401);
});
it('sin credenciales un cuerpo de 11 MB da 401, no 413: no se llega a leer', ...);
it('un Bearer inválido en una ruta pública da 401', async () => {
  await http.post('/api/v1/auth/login').set('Authorization', 'Bearer x').send(valido).expect(401);
});
it('POST a /actuator/health sin credenciales da 405, como Spring', ...);
it('un usuario autenticado que envía JSON malformado cuenta para el límite', ...);
it('con token válido, una ruta inexistente da 404', ...);
```

- [ ] **Step 2: Ejecutar y comprobar que fallan**

Run: `npx vitest run --project integration test/integration/identity/security.int.spec.ts test/integration/apikey`
Expected: FAIL.

- [ ] **Step 3: Implementar y añadir `/auth/me`, `/auth/password` y `/auth/email-verification/resend`**

- [ ] **Step 4: Adaptar las pruebas de E0 que ahora necesitan credenciales**

`errors.int.spec.ts`, `correlation-context.int.spec.ts` y `health.int.spec.ts` envían un token válido donde lo necesiten, firmado con `testConfig`. Sus aserciones sobre el cuerpo no cambian.

- [ ] **Step 5: Ejecutar toda la suite**

Run: `npm test && npm run build && npm run test:integration && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "feat(identity): autenticación antes del cuerpo y límite por identidad"
```

---

### Task 6: Empresas, empresa activa, roles y auditoría

**Files:**
- Create: `src/tenancy/tenant-access.ts`, `src/tenancy/tenant-access.guard.ts`, `src/tenancy/tenant.service.ts`, `src/tenancy/tenant.controller.ts`, `src/tenancy/tenancy.module.ts`, `src/compliance/audit-log.ts`, `src/compliance/compliance.module.ts`
- Modify: `src/app.module.ts`
- Test: `test/unit/tenancy/tenant-access.spec.ts`, `test/integration/tenancy/tenant-api.int.spec.ts`, `test/integration/tenancy/tenant-context.int.spec.ts`

**Interfaces:**
- Produces: `class TenantAccess` con `userId`, `tenantId`, `role`, `apiKeyId: string | null`, `viaApiKey`, `requireWrite()`, `requireOwner()`, `requireProductCreation()`, `requireBilling()`. `Role = 'OWNER' | 'ADMIN' | 'BILLER' | 'AUDITOR'`, `canWrite(role)`, `canBill(role)`, `API_KEY_ROLE = 'BILLER'`.
- Produces: `@Tenant()` y `UseGuards(TenantAccessGuard)`.
- Produces: `class AuditLog` con `recordFor(trx: Transaction<DB>, access: TenantAccess, action, entityType, entityId, metadata)` y `record(trx, tenantId, actorId, action, entityType, entityId, metadata)`. `trx` es obligatorio: equivale a `Propagation.MANDATORY`.
- Produces: `TenantView = { id; name; status; role }`.

Reglas y textos de `tenancy/TenantAccessResolver.java`, `tenancy/TenantAccess.java` y `tenancy/TenantService.java`. Empresa ajena e inexistente responden igual: 403 `TENANT_FORBIDDEN` "Sin acceso al tenant indicado". Solo cuentan membresías `ACTIVE` de empresas `ACTIVE`.

- [ ] **Step 1: Escribir las pruebas que fallan**

Traducir `TenantApiIT` y `TenantContextIT` completos, `headerOfForeignTenantDoesNotGrantAccess` de `TenantIsolationIT`, y de `ApiKeyAuthenticationIT`: `otherTenantHeaderIsForbidden`, `suspendedTenantDisablesTheKey`, `creatorWithoutAccessDisablesTheKey`, `creatorWhoCannotBillDisablesTheKey`. El resto de `TenantIsolationIT` llega en E2. Añadir: `tenantId` en el cuerpo se ignora; crear una empresa escribe `TENANT_CREATED` en `audit_events` en la misma transacción; si la auditoría falla no queda la empresa.

- [ ] **Step 2: Ejecutar y comprobar que fallan**

Run: `npx vitest run --project unit test/unit/tenancy && npx vitest run --project integration test/integration/tenancy`
Expected: FAIL.

- [ ] **Step 3: Implementar**

- [ ] **Step 4: Ejecutar las pruebas del Step 2 y `npm run lint && npm run typecheck`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(tenancy): empresas, empresa activa, roles y auditoría"
```

---

### Task 7: Gestión de API keys

**Files:**
- Create: `src/apikey/api-key.controller.ts`, `src/apikey/api-key.dto.ts`, `src/apikey/apikey.module.ts`
- Modify: `src/apikey/api-key.service.ts`, `src/app.module.ts`
- Test: `test/integration/apikey/api-key-api.int.spec.ts`

**Interfaces:**
- Consumes: `TenantAccess`, `AuditLog`, `UuidPipe`.
- Produces: `ApiKeyService.create(access, name)`, `list(access)` y `revoke(access, id)`. `ApiKeyView = { id; name; publicId; createdBy; createdAt; lastUsedAt; revokedAt }`, `CreatedApiKey = { id; name; publicId; key; createdAt }`.

Reglas de `apikey/ApiKeyService.java`: tope de 10 activas con `SELECT ... FOR UPDATE` sobre la empresa; nombre con `strip` y de 1 a 80 puntos de código; nombre activo repetido da 409 `API_KEY_NAME_TAKEN` (error 23505 en `uq_api_keys_active_name`); key de otra empresa da 404 `API_KEY_NOT_FOUND`; revocar otra vez no cambia nada ni se audita.

- [ ] **Step 1: Escribir las pruebas que fallan**

Traducir `ApiKeyApiIT` completo y, de `ApiKeyAuthenticationIT`, `revokedKeyStopsAtOnce`, `lastUsedAtIsWrittenAtMostOncePerMinute` y `auditNamesTheKeyAndItsCreator`. `concurrentCreatesRespectTheLimit` lanza 20 altas en paralelo sobre 9 activas y exige exactamente 1 creada. La auditoría no contiene ni la key ni su hash.

- [ ] **Step 2: Ejecutar y comprobar que fallan**

Run: `npx vitest run --project integration test/integration/apikey/api-key-api.int.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar**

- [ ] **Step 4: Ejecutar `npx vitest run --project integration test/integration/apikey` y `npm run lint && npm run typecheck`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(apikey): crear, listar y revocar API keys"
```

---

### Task 8: Worker y purga de sesiones

**Files:**
- Create: `src/orchestration/worker.module.ts`, `src/identity/auth-purge.ts`
- Modify: `src/app.module.ts`, `package.json`
- Test: `test/integration/identity/auth-purge.int.spec.ts`, `test/unit/orchestration/worker.module.spec.ts`

**Interfaces:**
- Produces: `WorkerModule.register(workerEnabled: boolean): DynamicModule`, el punto donde E4–E6 añadirán consumidores y tareas. Solo con `true` importa `ScheduleModule.forRoot()` y sus tareas.
- Produces: `class AuthPurge` con `purge(): Promise<void>`, cada hora. Es un valor fijo: Java lo admite como propiedad, pero no lo documenta ni lo usa ningún despliegue.

- [ ] **Step 1: Escribir las pruebas que fallan**

Integración: `purge` borra sesiones y enlaces vencidos hace más de 7 días, con los tokens de renovación por cascada; conserva los vencidos hace menos. Con la base caída no lanza. Unitaria: con `workerEnabled: false` la tarea no existe en la aplicación.

- [ ] **Step 2: Ejecutar y comprobar que fallan**

Run: `npx vitest run --project unit test/unit/orchestration && npx vitest run --project integration test/integration/identity/auth-purge.int.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar**

- [ ] **Step 4: Ejecutar las pruebas del Step 2 y `npm run lint && npm run typecheck`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test package.json package-lock.json
git commit -m "feat(orchestration): módulo de worker y purga de sesiones vencidas"
```

---

### Task 9: Compatibilidad con datos de Java y pendientes de E0

**Files:**
- Create: `tools/java-dump/run.mjs`, `tools/java-dump/README.md`, `test/fixtures/java-e1/dump.sql`, `test/fixtures/java-e1/meta.json`
- Modify: `src/database/database.module.ts`, `src/common/problem-details.filter.ts`, `test/integration/database/migrations.int.spec.ts`, `test/integration/common/rate-limiter.int.spec.ts`, `README.md`, `docs/route-inventory.md`
- Test: `test/integration/identity/java-compat.int.spec.ts`

**Interfaces:**
- Produces: `node tools/java-dump/run.mjs --java-repo <ruta>`: levanta PostgreSQL, RabbitMQ y Redis efímeros, arranca el jar de Java (`SRI_ENABLED_ENVIRONMENTS` vacío, correo apagado y `EINVOICE_AUTH_SESSIONTTL=87600h`, para que la sesión del dump no caduque y la prueba de renovación siga valiendo con el tiempo), y por HTTP registra un usuario, ingresa, crea una empresa y una API key. Escribe `pg_dump --no-owner` en `dump.sql` y en `meta.json` el correo, la contraseña, `tenantId`, el `refreshToken`, el `accessToken` con su `exp`, la API key, y `EINVOICE_JWT_SECRET` y `EINVOICE_MASTER_KEY` usados. Todo son valores de prueba generados en esa ejecución.

- [ ] **Step 1: Escribir la prueba que falla**

`java-compat.int.spec.ts` carga `dump.sql` en un PostgreSQL de prueba, ejecuta `flyway validate` y arranca NestJS con los secretos de `meta.json`. Comprueba, sin escribir nada por Java:

```ts
it('un usuario creado por Java ingresa con su contraseña', ...);
it('un token de renovación emitido por Java renueva la sesión', ...);
it('la API key creada por Java autentica y conserva su empresa', ...);
it('GET /tenants/current devuelve la empresa creada por Java', ...);
it('el access token de Java se acepta con el reloj fijado antes de su exp', ...);
```

- [ ] **Step 2: Generar los datos y ejecutar**

Run: `node tools/java-dump/run.mjs --java-repo ../backend-emite-facil && npx vitest run --project integration test/integration/identity/java-compat.int.spec.ts`
Expected: la generación termina con código 0 y las pruebas pasan. Si una falla, es una incompatibilidad real: se corrige en NestJS, no en los datos.

- [ ] **Step 3: Cerrar los pendientes de E0 asignados a E1**

`pool.on('error')` registra solo el código del error. `ProblemDetailsFilter` registra las `HttpException` 5xx. `migrations.int.spec.ts` deja el `any` y el import dinámico. `rate-limiter.int.spec.ts` añade el puerto rechazado con el contador en 3, como `RateLimiterTest.java`. `OPTIONS` sobre una ruta existente responde 200 con `Allow`, con prueba en `errors.int.spec.ts`.

- [ ] **Step 4: Actualizar la documentación**

README: estado E1. `docs/route-inventory.md`: marcar como portadas las 16 rutas de E1.

- [ ] **Step 5: Ejecutar toda la suite**

Run: `npm run lint && npm run typecheck && npm test && npm run build && npm run test:integration && npm audit --omit=dev --audit-level=high`
Expected: todo pasa.

- [ ] **Step 6: Commit**

```bash
git add tools test src README.md docs
git commit -m "test(identity): datos creados por Java siguen funcionando en NestJS"
```
