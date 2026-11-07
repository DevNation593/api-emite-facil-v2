# 14 — Integración verificable de XML/XSD de comprobantes

## Estado de activos

Los XSD y XML de ejemplo están físicamente en el repositorio. Todos fueron aportados por el usuario; **no se ha contrastado su hash contra los ZIP del SRI ni contra w3.org**. Hashes y estado por archivo en [xsd-source-registry.csv](xsd-source-registry.csv).

| Código | Comprobante | Versiones | Carpeta | Recibidos |
|---|---|---|---|---|
| `01` | Factura | `1.0.0`, `1.1.0`, `2.0.0`, `2.1.0` | `invoice/` | 2026-10-10 |
| `03` | Liquidación de compra de bienes y prestación de servicios | `1.0.0`, `1.1.0` | `liquidation/` | 2026-10-18 |
| `04` | Nota de crédito | `1.0.0`, `1.1.0` | `credit-note/` | 2026-10-18 |
| `05` | Nota de débito | `1.0.0` | `debit-note/` | 2026-10-18 |
| `06` | Guía de remisión | `1.0.0`, `1.1.0` | `remission-guide/` | 2026-10-18 |
| `07` | Comprobante de retención | `1.0.0`, `2.0.0` | `retention-receipt/` | 2026-10-18 |

Hoy se emiten la factura, la nota de crédito (`1.1.0`) y la nota de débito (`1.0.0`). Los demás tipos tienen el XSD empacado y compilando, pero todavía no se generan ni se envían al SRI.

Versión que emitirá cada tipo: factura `1.1.0`, liquidación `1.1.0`, nota de crédito `1.1.0`, nota de débito `1.0.0`, guía de remisión `1.1.0` y retención `2.0.0`. Cada tipo se habilita con su propio PR.

