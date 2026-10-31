/**
 * Fail-open shell interception.
 *
 * A pure `sleep` becomes the native wait, but only when the live bash output
 * contract accepts the synthetic result. Any doubt falls back to `next()`, so
 * a host upgrade can never break the shell path.
 *
 * @module sleep-plugin-dsh/intercept
 */

import { resolve } from 'node:path';

import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';

import { formatDuration } from './messages.js';
import { parseShellWait } from './parse.js';

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
 * Register the `tools/execute` wrapper.
 * @param ctx - plugin context.
 * @param deps - config, store, wait helpers, and cwd resolution.
 * @returns the exact disposer.
 */
export function registerInterceptor(ctx, deps) {
  const seen = new WeakMap();

  /**
   * Run one intercepted call or fall back to the shell.
   * @param exec - dispatched bash execution.
   * @param next - shell dispatch.
   * @returns the normalized outcome.
   */
  async function run(exec, next) {
    try {
      const args = exec.arguments;
      if (args === null || typeof args !== 'object' || typeof args.command !== 'string') return next();
      if (args.run_in_background === true) return next();
      if (args.sandbox_permissions !== undefined) return next();
      const plan = parseShellWait(args.command);
      if (plan === undefined || plan.ms > deps.config.maxMs) return next();
      if (typeof args.timeoutMs === 'number' && args.timeoutMs < plan.ms) return next();
      const schema = ctx.tools.get('bash', exec.agent)?.output?.schema;
      if (schema === undefined) return next();
      const { deliver, mode } = deps.modeFor(exec.agent, exec);
      const value = shellValue(deps.cwdFor(exec.agent, args.workdir), plan);
      if (validateJsonSchemaValue(schema, value).length > 0) return next();
      let wait;
      try {
        wait = deps.beginWait(plan.kind, exec.agent, plan.ms, 'bash', exec, deliver);
      } catch {
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

  return ctx.on(
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
  );
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
