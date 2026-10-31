import argon2 from 'argon2';
import { ApiException } from '../common/api-exception.js';
import { codePointLength, strip } from '../common/java-text.js';

const MIN_LENGTH = 12;
const MAX_LENGTH = 128;

// Los de Argon2PasswordEncoder.defaultsForSpringSecurity_v5_8(): así los hashes de Java siguen valiendo.
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 16384,
  timeCost: 2,
  parallelism: 1,
  saltLength: 16,
  hashLength: 32,
} as const;

/**
 * Contraseñas: qué se acepta y cómo se guardan. Solo se exige longitud (12 a 128 caracteres) y que
 * no sea el propio correo, sin reglas de composición (NIST SP 800-63B). Se guardan con Argon2id.
 */
export class Passwords {
  /** Hash de una contraseña que nadie tiene: un correo inexistente cuesta lo mismo que uno real. */
  private decoy: Promise<string> | undefined;

  /**
   * node-argon2 escribe los parámetros como m,p,t; Spring los lee por posición (m,t,p), así que un
   * hash en el otro orden se leería con iteraciones y paralelismo cambiados si hubiera que volver a Java.
   */
  async hash(password: string, salt?: Buffer): Promise<string> {
    // `salt` solo lo da la prueba golden, para reproducir un hash de Java.
    const phc = await argon2.hash(password, salt ? { ...ARGON2_OPTIONS, salt } : ARGON2_OPTIONS);
    return phc.replace(/\$m=(\d+),p=(\d+),t=(\d+)\$/, (_all, m, p, t) => `$m=${m},t=${t},p=${p}$`);
  }

  /** Compara siempre contra un hash, aunque la cuenta no exista o no tenga contraseña. */
  async matches(password: string, hash: string | null): Promise<boolean> {
    const known = hash !== null;
    try {
      const matches = await argon2.verify(known ? hash : await this.decoyHash(), password ?? '');
      return known && matches;
    } catch {
      // Un hash ilegible no es una coincidencia.
      return false;
    }
  }

  /** Rechaza con 422 una contraseña que no cumple las reglas, con el campo que la trajo. */
  requireAcceptable(field: string, password: string | null, email: string | null): void {
    const errors: Array<{ field: string; message: string }> = [];
    const length = password === null ? 0 : codePointLength(password);
    if (length < MIN_LENGTH || length > MAX_LENGTH) {
      errors.push({
        field,
        message: `La contraseña debe tener entre ${MIN_LENGTH} y ${MAX_LENGTH} caracteres`,
      });
    } else if (
      email !== null &&
      password !== null &&
      strip(password).toLowerCase() === email.toLowerCase()
    ) {
      errors.push({ field, message: 'La contraseña no puede ser el correo' });
    }
    if (errors.length > 0) {
      throw new ApiException(422, 'WEAK_PASSWORD', 'La contraseña no es válida', errors);
    }
  }

  private decoyHash(): Promise<string> {
    this.decoy ??= this.hash(`contraseña-de-relleno-${process.hrtime.bigint()}`);
    return this.decoy;
  }
}