- Fuente oficial: los paquetes «XML y XSD» de cada comprobante en [SRI — Facturación electrónica](https://www.sri.gob.ec/facturacion-electronica); el de factura es [este ZIP](https://www.sri.gob.ec/o/sri-portlet-biblioteca-alfresco-internet/descargar/05546998-6f29-4870-be3b-62650f312a6c/XML%20y%20XSD%20Factura.zip) (versiones `1.0.0` a `2.1.0`, actualizado a febrero 2022).
- Fuente normativa: [Ficha técnica 2.34 (julio 2026)](https://www.sri.gob.ec/o/sri-portlet-biblioteca-alfresco-internet/descargar/f8d9bb36-5632-4f96-b463-b9265b55338c/FICHA%20TE%CC%81CNICA%20COMPROBANTES%20ELECTRO%CC%81NICOS%20ESQUEMA%20OFFLINE%20Versio%CC%81n%202.34.pdf).
- Dependencia: `xmldsig-core-schema.xsd` ([especificación W3C XML Signature](https://www.w3.org/TR/xmldsig-core/#sec-Schema)), cabecera `Revision 1.2, 2013/04/16`, `targetNamespace` `http://www.w3.org/2000/09/xmldsig#`.

## Estructura

```text
resources/xsd/
  common/                       xmldsig-core-schema.xsd   (única copia)
  invoice/{versión}/            factura_V{versión}.xsd               factura_V{versión}.xml
  liquidation/{versión}/        LiquidacionCompra_V{versión}.xsd     LiquidacionCompra_V{versión}.xml
  credit-note/{versión}/        NotaCredito_V{versión}.xsd           NotaCredito_V{versión}.xml
  debit-note/{versión}/         NotaDebito_V{versión}.xsd            NotaDebito_V{versión}.xml
  remission-guide/{versión}/    GuiaRemision_V{versión}.xsd          GuiaRemision_V{versión}.xml
  retention-receipt/{versión}/  ComprobanteRetencion_V{versión}.xsd  ComprobanteRetencion_V{versión}.xml
```

En el código (`src/xml/document-type.ts`), `DocumentType` es el tipo (código SRI, carpeta y prefijo de archivo) y `DocumentSchema` cada par tipo y versión empacado. `XsdValidator` (`src/xml/xsd-validator.ts`) lee de disco el XSD de cada esquema la primera vez que se pide y lo guarda en memoria.

Todos los XSD del SRI importan `xmldsig-core-schema.xsd` con ruta relativa (`schemaLocation="xmldsig-core-schema.xsd"`). Antes había una copia idéntica junto a cada versión; ahora hay una sola en `common/` y es `XsdValidator` el que la entrega al motor con ese nombre. Así los XSD del SRI se conservan **sin editar** y sus huellas no cambian. No editar los XSD originales; si hiciera falta una copia derivada, identificarla claramente y acompañarla del hash del original.

## Resolución de dependencias sin red (decisión)

`xmldsig-core-schema.xsd` declara un `DOCTYPE` que referencia `http://www.w3.org/2001/XMLSchema.dtd` (identificador público `-//W3C//DTD XMLSchema 200102//EN`). Un libxml2 sin restricciones intentaría descargar ese DTD desde w3.org (prohibido en producción).

NestJS valida con libxml2 compilado a WebAssembly (`xmllint-wasm`), que corre en un worker con un sistema de archivos **en memoria**: no ve el disco ni la red. `validateWithSchema` en `src/xml/xsd-validator.ts` le entrega solo tres archivos, una lista cerrada equivalente a la `ClasspathSchemaResolver` de Java:

1. El XSD del comprobante, como `schema.xsd`.
2. `xmldsig-core-schema.xsd`, la copia única de `common/`, sea cual sea el comprobante o la versión que lo importa.
3. Un `XMLSchema.dtd` vacío. El subconjunto interno del propio archivo ya declara lo que el esquema necesita, así que el original se conserva sin modificar.

Cualquier otro `import`, `schemaLocation` o DTD externo no se encuentra y la validación falla sin abrir una conexión.

## Resultado de validación

| Comprobante | Versión | XSD | XML de ejemplo |
|---|---|---|---|
| Factura | 1.0.0 | compila | válido |
| Factura | 1.1.0 | compila | válido |
| Factura | 2.0.0 | compila | **inválido**: `incoTermFactura` vacío viola `minLength=1` |
| Factura | 2.1.0 | compila | válido |
| Liquidación de compra | 1.0.0, 1.1.0 | compilan | válidos |
| Nota de crédito | 1.0.0, 1.1.0 | compilan | válidos |
| Nota de débito | 1.0.0 | compila | válido |
| Guía de remisión | 1.0.0, 1.1.0 | compilan | válidos |
| Comprobante de retención | 1.0.0, 2.0.0 | compilan | válidos |

Lo cubren pruebas automatizadas que corren con `npm test`:

- `test/unit/xml/xsd-validator.spec.ts`: cada XML de ejemplo contra su XSD, con la excepción de la factura 2.0.0 esperada; la lista cerrada de recursos (un `import` por `http`, una ruta absoluta o relativa o un DTD externo no validan ni abren conexiones); el límite de 4 validaciones simultáneas y el plazo; y que un fallo del motor no copie su texto al error.
- `test/unit/xml/document-schemas.spec.ts`: el inventario de `DocumentSchema` y sus archivos.
- `test/unit/xml/secure-sax.spec.ts`: el lector `saxes` que rechaza `DOCTYPE` y entidades no predefinidas.
- `test/golden/xsd.spec.ts`: casos generados con el código Java contra el validador de NestJS.

La integridad de los archivos (cada fila del registro existe y su SHA-256 coincide, y no hay archivos sin registrar) la comprueba `scripts/verify_xsd_assets.py`, que corre en CI.

El estado en el registro sigue en `*_PRUEBA_MANUAL` hasta la primera ejecución en CI.

## Lo que el XSD no valida

Los XML de ejemplo traen `codDoc=00`, `version="version0"`, clave de acceso en ceros y `xsi:noNamespaceSchemaLocation` con una ruta `file:/C:/...`, y aun así casi todos pasan el XSD: el tipo `codDoc` solo exige dos dígitos y el atributo `version` no tiene restricción. Por tanto, **además** del XSD, el generador y el validador deben comprobar en código:

- `codDoc` igual al código SRI del tipo de documento (`01` factura, `03` liquidación, `04` nota de crédito, `05` nota de débito, `06` guía de remisión, `07` retención).
- Atributo `version` igual a la versión del esquema usada.
- Atributo `id="comprobante"` presente (el XSD lo admite ausente; la firma lo referencia).
- `claveAcceso` válida (doc 06) y coherente con `fechaEmision`, `ruc`, `ambiente`, `estab`, `ptoEmi`, `secuencial` y `tipoEmision` del mismo XML.
- Ausencia de `DOCTYPE` y de `schemaLocation`/`noNamespaceSchemaLocation` en el XML generado o recibido. `src/xml/secure-sax.ts` (`saxes`) rechaza el `DOCTYPE` y las entidades no predefinidas antes de que libxml2 vea el XML.

Los XML de ejemplo son plantillas ilustrativas: no usarlos como fixtures de comprobante válido ni emitirlos.

## Secuencia segura de integración

1. Descargar cada ZIP **directamente del SRI**, registrar fecha y SHA-256 del ZIP, y contrastar los hashes de los archivos ya incorporados. Si difieren, sustituir por los oficiales y actualizar el registro.
2. Contrastar `xmldsig-core-schema.xsd` con la copia publicada por W3C y registrar el resultado.
3. Ejecutar `python3 scripts/verify_xsd_assets.py resources/xsd` (como hace el flujo de CI) para diagnosticar dependencias, inventario y hashes. El script **no sustituye** la compilación real con libxml2.
4. Mantener la lista cerrada de archivos de `validateWithSchema` y el rechazo de `DOCTYPE` y entidades externas (XXE) de `secure-sax.ts`.
5. Añadir el `DocumentSchema` del tipo y versión nuevos, sus filas en el registro y su XML de ejemplo (lo prueba `test/unit/xml/xsd-validator.spec.ts`), y las comprobaciones de la sección anterior cuando el tipo se emita.
6. Conservar como evidencia: versión, fuente, hash, fecha, resultado del parser, archivo XML probado y resultado de validación.

## Registro de procedencia

Mantener [xsd-source-registry.csv](xsd-source-registry.csv). Estados: `PENDIENTE`; `COMPILA_PRUEBA_MANUAL`, `VALIDA_XSD_PRUEBA_MANUAL` e `INVALIDO_XSD_PRUEBA_MANUAL` mientras la evidencia sea manual; los mismos con sufijo `_CI` cuando la cubra un test automatizado; y `VALIDADO` solo cuando además el origen oficial esté contrastado.

## Criterio de aceptación

- Todos los XSD compilan en CI con el XMLDSig compartido y sin acceso externo.
- Como mucho 4 validaciones XSD a la vez y un plazo de 10 s por validación; si vence, o si el motor falla, la emisión responde `500 INTERNAL_ERROR` y se revierte, no un XML inválido.
- Los XML de ejemplo aplicables pasan la validación y la excepción de 2.0.0 queda cubierta por un test que la espera.
- No hay descargas HTTP en producción para resolver imports ni DTD.
- Hashes contrastados con el paquete oficial del SRI y con W3C.
- Tests de esquemas y firma se ejecutan en CI.
- XML firmado conforme al perfil XAdES-BES del SRI; validar XSD por sí solo no acredita una firma válida.

## Versión que se emite y discrepancias con la ficha
- **Versión 1.1.0.** Es la que la ficha (Anexo 3) define para cantidad y precio unitario con seis decimales. Las versiones 2.0.0 y 2.1.0 añaden rubros de terceros y la factura sustitutiva de guía de remisión, que no se usan. `buildInvoiceXml` (`src/xml/invoice-xml.ts`) escribe el XML y un test lo compara byte a byte con el esperado y lo valida contra el XSD.
- **RUC del emisor.** El tipo `numeroRuc` del XSD es `[0-9]{10}001`: el alta de emisores exige ese formato y la base lo impone con una restricción.
- **Leyenda de negocio popular.** La ficha (Anexo 22) admite `CONTRIBUYENTE NEGOCIO POPULAR - RÉGIMEN RIMPE`, pero el `factura_V1.1.0.xsd` del repositorio solo acepta `CONTRIBUYENTE RÉGIMEN RIMPE`. Sus facturas quedarían en `XSD_INVALID` después de consumir un secuencial, así que el alta de un emisor con `rimpeRegime=NEGOCIO_POPULAR` se rechaza con `422 RIMPE_REGIME_UNSUPPORTED`. Se habilitará cuando se contraste el XSD con el paquete oficial del SRI (tarea N1).
- **Clave de acceso.** `EnvelopeRules` (`src/xml/envelope-rules.ts`) comprueba además que `claveAcceso` sea válida y coincida con fecha, tipo, RUC, ambiente, establecimiento, punto, secuencial y tipo de emisión del mismo XML.
- **Tamaño.** Un XML de más de 320 KB (límite de envío individual de la ficha) se rechaza al generarlo.

## Fuentes oficiales y control de cambios
- [SRI — Facturación electrónica](https://www.sri.gob.ec/facturacion-electronica): ficha técnica esquema off-line v2.34 (julio 2026), XSD y normativa.
- [W3C — XML Signature Schema](https://www.w3.org/TR/xmldsig-core/#sec-Schema): fuente técnica complementaria, no norma tributaria.

> **Límite jurídico/técnico:** estos documentos son una especificación de ingeniería, no sustituyen los XSD oficiales, la ficha técnica integral, las resoluciones publicadas en Registro Oficial ni asesoría tributaria. Antes de pasar a producción, congelar versiones de normativa, XSD y catálogos, y ejecutar la matriz de conformidad con el ambiente de certificación del SRI. El detalle y fechas de entrada en vigor de cada reforma deben corroborarse en su texto normativo publicado.
