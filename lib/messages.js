/**
 * Model-facing wake, placeholder, and cancellation messages.
 *
 * Every message carries this plugin's own source kind, so projections and the
 * model can tell a timer wake from user input. The source also keeps the wake
 * out of title/outline logic that keys on ordinary user messages.
 *
 * @module sleep-plugin-dsh/messages
 */

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';

/** Producer-owned source kind. */
export const SOURCE = 'sleep-plugin-dsh';

/**
 * Human duration for model text.
 * @param ms - elapsed or planned milliseconds.
 * @returns a short seconds string.
 */
export function formatDuration(ms) {
  return `${(Math.max(0, ms) / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

/**
 * Build the wake message delivered when a wait fires.
 * @param wait - fired wait.
 * @param pendingIds - other pending wait ids of the same agent.
 * @returns the immutable user-role wake message.
 */
export function wakeMessage(wait, pendingIds) {
  const elapsed = formatDuration(Date.now() - wait.requestedAt);
  const reason = wait.reason === undefined ? '' : ` (${wait.reason})`;
  const pending = pendingIds.length === 0 ? '' : `\nOther waits pending: ${pendingIds.join(', ')}.`;
  const text = wait.hit
    ? `Shell timeout hit after ${elapsed} (${wait.id}) while sleeping ${formatDuration(wait.requestedMs)}. The sleep ended early; continue the task you paused.${pending}`
    : wait.kind === 'timeout'
      ? `Timeout reached after ${elapsed} (${wait.id})${reason}. This is a watchdog notice, not a new instruction. Continue working and decide whether to keep going.${pending}`
      : `Sleep finished after ${elapsed} (${wait.id})${reason}. Continue the task you paused before the sleep.${pending}`;
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: SOURCE,
      form: 'notice',
      summary: boundContextSummary(
        wait.hit ? `shell timeout ${wait.id}` : wait.kind === 'timeout' ? `timeout ${wait.id}` : `sleep ${wait.id}`,
      ),
    },
  });
}

/**
 * Build the pending context that keeps a delegated activation alive.
 * @param wait - pending sleep.
 * @returns the immutable user-role placeholder message.
 */
export function placeholderMessage(wait) {
  return createUserMessage({
    content: [
      {
        type: 'text',
        text: `Native wait pending until ${new Date(wait.wakeAt).toISOString()} (${wait.id}). The wake notice continues this run; do not call structured_output before then.`,
      },
    ],
    source: {
      kind: SOURCE,
      form: 'notice',
      summary: boundContextSummary(`sleeping ${wait.id}`),
    },
  });
}

/**
 * Build the notice injected when a cancellation clears pending waits.
 * @param ids - cancelled wait ids.
 * @returns the immutable user-role notice.
 */
export function cancelledMessage(ids) {
  return createUserMessage({
    content: [
      {
        type: 'text',
        text: `Pending native waits cancelled by the cancellation: ${ids.join(', ')}.`,
      },
    ],
    source: {
      kind: SOURCE,
      form: 'notice',
      summary: boundContextSummary(`cancelled ${ids.length} wait${ids.length === 1 ? '' : 's'}`),
    },
  });
}
