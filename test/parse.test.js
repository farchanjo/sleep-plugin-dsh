import assert from 'node:assert/strict';
import test from 'node:test';

import { parseShellWait, parseSleepCommand, parseTimeoutSleepCommand } from '../lib/parse.js';

test('parses a bare sleep in seconds', () => {
  assert.deepEqual(parseSleepCommand('sleep 5'), { kind: 'sleep', ms: 5000 });
});

test('parses a decimal sleep', () => {
  assert.deepEqual(parseSleepCommand('sleep 0.5'), { kind: 'sleep', ms: 500 });
});

test('parses supported unit suffixes', () => {
  assert.deepEqual(parseSleepCommand('sleep 1m'), { kind: 'sleep', ms: 60_000 });
  assert.deepEqual(parseSleepCommand('sleep 1h'), { kind: 'sleep', ms: 3_600_000 });
  assert.deepEqual(parseSleepCommand('sleep 1d'), { kind: 'sleep', ms: 86_400_000 });
});

test('sums multiple durations', () => {
  assert.deepEqual(parseSleepCommand('sleep 1 2'), { kind: 'sleep', ms: 3000 });
});

test('accepts one trailing command separator', () => {
  assert.deepEqual(parseSleepCommand('sleep 5;'), { kind: 'sleep', ms: 5000 });
  assert.deepEqual(parseSleepCommand('  sleep 5 ;  '), { kind: 'sleep', ms: 5000 });
});

test('rejects the unsupported ms suffix', () => {
  assert.equal(parseSleepCommand('sleep 500ms'), undefined);
});

test('parses a timeout that fires before the sleep ends', () => {
  assert.deepEqual(parseTimeoutSleepCommand('timeout 10 sleep 60'), {
    kind: 'timeout',
    ms: 10_000,
    outerMs: 10_000,
    requestedMs: 60_000,
  });
});

test('collapses a timeout longer than the sleep to a plain sleep', () => {
  assert.deepEqual(parseTimeoutSleepCommand('timeout 10 sleep 5'), {
    kind: 'sleep',
    ms: 5000,
    outerMs: 10_000,
  });
});

test('rejects compound commands', () => {
  assert.equal(parseShellWait('sleep 5 && echo ok'), undefined);
  assert.equal(parseShellWait('sleep 5 | cat'), undefined);
});

test('rejects a timeout around a real command', () => {
  assert.equal(parseShellWait('timeout 10 curl x'), undefined);
});

test('rejects timeout flags', () => {
  assert.equal(parseShellWait('timeout -k 5 10 sleep 1'), undefined);
});

test('rejects infinity, zero, empty, and garbage', () => {
  assert.equal(parseShellWait('sleep infinity'), undefined);
  assert.equal(parseShellWait('sleep 0'), undefined);
  assert.equal(parseShellWait(''), undefined);
  assert.equal(parseShellWait('garbage'), undefined);
  assert.equal(parseShellWait('sleep'), undefined);
  assert.equal(parseShellWait('timeout 10 sleep'), undefined);
});

test('dispatches the timeout parser first', () => {
  assert.deepEqual(parseShellWait('timeout 10 sleep 60'), {
    kind: 'timeout',
    ms: 10_000,
    outerMs: 10_000,
    requestedMs: 60_000,
  });
  assert.deepEqual(parseShellWait('sleep 5'), { kind: 'sleep', ms: 5000 });
});

test('accepts tab separators', () => {
  assert.deepEqual(parseShellWait('sleep\t5'), { kind: 'sleep', ms: 5000 });
  assert.deepEqual(parseShellWait('timeout\t10\tsleep\t60'), {
    kind: 'timeout',
    ms: 10_000,
    outerMs: 10_000,
    requestedMs: 60_000,
  });
});
