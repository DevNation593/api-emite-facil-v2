import { Logger } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import type { DB } from '../database/schema.js';
import { describeError } from '../orchestration/fixed-delay-scheduler.js';

/**
 * Cada cuánto corre la purga. Es un valor fijo: Java lo admite como propiedad
 * (einvoice.auth.purge-interval-ms), pero no lo documenta ni lo usa ningún despliegue.
 */
export const AUTH_PURGE_INTERVAL_MS = 3_600_000;

/**
 * Borra, en el worker y cada hora, las sesiones y los enlaces de correo que vencieron hace más de
 * una semana: ya no sirven y solo quedan para mirar qué pasó en los últimos días.
 */
export class AuthPurge {
  private readonly logger = new Logger(AuthPurge.name);

  constructor(private readonly db: Kysely<DB>) {}

  async purge(): Promise<void> {
    try {
      // Los tokens de renovación caen con su sesión (ON DELETE CASCADE).
      const sessions = await this.db
        .deleteFrom('auth_sessions')
        .where('expires_at', '<', sql<Date>`now() - interval '7 days'`)
        .executeTakeFirst();
      const links = await this.db
        .deleteFrom('user_tokens')
        .where('expires_at', '<', sql<Date>`now() - interval '7 days'`)
        .executeTakeFirst();
      const deletedSessions = Number(sessions.numDeletedRows);
      const deletedLinks = Number(links.numDeletedRows);
      if (deletedSessions + deletedLinks > 0) {
        this.logger.log(
          `Autenticación: ${deletedSessions} sesiones y ${deletedLinks} enlaces vencidos borrados`,
        );
      }
    } catch (error) {
      // Base no disponible: la siguiente pasada lo vuelve a intentar.
      this.logger.warn(`La purga de sesiones vencidas falló: ${describeError(error)}`);
    }
  }
}
