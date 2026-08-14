import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Deterministic regardless of local .env files.
    env: {
      VITE_API_URL: '/api/v1',
    },
  },
});