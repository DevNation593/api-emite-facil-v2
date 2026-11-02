# Sondeo HTTP de la API Java

Genera `test/golden/http/<casos>.json` con lo que la API Java (`backend-emite-facil`) responde a una
lista de peticiones. Fija lo que el código Java no dice a simple vista: la coerción de Jackson (un
`"5"` o un `5.7` donde va un `Integer`), la conversión de parámetros de Spring (`page=0x10` vale 16),
el orden de las propiedades, los `null` y las cabeceras `Allow`.
`test/integration/java-probes.int.spec.ts` repite las mismas peticiones contra NestJS y exige la
misma respuesta.

## Uso

```bash
node tools/java-probe/make-cases.mjs
node tools/java-probe/run.mjs --java-repo ../backend-emite-facil --cases e2
```

`make-cases.mjs` escribe `cases/e2.json`. Con `--skip-build`, `run.mjs` reutiliza el jar de `target/`.
Requisitos: Docker en marcha, Java 25 en el `PATH`, Node 24 y las dependencias de Maven del repo Java.

## Cómo funciona

1. Arranca Java como `tools/java-dump` (`java-dump/java-app.mjs`), con correo, SRI y worker apagados.
2. `runScenario` crea por HTTP una persona, su empresa, el emisor `1790012345001`, el establecimiento
   y el punto de emisión `001`, un cliente y un producto.
3. `runProbes` envía cada caso en orden, con `{taxpayerId}` y los demás marcadores sustituidos, y
   guarda el estado, `Content-Type`, `Allow` y el cuerpo normalizados. `normalize` quita
   `correlationId` y cambia los ids del escenario por su marcador, cualquier otro UUID por `{uuid}` y
   las fechas ISO por `{timestamp}`.
4. Falla si Java responde 5xx a algún caso.

Las peticiones van por `node:http`, no por `fetch`: así se ve si una cabecera llega repetida. En un
405, Spring lista los métodos permitidos de un `HashSet`, cuyo orden cambia entre arranques, y por eso
se guardan ordenados. El `Allow` de `OPTIONS` sí es estable y se guarda tal cual.

Un caso es `{ name, method, path, query?, body?, rawBody?, headers?, auth: 'owner' | 'none' }`. Los
casos se ejecutan en orden sobre la misma base, así que los que crean o borran afectan a los
siguientes; el orden es el mismo contra Java y contra NestJS.
