import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import pkg from './package.json' with { type: 'json' };
import { swPrecache } from './scripts/swPrecache';

export default defineConfig({
  base: '/influence-web/',
  plugins: [preact(), swPrecache()],
  worker: { format: 'es' },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
