// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import {TZ, toMs, fmtDateTime, fmtTime, fmtDay, ageText, validityState, withOffset, dayBounds, localDate, HOUR} from '../app/lib/time.js';

test('display is Colorado time across the DST change (2026-11-01 08:00 UTC)', () => {
  assert.equal(TZ, 'America/Denver');
  assert.equal(fmtTime('2026-11-01T07:30:00Z'), '1:30 AM'); // MDT, UTC-6
  assert.equal(fmtTime('2026-11-01T08:30:00Z'), '1:30 AM'); // MST, UTC-7: the repeated hour
  assert.match(fmtDateTime('2026-11-01T07:30:00Z'), /MDT$/);
  assert.match(fmtDateTime('2026-11-01T08:30:00Z'), /MST$/);
  assert.equal(fmtDay('2026-11-06T05:00:00Z'), 'Thu, Nov 5'); // 10 PM MST on Nov 5
  assert.equal(fmtDay('2026-11-05'), 'Thu, Nov 5'); // calendar date, not shifted
  const [a, b] = dayBounds('2026-11-01');
  assert.equal((b - a) / HOUR, 25);
  const [c, d] = dayBounds('2026-03-08');
  assert.equal((d - c) / HOUR, 23);
  assert.equal(localDate(Date.parse('2026-11-06T05:00:00Z')), '2026-11-05');
});

test('offsetless date-times are rejected, not guessed', () => {
  assert.equal(toMs('2026-11-05 13:00'), null);
  assert.equal(fmtDateTime('2026-11-05T13:00:00'), 'n/a');
  assert.equal(fmtTime(null), 'n/a');
  assert.equal(fmtDay(undefined), 'n/a');
  assert.equal(fmtDay('2026-02-30'), 'n/a');
});

test('withOffset keeps fixed standard time (no DST) for station clocks', () => {
  const s = withOffset('2026-07-01 12:00', -7);
  assert.equal(s, '2026-07-01T12:00:00-07:00');
  assert.equal(new Date(toMs(s)).toISOString(), '2026-07-01T19:00:00.000Z');
  assert.equal(fmtTime(s), '1:00 PM'); // shown in MDT in summer
  assert.equal(withOffset('garbage', -7), null);
});

test('ageText', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  assert.equal(ageText('2026-11-05T11:59:30Z', now), 'just now');
  assert.equal(ageText('2026-11-05T11:00:00Z', now), '1 h ago');
  assert.equal(ageText('2026-11-05T11:55:00Z', now), '5 min ago');
  assert.equal(ageText('2026-11-02T12:00:00Z', now), '3 days ago');
  assert.equal(ageText('2026-11-05T15:00:00Z', now), 'in 3 h');
  assert.equal(ageText(null, now), 'n/a');
});

test('validityState', () => {
  const w = {validFrom: '2026-11-05T00:00:00Z', validTo: '2026-11-06T00:00:00Z'};
  assert.equal(validityState(w, Date.parse('2026-11-05T12:00:00Z')), 'current');
  assert.equal(validityState(w, Date.parse('2026-11-06T00:00:00Z')), 'expired');
  assert.equal(validityState(w, Date.parse('2026-11-04T23:59:59Z')), 'not-yet-valid');
  assert.equal(validityState({validFrom: null, validTo: w.validTo}, Date.now()), 'unknown');
  assert.equal(validityState({validFrom: '2026-11-05T00:00:00', validTo: w.validTo}, Date.now()), 'unknown');
  assert.equal(validityState(undefined), 'unknown');
});
