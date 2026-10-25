// The paywall's display price must follow the same rule as the backend's
// priceFor() (functions/src/pricing.js): +91 pays INR, any other country
// code pays USD. Display only — the server decides the charge.

import { displayPrice, guessPrice, priceNote } from '../js/ui/accountPanel.js';

test('Indian numbers and an empty field show rupees', () => {
  expect(displayPrice('')).toBe('₹1,997');
  expect(displayPrice('+')).toBe('₹1,997');
  expect(displayPrice('+91')).toBe('₹1,997');
  // Still typing: '+9' could become '+91'.
  expect(displayPrice('+9')).toBe('₹1,997');
  expect(displayPrice('+91 98765 43210')).toBe('₹1,997');
});

test('any other country code shows dollars', () => {
  expect(displayPrice('+1 415 555 0100')).toBe('$19.97');
  expect(displayPrice('+44 7700 900123')).toBe('$19.97');
  expect(displayPrice('+92 300 1234567')).toBe('$19.97');
});

test('a number without a country code keeps the default', () => {
  expect(displayPrice('9876543210')).toBe('₹1,997');
});

test('the landing-page offer guesses the currency from the time zone', () => {
  expect(guessPrice('Asia/Kolkata')).toBe('₹1,997');
  expect(guessPrice('Asia/Calcutta')).toBe('₹1,997');
  expect(guessPrice('America/New_York')).toBe('$19.97');
  expect(guessPrice('Europe/London')).toBe('$19.97');
  // Unknown zone: same default as an empty checkout field.
  expect(guessPrice('')).toBe('₹1,997');
});

test('the rupee price says it includes GST; the dollar price does not', () => {
  expect(priceNote('₹1,997')).toBe('incl. GST · one-time · lifetime');
  expect(priceNote('$19.97')).toBe('one-time · lifetime');
});
