// The paywall's display price must follow the same rule as the backend's
// priceFor() (functions/src/pricing.js): +91 pays INR, any other country
// code pays USD. Display only — the server decides the charge.

import { displayPrice } from '../js/ui/accountPanel.js';

test('Indian numbers and an empty field show rupees', () => {
  expect(displayPrice('')).toBe('₹499');
  expect(displayPrice('+')).toBe('₹499');
  expect(displayPrice('+91')).toBe('₹499');
  // Still typing: '+9' could become '+91'.
  expect(displayPrice('+9')).toBe('₹499');
  expect(displayPrice('+91 98765 43210')).toBe('₹499');
});

test('any other country code shows dollars', () => {
  expect(displayPrice('+1 415 555 0100')).toBe('$9.99');
  expect(displayPrice('+44 7700 900123')).toBe('$9.99');
  expect(displayPrice('+92 300 1234567')).toBe('$9.99');
});

test('a number without a country code keeps the default', () => {
  expect(displayPrice('9876543210')).toBe('₹499');
});
