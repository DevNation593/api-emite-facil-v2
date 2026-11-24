# Inventario de rutas

Rutas de los controladores de la API Java (`@RequestMapping` de clase más `@GetMapping`, `@PostMapping`, `@PutMapping`, `@PatchMapping` y `@DeleteMapping` de `src/main/java`, repo `backend-emite-facil`) frente a `contracts/openapi.yaml`. La comparación ignora el nombre de los parámetros de ruta (`{id}` y `{taxpayerId}` son la misma ruta). La etapa es la del plan de migración (E1 a E6) en la que se porta la ruta; "Portada" dice si NestJS ya la sirve.

| Método | Ruta | En openapi.yaml | Módulo Java | Etapa | Portada |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/api-keys` | sí | `apikey` (`ApiKeyController`) | E1 | sí |
| POST | `/api/v1/api-keys` | sí | `apikey` (`ApiKeyController`) | E1 | sí |
| DELETE | `/api/v1/api-keys/{id}` | sí | `apikey` (`ApiKeyController`) | E1 | sí |
| POST | `/api/v1/auth/email-verification` | sí | `identity` (`AuthController`) | E1 | sí |
| POST | `/api/v1/auth/email-verification/resend` | sí | `identity` (`AuthController`) | E1 | sí |
| POST | `/api/v1/auth/login` | sí | `identity` (`AuthController`) | E1 | sí |
| POST | `/api/v1/auth/logout` | sí | `identity` (`AuthController`) | E1 | sí |
| GET | `/api/v1/auth/me` | sí | `identity` (`AuthController`) | E1 | sí |
| POST | `/api/v1/auth/password` | sí | `identity` (`AuthController`) | E1 | sí |
| POST | `/api/v1/auth/password-reset` | sí | `identity` (`AuthController`) | E1 | sí |
| POST | `/api/v1/auth/password-reset/request` | sí | `identity` (`AuthController`) | E1 | sí |
| POST | `/api/v1/auth/refresh` | sí | `identity` (`AuthController`) | E1 | sí |
| POST | `/api/v1/auth/register` | sí | `identity` (`AuthController`) | E1 | sí |
| GET | `/api/v1/tenants` | sí | `tenancy` (`TenantController`) | E1 | sí |
| POST | `/api/v1/tenants` | sí | `tenancy` (`TenantController`) | E1 | sí |
| GET | `/api/v1/tenants/current` | sí | `tenancy` (`TenantController`) | E1 | sí |
| GET | `/api/v1/catalogs/identification-types` | sí | `catalog` (`CatalogController`) | E2 | sí |
| GET | `/api/v1/catalogs/payment-methods` | sí | `catalog` (`CatalogController`) | E2 | sí |
| GET | `/api/v1/catalogs/tax-rates` | sí | `catalog` (`CatalogController`) | E2 | sí |
| GET | `/api/v1/certificates` | sí | `certificate` (`CertificateController`) | E2 | sí |
| POST | `/api/v1/certificates` | sí | `certificate` (`CertificateController`) | E2 | sí |
| GET | `/api/v1/customers` | sí | `catalog` (`CustomerController`) | E2 | sí |
| POST | `/api/v1/customers` | sí | `catalog` (`CustomerController`) | E2 | sí |
| DELETE | `/api/v1/customers/{id}` | sí | `catalog` (`CustomerController`) | E2 | sí |
| GET | `/api/v1/customers/{id}` | sí | `catalog` (`CustomerController`) | E2 | sí |
| PUT | `/api/v1/customers/{id}` | sí | `catalog` (`CustomerController`) | E2 | sí |
| GET | `/api/v1/emission-points` | sí | `taxpayer` (`EmissionPointController`) | E2 | sí |
| POST | `/api/v1/emission-points` | sí | `taxpayer` (`EmissionPointController`) | E2 | sí |
| PUT | `/api/v1/emission-points/{id}/sequence` | sí | `sequence` (`SequenceController`) | E2 | sí |
| GET | `/api/v1/products` | sí | `catalog` (`ProductController`) | E2 | sí |
| POST | `/api/v1/products` | sí | `catalog` (`ProductController`) | E2 | sí |
| DELETE | `/api/v1/products/{id}` | sí | `catalog` (`ProductController`) | E2 | sí |
| GET | `/api/v1/products/{id}` | sí | `catalog` (`ProductController`) | E2 | sí |
| PUT | `/api/v1/products/{id}` | sí | `catalog` (`ProductController`) | E2 | sí |
| GET | `/api/v1/taxpayers` | sí | `taxpayer` (`TaxpayerController`) | E2 | sí |
| POST | `/api/v1/taxpayers` | sí | `taxpayer` (`TaxpayerController`) | E2 | sí |
| GET | `/api/v1/taxpayers/{id}` | sí | `taxpayer` (`TaxpayerController`) | E2 | sí |
| PATCH | `/api/v1/taxpayers/{id}` | sí | `taxpayer` (`TaxpayerController`) | E2 | sí |
| GET | `/api/v1/taxpayers/{taxpayerId}/establishments` | sí | `taxpayer` (`EstablishmentController`) | E2 | sí |
| POST | `/api/v1/taxpayers/{taxpayerId}/establishments` | sí | `taxpayer` (`EstablishmentController`) | E2 | sí |
| POST | `/api/v1/credit-notes` | sí | `notes` (`CreditNoteController`) | E3 | sí |
| POST | `/api/v1/debit-notes` | sí | `notes` (`DebitNoteController`) | E3 | sí |
| GET | `/api/v1/documents` | sí | `billing` (`DocumentController`) | E3 | sí |
| GET | `/api/v1/documents/{id}` | sí | `billing` (`DocumentController`) | E3 | sí |
| POST | `/api/v1/invoices` | sí | `billing` (`InvoiceController`) | E3 | sí |
| POST | `/api/v1/documents/{id}/retry` | sí | `orchestration` (`DocumentRetryController`) | E4 | sí |
| GET | `/api/v1/documents/{id}/sri-attempts` | sí | `sri` (`SriAttemptController`) | E4 | sí |
| POST | `/api/v1/webhooks/deliveries/{id}/retry` | sí | `webhook` (`WebhookController`) | E6 | no |
| GET | `/api/v1/documents/{id}/artifacts/{kind}` | sí | `storage` (`ArtifactController`) | E5 | sí |
| GET | `/api/v1/documents/{id}/deliveries` | sí | `delivery` (`DeliveryController`) | E5 | sí |
| POST | `/api/v1/documents/{id}/deliveries` | sí | `delivery` (`DeliveryController`) | E5 | sí |
| GET | `/api/v1/webhooks/subscriptions/{id}/deliveries` | sí | `webhook` (`WebhookController`) | E6 | no |
| POST | `/api/v1/taxpayers/{id}/production-activation` | sí | `compliance` (`ProductionActivationController`) | E6 | no |
| GET | `/api/v1/taxpayers/{id}/production-readiness` | sí | `compliance` (`ProductionActivationController`) | E6 | no |
| GET | `/api/v1/webhooks/subscriptions` | sí | `webhook` (`WebhookController`) | E6 | no |
| POST | `/api/v1/webhooks/subscriptions` | sí | `webhook` (`WebhookController`) | E6 | no |
| DELETE | `/api/v1/webhooks/subscriptions/{id}` | sí | `webhook` (`WebhookController`) | E6 | no |
| PUT | `/api/v1/webhooks/subscriptions/{id}` | sí | `webhook` (`WebhookController`) | E6 | no |
| POST | `/api/v1/webhooks/subscriptions/{id}/secret` | sí | `webhook` (`WebhookController`) | E6 | no |
| POST | `/api/v1/webhooks/subscriptions/{id}/test` | sí | `webhook` (`WebhookController`) | E6 | no |

Total: 60 rutas en Java; 60 operaciones en el contrato. Portadas: 50 (16 de E1, 24 de E2, 5 de E3, 2 de E4 y 3 de E5). `POST /webhooks/deliveries/{id}/retry` (antes E4) y `GET /webhooks/subscriptions/{id}/deliveries` (antes E5) pasan a E6: son las entregas de los webhooks, no las de los comprobantes.

## Diferencias entre Java y el contrato

### En Java y no en el contrato

Ninguna.

### En el contrato y no en Java

Ninguna.

### Códigos de error

Java devuelve `CATALOG_CHANGED` (409, al editar o borrar un cliente o un producto que otra petición
cambió entre medias) y el enum `errorCode` de `openapi.yaml` no lo declara. NestJS lo devuelve igual;
`JAVA_ONLY_ERROR_CODES` en `src/common/error-codes.ts` lo deja anotado.

Lo mismo ocurre con los códigos de las emisiones de E3, que `openapi.yaml` nombra en las descripciones
pero no en el enum: `DOCUMENT_XML_INVALID`, `REPLACED_DOCUMENT_OTHER_TYPE`, `MODIFIED_DOCUMENT_REQUIRED`,
`MODIFIED_DOCUMENT_NOT_INVOICE`, `MODIFIED_INVOICE_OTHER_ISSUER`, `MODIFIED_INVOICE_NOT_AUTHORIZED`,
`INVALID_MODIFIED_DOCUMENT_DATE`, `CREDIT_LINE_UNKNOWN`, `CREDIT_LINE_EXCEEDS_INVOICE` y
`CREDIT_EXCEEDS_INVOICE`. También están en `JAVA_ONLY_ERROR_CODES`.

### Detalle de `DOCUMENT_XML_INVALID`

Cuando el XML generado no pasa el XSD del SRI, o no se puede leer, Java pone en `detail` el mensaje de
Xerces; NestJS valida con libxml2 (`xmllint-wasm`) y lee el XML con `saxes`, así que el `detail` trae
el mensaje de libxml2 o de `saxes`. El estado (422), el `errorCode`, el título, el tope de 500
caracteres y que no se consuma el secuencial son los mismos; solo cambia el texto del motor.

Hay una diferencia más: si el motor XSD no responde (plazo de 10 s vencido o fallo del worker de libxml2),
NestJS contesta `500 INTERNAL_ERROR` y revierte la transacción, sin consumir el secuencial. Java
(`XsdValidator.java`) trata la `IOException` como un resultado inválido y contestaría `422`.

### Consumidor de comprobantes (E4)

El consumidor de `document.issue` toma a la vez tantos mensajes como `EINVOICE_WORKER_MAX_CONSUMERS`
(`prefetch`), en lugar de escalar entre `EINVOICE_WORKER_CONSUMERS` y ese máximo como el contenedor de Spring.
Un mensaje ilegible o sin empresa o sin documento va directo a `document.issue.dlq`, sin los 3 reintentos que
Spring le daría antes de rechazarlo; un mensaje legible que falla sí se reintenta (a los 2, 4 y 8 s) antes de ir
a la cola de mensajes muertos. Al apagarse, un mensaje que espera su reintento vuelve a la cola en vez de esperar.

### Consultas de autorización duplicadas (E4)

Diferencia deliberada en el pipeline: si llegan varios eventos del mismo comprobante en `RECEIVED` o `SENDING`,
Java consulta al SRI por cada uno y cada respuesta no concluyente gasta un reintento. NestJS reserva la consulta
con el comprobante bloqueado: descarta el avance si ya hay una consulta en curso (conexión + lectura + 30 s) o si
no ha pasado la espera mínima desde el último resultado, sin llamar al SRI ni tocar `attempt_count`. Una consulta
que pasa ese plazo queda `ABANDONED` y su resultado tardío no se aplica. El reintento manual pone la cuenta a
cero, así que consulta de inmediato.

### Rutas estrictas (E4)

Como Spring 6, una ruta con barra final (`/documents/{id}/retry/`) no es la misma y responde 404, y
`POST /documents/{id}/retry` no lee el cuerpo (un JSON ilegible no es un error), como un manejador sin
`@RequestBody`. `tools/java-probe` lo fija en `test/golden/http/e4.json`.

### Cuerpos, cabeceras y descargas (E5)

Como Java, y comprobado con `test/golden/http/e5.json`: toda respuesta lleva las cabeceras por defecto de Spring
Security (sin HSTS: el TLS termina en el proxy); el cuerpo no se lee en `GET`, `HEAD`, `DELETE` ni `OPTIONS`, y en
las demás rutas un cuerpo ilegible o de un tipo que no es JSON solo es un error cuando el manejador va a leerlo, después
de la ruta, el acceso a la empresa y los identificadores. La descarga admite `If-None-Match` (304) y no negocia
`Accept` ni rangos.

Diferencias que quedan, todas de antes de llegar a la API: una ruta con `;` la rechaza el cortafuegos de Spring
Security con 401 y una con `%2F` la rechaza Tomcat con una página HTML 400; en NestJS son rutas o valores como
cualquier otro (400 o 404 en problem+json).

### Entrega por correo (E5)

- El texto con que el servidor SMTP rechaza un mensaje (`lastError`) se lee en UTF-8; JavaMail lo lee en Latin-1.
- Una respuesta `251` o `252` al mensaje completo cuenta como aceptado; JavaMail la da por fallo temporal y el correo
  se repetiría.
- `lastError` nombra la excepción de Java que correspondería (`ConnectException`, `SocketTimeoutException`,
  `AuthenticationFailedException`…), salvo un fallo imprevisto, que nombra la clase de JavaScript.
- El RIDE se compone en el mismo hilo que atiende la API: uno de 500 líneas ocupa unos 0,1–0,2 s. Una instancia con
  `EINVOICE_WORKER_ENABLED=false` no compone ninguno.
- El XML firmado va en el XML autorizado byte a byte sin pasar por texto.
