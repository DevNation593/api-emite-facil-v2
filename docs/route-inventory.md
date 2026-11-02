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
| POST | `/api/v1/credit-notes` | sí | `notes` (`CreditNoteController`) | E3 | no |
| POST | `/api/v1/debit-notes` | sí | `notes` (`DebitNoteController`) | E3 | no |
| GET | `/api/v1/documents` | sí | `billing` (`DocumentController`) | E3 | no |
| GET | `/api/v1/documents/{id}` | sí | `billing` (`DocumentController`) | E3 | no |
| POST | `/api/v1/invoices` | sí | `billing` (`InvoiceController`) | E3 | no |
| POST | `/api/v1/documents/{id}/retry` | sí | `orchestration` (`DocumentRetryController`) | E4 | no |
| GET | `/api/v1/documents/{id}/sri-attempts` | sí | `sri` (`SriAttemptController`) | E4 | no |
| POST | `/api/v1/webhooks/deliveries/{id}/retry` | sí | `webhook` (`WebhookController`) | E4 | no |
| GET | `/api/v1/documents/{id}/artifacts/{kind}` | sí | `storage` (`ArtifactController`) | E5 | no |
| GET | `/api/v1/documents/{id}/deliveries` | sí | `delivery` (`DeliveryController`) | E5 | no |
| POST | `/api/v1/documents/{id}/deliveries` | sí | `delivery` (`DeliveryController`) | E5 | no |
| GET | `/api/v1/webhooks/subscriptions/{id}/deliveries` | sí | `webhook` (`WebhookController`) | E5 | no |
| POST | `/api/v1/taxpayers/{id}/production-activation` | sí | `compliance` (`ProductionActivationController`) | E6 | no |
| GET | `/api/v1/taxpayers/{id}/production-readiness` | sí | `compliance` (`ProductionActivationController`) | E6 | no |
| GET | `/api/v1/webhooks/subscriptions` | sí | `webhook` (`WebhookController`) | E6 | no |
| POST | `/api/v1/webhooks/subscriptions` | sí | `webhook` (`WebhookController`) | E6 | no |
| DELETE | `/api/v1/webhooks/subscriptions/{id}` | sí | `webhook` (`WebhookController`) | E6 | no |
| PUT | `/api/v1/webhooks/subscriptions/{id}` | sí | `webhook` (`WebhookController`) | E6 | no |
| POST | `/api/v1/webhooks/subscriptions/{id}/secret` | sí | `webhook` (`WebhookController`) | E6 | no |
| POST | `/api/v1/webhooks/subscriptions/{id}/test` | sí | `webhook` (`WebhookController`) | E6 | no |

Total: 60 rutas en Java; 60 operaciones en el contrato. Portadas: 40 (16 de E1 y 24 de E2).

## Diferencias entre Java y el contrato

### En Java y no en el contrato

Ninguna.

### En el contrato y no en Java

Ninguna.

### Códigos de error

Java devuelve `CATALOG_CHANGED` (409, al editar o borrar un cliente o un producto que otra petición
cambió entre medias) y el enum `errorCode` de `openapi.yaml` no lo declara. NestJS lo devuelve igual;
`JAVA_ONLY_ERROR_CODES` en `src/common/error-codes.ts` lo deja anotado.
