// Reparte cada conexión de una sola variable (DATABASE_URL, RABBITMQ_URL), igual que
// ConnectionUrlsEnvironmentPostProcessor en la API Java. Los mensajes de error nombran la
// variable y nunca repiten la URL: puede llevar la contraseña.

export interface DatabaseConnection {
  host: string;
  port: number;
  database: string;
  user?: string;
  password?: string;
  /** Valor de currentSchema, o null si la URL no lo trae. */
  schema: string | null;
  /** Parámetros de la URL, sin currentSchema. */
  params: Record<string, string>;
}

export interface RabbitConnection {
  host: string;
  port: number;
  user?: string;
  password?: string;
  vhost: string;
  tls: boolean;
}

const DATABASE_URL = 'DATABASE_URL';
const RABBITMQ_URL = 'RABBITMQ_URL';
const DATABASE_FORM = 'postgresql://usuario:contraseña@host:puerto/base';
const RABBIT_FORM = 'amqp://usuario:contraseña@host:puerto';

function invalid(variable: string, reason: string, form: string): Error {
  return new Error(`${variable} ${reason} (forma esperada: ${form})`);
}

function parse(
  variable: string,
  value: string,
  schemes: readonly string[],
  form: string,
): URL {
  let url: URL;
  try {
    // Los espacios los acepta WHATWG (los codifica); la URL Java los rechazaba.
    if (/\s/.test(value)) throw new Error('espacio en la URL');
    url = new URL(value);
  } catch {
    // El mensaje de TypeError de URL repite la URL entera, contraseña incluida.
    throw invalid(variable, 'no es una URL válida', form);
  }
  if (!schemes.includes(url.protocol.slice(0, -1))) {
    throw invalid(
      variable,
      `debe empezar por ${form.slice(0, form.indexOf('//') + 2)}`,
      form,
    );
  }
  if (url.hostname === '') {
    throw invalid(variable, 'no dice el servidor', form);
  }
  return url;
}

/** Decodifica %XX sin tratar el + como espacio, que eso es de los formularios y no de las URL. */
function decode(variable: string, raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new Error(
      `${variable} tiene un % que no va seguido de dos dígitos hexadecimales`,
    );
  }
}

function credentials(
  variable: string,
  url: URL,
): { user?: string; password?: string } {
  if (url.username === '' && url.password === '') return {};
  const result: { user?: string; password?: string } = {
    user: decode(variable, url.username),
  };
  if (url.password !== '') result.password = decode(variable, url.password);
  return result;
}

export function parseDatabaseUrl(value: string): DatabaseConnection {
  const url = parse(
    DATABASE_URL,
    value.trim(),
    ['postgresql', 'postgres'],
    DATABASE_FORM,
  );
  if (url.pathname.length <= 1) {
    throw invalid(DATABASE_URL, 'no dice el nombre de la base de datos', DATABASE_FORM);
  }

  const params: Record<string, string> = {};
  let schema: string | null = null;
  const query = url.search.startsWith('?') ? url.search.slice(1) : '';
  for (const parameter of query.split('&')) {
    if (parameter === '') continue;
    const equals = parameter.indexOf('=');
    const key = decode(DATABASE_URL, equals === -1 ? parameter : parameter.slice(0, equals));
    const val = equals === -1 ? '' : decode(DATABASE_URL, parameter.slice(equals + 1));
    if (key === 'currentSchema') {
      const trimmed = val.trim();
      // Flyway gestionaría todos los de la lista, incluido limpiarlos.
      if (trimmed === '' || trimmed.includes(',')) {
        throw new Error(`${DATABASE_URL} debe indicar un solo esquema en currentSchema`);
      }
      schema = trimmed;
    } else {
      params[key] = val;
    }
  }

  return {
    host: url.hostname,
    port: url.port === '' ? 5432 : Number(url.port),
    database: decode(DATABASE_URL, url.pathname.slice(1)),
    ...credentials(DATABASE_URL, url),
    schema,
    params,
  };
}

export function parseRabbitUrl(value: string): RabbitConnection {
  const url = parse(RABBITMQ_URL, value.trim(), ['amqp', 'amqps'], RABBIT_FORM);
  const tls = url.protocol === 'amqps:';
  return {
    host: url.hostname,
    port: url.port === '' ? (tls ? 5671 : 5672) : Number(url.port),
    ...credentials(RABBITMQ_URL, url),
    vhost: url.pathname.length > 1 ? decode(RABBITMQ_URL, url.pathname.slice(1)) : '/',
    tls,
  };
}
