# Imagen de la API y del worker (la misma: EINVOICE_WORKER_ENABLED decide qué hace cada instancia).
#   docker build -t einvoice-api .
# Las pruebas no corren aquí: las ejecuta el CI antes de construir la imagen.

FROM node:24-bookworm-slim AS build
WORKDIR /src
# Las dependencias van en una capa propia, que solo se rehace cuando cambian los package*.json.
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src src
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    LOGGING_STRUCTURED_FORMAT_CONSOLE=logstash
WORKDIR /app
COPY package.json package-lock.json ./
# Solo dependencias de producción; sin scripts de instalación (los de desarrollo no hacen falta).
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /src/dist dist
COPY resources resources
COPY contracts contracts
# El usuario "node" (uid 1000) no tiene privilegios; la aplicación no escribe en disco.
USER node
# Escucha en PORT (8080 si no se define).
EXPOSE 8080
# node es el proceso 1 y recibe SIGTERM directamente: cierra de forma ordenada.
CMD ["node", "dist/main.js"]
