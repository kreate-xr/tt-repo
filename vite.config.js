import { defineConfig, loadEnv } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { createRequire } from 'node:module';

// Stamped into every session doc (js/analytics/session.js) so an error can be
// tied to the deploy it came from — otherwise a fixed crash is indistinguishable
// from one still in the wild.
const { version } = createRequire(import.meta.url)('./package.json');

// HTTPS is required for WebXR on Quest. For desktop testing with the WebXR
// emulator extension, set DEV_HTTP=1 to serve plain HTTP — that avoids the
// mixed-content block when the page opens ws://localhost:8080 for signaling.
const httpOnly = process.env.DEV_HTTP === '1';

export default defineConfig(({ mode }) => {
  // loadEnv reads .env / .env.local the same way import.meta.env would, but at
  // CONFIG time so the value can go through `define`. js/analytics/gtm.js
  // cannot read import.meta.env directly: babel-jest cannot transform
  // import.meta to CJS, so a module that touches it is un-unit-testable — the
  // constraint js/network/iceConfig.js documents. A define keeps the container
  // id configurable AND the loader under test.
  const env = loadEnv(mode, process.cwd(), 'VITE_');

  return {
  plugins: httpOnly ? [] : [basicSsl()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __GTM_CONTAINER_ID__: JSON.stringify(env.VITE_GTM_CONTAINER_ID || ''),
  },
  server: {
    host: true,
    port: 5173,
  },
  build: {
    // 'hidden' generates the maps but omits the //# sourceMappingURL comment,
    // so they are not fetched by visitors — while `errors[]` on the session doc
    // (js/analytics/session.js) still symbolicates against dist/assets/*.map in
    // the LOCAL build of the same version. Without this every captured stack is
    // `at t (index-a3f9.js:1:48213)`, i.e. useless.
    //
    // 'hidden' only drops the comment; the files are still emitted into dist/
    // and would be fetchable by URL, so firebase.json's hosting `ignore` keeps
    // **/*.map out of the deploy. Symbolicate from your own dist, matching the
    // appVersion the session doc reports.
    sourcemap: 'hidden',
  },
  };
});
