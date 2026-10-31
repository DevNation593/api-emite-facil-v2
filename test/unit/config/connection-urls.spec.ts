import {
  parseDatabaseUrl,
  parseRabbitUrl,
} from '../../../src/config/connection-urls.js';

/** Captura el mensaje del error para comprobar que no filtra la contraseña. */
function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('se esperaba un error');
}

describe('parseDatabaseUrl', () => {
  it('reparte la URL en servidor, base, credenciales decodificadas, esquema y parámetros', () => {
    expect(
      parseDatabaseUrl(
        'postgresql://app:p%40ss%3Aw@db:6543/einvoice?sslmode=require&currentSchema=einvoice',
      ),
    ).toEqual({
      host: 'db',
      port: 6543,
      database: 'einvoice',
      user: 'app',
      password: 'p@ss:w',
      schema: 'einvoice',
      params: { sslmode: 'require' },
    });
  });

  it('acepta postgres://, usa el puerto 5432 y conserva los parámetros', () => {
    const parsed = parseDatabaseUrl(
      'postgres://app:secreto@db.example.com/einvoice?sslmode=require',
    );
    expect(parsed.port).toBe(5432);
    expect(parsed.host).toBe('db.example.com');
    expect(parsed.params).toEqual({ sslmode: 'require' });
    expect(parseDatabaseUrl('postgres://db/einvoice').port).toBe(5432);
  });

  it('sin currentSchema el esquema es null', () => {
    expect(
      parseDatabaseUrl('postgresql://app:secreto@db:5432/einvoice?sslmode=require')
        .schema,
    ).toBeNull();
  });

  it('decodifica usuario y contraseña sin tratar el + como espacio', () => {
    const parsed = parseDatabaseUrl(
      'postgresql://app%40corp:p%40ss%3Aw+rd%2F@localhost:5432/einvoice',
    );
    expect(parsed.user).toBe('app@corp');
    expect(parsed.password).toBe('p@ss:w+rd/');
  });

  it('admite una URL sin contraseña', () => {
    const parsed = parseDatabaseUrl('postgresql://app@localhost/einvoice');
    expect(parsed.user).toBe('app');
    expect(parsed.password).toBeUndefined();
  });

  it('rechaza una URL sin nombre de base', () => {
    expect(() => parseDatabaseUrl('postgresql://app:secreta@db:5432')).toThrow(
      /nombre de la base/,
    );
  });

  it('rechaza otros esquemas', () => {
    expect(() => parseDatabaseUrl('mysql://app:secreta@db/x')).toThrow(
      /debe empezar por postgresql:\/\//,
    );
  });

  it('rechaza varios esquemas en currentSchema', () => {
    expect(() =>
      parseDatabaseUrl('postgresql://app:secreta@db/x?currentSchema=a,b'),
    ).toThrow(/un solo esquema/);
    expect(() =>
      parseDatabaseUrl('postgresql://app:secreta@db/x?currentSchema='),
    ).toThrow(/un solo esquema/);
  });

  it('rechaza un % mal formado', () => {
    expect(() => parseDatabaseUrl('postgresql://app:se%zzcreta@db/x')).toThrow(/%/);
  });

  it('nombra la variable y nunca repite la contraseña en los errores', () => {
    const bad = [
      'postgresql://app:secreta@db:99999/x',
      'postgresql://app:secreta@/x',
      'mysql://app:secreta@db/x',
      'postgresql://app:secreta@db',
      'postgresql://app:sec reta@db/x',
      'postgresql://app:se%zzcreta@db/x',
      'postgresql://app:secreta@db/x?currentSchema=a,b',
    ];
    for (const value of bad) {
      const message = messageOf(() => parseDatabaseUrl(value));
      expect(message).toContain('DATABASE_URL');
      expect(message).not.toContain('secreta');
      expect(message).not.toContain('sec reta');
    }
  });
});

describe('parseRabbitUrl', () => {
  it('decodifica credenciales y vhost, y activa TLS con amqps', () => {
    expect(parseRabbitUrl('amqps://u:p@mq/v%2Fh')).toEqual({
      host: 'mq',
      port: 5671,
      user: 'u',
      password: 'p',
      vhost: 'v/h',
      tls: true,
    });
  });

  it('el vhost por defecto es /', () => {
    expect(parseRabbitUrl('amqp://u:p@mq').vhost).toBe('/');
  });

  it('usa el puerto 5672 sin TLS y decodifica la contraseña', () => {
    const parsed = parseRabbitUrl(
      'amqp://einvoice:cl%40ve%3A1@broker.example.com:5673',
    );
    expect(parsed).toMatchObject({
      host: 'broker.example.com',
      port: 5673,
      user: 'einvoice',
      password: 'cl@ve:1',
      tls: false,
    });
    expect(parseRabbitUrl('amqp://broker').port).toBe(5672);
  });

  it('rechaza otros esquemas sin revelar la contraseña', () => {
    const message = messageOf(() =>
      parseRabbitUrl('http://einvoice:secreto@broker:5672'),
    );
    expect(message).toContain('RABBITMQ_URL');
    expect(message).not.toContain('secreto');
  });
});

describe('sslmode de DATABASE_URL', () => {
  const url = (query: string) => `postgresql://app:secreto-xyz@db:5432/einvoice?${query}`;

  it.each(['disable', 'require', 'verify-ca', 'verify-full'])('admite %s', (mode) => {
    expect(parseDatabaseUrl(url(`sslmode=${mode}`)).params).toEqual({ sslmode: mode });
  });

  it('sin sslmode no hay parámetro', () => {
    expect(parseDatabaseUrl('postgresql://app@db/einvoice').params).toEqual({});
  });

  it.each(['prefer', 'allow', 'otro', ''])('rechaza sslmode=%j sin repetir la URL', (mode) => {
    const message = messageOf(() => parseDatabaseUrl(url(`sslmode=${mode}`)));
    expect(message).toContain('DATABASE_URL');
    expect(message).not.toContain('secreto-xyz');
  });

  it('rechaza sslrootcert sin repetir la URL', () => {
    const message = messageOf(() =>
      parseDatabaseUrl(url('sslmode=verify-full&sslrootcert=%2Fetc%2Fca.pem')),
    );
    expect(message).toContain('DATABASE_URL');
    expect(message).not.toContain('secreto-xyz');
    expect(message).not.toContain('ca.pem');
  });
});
