// Live runs only. Separate config so a real, paid run can never be started by
// `npm test`.
//
//     npx vitest run --config vitest.live.config.ts
//
// NOTE: does not extend the root config — inheriting minWorkers alongside a
// maxWorkers here makes vitest refuse the combination and silently run zero
// tests, which is worse than failing loudly.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/live/**/*.livetest.ts'],
    testTimeout: 2_400_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
