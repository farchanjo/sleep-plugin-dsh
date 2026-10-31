/**
 * Shell wait policy: replace what can be replaced, deny the rest.
 *
 * A pure `sleep` becomes the native wait, but only when the live bash output
 * contract accepts the synthetic result. Any other bash command that would run
 * `sleep` or `timeout` is denied before dispatch with a pointer to the native
 * tools, so a loaded plugin never lets the shell wait. Internal failures stay
 * fail-open: a scanner or lookup error lets the call through.
 *
 * @module sleep-plugin-dsh/intercept
 */

import { resolve } from 'node:path';

import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';

import { formatDuration } from './messages.js';
import { parseShellWait } from './parse.js';
import { findShellWaits } from './scan.js';

/** Structured identity of a policy denial. */
const DENIED_INFO = Object.freeze({ name: 'ShellWaitDenied', code: 'SHELL_WAIT_DENIED' });

/**
 * Compose the model-facing denial for the waits a command would run.
 * @param found - `sleep`, `timeout`, or both.
 * @returns the denial reason.
 */
export function denialReason(found) {
  const parts = [];
  if (found.includes('sleep')) {
    parts.push(
      'shell `sleep` is blocked; call the `sleep` tool to wait (the turn yields and a wake message resumes this session). To poll, run one check per bash call with a `sleep` tool call between checks, or start long work with `run_in_background: true` and wait for the job notice',
    );
  }
  if (found.includes('timeout')) {
    parts.push(
      'shell `timeout` is blocked; bound the command with the bash `timeoutMs` argument instead, and arm the `timeout` tool for a watchdog',
    );
  }
  return `sleep-plugin-dsh: ${parts.join('. Also, ')}. Rerun the command without the shell wait; do not emulate it with another interpreter.`;
}

/**
 * Build a failed bash outcome for a native wait that could not start.
 * @param message - model-facing reason.
 * @returns a canonical tool failure.
 */
function failure(message) {
  return {
    isError: true,
    error: { message, info: DENIED_INFO },
    content: [{ type: 'text', text: `Error: ${message}` }],
  };
}

/**
 * Build the foreground value the bash tool's own renderer consumes.
 * @param cwd - resolved working directory.
 * @param plan - parsed wait.
 * @returns a shape matching the shipped bash output union.
 */
function shellValue(cwd, plan) {
  const timedOut = plan.kind === 'timeout';
  return {
    kind: 'foreground',
    cwd,
    exitCode: timedOut ? 124 : 0,
    signal: null,
    timedOut,
    aborted: false,
    timeoutMs: timedOut ? plan.outerMs : 0,
    stdout: { text: '', truncated: false },
    stderr: { text: '', truncated: false },
  };
}

/**
 * Compose the model-facing result text.
 * @param wait - started wait.
 * @param plan - parsed wait.
 * @param mode - yield or degraded mode.
 * @returns the result text.
 */
function resultText(wait, plan, mode) {
  const duration = formatDuration(plan.ms);
  const head =
    plan.kind === 'timeout'
      ? `[native sleep ${duration} (${wait.id}): the shell timeout hit before the requested ${formatDuration(plan.requestedMs)}`
      : `[native sleep ${duration} (${wait.id})`;
  const tail =
    mode === 'yield'
      ? '; turn yielded; a wake message reopens this session]'
      : mode === 'aborted'
        ? '; cancelled with the turn]'
        : mode === 'cancelled'
          ? '; cancelled before the timer fired]'
          : mode === 'blocked-goal'
            ? '; blocked because a goal is active]'
            : mode === 'blocked-host'
              ? '; blocked because this host cannot yield]'
              : ']';
  return `${head}${tail}`;
}

/**
 * Read the bash command string of one call.
 * @param exec - tool execution.
 * @returns the command, or undefined for malformed arguments.
 */
function commandOf(exec) {
  const args = exec.arguments;
  if (args === null || typeof args !== 'object' || typeof args.command !== 'string') return undefined;
  return args.command;
}

/**
 * Register the `tools/pre-execute` gate and the `tools/execute` wrapper.
 * @param ctx - plugin context.
 * @param deps - config, store, wait helpers, and cwd resolution.
 * @returns one disposer for both listeners.
 */
