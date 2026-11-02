import {
  alreadyRegisteredMail,
  describeDuration,
  passwordResetMail,
  verificationMail,
} from '../../../src/identity/auth-mailer.js';

const HOUR = 3_600_000;
const LINK = 'http://localhost:3000/verify#token=abc';

describe('describeDuration', () => {
  it.each([
    [HOUR, '1 hora'],
    [24 * HOUR, '24 horas'],
    [15 * 60_000, '15 minutos'],
    [60_000, '1 minuto'],
    [90 * 60_000, '90 minutos'],
  ])('%i ms -> %s', (ms, expected) => {
    expect(describeDuration(ms)).toBe(expected);
  });
});

describe('textos de los correos', () => {
  it('confirmación del correo', () => {
    expect(verificationMail('a@b.ec', LINK, 24 * HOUR)).toEqual({
      to: 'a@b.ec',
      subject: 'Confirma tu correo',
      kind: 'VERIFY_EMAIL',
      text:
        'Hola:\n\n' +
        'Para confirmar que este correo es tuyo, abre este enlace:\n\n' +
        `${LINK}\n\n` +
        'El enlace vale 24 horas. Si no creaste una cuenta de facturación electrónica, ignora este mensaje.\n',
    });
  });

  it('cambio de contraseña', () => {
    expect(passwordResetMail('a@b.ec', LINK, HOUR)).toEqual({
      to: 'a@b.ec',
      subject: 'Cambia tu contraseña',
      kind: 'RESET_PASSWORD',
      text:
        'Hola:\n\n' +
        'Alguien pidió cambiar la contraseña de tu cuenta. Para elegir una nueva, abre este enlace:\n\n' +
        `${LINK}\n\n` +
        'El enlace vale 1 hora y sirve una sola vez. Si no lo pediste tú, ignora este mensaje: tu contraseña\n' +
        'sigue siendo la misma.\n',
    });
  });

  it('cuenta ya registrada', () => {
    expect(alreadyRegisteredMail('a@b.ec', LINK, 15 * 60_000)).toEqual({
      to: 'a@b.ec',
      subject: 'Ya tienes una cuenta',
      kind: 'ALREADY_REGISTERED',
      text:
        'Hola:\n\n' +
        'Alguien intentó crear una cuenta con este correo, pero ya tienes una. Si fuiste tú y no\n' +
        'recuerdas tu contraseña, elige una nueva con este enlace (vale 15 minutos):\n\n' +
        `${LINK}\n\n` +
        'Si no fuiste tú, ignora este mensaje.\n',
    });
  });
});
