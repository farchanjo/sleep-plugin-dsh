/**
 * sleep-plugin-dsh — native waits with a yielded turn.
 *
 * `sleep` ends the turn on a native timer and wakes the exact owner when it
 * fires. `timeout` is a watchdog over ongoing work. Both act inside the
 * calling Agent's own context; the root session and every delegated child keep
 * separate timer sets.
 *
 * The shell interception is fail-open: a pure `bash sleep` is replaced only
 * while the live bash output contract still accepts the synthetic result.
 * Otherwise the shell runs untouched.
 *
 * @module sleep-plugin-dsh
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import { normalizeConfig } from './config.js';
import { registerInterceptor, shellCwd } from './intercept.js';
import { cancelledMessage, formatDuration, placeholderMessage, wakeMessage } from './messages.js';
import { WaitStore } from './store.js';

export const name = 'sleep-plugin-dsh';

/** The tools registry is the only hard dependency; everything else degrades. */
export const inject = ['tools'];

/** Prompt section placement, after the background-job guidance. */
const SECTION_ORDER = 1650;
const SECTION = 'tool:sleep';

/** Shared mode vocabulary for a sleep result. */
const SLEEP_MODES = ['yield', 'block', 'blocked-goal', 'blocked-host', 'cancelled', 'aborted'];

/**
 * Whether an agent is a delegated child.
 * @param agent - live agent.
 * @returns true above delegation depth zero.
 */
function isSubagent(agent) {
  try {
    const depth = agent.session?.header?.delegationDepth ?? agent.options?.subagentDepth ?? 0;
    return Number.isSafeInteger(depth) && depth > 0;
  } catch {
    return false;
  }
}

/**
 * Whether an armed active goal would consume an idle round.
 * @param ctx - plugin context.
 * @param agent - live agent.
 * @returns true while the goal driver would reopen the turn.
 */
function goalArmed(ctx, agent) {
  try {
    const goal = ctx.get('goals')?.get(agent);
    return goal?.phase === 'active' && goal.activation === 'armed';
  } catch {
    return false;
  }
}

/**
 * Whether the host exposes the yield primitives on this execution.
 * @param agent - live agent.
 * @param exec - tool or dispatch execution.
 * @returns true when concludeTurn, followup, inject, and maintenance exist.
 */
function hostCanYield(agent, exec) {
  return (
    typeof exec.concludeTurn === 'function' &&
    typeof agent.followup === 'function' &&
    typeof agent.inject === 'function' &&
    typeof agent.runMaintenance === 'function' &&
    typeof agent.status === 'string'
  );
}

/**
 * Resolve one call's delivery mode.
 * @param ctx - plugin context.
 * @param config - normalized config.
 * @param agent - live agent.
 * @param exec - execution.
 * @returns whether to yield and the reported mode.
 */
function modeFor(ctx, config, agent, exec) {
  if (!config.yieldByDefault) return { deliver: false, mode: 'block' };
  if (!hostCanYield(agent, exec)) return { deliver: false, mode: 'blocked-host' };
  if (config.goalMode === 'block' && goalArmed(ctx, agent)) return { deliver: false, mode: 'blocked-goal' };
  return { deliver: true, mode: 'yield' };
}

/**
 * Require the calling agent.
 * @param exec - execution.
 * @returns the live agent.
 */
function requireAgent(exec) {
  if (exec.agent === undefined) throw new Error('native waits require a live agent');
  return exec.agent;
}

/**
 * Validate one duration against the mount limit.
 * @param ms - model-supplied milliseconds.
 * @param maxMs - mount limit.
 * @returns the accepted duration.
 */
function validateMs(ms, maxMs) {
  if (!Number.isSafeInteger(ms) || ms < 1) throw new Error('ms must be a positive whole number');
  if (ms > maxMs) throw new Error(`ms must not exceed ${maxMs}`);
  return ms;
}

