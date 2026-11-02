import { ApiException } from '../../../src/common/api-exception.js';
import { Passwords } from '../../../src/identity/passwords.js';

const passwords = new Passwords();

function weak(password: string | null, email: string | null): ApiException {
  try {
    passwords.requireAcceptable('password', password, email);
  } catch (error) {
    return error as ApiException;
  }
  throw new Error('se esperaba un rechazo');
}

describe('Passwords', () => {
  it('guarda en Argon2id y lo comprueba', async () => {
    const hash = await passwords.hash('una contraseña larga');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=16384,t=2,p=1\$/);
    expect(hash).not.toBe(await passwords.hash('una contraseña larga'));
    expect(await passwords.matches('una contraseña larga', hash)).toBe(true);
    expect(await passwords.matches('otra contraseña larga', hash)).toBe(false);
  });

  it('una cuenta sin contraseña nunca coincide', async () => {
    expect(await passwords.matches('cualquier cosa', null)).toBe(false);
    expect(await passwords.matches(null as unknown as string, null)).toBe(false);
  });

  it('un hash ilegible no coincide ni lanza', async () => {
    expect(await passwords.matches('una contraseña larga', 'no-es-un-hash')).toBe(false);
  });

  it('solo importan la longitud y no ser el correo', () => {
    expect(() =>
      passwords.requireAcceptable('password', 'solo minusculas', 'a@b.ec'),
    ).not.toThrow();
    expect(() => passwords.requireAcceptable('password', 'ñ'.repeat(12), 'a@b.ec')).not.toThrow();
    // 12 puntos de código fuera del plano básico: 24 unidades UTF-16.
    expect(() => passwords.requireAcceptable('password', '😀'.repeat(12), null)).not.toThrow();
    for (const bad of [null, 'corta', 'x'.repeat(11), 'x'.repeat(129), ' Usuario@Example.EC ']) {
      const error = weak(bad, 'usuario@example.ec');
      expect(error).toBeInstanceOf(ApiException);
      expect(error.status).toBe(422);
      expect(error.errorCode).toBe('WEAK_PASSWORD');
      expect(error.detail).toBe('La contraseña no es válida');
      expect(error.errors.map((e) => e.field)).toEqual(['password']);
    }
  });

  it('los mensajes son los de Java', () => {
    expect(weak('corta', null).errors[0]!.message).toBe(
      'La contraseña debe tener entre 12 y 128 caracteres',
    );
    expect(weak('usuario@example.ec', 'Usuario@example.ec').errors[0]!.message).toBe(
      'La contraseña no puede ser el correo',
    );
  });
});

describe('Passwords: hash de relleno', () => {
  it('se calcula al construir, no en el primer correo desconocido', () => {
    let hashed = 0;
    class Counting extends Passwords {
      override hash(password: string, salt?: Buffer): Promise<string> {
        hashed++;
        return super.hash(password, salt);
      }
    }
    new Counting();
    expect(hashed).toBe(1);
  });

  it('si el cálculo inicial falla, no queda guardado y se reintenta', async () => {
    let calls = 0;
    class Flaky extends Passwords {
      override hash(password: string, salt?: Buffer): Promise<string> {
        calls++;
        if (calls === 1) return Promise.reject(new Error('fallo transitorio'));
        return super.hash(password, salt);
      }
    }
    const flaky = new Flaky();
    // El intento del constructor falló sin lanzar y no quedó guardado.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(1);
    // El siguiente uso lo repite, y desde entonces se reutiliza.
    await expect(flaky.matches('x', null)).resolves.toBe(false);
    expect(calls).toBe(2);
    await expect(flaky.matches('x', null)).resolves.toBe(false);
    expect(calls).toBe(2);
  });
});
