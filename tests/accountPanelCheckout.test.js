// Checkout consent and the refund block on the account screen
// (js/ui/accountPanel.js). The DOM wiring is covered end-to-end in
// e2e/accounts.e2e.mjs; these pin the rules it applies.

import { payDisabled, refundState } from '../js/ui/accountPanel.js';

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

test('an unknown reason hides the block rather than showing a code', () => {
  expect(refundState({ eligible: false, reason: 'something_new' }, fmt).show).toBe(false);
});
