import { defineConfig, loadEnv } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

// Stamped into every session doc (js/analytics/session.js) so an error can be
// tied to the deploy it came from — otherwise a fixed crash is indistinguishable
// from one still in the wild.
const { version } = createRequire(import.meta.url)('./package.json');

// HTTPS is required for WebXR on Quest. For desktop testing with the WebXR
// emulator extension, set DEV_HTTP=1 to serve plain HTTP — that avoids the
// mixed-content block when the page opens ws://localhost:8080 for signaling.
const httpOnly = process.env.DEV_HTTP === '1';

export default defineConfig(({ mode, command }) => {
  // Two Firebase projects, selected by mode (see .env.example): the default
  // mode reads .env.local (sportyxr-test); `--mode prod` layers .env.prod.local
  // on top (sportyxr-tech). Vite loads .env.local in EVERY mode, so a prod run
  // without .env.prod.local would silently build the test config under a prod
  // label — refuse instead.
  if (mode === 'prod' && !existsSync('.env.prod.local')) {
    throw new Error('--mode prod needs .env.prod.local (copy .env.example and fill in the sportyxr-tech values)');
  }

  // loadEnv reads .env / .env.local the same way import.meta.env would, but at
  // CONFIG time so the value can go through `define`. js/analytics/gtm.js
  // cannot read import.meta.env directly: babel-jest cannot transform
  // import.meta to CJS, so a module that touches it is un-unit-testable — the
  // constraint js/network/iceConfig.js documents. A define keeps the container
  // id configurable AND the loader under test.
  const env = loadEnv(mode, process.cwd(), 'VITE_');

  // App Check (js/network/appCheck.js). The debug token is loaded with an
  // EMPTY prefix on purpose: it is not VITE_-prefixed, so import.meta.env can
  // never inline it, and it is substituted only under the dev server
  // (`command === 'serve'`) — `vite build` defines it as '' so no production
  // bundle can contain it. The site key is public and ships in every build.
  const isDevServer = command === 'serve';
  const secrets = isDevServer ? loadEnv(mode, process.cwd(), '') : {};

  // Every build/dev run states which project it targets, so a deploy log
  // shows the mistake before `firebase deploy` does.
  console.log(`[vite] mode=${mode} firebase project=${env.VITE_FIREBASE_PROJECT_ID || '(unset)'}`);

  return {
  plugins: httpOnly ? [] : [basicSsl()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __GTM_CONTAINER_ID__: JSON.stringify(env.VITE_GTM_CONTAINER_ID || ''),
    __RECAPTCHA_SITE_KEY__: JSON.stringify(env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY || ''),
    __APPCHECK_DEBUG_TOKEN__: JSON.stringify(isDevServer ? (secrets.APPCHECK_DEBUG_TOKEN || '') : ''),
    __IS_DEV_SERVER__: JSON.stringify(isDevServer),
    // PayLayer service origin; its browser SDK is loaded from here at checkout
    // (js/account/account.js). Public. Test and prod use different PayLayer
    // deployments (test-mode vs live Razorpay keys).
    __PAYLAYER_URL__: JSON.stringify(env.VITE_PAYLAYER_URL || ''),
  },
  server: {
    host: true,
    port: 5173,
    // The backend (functions/) is reached same-origin under /api and
    // /webhooks — a Firebase Hosting rewrite in production. The dev server
    // has no such rewrite, so API_PROXY_TARGET (not VITE_-prefixed: config
    // only) forwards them: to the deployed test site
    // (https://sportyxr-test.web.app) for headset dev, or to the Functions
    // emulator's `api` URL for the e2e suite (e2e/README.md).
    proxy: secrets.API_PROXY_TARGET
      ? Object.fromEntries(['/api', '/webhooks'].map((p) => [p, {
          target: secrets.API_PROXY_TARGET,
          changeOrigin: true,
        }]))
      : undefined,
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

    // three.js is ~600 kB minified and is needed before the first frame, so it
    // can never leave the startup path — but it changes only when the package
    // is bumped. In its own chunk its content hash survives every game-code
    // deploy, so a returning headset re-fetches only the ~430 kB game half
    // instead of the whole 1 MB bundle. Firebase is already lazy
    // (js/analytics/session.js, js/data/submissions.js) and stays out of both.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: 'three', test: /[/]node_modules[/]three[/]/ }],
        },
      },
    },
    // Default is 500 kB, which the three chunk alone exceeds by design (above).
    // 700 keeps the expected build silent while still catching a regression
    // such as Firestore (~380 kB) getting statically imported into `index`.
    chunkSizeWarningLimit: 700,
  },
  };
});
