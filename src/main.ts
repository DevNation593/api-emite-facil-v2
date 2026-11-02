import { createApp } from './bootstrap.js';
import { APP_CONFIG, type AppConfig } from './config/app-config.js';
import { gracefulShutdown, readiness } from './observability/lifecycle.js';

const app = await createApp();
await app.listen(app.get<AppConfig>(APP_CONFIG).port);
readiness.markReady();

// No se usa app.enableShutdownHooks(): cerraría la aplicación de inmediato, sin esperar a las
// peticiones en curso. gracefulShutdown hace el cierre completo y aquí solo se sale.
let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  gracefulShutdown(app).then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(
        'Error durante el cierre',
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    },
  );
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
