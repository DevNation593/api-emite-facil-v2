import { loadConfig } from '../../src/config/app-config.js';

/** Entorno mínimo válido para las pruebas: nada apunta a servicios reales. */
export const testEnv: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://app:app@localhost:5432/einvoice',
  RABBITMQ_URL: 'amqp://guest:guest@localhost:5672',
  REDIS_URL: 'redis://localhost:6379',
  // 32 bytes (0x01 repetido) en Base64.
  EINVOICE_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
  EINVOICE_JWT_SECRET: 'test-jwt-secret-con-al-menos-32-bytes!!',
  EINVOICE_WEB_URL: 'http://localhost:3000',
};

export const testConfig = loadConfig(testEnv);
