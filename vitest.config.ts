import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/agent.ts', 'src/scraper.ts', 'src/api-types.ts', 'src/config.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
      },
    },
  },
});