/**
 * Wire the plugin.
 * @param ctx - Cordis context of the profile row.
 * @param rawConfig - optional row config.
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  const logger = ctx.logger;
  const disposers = [];

  /**
   * Whether one agent is still the registry's live instance.
   * @param agent - stored owner.
   * @returns true while it is live.
   */
  function isLive(agent) {
    try {
      const agents = ctx.get('agents');
      return agents === undefined || agents.get(agent.id) === agent;
    } catch {
      return true;
    }
  }

  const store = new WaitStore({
    maxPendingPerAgent: config.maxPendingPerAgent,
    wakeOnInput: config.wakeOnInput,
    now: Date.now,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (timer) => clearTimeout(timer),
    logger,
    deliver(wait) {
      if (!isLive(wait.agent)) return;
      const pending = store
        .list(wait.agent)
        .map((item) => item.id)
        .filter((id) => id !== wait.id);
      const message = wakeMessage(wait, pending);
      if (wait.kind === 'timeout' && wait.agent.status !== 'idle') wait.agent.inject(message);
      else wait.agent.followup(message);
    },
    placeholder(agent, wait) {
      if (!isSubagent(agent)) return undefined;
      const message = placeholderMessage(wait);
      agent.inject(message);
      return message.id;
    },
    removePlaceholder(agent, id) {
      agent.inbox?.remove(id);
    },
    onAborted(agent, ids) {
      if (!isLive(agent)) return;
      agent.inject(cancelledMessage(ids));
    },
  });

  /**
   * Start one wait and, on a yield, conclude the turn.
   * @param kind - wait kind.
   * @param agent - exact owner.
   * @param ms - duration.
   * @param reason - optional label.
   * @param exec - execution that may conclude.
   * @param deliver - whether firing wakes the owner.
   * @returns the started wait.
   */
  function beginWait(kind, agent, ms, reason, exec, deliver) {
    const wait = store.start({ kind, agent, ms, reason, deliver });
    if (deliver) {
      try {
        exec.concludeTurn();
      } catch (error) {
        store.cancel(agent, wait.id);
        throw error;
      }
    }
    return wait;
  }

  /**
   * Wait for settlement of a blocking call.
   * @param wait - started wait.
   * @param signal - caller cancellation.
   * @returns the terminal status.
   */
  function waitFor(wait, signal) {
    return new Promise((resolve) => {
      const finish = (outcome) => {
        signal.removeEventListener('abort', abort);
        resolve(outcome);
      };
      const abort = () => {
        finish({ status: 'aborted' });
        store.cancel(wait.agent, wait.id);
      };
      wait.waiters.push(finish);
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  }

  // ---- lifecycle listeners -------------------------------------------------
  disposers.push(
    ctx.on('agent/status', ({ agent, status }) => store.onStatus(agent, status), { global: true }),
    ctx.on('agent/inbox/inserted', ({ agent, message }) => store.onInserted(agent, message), { global: true }),
    ctx.on('agent/disposed', ({ agent }) => store.disposeAgent(agent), { global: true }),
  );

  // A delegated run that submits its structured result is done: pending
  // watchdogs would only delay the parent's settlement.
  disposers.push(
    ctx.on(
      'tools/pre-execute',
      (exec, next) => {
        if (exec.name === 'structured_output' && exec.agent !== undefined) store.cancelKind(exec.agent, 'timeout');
        return next();
      },
      { global: true },
    ),
  );

  // ---- tools ---------------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: 'sleep',
      description:
        'Wait on a native timer and end this turn. The turn stops immediately; when the timer fires, a wake message reopens this same agent and session so the paused task continues. Use it instead of shell sleep. Blocked while an armed goal is active. Returns an id for sleep_cancel.',
      parameters: {
        ms: { type: 'integer', required: true, description: 'Wait duration in milliseconds.' },
        reason: { type: 'string', description: 'Optional one-line note echoed in the wake.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            kind: { type: 'string', required: true, const: 'sleep' },
            ms: { type: 'integer', required: true },
            wakeAt: { type: 'integer', required: true },
            mode: { type: 'string', required: true, enum: SLEEP_MODES },
            reason: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const label = `sleep ${formatDuration(value.ms)} (${value.id})`;
          if (value.mode === 'yield') {
            return [
              {
                type: 'text',
                text: `${label}; the turn ends now and a wake message reopens this session at ${new Date(value.wakeAt).toISOString()}.`,
              },
            ];
          }
          if (value.mode === 'aborted') return [{ type: 'text', text: `${label}; cancelled with the turn.` }];
          if (value.mode === 'cancelled')
            return [{ type: 'text', text: `${label}; cancelled before the timer fired.` }];
          if (value.mode === 'block') return [{ type: 'text', text: `${label}; blocking wait completed.` }];
          const why = value.mode === 'blocked-goal' ? 'an armed goal is active' : 'this host cannot yield';
          return [{ type: 'text', text: `${label}; blocked because ${why}.` }];
        },
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const agent = requireAgent(exec);
        const ms = validateMs(args.ms, config.maxMs);
        const { deliver, mode } = modeFor(ctx, config, agent, exec);
        const wait = beginWait('sleep', agent, ms, args.reason, exec, deliver);
        const tagged = args.reason === undefined ? {} : { reason: args.reason };
        if (deliver) return { id: wait.id, kind: 'sleep', ms, wakeAt: wait.wakeAt, mode, ...tagged };
        const outcome = await waitFor(wait, exec.signal);
        return {
          id: wait.id,
          kind: 'sleep',
          ms,
          wakeAt: wait.wakeAt,
          mode: outcome.status === 'aborted' ? 'aborted' : outcome.status === 'cancelled' ? 'cancelled' : mode,
          ...tagged,
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'timeout',
      description:
        'Arm a watchdog for the current work. Does not end the turn: when it fires, a notice is injected at the next step, or the agent is woken if idle. Cancel it with sleep_cancel when the work finishes. Unlike sleep, it pauses nothing.',
      parameters: {
        ms: { type: 'integer', required: true, description: 'Watchdog duration in milliseconds.' },
        reason: { type: 'string', description: 'Optional one-line note echoed in the notice.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            kind: { type: 'string', required: true, const: 'timeout' },
            ms: { type: 'integer', required: true },
            wakeAt: { type: 'integer', required: true },
            reason: { type: 'string' },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `timeout ${formatDuration(value.ms)} armed (${value.id}); the notice arrives when it fires. Cancel with sleep_cancel.`,
          },
        ],
      },
      isConcurrencySafe: () => true,
      execute(args, exec) {
        const agent = requireAgent(exec);
        const ms = validateMs(args.ms, config.maxMs);
        const wait = store.start({ kind: 'timeout', agent, ms, reason: args.reason, deliver: true });
        return Promise.resolve({
          id: wait.id,
          kind: 'timeout',
          ms,
          wakeAt: wait.wakeAt,
          ...(args.reason === undefined ? {} : { reason: args.reason }),
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'sleep_list',
      description: "List this agent's pending native sleeps and timeouts.",
      parameters: {},
      output: {
        schema: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              kind: { type: 'string', required: true },
              remainingMs: { type: 'integer', required: true },
              reason: { type: 'string' },
            },
          },
        },
        render: (_args, value) =>
          value.length === 0
            ? [{ type: 'text', text: '(no pending waits)' }]
            : [
                {
                  type: 'text',
                  text: value
                    .map((item) => `${item.id} [${item.kind}] ${formatDuration(item.remainingMs)} left`)
                    .join('\n'),
                },
              ],
      },
      execute(_args, exec) {
        return Promise.resolve(store.list(requireAgent(exec)));
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'sleep_cancel',
      description: 'Cancel one pending wait by id, or every pending wait of this agent when the id is omitted.',
      parameters: {
        id: { type: 'string', description: 'Wait id from sleep, timeout, or sleep_list.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            cancelled: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              value.cancelled.length === 0 ? 'no matching pending wait' : `cancelled: ${value.cancelled.join(', ')}`,
          },
        ],
      },
      execute(args, exec) {
        return Promise.resolve({ cancelled: store.cancel(requireAgent(exec), args.id) });
      },
    }),
  );

  // ---- prompt guidance -----------------------------------------------------
  ctx.effect(() =>
    ctx.inject(['systemPrompt'], (scope) =>
      scope.systemPrompt.section({
        name: SECTION,
        order: SECTION_ORDER,
        text: config.denyShellWaits
          ? 'Never run `sleep` or `timeout` in bash: such calls are denied. Wait with the `sleep` tool (the turn yields and a wake message reopens it). Bound a command with the bash `timeoutMs` argument. To poll, run one check per bash call with a `sleep` tool call between checks, or use `run_in_background` and wait for the job notice. Use the `timeout` tool as a watchdog during work and cancel it with `sleep_cancel` when done. In delegated runs, call `sleep` before `structured_output`. A user message or a completed background job wakes you early; cancel a wait that no longer matters.'
          : 'Prefer the `sleep` tool over `bash sleep`: the turn yields and a wake message reopens it. Use `timeout` as a watchdog during work and cancel it with `sleep_cancel` when done. In delegated runs, call `sleep` before `structured_output`. A user message or a completed background job wakes you early; cancel a wait that no longer matters.',
      }),
    ),
  );

  // ---- /sleep command ------------------------------------------------------
  ctx.effect(() =>
    ctx.inject(['commands'], (scope) =>
      scope.commands.register({
        name: 'sleep',
        description: "List or cancel this session's native sleeps and timeouts",
        input: { hint: 'list · cancel [id]' },
        handler: ({ agent, rawInput }) => {
          const text = String(rawInput ?? '')
            .trim()
            .replace(/^\/sleep\b/i, '')
            .trim();
          const [verb = '', ...rest] = text.split(/\s+/);
          const action = verb.toLowerCase();
          if (action === '' || action === 'list' || action === 'status') {
            const waits = store.list(agent);
            if (waits.length === 0) return { kind: 'success', text: 'no pending waits.' };
            return {
              kind: 'success',
              text: waits
                .map((wait) => `${wait.id} [${wait.kind}] ${formatDuration(wait.remainingMs)} left`)
                .join('\n'),
            };
          }
          if (action === 'cancel') {
            const cancelled = store.cancel(agent, rest[0]);
            return {
              kind: cancelled.length === 0 ? 'error' : 'success',
              text: cancelled.length === 0 ? 'no matching pending wait.' : `cancelled: ${cancelled.join(', ')}`,
            };
          }
          return { kind: 'error', text: `unknown option "${action}" — /sleep for the list.` };
        },
      }),
    ),
  );

  // ---- shell interception --------------------------------------------------
  disposers.push(
    registerInterceptor(ctx, {
      config,
      logger,
      beginWait,
      waitFor,
      modeFor: (agent, exec) => modeFor(ctx, config, agent, exec),
      cwdFor: (agent, workdir) => shellCwd(ctx, agent, workdir),
    }),
  );

  // ---- cleanup -------------------------------------------------------------
  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose?.();
      } catch {
        /* already released */
      }
    }
    store.disposeAll();
  });
}
