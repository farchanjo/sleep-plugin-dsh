import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';

import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';

import { apply } from '../lib/index.js';

/** Standard JSON Schema matching the shipped bash foreground union. */
const BASH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'cwd', 'exitCode', 'signal', 'timedOut', 'aborted', 'timeoutMs', 'stdout', 'stderr'],
  properties: {
    kind: { type: 'string', const: 'foreground' },
    cwd: { type: 'string' },
    exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    timedOut: { type: 'boolean' },
    aborted: { type: 'boolean' },
    timeoutMs: { type: 'number' },
    stdout: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'truncated'],
      properties: { text: { type: 'string' }, truncated: { type: 'boolean' } },
    },
    stderr: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'truncated'],
      properties: { text: { type: 'string' }, truncated: { type: 'boolean' } },
    },
  },
};

/** Schema that rejects the foreground kind. */
const WRONG_SCHEMA = {
  type: 'object',
  required: ['kind'],
  properties: { kind: { type: 'string', const: 'background' } },
  additionalProperties: true,
};

/**
 * Minimal Cordis context with the exact surfaces the plugin touches.
 * @param options - schema, lookup, and cwd overrides.
 * @returns harness handles.
 */
function harness(options = {}) {
  const handlers = new Map();
  const tools = new Map();
  const sections = [];
  const commands = new Map();
  const effects = [];
  const agents = new Map();
  const goals = new Map();
  const warnings = [];
  const lookedUp = [];
  const scope = {
    systemPrompt: {
      section(definition) {
        sections.push(definition);
        return () => {};
      },
    },
    commands: {
      register(definition) {
        commands.set(definition.name, definition);
        return () => commands.delete(definition.name);
      },
    },
  };
  const ctx = {
    logger: { warn: (message) => warnings.push(String(message)) },
    get(name) {
      if (name === 'agents') return { get: (id) => agents.get(id) };
      if (name === 'goals') return { get: (agent) => goals.get(agent) };
      if (name === 'workingDirectory') return { get: () => options.cwd ?? '/tmp/work' };
      return undefined;
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
      },
      get(name, agent) {
        lookedUp.push({ name, agent });
        if (name !== 'bash' || options.noBash === true) return undefined;
        return { output: { schema: options.schema ?? BASH_SCHEMA } };
      },
    },
    inject(_deps, fn) {
      const disposer = fn(scope);
      return () => disposer?.();
    },
    effect(fn) {
      const disposer = fn();
      effects.push(disposer);
      return disposer;
    },
  };
  return { ctx, handlers, tools, sections, commands, effects, agents, goals, warnings, lookedUp, scope };
}

/**
 * Fake Agent with the lifecycle primitives the plugin uses.
 * @param id - session identity.
 * @returns the fake agent.
 */
function agentOf(id) {
  const delivered = [];
  const agent = {
    id,
    status: 'running',
    options: {},
    session: { header: { cwd: '/tmp/work', delegationDepth: 0 } },
    delivered,
    maintenanceActive: false,
    inbox: {
      nextTurn: [],
      nextStep: [],
      remove(messageId) {
        for (const list of [agent.inbox.nextTurn, agent.inbox.nextStep]) {
          const index = list.findIndex((message) => message.id === messageId);
          if (index >= 0) {
            list.splice(index, 1);
            return true;
          }
        }
        return false;
      },
    },
    followup(message) {
      delivered.push(['followup', message]);
      agent.inbox.nextTurn.push(message);
      agent.status = 'running';
    },
    inject(message) {
      delivered.push(['inject', message]);
      agent.inbox.nextStep.push(message);
    },
    runMaintenance(task) {
      const abort = new AbortController();
      agent.maintenanceActive = true;
      return Promise.resolve(task(abort.signal)).finally(() => {
        agent.maintenanceActive = false;
      });
    },
  };
  return agent;
}

/**
 * Build a bash dispatch execution.
 * @param agent - calling agent.
 * @param args - bash arguments.
 * @returns execution with a concludeTurn counter and abort signal.
 */