export function registerInterceptor(ctx, deps) {
  const seen = new WeakMap();

  /**
   * Plan the native replacement of one call, when the call is a pure wait the
   * live bash contract can represent.
   * @param exec - bash execution, pre-dispatch or dispatched.
   * @returns the parsed wait and its synthetic value, or undefined.
   */
  function interceptPlan(exec) {
    if (!deps.config.interceptShell) return undefined;
    const args = exec.arguments;
    if (commandOf(exec) === undefined) return undefined;
    if (args.run_in_background === true) return undefined;
    if (args.sandbox_permissions !== undefined) return undefined;
    const plan = parseShellWait(args.command);
    if (plan === undefined || plan.ms > deps.config.maxMs) return undefined;
    if (typeof args.timeoutMs === 'number' && args.timeoutMs < plan.ms) return undefined;
    const schema = ctx.tools.get('bash', exec.agent)?.output?.schema;
    if (schema === undefined) return undefined;
    const value = shellValue(deps.cwdFor(exec.agent, args.workdir), plan);
    if (validateJsonSchemaValue(schema, value).length > 0) return undefined;
    return { plan, value };
  }

  /**
   * Run one intercepted call or fall back to the shell.
   * @param exec - dispatched bash execution.
   * @param next - shell dispatch.
   * @returns the normalized outcome.
   */
  async function run(exec, next) {
    try {
      const planned = interceptPlan(exec);
      if (planned === undefined) return next();
      const { plan, value } = planned;
      const { deliver, mode } = deps.modeFor(exec.agent, exec);
      let wait;
      try {
        wait = deps.beginWait(plan.kind, exec.agent, plan.ms, 'bash', exec, deliver);
      } catch (error) {
        // The gate already let this pure wait through; the shell must not
        // run it instead while waits are denied.
        if (deps.config.denyShellWaits) {
          return failure(`sleep-plugin-dsh: the native wait could not start: ${error?.message ?? error}`);
        }
        return next();
      }
      if (plan.kind === 'timeout') {
        wait.hit = true;
        wait.requestedMs = plan.requestedMs;
      }
      value.stdout.text = resultText(wait, plan, mode);
      if (!deliver) {
        const outcome = await deps.waitFor(wait, exec.signal);
        const finalMode =
          outcome.status === 'aborted' ? 'aborted' : outcome.status === 'cancelled' ? 'cancelled' : mode;
        value.stdout.text = resultText(wait, plan, finalMode);
        if (outcome.status === 'aborted') {
          value.aborted = true;
          value.exitCode = null;
        } else if (outcome.status === 'cancelled') {
          value.exitCode = null;
        }
      }
      return { isError: false, value };
    } catch (error) {
      deps.logger?.warn?.(`sleep-plugin-dsh: shell interception fell back: ${error?.message ?? error}`);
      return next();
    }
  }

  /**
   * Deny a bash call that would run a shell wait the wrapper cannot replace.
   * @param exec - pending bash execution.
   * @param next - the rest of the pre-dispatch chain.
   * @returns the decision.
   */
  function gate(exec, next) {
    if (!deps.config.denyShellWaits) return next();
    if (exec.name !== 'bash' || exec.agent === undefined) return next();
    try {
      const command = commandOf(exec);
      if (command === undefined) return next();
      if (interceptPlan(exec) !== undefined) return next();
      const found = findShellWaits(command);
      if (found.length === 0) return next();
      return Promise.resolve({ kind: 'deny', reason: denialReason(found), info: { ...DENIED_INFO } });
    } catch (error) {
      deps.logger?.warn?.(`sleep-plugin-dsh: shell wait gate fell back: ${error?.message ?? error}`);
      return next();
    }
  }

  const disposers = [
    ctx.on('tools/pre-execute', gate, { global: true }),
    ctx.on(
      'tools/execute',
      (exec, next) => {
        if (!deps.config.interceptShell) return next();
        if (exec.name !== 'bash' || exec.agent === undefined) return next();
        const cached = seen.get(exec);
        if (cached !== undefined) return cached;
        const promise = run(exec, next);
        seen.set(exec, promise);
        return promise;
      },
      { global: true },
    ),
  ];
  return () => {
    for (const dispose of disposers) dispose?.();
  };
}

/**
 * Resolve the working directory an intercepted call would use.
 * @param ctx - plugin context.
 * @param agent - calling agent.
 * @param workdir - optional per-call override.
 * @returns an absolute directory string.
 */
export function shellCwd(ctx, agent, workdir) {
  let base = process.cwd();
  try {
    base = ctx.get('workingDirectory')?.get(agent.session) ?? agent.session?.header?.cwd ?? base;
  } catch {
    /* keep the process directory */
  }
  if (typeof workdir === 'string' && workdir !== '') {
    try {
      return resolve(base, workdir);
    } catch {
      /* keep the base */
    }
  }
  return base;
}
