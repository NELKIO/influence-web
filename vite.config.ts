import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  base: '/influence-web/',
  plugins: [preact()],
  worker: { format: 'es' },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
