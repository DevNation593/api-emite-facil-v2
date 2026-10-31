import type { Application } from 'express';

interface RouteLayer {
  route?: { methods: Record<string, boolean> };
  match(path: string): boolean;
}

const CORE_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function declaresEveryMethod(methods: Record<string, boolean>): boolean {
  return CORE_METHODS.every((method) => methods[method] === true);
}

/**
 * Métodos con los que alguna ruta registrada atiende `pathname`. Se consulta
 * solo en el camino del "no encontrado" para distinguir 404 de 405: Express 5
 * no tiene noción de 405 y recorrer el router aquí evita mantener una tabla
 * aparte que se desincronice de las rutas que Nest registra.
 */
export function allowedMethods(app: Application, pathname: string): string[] {
  const stack = (app.router as unknown as { stack: RouteLayer[] }).stack;
  const methods = new Set<string>();
  for (const layer of stack) {
    if (layer.route === undefined || !layer.match(pathname)) continue;
    // Nest registra /actuator/{*path} con `all`: atiende cualquier método y
    // taparía el 405 de las rutas concretas.
    if (declaresEveryMethod(layer.route.methods)) continue;
    for (const [method, enabled] of Object.entries(layer.route.methods)) {
      if (enabled && method !== '_all') methods.add(method.toUpperCase());
    }
  }
  if (methods.has('GET')) methods.add('HEAD');
  return [...methods];
}
