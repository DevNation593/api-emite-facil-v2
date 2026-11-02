# Inventario de rutas

Rutas de los controladores de la API Java (`@RequestMapping` de clase más `@GetMapping`, `@PostMapping`, `@PutMapping`, `@PatchMapping` y `@DeleteMapping` de `src/main/java`, repo `backend-emite-facil`) frente a `contracts/openapi.yaml`. La comparación ignora el nombre de los parámetros de ruta (`{id}` y `{taxpayerId}` son la misma ruta). La etapa es la del plan de migración (E1 a E6) en la que se porta la ruta.

| Método | Ruta | En openapi.yaml | Módulo Java | Etapa |
| --- | --- | --- | --- | --- |
| GET | `/api/v1/api-keys` | sí | `apikey` (`ApiKeyController`) | E1 |
| POST | `/api/v1/api-keys` | sí | `apikey` (`ApiKeyController`) | E1 |
| DELETE | `/api/v1/api-keys/{id}` | sí | `apikey` (`ApiKeyController`) | E1 |
| POST | `/api/v1/auth/email-verification` | sí | `identity` (`AuthController`) | E1 |
| POST | `/api/v1/auth/email-verification/resend` | sí | `identity` (`AuthController`) | E1 |
| POST | `/api/v1/auth/login` | sí | `identity` (`AuthController`) | E1 |
| POST | `/api/v1/auth/logout` | sí | `identity` (`AuthController`) | E1 |
| GET | `/api/v1/auth/me` | sí | `identity` (`AuthController`) | E1 |
| POST | `/api/v1/auth/password` | sí | `identity` (`AuthController`) | E1 |
| POST | `/api/v1/auth/password-reset` | sí | `identity` (`AuthController`) | E1 |
| POST | `/api/v1/auth/password-reset/request` | sí | `identity` (`AuthController`) | E1 |
| POST | `/api/v1/auth/refresh` | sí | `identity` (`AuthController`) | E1 |
| POST | `/api/v1/auth/register` | sí | `identity` (`AuthController`) | E1 |
| GET | `/api/v1/tenants` | sí | `tenancy` (`TenantController`) | E1 |
| POST | `/api/v1/tenants` | sí | `tenancy` (`TenantController`) | E1 |
| GET | `/api/v1/tenants/current` | sí | `tenancy` (`TenantController`) | E1 |
| GET | `/api/v1/catalogs/identification-types` | sí | `catalog` (`CatalogController`) | E2 |
| GET | `/api/v1/catalogs/payment-methods` | sí | `catalog` (`CatalogController`) | E2 |
| GET | `/api/v1/catalogs/tax-rates` | sí | `catalog` (`CatalogController`) | E2 |
| GET | `/api/v1/certificates` | sí | `certificate` (`CertificateController`) | E2 |
| POST | `/api/v1/certificates` | sí | `certificate` (`CertificateController`) | E2 |
| GET | `/api/v1/customers` | sí | `catalog` (`CustomerController`) | E2 |
| POST | `/api/v1/customers` | sí | `catalog` (`CustomerController`) | E2 |
| DELETE | `/api/v1/customers/{id}` | sí | `catalog` (`CustomerController`) | E2 |
| GET | `/api/v1/customers/{id}` | sí | `catalog` (`CustomerController`) | E2 |
| PUT | `/api/v1/customers/{id}` | sí | `catalog` (`CustomerController`) | E2 |
| GET | `/api/v1/emission-points` | sí | `taxpayer` (`EmissionPointController`) | E2 |
| POST | `/api/v1/emission-points` | sí | `taxpayer` (`EmissionPointController`) | E2 |
| PUT | `/api/v1/emission-points/{id}/sequence` | sí | `sequence` (`SequenceController`) | E2 |
| GET | `/api/v1/products` | sí | `catalog` (`ProductController`) | E2 |
| POST | `/api/v1/products` | sí | `catalog` (`ProductController`) | E2 |
| DELETE | `/api/v1/products/{id}` | sí | `catalog` (`ProductController`) | E2 |
| GET | `/api/v1/products/{id}` | sí | `catalog` (`ProductController`) | E2 |
| PUT | `/api/v1/products/{id}` | sí | `catalog` (`ProductController`) | E2 |
| GET | `/api/v1/taxpayers` | sí | `taxpayer` (`TaxpayerController`) | E2 |
| POST | `/api/v1/taxpayers` | sí | `taxpayer` (`TaxpayerController`) | E2 |
| GET | `/api/v1/taxpayers/{id}` | sí | `taxpayer` (`TaxpayerController`) | E2 |
| PATCH | `/api/v1/taxpayers/{id}` | sí | `taxpayer` (`TaxpayerController`) | E2 |
| GET | `/api/v1/taxpayers/{taxpayerId}/establishments` | sí | `taxpayer` (`EstablishmentController`) | E2 |
| POST | `/api/v1/taxpayers/{taxpayerId}/establishments` | sí | `taxpayer` (`EstablishmentController`) | E2 |
| POST | `/api/v1/credit-notes` | sí | `notes` (`CreditNoteController`) | E3 |
| POST | `/api/v1/debit-notes` | sí | `notes` (`DebitNoteController`) | E3 |
| GET | `/api/v1/documents` | sí | `billing` (`DocumentController`) | E3 |
| GET | `/api/v1/documents/{id}` | sí | `billing` (`DocumentController`) | E3 |
| POST | `/api/v1/invoices` | sí | `billing` (`InvoiceController`) | E3 |
| POST | `/api/v1/documents/{id}/retry` | sí | `orchestration` (`DocumentRetryController`) | E4 |
| GET | `/api/v1/documents/{id}/sri-attempts` | sí | `sri` (`SriAttemptController`) | E4 |
| POST | `/api/v1/webhooks/deliveries/{id}/retry` | sí | `webhook` (`WebhookController`) | E4 |
| GET | `/api/v1/documents/{id}/artifacts/{kind}` | sí | `storage` (`ArtifactController`) | E5 |
| GET | `/api/v1/documents/{id}/deliveries` | sí | `delivery` (`DeliveryController`) | E5 |
| POST | `/api/v1/documents/{id}/deliveries` | sí | `delivery` (`DeliveryController`) | E5 |
| GET | `/api/v1/webhooks/subscriptions/{id}/deliveries` | sí | `webhook` (`WebhookController`) | E5 |
| POST | `/api/v1/taxpayers/{id}/production-activation` | sí | `compliance` (`ProductionActivationController`) | E6 |
| GET | `/api/v1/taxpayers/{id}/production-readiness` | sí | `compliance` (`ProductionActivationController`) | E6 |
| GET | `/api/v1/webhooks/subscriptions` | sí | `webhook` (`WebhookController`) | E6 |
| POST | `/api/v1/webhooks/subscriptions` | sí | `webhook` (`WebhookController`) | E6 |
| DELETE | `/api/v1/webhooks/subscriptions/{id}` | sí | `webhook` (`WebhookController`) | E6 |
| PUT | `/api/v1/webhooks/subscriptions/{id}` | sí | `webhook` (`WebhookController`) | E6 |
| POST | `/api/v1/webhooks/subscriptions/{id}/secret` | sí | `webhook` (`WebhookController`) | E6 |
| POST | `/api/v1/webhooks/subscriptions/{id}/test` | sí | `webhook` (`WebhookController`) | E6 |

Total: 60 rutas en Java; 60 operaciones en el contrato.

## Diferencias entre Java y el contrato

### En Java y no en el contrato

Ninguna.

### En el contrato y no en Java

Ninguna.
