import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULTS, MAX_TIMER_MS, normalizeConfig } from '../lib/config.js';

test('fills every field with its default', () => {
  assert.deepEqual(normalizeConfig(), { ...DEFAULTS });
  assert.deepEqual(normalizeConfig(undefined), { ...DEFAULTS });
});

test('treats null and non-object raw values as defaults', () => {
  assert.deepEqual(normalizeConfig(null), { ...DEFAULTS });
  assert.deepEqual(normalizeConfig('ignored'), { ...DEFAULTS });
});

test('keeps valid overrides', () => {
  assert.deepEqual(normalizeConfig({ goalMode: 'yield', maxMs: 1000, maxPendingPerAgent: 3 }), {
    ...DEFAULTS,
    goalMode: 'yield',
    maxMs: 1000,
    maxPendingPerAgent: 3,
  });
});

test('coerces boolean strings', () => {
  assert.equal(normalizeConfig({ yieldByDefault: 'false' }).yieldByDefault, false);
  assert.equal(normalizeConfig({ yieldByDefault: '0' }).yieldByDefault, false);
  assert.equal(normalizeConfig({ interceptShell: 'no' }).interceptShell, false);
  assert.equal(normalizeConfig({ wakeOnInput: 'off' }).wakeOnInput, false);
  assert.equal(normalizeConfig({ wakeOnInput: 'on' }).wakeOnInput, true);
  assert.equal(normalizeConfig({ interceptShell: 'true' }).interceptShell, true);
});

test('coerces numeric strings', () => {
  assert.equal(normalizeConfig({ maxMs: '1000' }).maxMs, 1000);
  assert.equal(normalizeConfig({ maxPendingPerAgent: '2' }).maxPendingPerAgent, 2);
});

test('rejects an invalid goal mode', () => {
  assert.throws(() => normalizeConfig({ goalMode: 'pause' }), /goalMode/);
  assert.throws(() => normalizeConfig({ goalMode: 1 }), /goalMode/);
});

test('rejects out-of-range durations', () => {
  assert.throws(() => normalizeConfig({ maxMs: MAX_TIMER_MS + 1 }), /maxMs/);
  assert.throws(() => normalizeConfig({ maxMs: 0 }), /maxMs/);
  assert.throws(() => normalizeConfig({ maxMs: 1.5 }), /maxMs/);
  assert.throws(() => normalizeConfig({ maxMs: 'abc' }), /maxMs/);
});

test('rejects out-of-range pending caps', () => {
  assert.throws(() => normalizeConfig({ maxPendingPerAgent: 0 }), /maxPendingPerAgent/);
  assert.throws(() => normalizeConfig({ maxPendingPerAgent: 129 }), /maxPendingPerAgent/);
  assert.throws(() => normalizeConfig({ maxPendingPerAgent: 2.5 }), /maxPendingPerAgent/);
});

test('rejects a non-boolean flag', () => {
  assert.throws(() => normalizeConfig({ yieldByDefault: {} }), /boolean/);
});

test('returns a frozen object', () => {
  assert.equal(Object.isFrozen(normalizeConfig()), true);
});
