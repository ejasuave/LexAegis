import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Only VITE_-prefixed values reach the bundle; none of them may be secret.
export default defineConfig({
  plugins: [react()],
  envDir: '../..',
  server: { host: '127.0.0.1' },
});