function execOf(agent, args) {
  return {
    name: 'bash',
    arguments: args,
    agent,
    signal: new AbortController().signal,
    calls: 0,
    concludeTurn() {
      this.calls += 1;
    },
  };
}

/** Shell fallback outcome and call counter. */
function shellNext() {
  const next = function nextWithCount() {
    next.calls += 1;
    return { isError: false, value: { shell: true }, content: [] };
  };
  next.calls = 0;
  return next;
}

let cleanup;

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  cleanup = undefined;
});

afterEach(() => {
  try {
    cleanup?.();
  } catch {
    /* already disposed */
  }
  mock.timers.reset();
});

/**
 * Boot one plugin instance.
 * @param config - row config.
 * @param options - harness options.
 * @returns harness and the interception handler.
 */
function boot(config = {}, options = {}) {
  const h = harness(options);
  apply(h.ctx, config);
  cleanup = h.effects.at(-1);
  const handler = h.handlers.get('tools/execute')?.[0];
  assert.ok(handler, 'interception handler is registered');
  return { h, handler };
}

test('a pure bash sleep is replaced and yields', async () => {
  const { h, handler } = boot();
  const a = agentOf('a');
  h.agents.set('a', a);
  const exec = execOf(a, { command: 'sleep 5' });
  const next = shellNext();

  const result = await handler(exec, next);

  assert.equal(next.calls, 0);
  assert.equal(exec.calls, 1);
  assert.equal(result.isError, false);
  assert.equal(result.value.kind, 'foreground');
  assert.equal(result.value.timedOut, false);
  assert.match(result.value.stdout.text, /native sleep 5\.0s \(sleep-/);
  assert.deepEqual(validateJsonSchemaValue(BASH_SCHEMA, result.value), []);

  mock.timers.tick(5000);
  assert.equal(a.delivered.length, 1);
  assert.equal(a.delivered[0][0], 'followup');
});

/**
 * Run the `tools/pre-execute` waterfall the way the registry composes it.
 * @param h - harness.
 * @param exec - pending execution.
 * @returns the decision and how often the chain reached its end.
 */
async function preExecute(h, exec) {
  const listeners = h.handlers.get('tools/pre-execute') ?? [];
  let allowed = 0;
  const step = (index) => {
    if (index >= listeners.length) {
      allowed += 1;
      return Promise.resolve({ kind: 'allow' });
    }
    return Promise.resolve(listeners[index](exec, () => step(index + 1)));
  };
  const decision = await step(0);
  return { decision, allowed };
}

test('the gate denies shell waits the wrapper cannot replace', async () => {
  const cases = [
    [{ command: 'sleep 5 && echo ok' }, /shell `sleep` is blocked/],
    [{ command: 'for i in 1 2; do curl x; sleep 2; done' }, /shell `sleep` is blocked/],
    [{ command: 'timeout 10 curl x' }, /shell `timeout` is blocked.*timeoutMs/],
    [{ command: 'timeout 5 x; sleep 1' }, /`sleep` is blocked.*Also, shell `timeout` is blocked/],
    [{ command: 'sleep 5', run_in_background: true }, /`sleep` tool/],
    [{ command: 'sleep 5', sandbox_permissions: 'danger-full-access' }, /`sleep` tool/],
    [{ command: 'sleep 5', timeoutMs: 1000 }, /`sleep` tool/],
    [{ command: 'sleep 999999999' }, /`sleep` tool/],
  ];
  for (const [args, reason] of cases) {
    const { h } = boot();
    const a = agentOf('a');
    h.agents.set('a', a);

    const { decision, allowed } = await preExecute(h, execOf(a, args));

    assert.equal(allowed, 0, JSON.stringify(args));
    assert.equal(decision.kind, 'deny');
    assert.match(decision.reason, reason);
    assert.deepEqual(decision.info, { name: 'ShellWaitDenied', code: 'SHELL_WAIT_DENIED' });
    cleanup();
    cleanup = undefined;
  }
});

test('the gate allows replaceable waits and commands without waits', async () => {
  const cases = [
    { command: 'sleep 5' },
    { command: 'timeout 10 sleep 60' },
    { command: 'grep -rn sleep lib/' },
    { command: 'echo "timeout 5"' },
    { command: 'npm test', timeoutMs: 60_000 },
  ];
  for (const args of cases) {
    const { h } = boot();
    const a = agentOf('a');
    h.agents.set('a', a);

    const { decision, allowed } = await preExecute(h, execOf(a, args));

    assert.equal(allowed, 1, JSON.stringify(args));
    assert.equal(decision.kind, 'allow');
    cleanup();
    cleanup = undefined;
  }
});

test('the gate denies a pure wait the wrapper would not replace', async () => {
  const variants = [
    [{ interceptShell: false }, {}],
    [{}, { schema: WRONG_SCHEMA }],
    [{}, { noBash: true }],
  ];
  for (const [config, options] of variants) {
    const { h } = boot(config, options);
    const a = agentOf('a');
    h.agents.set('a', a);

    const { decision } = await preExecute(h, execOf(a, { command: 'sleep 5' }));

    assert.equal(decision.kind, 'deny', JSON.stringify({ config, options }));
    cleanup();
    cleanup = undefined;
  }
});

test('the gate ignores other tools, missing agents, and denyShellWaits false', async () => {
  const { h } = boot();
  const a = agentOf('a');
  h.agents.set('a', a);

  const other = await preExecute(h, { ...execOf(a, { command: 'sleep 5 && x' }), name: 'pwsh' });
  assert.equal(other.decision.kind, 'allow');
  const orphan = await preExecute(h, { ...execOf(a, { command: 'sleep 5 && x' }), agent: undefined });
  assert.equal(orphan.decision.kind, 'allow');
  cleanup();
  cleanup = undefined;

  const off = boot({ denyShellWaits: false });
  const b = agentOf('b');
  off.h.agents.set('b', b);
  const allowed = await preExecute(off.h, execOf(b, { command: 'sleep 5 && echo ok' }));
  assert.equal(allowed.decision.kind, 'allow');
  assert.doesNotMatch(off.h.sections.at(-1).text, /denied/);
});

test('a denying gate tells the model in the prompt section', () => {
  const { h } = boot();
  assert.match(h.sections.at(-1).text, /Never run `sleep` or `timeout` in bash/);
  assert.match(h.sections.at(-1).text, /timeoutMs/);
});

test('a pure wait over the pending cap fails instead of reaching the shell', async () => {
  const { h, handler } = boot({ maxPendingPerAgent: 1 });
  const a = agentOf('a');
  h.agents.set('a', a);
  await handler(execOf(a, { command: 'sleep 5' }), shellNext());

  const next = shellNext();
  const result = await handler(execOf(a, { command: 'sleep 5' }), next);

  assert.equal(next.calls, 0);
  assert.equal(result.isError, true);
  assert.equal(result.error.info.code, 'SHELL_WAIT_DENIED');
  assert.match(result.content[0].text, /^Error: sleep-plugin-dsh: the native wait could not start/);
});

test('without the deny policy a pure wait over the cap reaches the shell', async () => {
  const { h, handler } = boot({ maxPendingPerAgent: 1, denyShellWaits: false });
  const a = agentOf('a');
  h.agents.set('a', a);
  await handler(execOf(a, { command: 'sleep 5' }), shellNext());

  const next = shellNext();
  const result = await handler(execOf(a, { command: 'sleep 5' }), next);

  assert.equal(next.calls, 1);
  assert.deepEqual(result.value, { shell: true });
});

test('cleanup removes the gate', () => {
  const { h } = boot();
  const before = h.handlers.get('tools/pre-execute').length;
  cleanup();
  cleanup = undefined;
  assert.equal(h.handlers.get('tools/pre-execute').length, before - 2);
});

test('the dispatch wrapper leaves forms outside the exact grammar to the next stage', async () => {
  const cases = [
    { command: 'sleep 5 && echo ok' },
    { command: 'timeout 10 curl x' },
    { command: 'sleep 5', run_in_background: true },
    { command: 'sleep 5', sandbox_permissions: 'danger-full-access' },
    { command: 'sleep 5', timeoutMs: 1000 },
  ];
  for (const args of cases) {
    const { h, handler } = boot();
    const a = agentOf('a');
    h.agents.set('a', a);
    const exec = execOf(a, args);
    const next = shellNext();

    const result = await handler(exec, next);

    assert.equal(next.calls, 1, JSON.stringify(args));
    assert.deepEqual(result.value, { shell: true });
    assert.equal(exec.calls, 0);
    cleanup();
    cleanup = undefined;
  }
});

test('an incompatible live schema falls back', async () => {
  const { h, handler } = boot({}, { schema: WRONG_SCHEMA });
  const a = agentOf('a');
  h.agents.set('a', a);
  const exec = execOf(a, { command: 'sleep 5' });
  const next = shellNext();

  const result = await handler(exec, next);

  assert.equal(next.calls, 1);
  assert.equal(exec.calls, 0);
  assert.deepEqual(result.value, { shell: true });
});

test('a missing bash lookup falls back', async () => {
  const { h, handler } = boot({}, { noBash: true });
  const a = agentOf('a');
  h.agents.set('a', a);
  const exec = execOf(a, { command: 'sleep 5' });
  const next = shellNext();

  const result = await handler(exec, next);

  assert.equal(next.calls, 1);
  assert.deepEqual(result.value, { shell: true });
});

test('timeout 10 sleep 60 fires at 10s with a timeout result', async () => {
  const { h, handler } = boot();
  const a = agentOf('a');
  h.agents.set('a', a);
  const exec = execOf(a, { command: 'timeout 10 sleep 60' });
  const next = shellNext();

  const result = await handler(exec, next);

  assert.equal(next.calls, 0);
  assert.equal(exec.calls, 1);
  assert.equal(result.value.timedOut, true);
  assert.equal(result.value.exitCode, 124);
  assert.equal(result.value.timeoutMs, 10_000);
  assert.deepEqual(validateJsonSchemaValue(BASH_SCHEMA, result.value), []);

  a.status = 'idle';
  for (const listener of h.handlers.get('agent/status') ?? []) listener({ agent: a, status: 'idle' });
  mock.timers.tick(10_000);
  assert.equal(a.delivered.length, 1);
  assert.equal(a.delivered[0][0], 'followup');
  assert.match(a.delivered[0][1].content[0].text, /Shell timeout hit/);
  assert.match(a.delivered[0][1].content[0].text, /60s/);

  mock.timers.tick(60_000);
  assert.equal(a.delivered.length, 1);
});

test('timeout 10 sleep 5 keeps the success shape', async () => {
  const { h, handler } = boot();
  const a = agentOf('a');
  h.agents.set('a', a);
  const exec = execOf(a, { command: 'timeout 10 sleep 5' });
  const next = shellNext();

  const result = await handler(exec, next);

  assert.equal(result.value.timedOut, false);
  assert.equal(result.value.exitCode, 0);
  assert.deepEqual(validateJsonSchemaValue(BASH_SCHEMA, result.value), []);

  mock.timers.tick(5000);
  assert.equal(a.delivered.length, 1);
});

test('interceptShell false falls back', async () => {
  const { h, handler } = boot({ interceptShell: false });
  const a = agentOf('a');
  h.agents.set('a', a);
  const exec = execOf(a, { command: 'sleep 5' });
  const next = shellNext();

  const result = await handler(exec, next);

  assert.equal(next.calls, 1);
  assert.deepEqual(result.value, { shell: true });
});

test('interception resolves the schema for the exact calling agent', async () => {
  const { h, handler } = boot();
  const a = agentOf('a');
  const b = agentOf('b');
  h.agents.set('a', a);
  h.agents.set('b', b);
  const exec = execOf(a, { command: 'sleep 1' });
  const next = shellNext();

  await handler(exec, next);

  assert.equal(h.lookedUp.at(-1).agent, a);
  assert.equal(h.lookedUp.at(-1).name, 'bash');

  mock.timers.tick(1000);
  assert.equal(a.delivered.length, 1);
  assert.equal(b.delivered.length, 0);
});
