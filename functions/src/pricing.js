// The price of the lifetime unlock. Decided here and ONLY here — the client
// never sends an amount, so it cannot change one.
//
// Currency follows the verified-at-checkout phone number: an Indian number
// pays in INR (UPI, domestic cards), everyone else pays in USD on an
// international card. Both currencies must be enabled on the PayLayer site
// (`site:create --currencies INR,USD`).
//
// Amounts are in the smallest unit (paise / cents), as PayLayer expects.

export const PRODUCT_ID = 'full_game_lifetime';
export const PRODUCT_DESCRIPTION = 'Table Tennis XR: full game, lifetime';

const PRICES = {
  INR: 49900, // ₹499
  USD: 999,   // $9.99
};

/** E.164, the format PayLayer validates `customer.contact` against. */
export const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * @param {string} phone E.164
 * @returns {{ amount: number, currency: 'INR'|'USD' }}
 */
export function priceFor(phone) {
  const currency = String(phone).startsWith('+91') ? 'INR' : 'USD';
  return { amount: PRICES[currency], currency };
}
