/**
 * Strict parsers for the two shell waits this plugin can replace without a
 * shell: a bare `sleep` and a `timeout ... sleep`.
 *
 * Everything else stays in the shell. A false negative costs a process; a
 * false positive would change semantics.
 *
 * @module sleep-plugin-dsh/parse
 */

/** Duration suffix factors in milliseconds. */
const UNIT = Object.freeze({
  '': 1000,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
});

/** One duration token: decimal number plus optional unit. */
const DURATION = /^(\d+(?:\.\d+)?)([smhd]?)$/;

/**
 * Strip surrounding whitespace and one trailing command separator.
 * @param command - raw shell command.
 * @returns the trimmed command.
 */
function clean(command) {
  let text = String(command).trim();
  if (text.endsWith(';')) text = text.slice(0, -1).trim();
  return text;
}

/**
 * Convert one duration token to milliseconds.
 * @param token - number plus optional unit.
 * @returns milliseconds, or undefined for an unsupported token.
 */
function duration(token) {
  const match = DURATION.exec(token);
  if (match === null) return undefined;
  const value = Number(match[1]) * UNIT[match[2]];
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.round(value)) : undefined;
}

/**
 * Sum the duration tokens of one sleep body.
 * @param tokens - whitespace-split durations.
 * @returns milliseconds, or undefined when a token is not a duration.
 */
function sumDurations(tokens) {
  if (tokens.length === 0) return undefined;
  let total = 0;
  for (const token of tokens) {
    if (token === 'infinity') return undefined;
    const ms = duration(token);
    if (ms === undefined) return undefined;
    total += ms;
  }
  return total > 0 ? total : undefined;
}

/**
 * Parse a command that is exactly `sleep <duration...>`.
 * @param command - raw shell command.
 * @returns the planned wait, or undefined when the shell must run.
 */
export function parseSleepCommand(command) {
  const match = /^sleep[ \t]+(.+)$/.exec(clean(command));
  if (match === null) return undefined;
  const ms = sumDurations(match[1].trim().split(/[ \t]+/));
  return ms === undefined ? undefined : { kind: 'sleep', ms };
}

/**
 * Parse a command that is exactly `timeout <duration> sleep <duration...>`.
 *
 * A timeout that fires first becomes a wait of its own kind; a timeout longer
 * than the sleep collapses to a plain sleep.
 * @param command - raw shell command.
 * @returns the planned wait, or undefined when the shell must run.
 */
export function parseTimeoutSleepCommand(command) {
  const outerMatch = /^timeout[ \t]+(\S+)[ \t]+(.+)$/.exec(clean(command));
  if (outerMatch === null) return undefined;
  const outer = duration(outerMatch[1]);
  if (outer === undefined) return undefined;
  const body = /^sleep[ \t]+(.+)$/.exec(outerMatch[2].trim());
  if (body === null) return undefined;
  const inner = sumDurations(body[1].trim().split(/[ \t]+/));
  if (inner === undefined) return undefined;
  return inner > outer
    ? { kind: 'timeout', ms: outer, outerMs: outer, requestedMs: inner }
    : { kind: 'sleep', ms: inner, outerMs: outer };
}

/**
 * Parse either supported shell wait.
 * @param command - raw shell command.
 * @returns the planned wait, or undefined when the shell must run.
 */
export function parseShellWait(command) {
  return parseTimeoutSleepCommand(command) ?? parseSleepCommand(command);
}
