import { defineConfig } from 'vitest/config';

// Tres proyectos: unit y golden corren sin infraestructura; integration
// necesita Docker (Testcontainers) y por eso queda fuera de `npm test`.
// passWithNoTests evita que un proyecto aún vacío rompa su script.
export default defineConfig({
  test: {
    globals: true,
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        resolve: { tsconfigPaths: true },
        test: { name: 'unit', include: ['test/unit/**/*.spec.ts'] },
      },
      {
        extends: true,
        resolve: { tsconfigPaths: true },
        test: { name: 'golden', include: ['test/golden/**/*.spec.ts'] },
      },
      {
        extends: true,
        resolve: { tsconfigPaths: true },
        test: {
          name: 'integration',
          include: ['test/integration/**/*.int.spec.ts'],
          testTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
