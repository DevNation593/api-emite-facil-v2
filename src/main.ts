import { createApp } from './bootstrap.js';
import { APP_CONFIG, type AppConfig } from './config/app-config.js';

const app = await createApp();
app.enableShutdownHooks();
await app.listen(app.get<AppConfig>(APP_CONFIG).port);
