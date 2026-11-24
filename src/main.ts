// Vercel solo reconoce como entrada de NestJS un archivo que importe @nestjs/core directamente.
import '@nestjs/core';
import { createApp } from './bootstrap.js';
import { APP_CONFIG, type AppConfig } from './config/app-config.js';
import { gracefulShutdown, readiness } from './observability/lifecycle.js';

const app = await createApp();
await app.init();
readiness.markReady();

// No se espera a listen(): el lanzador de Vercel lo sustituye por una función que nunca avisa, y el import de
// este archivo no terminaría. Allí atiende la exportación por defecto, que por eso va ya inicializada. Si no se
// puede escuchar (puerto ocupado), el rechazo sin atender termina el proceso con error.
void app.listen(app.get<AppConfig>(APP_CONFIG).port);
export default app.getHttpAdapter().getInstance();

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
