# AGENTS.md — API de facturación electrónica (api-emite-facil-v2)

API y worker del SaaS de facturación electrónica para Ecuador, portados 1:1 desde Java/Spring Boot a Node 24, TypeScript 6 y NestJS 12 (ESM), con Kysely, PostgreSQL, RabbitMQ (`amqplib`), Redis (`ioredis`) y almacenamiento S3/MinIO. Emite la factura (código SRI `01`) y las notas de crédito y débito: calcula y numera, genera el XML, lo valida contra el XSD, lo firma en XAdES-BES, lo transmite al SRI (recepción y autorización), archiva XML y RIDE y los entrega por correo. La aplicación web vive en [client-factura-facil](https://github.com/DevNation593/client-factura-facil).

**Comportamiento de referencia:** hasta el corte, el comportamiento correcto es el del repo Java (`backend-emite-facil`). Ante cualquier duda manda el código Java; las pruebas golden en `test/golden/` se generan a partir de él.

## Contexto que hay que leer

- `docs/superpowers/specs/2026-10-29-api-nestjs-design.md`: diseño de la migración (arquitectura, errores, pruebas).
- `docs/superpowers/plans/`: planes por etapa.
- `README.md`, `docs/DEVELOPMENT.md`, `docs/10-security.md`, `docs/05-electronic-document-flow.md`, `docs/09-error-handling.md` y `docs/11-api-specification.md`: se copian y adaptan del repo Java a medida que avanzan las etapas.
- `contracts/openapi.yaml`: el contrato HTTP; se copia sin cambios.

## Estructura

- `src/<módulo>/`: código NestJS por módulo (`tenancy`, `identity`, `apikey`, `taxpayer`, `catalog`, `sequence`, `billing`, `notes`, `xml`, `signature`, `certificate`, `sri`, `orchestration`, `storage`, `delivery`, `webhook`, `compliance`, `observability` y `common`).
- `src/main.ts`: arranque (API o API+worker); `src/bootstrap.ts` expone `createApp`, que crea la app sin escuchar.
- `db/migration/`: migraciones `V1`…`V19` copiadas de Java sin cambios; lo nuevo como `V20+`. Una migración publicada no se edita: se añade otra.
- `resources/xsd/`: XSD y XML de ejemplo del SRI, resueltos sin red.
- `contracts/openapi.yaml`: contrato de la API.
- `test/unit/`, `test/integration/` (Testcontainers), `test/golden/` (casos generados con Java).
- `tools/golden-generator/`: programa Java que produce `test/golden/` a partir del código Java.
- `e2e/`: pruebas con navegador del recorrido completo contra un SRI simulado.
- `infra/`, `docs/`, `scripts/`: copiados y adaptados a Node.

## Comandos

```bash
npm ci                      # instala dependencias
npm test                    # unitarias + golden (sin Docker)
npm run test:integration    # integración; necesita Docker en marcha
npm run lint
npm run typecheck
npm run build
```

## Convenciones

- Documentación, comentarios, mensajes de commit y textos para el usuario en español; identificadores de código en inglés.
- Commits con el formato `tipo(ámbito): descripción en español`, por ejemplo `feat(sri): …` o `fix(billing): …`.
- Ramas: `dev` es la de integración y cada cambio entra por pull request a `dev`. De ahí se promueve a `qa` y luego a `main`.
- Proyecto ESM: imports relativos con extensión `.js`.

## Code Review Rules

### Cómo revisar

- Escribe la revisión en español.
- Señala solo defectos reales que puedas sostener con el código del diff y su contexto: una entrada concreta que produce un resultado incorrecto, un dato expuesto, un estado inconsistente. No comentes estilo, nombres ni formato.
- Cita el archivo y la línea, explica el escenario que falla y propone el arreglo mínimo.
- Antes de marcar algo como riesgo, comprueba si `SECURITY.md` o `docs/10-security.md` lo declaran como límite aceptado. Si es así, no lo marques, salvo que el cambio lo empeore.

### Qué es P0

Trátalo como P0 aunque el cambio parezca pequeño:

- Una empresa puede leer, modificar o emitir con datos de otra: `tenantId` tomado del cuerpo, de la ruta o de un mensaje sin comprobarlo contra el usuario autenticado o la API key, o una consulta sin filtro por empresa.
- El `.p12`, su contraseña, la clave maestra, un token, una API key completa o un secreto de webhook llegan a logs, respuestas, auditoría, `outbox`, RabbitMQ o métricas.
- Un comprobante firmado, su XML, su autorización, los mensajes del SRI o su historia de estados se modifican o se borran, o se debilitan los disparadores que los hacen de solo inserción.
- Se puede emitir dos veces el mismo comprobante, repetir o saltar un secuencial, o cambiar la clave de acceso de un comprobante ya enviado.
- Se reemite o se cambia la clave tras un timeout del SRI sin consultar antes la autorización.
- Un parser XML acepta `DOCTYPE`, entidades externas o descarga recursos de la red.
- Un endpoint pierde su autenticación o su control de rol.

### Qué es P1

- Importes o cantidades con `number`, o con una escala o un redondeo distintos de los que fija el XSD. El dinero va en `decimal.js`.
- IVA, catálogos, tarifas o versiones de XSD escritos a mano en el código en vez de salir de sus fuentes controladas.
- Un cambio de estado del comprobante sin su evento de auditoría, o fuera de la transacción que lo produce.
- Trabajo en segundo plano que no se deduplica, o una transacción de negocio que publica en RabbitMQ sin pasar por el `outbox`.
- `RECIBIDA` tratado como `AUTORIZADO`, o un estado del SRI mapeado de forma distinta a `docs/05-electronic-document-flow.md`.
- `POST` que crea comprobantes sin exigir ni respetar `Idempotency-Key`.
- Webhooks que llaman sin volver a comprobar que la dirección es pública, que siguen redirecciones o que leen el cuerpo de la respuesta.
- Respuestas de error que revelan si existe un correo, una API key o un recurso de otra empresa.
- Migraciones Flyway que editan una ya publicada, que bloquean tablas grandes sin necesidad o que no tienen camino de datos para filas existentes.
- Cambios en el contrato HTTP sin actualizar `contracts/openapi.yaml`, o un cambio incompatible sin avisar.
- Lógica nueva sin prueba que la ejercite. Lo que toca aislamiento entre empresas, secuenciales, firma o estados del SRI necesita su prueba de integración.
- Documentación en `docs/` o en el `README.md` que deja de ser cierta por el cambio.

### Lo que no hay que marcar

- Que la transmisión al SRI real esté apagada, que no haya MFA o que la clave maestra no venga de un KMS: son límites conocidos y documentados.
- Diferencias de formato que corrige el compilador o el formateador.
