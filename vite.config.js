import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS is required for WebXR on Quest. For desktop testing with the WebXR
// emulator extension, set DEV_HTTP=1 to serve plain HTTP — that avoids the
// mixed-content block when the page opens ws://localhost:8080 for signaling.
const httpOnly = process.env.DEV_HTTP === '1';

export default defineConfig({
  plugins: httpOnly ? [] : [basicSsl()],
  server: {
    host: true,
    port: 5173,
  },
});
