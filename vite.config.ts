import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { logWriter } from './vite-plugins/logWriter';
import { publicEnvDefine } from './vite-plugins/publicEnv';

export default defineConfig(({ mode }) => {
  // The third argument is '' — load EVERY variable, not just VITE_-prefixed
  // ones, because the Supabase credentials in `.env` carry no prefix. Loading
  // them here does not publish them: `publicEnvDefine` allowlists the two the
  // browser is allowed to have and drops the rest, the secret key included.
  // See vite-plugins/publicEnv.ts for why that is an allowlist.
  const env = loadEnv(mode, process.cwd(), '');

  return {
    // `logWriter` adds POST /api/logs to the DEV SERVER only — the app has no
    // backend, so an interview log otherwise lives and dies in one browser's
    // IndexedDB. See the header of vite-plugins/logWriter.ts for what this is
    // and, more importantly, what it is not.
    plugins: [react(), logWriter()],
    define: publicEnvDefine(env),
    server: {
      port: 5174,
      proxy: {
        // DWG → DXF conversion service (services/dwg-convert, Docker, port 5179)
        '/dwg-convert': {
          target: 'http://localhost:5179',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/dwg-convert/, ''),
        },
      },
    },
  };
});
