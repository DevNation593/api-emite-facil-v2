#!/bin/sh
# Corre Flyway (imagen flyway/flyway:12.4.0) contra la misma DATABASE_URL que lee la API. Java conserva
# currentSchema en la URL JDBC y además lo pasa como esquema de Flyway; aquí la URL JDBC es
# host:puerto/base + la query sin currentSchema, y los esquemas de Flyway (FLYWAY_SCHEMAS) = currentSchema. SPRING_FLYWAY_USER y SPRING_FLYWAY_PASSWORD,
# si existen, mandan sobre las credenciales de la URL. Nunca se imprime la contraseña (no usar set -x).
#   migrate.sh [migrate|validate|info]
set -eu
command="${1:-migrate}"
here="$(dirname "$0")"
url="${DATABASE_URL:?DATABASE_URL no está definida}"
part() { sh "$here/connection-url.sh" "$1" "$url"; }

host="$(part host)"
port="$(part port)"
database="$(part path)"
if [ -z "$host" ] || [ -z "$database" ]; then
  echo "migrate.sh: DATABASE_URL debe tener la forma postgresql://usuario:contraseña@host:puerto/base" >&2
  exit 2
fi

# Se separa la query en parámetros: currentSchema pasa a FLYWAY_SCHEMAS y el resto (sslmode…) a la URL JDBC.
query=""
schema=""
schema_given=0
set -f
IFS='&'
for parameter in $(part query); do
  case "$parameter" in
    currentSchema=*) schema="${parameter#currentSchema=}"; schema_given=1 ;;
    "") ;;
    *) query="${query:+$query&}$parameter" ;;
  esac
done
unset IFS
set +f

FLYWAY_URL="jdbc:postgresql://$host:${port:-5432}/$database${query:+?$query}"
export FLYWAY_URL
if [ -n "${SPRING_FLYWAY_USER:-}" ]; then FLYWAY_USER="$SPRING_FLYWAY_USER"; else FLYWAY_USER="$(part user)"; fi
if [ -n "${SPRING_FLYWAY_PASSWORD:-}" ]; then FLYWAY_PASSWORD="$SPRING_FLYWAY_PASSWORD"; else FLYWAY_PASSWORD="$(part password)"; fi
[ -n "$FLYWAY_USER" ] && export FLYWAY_USER
[ -n "$FLYWAY_PASSWORD" ] && export FLYWAY_PASSWORD
# currentSchema llega con %XX; connection-url.sh no decodifica la query. Como la API (connection-urls.ts),
# debe ser un solo esquema: vacío dejaría a Flyway migrando el esquema por defecto y una lista, gestionando todos.
if [ "$schema_given" = 1 ]; then
  decoded="$(sh "$here/connection-url.sh" path "x://h/$schema")"
  case "$decoded" in
    *,*|"") invalid_schema=1 ;;
    *[![:space:]]*) invalid_schema=0 ;;
    *) invalid_schema=1 ;;
  esac
  if [ "$invalid_schema" = 1 ]; then
    echo "migrate.sh: DATABASE_URL debe indicar un solo esquema en currentSchema" >&2
    exit 2
  fi
  FLYWAY_SCHEMAS="$decoded"
  export FLYWAY_SCHEMAS
fi
export FLYWAY_LOCATIONS="${FLYWAY_LOCATIONS:-filesystem:/flyway/sql}"
unset DATABASE_URL
exec flyway "$command"
