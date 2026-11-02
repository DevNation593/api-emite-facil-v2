import { testEnv } from './test-env.js';

// Sin pisar lo ya definido: las pruebas de integración fijan sus propias URL de contenedor.
for (const [name, value] of Object.entries(testEnv)) {
  process.env[name] ??= value;
}
