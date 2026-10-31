/**
 * Row-config normalization and hard limits.
 *
 * The config is seed data for one mount. Invalid values fail the mount so a
 * typo never silently changes the wait semantics.
 *
 * @module sleep-plugin-dsh/config
 */

/** Node's largest single `setTimeout` delay. */
export const MAX_TIMER_MS = 2_147_483_647;

/** Defaults shipped by the bundle patch. */
export const DEFAULTS = Object.freeze({
  yieldByDefault: true,
  goalMode: 'block',
  interceptShell: true,
  denyShellWaits: true,
  wakeOnInput: true,
  maxMs: 604_800_000,
  maxPendingPerAgent: 8,
});

/**
 * Coerce one row-config boolean.
 * @param value - raw config value.
 * @param fallback - value used when the field is absent.
 * @returns the coerced boolean.
 */
function flag(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return !['false', '0', 'no', 'off'].includes(value.trim().toLowerCase());
  throw new TypeError(`sleep-plugin-dsh: expected a boolean, got ${JSON.stringify(value)}`);
}

/**
 * Coerce one bounded positive integer.
 * @param value - raw config value.
 * @param fallback - value used when the field is absent.
 * @param max - inclusive upper bound.
 * @param field - field name for the error.
 * @returns the coerced integer.
 */
function positiveInt(value, fallback, max, field) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'string' ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 1 || number > max) {
    throw new TypeError(`sleep-plugin-dsh: ${field} must be a whole number from 1 to ${max}`);
  }
  return number;
}

/**
 * Normalize one raw row config.
 * @param raw - row config supplied by the profile loader.
 * @returns a frozen complete config.
 */
export function normalizeConfig(raw = {}) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const goalMode = source.goalMode === undefined ? DEFAULTS.goalMode : String(source.goalMode);
  if (goalMode !== 'block' && goalMode !== 'yield') {
    throw new TypeError('sleep-plugin-dsh: goalMode must be "block" or "yield"');
  }
  return Object.freeze({
    yieldByDefault: flag(source.yieldByDefault, DEFAULTS.yieldByDefault),
    goalMode,
    interceptShell: flag(source.interceptShell, DEFAULTS.interceptShell),
    denyShellWaits: flag(source.denyShellWaits, DEFAULTS.denyShellWaits),
    wakeOnInput: flag(source.wakeOnInput, DEFAULTS.wakeOnInput),
    maxMs: positiveInt(source.maxMs, DEFAULTS.maxMs, MAX_TIMER_MS, 'maxMs'),
    maxPendingPerAgent: positiveInt(source.maxPendingPerAgent, DEFAULTS.maxPendingPerAgent, 128, 'maxPendingPerAgent'),
  });
}
