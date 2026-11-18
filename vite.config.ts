import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import pkg from './package.json' with { type: 'json' };
import { swPrecache } from './scripts/swPrecache';

export default defineConfig({
  base: '/influence-web/',
  plugins: [preact(), swPrecache()],
  worker: { format: 'es' },
  // shown as "2.0" rather than "2.0.0": a zero patch number says nothing to a player
  define: { __APP_VERSION__: JSON.stringify(pkg.version.replace(/\.0$/, '')) },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
