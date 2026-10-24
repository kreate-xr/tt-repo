import { test } from 'node:test';
import assert from 'node:assert/strict';
import { networkKey } from '../src/network.js';

test('IPv4 is the whole address', () => {
  assert.equal(networkKey('203.0.113.7'), 'v4:203.0.113.7');
  assert.equal(networkKey(' 203.0.113.7 '), 'v4:203.0.113.7');
  assert.equal(networkKey('203.0.113.7:5123'), 'v4:203.0.113.7');
});

test('IPv4-mapped IPv6 is treated as IPv4', () => {
  assert.equal(networkKey('::ffff:203.0.113.7'), 'v4:203.0.113.7');
});

test('IPv6 groups by /64, so rotating device addresses share one network', () => {
  const a = networkKey('2001:db8:abcd:12:1111:2222:3333:4444');
  const b = networkKey('2001:0db8:ABCD:0012:9:8:7:6');
  assert.equal(a, 'v6:2001:0db8:abcd:0012');
  assert.equal(a, b);
  assert.notEqual(a, networkKey('2001:db8:abcd:13::1'));
});

test('IPv6 shorthand, brackets and zones', () => {
  assert.equal(networkKey('2001:db8::1'), 'v6:2001:0db8:0000:0000');
  assert.equal(networkKey('[2001:db8:1:2::5]'), 'v6:2001:0db8:0001:0002');
  assert.equal(networkKey('fe80::1%eth0'), 'v6:fe80:0000:0000:0000');
  assert.equal(networkKey('::1'), 'v6:0000:0000:0000:0000');
});

test('garbage gives no key', () => {
  assert.equal(networkKey(''), '');
  assert.equal(networkKey(undefined), '');
  assert.equal(networkKey('not-an-ip'), '');
});
