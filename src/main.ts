import { createApp } from './bootstrap.js';

const app = await createApp();
app.enableShutdownHooks();
// La Task 3 sustituye esto por la configuración tipada.
await app.listen(process.env.SERVER_PORT ?? process.env.PORT ?? 8080);
