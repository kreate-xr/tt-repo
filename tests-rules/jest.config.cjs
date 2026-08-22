// Separate Jest config for the Firestore security-rules suite. These tests
// need the Firestore emulator, so they are kept OUT of the default `npm test`
// run (whose testMatch only covers tests/). Run via `npm run test:rules`,
// which wraps this in `firebase emulators:exec`.
module.exports = {
  rootDir: '..',
  testMatch: ['<rootDir>/tests-rules/**/*.test.js'],
  testEnvironment: 'node',
  transform: { '^.+\\.js$': 'babel-jest' },
  // Emulator round-trips make individual assertions slow-ish.
  testTimeout: 20000,
  // The suite talks to one shared emulator instance; run files serially.
  maxWorkers: 1,
};
