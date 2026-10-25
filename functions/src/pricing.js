// The price of the lifetime unlock. Decided here and ONLY here — the client
// never sends an amount, so it cannot change one.
//
// Currency follows the verified-at-checkout phone number: an Indian number
// pays in INR (UPI, domestic cards), everyone else pays in USD on an
// international card. Both currencies must be enabled on the PayLayer site
// (`site:create --currencies INR,USD`).
//
// The INR price INCLUDES GST: an Indian buyer is charged exactly ₹1,997 and
// no tax line is added or shown. The USD price is a flat $19.97. The display
// copy (js/ui/accountPanel.js, index.html, public/pricing.html, terms.html,
// refund.html) must say the same.
//
// Amounts are in the smallest unit (paise / cents), as PayLayer expects.

export const PRODUCT_ID = 'full_game_lifetime';
export const PRODUCT_DESCRIPTION = 'Lifetime game unlock';

// The refund window asked of PayLayer per purchase: 3 days, or 0
// (non-refundable) once the account has used its one refund.
export const REFUND_WINDOW_DAYS = 3;

// The consent checkbox text the player ticked (index.html, #acct-buy-consent).
// Bump together with that text.
export const CONSENT_TEXT_VERSION = 'v1';

const PRICES = {
  INR: 199700, // ₹1,997, GST included
  USD: 1997,   // $19.97
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
