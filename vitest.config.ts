import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    // Live runs spend real requests. They are never swept up by `npm test`.
    exclude: ['**/node_modules/**', '**/*.livetest.ts'],
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 1,
    restoreMocks: true,
    clearMocks: true,
  },
});
