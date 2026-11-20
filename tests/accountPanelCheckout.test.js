// Checkout consent and the refund block on the account screen
// (js/ui/accountPanel.js). The DOM wiring is covered end-to-end in
// e2e/accounts.e2e.mjs; these pin the rules it applies.

import { payDisabled, refundState, refundAmounts, formatMoney } from '../js/ui/accountPanel.js';

test('Pay is disabled until the consent box is ticked', () => {
  expect(payDisabled({ busy: false, consent: false })).toBe(true);
  expect(payDisabled({ busy: false, consent: undefined })).toBe(true);
  expect(payDisabled({ busy: false, consent: true })).toBe(false);
});

test('Pay is disabled while a request runs, ticked or not', () => {
  expect(payDisabled({ busy: true, consent: true })).toBe(true);
  expect(payDisabled({ busy: true, consent: false })).toBe(true);
});

const fmt = (d) => d.toISOString();

test('no purchase: no refund block at all', () => {
  expect(refundState(null, fmt)).toEqual({ show: false, button: false, note: '' });
});

test('eligible: the button shows, with the deadline', () => {
  const s = refundState({
    eligible: true, reason: null, refundableUntil: '2026-10-28T10:00:00.000Z', playedSec: 600,
  }, fmt);
  expect(s.show).toBe(true);
  expect(s.button).toBe(true);
  expect(s.note).toBe('Refund available until 2026-10-28T10:00:00.000Z.');
});

test('not eligible: no button, and the reason is shown', () => {
  const cases = {
    refund_window_expired: /3-day refund window has passed/,
    played_too_long: /less than 2 hours/,
    refund_used: /already used its one refund/,
    refund_in_progress: /being processed/,
    already_refunded: /was refunded/,
  };
  for (const [reason, text] of Object.entries(cases)) {
    const s = refundState({ eligible: false, reason, refundableUntil: null, playedSec: 0 }, fmt);
    expect(s.button).toBe(false);
    expect(s.show).toBe(true);
    expect(s.note).toMatch(text);
  }
});

test('money is shown in the currency paid, from paise or cents', () => {
  expect(formatMoney(194988, 'INR')).toBe('₹1,949.88');
  expect(formatMoney(1950, 'USD')).toBe('US$19.50');
  expect(formatMoney(100, 'EUR')).toBe('EUR 1.00');
});

test('a refund says what came back and what the gateway kept', () => {
  expect(refundAmounts({ amount: 194988, processingFee: 4712, currency: 'INR' }))
    .toBe('₹1,949.88 to your original payment method (₹47.12 payment processing charges deducted)');
  expect(refundAmounts({ amount: 1997, processingFee: 0, currency: 'USD' }))
    .toBe('US$19.97 to your original payment method (no processing charges deducted)');
  expect(refundAmounts(null)).toBe('');
});

test('a refunded purchase keeps showing the amounts on the account screen', () => {
  const breakdown = { amount: 194988, processingFee: 4712, currency: 'INR' };
  for (const reason of ['refund_in_progress', 'already_refunded']) {
    const s = refundState({ eligible: false, reason, breakdown }, fmt);
    expect(s.note).toMatch(/Refund: ₹1,949\.88 .*₹47\.12 payment processing charges deducted/);
  }
  // Never on a refusal, whatever the server sent.
  expect(refundState({ eligible: false, reason: 'refund_used', breakdown }, fmt).note).not.toMatch(/₹/);
});

test('an unknown reason hides the block rather than showing a code', () => {
  expect(refundState({ eligible: false, reason: 'something_new' }, fmt).show).toBe(false);
});
