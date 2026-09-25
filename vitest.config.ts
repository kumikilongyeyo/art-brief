import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __REFS_V__: JSON.stringify('test'), __ORT_VERSION__: JSON.stringify('test'), __APP_VERSION__: JSON.stringify('test') },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 180000,
  },
});
