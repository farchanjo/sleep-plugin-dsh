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

test('shell forms outside the exact grammar fall back', async () => {
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
