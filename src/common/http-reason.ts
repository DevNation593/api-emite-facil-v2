import { STATUS_CODES } from 'node:http';

/**
 * Frases de HttpStatus de Spring 7.0.9 donde difieren de las de Node: el `title`
 * del problema debe ser el mismo que devuelve la API Java.
 */
const SPRING_REASONS: Record<number, string> = {
  413: 'Content Too Large',
  416: 'Requested range not satisfiable',
  418: "I'm a teapot",
  422: 'Unprocessable Content',
  505: 'HTTP Version not supported',
};

export function reasonPhrase(status: number): string {
  return SPRING_REASONS[status] ?? STATUS_CODES[status] ?? 'Error';
}
