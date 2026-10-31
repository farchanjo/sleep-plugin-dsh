import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';

import { apply } from '../lib/index.js';

/** Standard JSON Schema matching the shipped bash foreground union. */
const BASH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'cwd', 'exitCode', 'signal', 'timedOut', 'aborted', 'timeoutMs', 'stdout', 'stderr'],
  properties: {
    kind: { const: 'foreground' },
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

/**
 * Minimal Cordis context with the exact surfaces the plugin touches.
 * @param options - bash definition override and cwd.
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
      get(name) {
        lookedUp.push(name);
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
 * @param options - delegation depth and initial status.
 * @returns the fake agent.
 */
function agentOf(id, options = {}) {
  const delivered = [];
  const agent = {
    id,
    status: options.status ?? 'running',
    options: {},
    session: { header: { cwd: '/tmp/work', delegationDepth: options.depth ?? 0 } },
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
      const promise = Promise.resolve(task(abort.signal)).finally(() => {
        agent.maintenanceActive = false;
      });
      return promise;
    },
  };
  return agent;
}

/**
 * Fake tool execution.
 * @param agent - calling agent.
 * @param args - model arguments.
 * @returns execution with a concludeTurn counter.
 */
function execOf(agent, args = {}) {
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
 * @returns the harness.
 */
function boot(config = {}, options = {}) {
  const h = harness(options);
  apply(h.ctx, config);
  cleanup = h.effects.at(-1);
  return h;
}

/**
 * Run one tool body.
 * @param h - harness.
 * @param name - tool name.
 * @param args - arguments.
 * @param agent - calling agent.
 * @returns the tool value.
 */
function call(h, name, args, agent) {
  const definition = h.tools.get(name);
  assert.ok(definition, `tool ${name} is registered`);
  return definition.execute(args, execOf(agent, args));
}

/**
 * Emit one lifecycle event to the registered listeners.
 * @param h - harness.
 * @param event - event name.
 * @param payload - event payload.
 */
function emit(h, event, payload) {
  for (const handler of h.handlers.get(event) ?? []) handler(payload);
}

test('sleep yields, concludes the turn, and wakes only its owner', async () => {
  const h = boot();
  const a = agentOf('a');
  const b = agentOf('b');
  h.agents.set('a', a);
  h.agents.set('b', b);

  const exec = execOf(a);
  const result = await h.tools.get('sleep').execute({ ms: 5000, reason: 'wait' }, exec);

  assert.equal(result.mode, 'yield');
  assert.equal(exec.calls, 1);
  assert.equal(a.delivered.length, 0);
  assert.equal(b.delivered.length, 0);

  a.status = 'idle';
  emit(h, 'agent/status', { agent: a, status: 'idle' });
  assert.equal(a.maintenanceActive, true);

  mock.timers.tick(5000);
  await Promise.resolve();

  assert.equal(a.delivered.length, 1);
  assert.equal(a.delivered[0][0], 'followup');
  assert.equal(a.delivered[0][1].source.kind, 'sleep-plugin-dsh');
  assert.match(a.delivered[0][1].content[0].text, /Sleep finished/);
  assert.equal(b.delivered.length, 0);
  assert.deepEqual(await call(h, 'sleep_list', {}, a), []);
});

test('sleep blocks while an armed goal is active', async () => {
  const h = boot();
  const a = agentOf('a');
  h.agents.set('a', a);
  h.goals.set(a, { phase: 'active', activation: 'armed' });

  const exec = execOf(a);
  const promise = h.tools.get('sleep').execute({ ms: 3000 }, exec);
  assert.equal(exec.calls, 0);

  mock.timers.tick(3000);
  const result = await promise;

  assert.equal(result.mode, 'blocked-goal');
  assert.equal(exec.calls, 0);
  assert.equal(a.delivered.length, 0);
});

test('sleep blocks when the host cannot conclude a turn', async () => {
  const h = boot();
  const a = agentOf('a');
  h.agents.set('a', a);
  const exec = execOf(a);
  delete exec.concludeTurn;

  const promise = h.tools.get('sleep').execute({ ms: 2000 }, exec);
  mock.timers.tick(2000);
  const result = await promise;

  assert.equal(result.mode, 'blocked-host');
  assert.equal(a.delivered.length, 0);
});

test('timeout never concludes and injects into a running agent', async () => {
  const h = boot();
  const a = agentOf('a');
  h.agents.set('a', a);
  const exec = execOf(a);

  const result = await h.tools.get('timeout').execute({ ms: 1000 }, exec);
  assert.equal(exec.calls, 0);
  assert.equal(result.kind, 'timeout');

  mock.timers.tick(1000);
  assert.equal(a.delivered.length, 1);
  assert.equal(a.delivered[0][0], 'inject');
  assert.match(a.delivered[0][1].content[0].text, /Timeout reached/);
});

test('timeout follows a previously idle agent', async () => {
  const h = boot();
  const a = agentOf('a');
  h.agents.set('a', a);

  await h.tools.get('timeout').execute({ ms: 1000 }, execOf(a));
  a.status = 'idle';
  emit(h, 'agent/status', { agent: a, status: 'idle' });
  assert.equal(a.maintenanceActive, true);

  mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(a.delivered.length, 1);
  assert.equal(a.delivered[0][0], 'followup');
});

test('sleep_list and sleep_cancel only see the calling agent', async () => {
  const h = boot();
  const a = agentOf('a');
  const b = agentOf('b');
  h.agents.set('a', a);
  h.agents.set('b', b);

  const aWait = await call(h, 'sleep', { ms: 5000 }, a);
  const bWait = await call(h, 'sleep', { ms: 5000 }, b);

  const aList = await call(h, 'sleep_list', {}, a);
  assert.deepEqual(
    aList.map((item) => item.id),
    [aWait.id],
  );
  const bList = await call(h, 'sleep_list', {}, b);
  assert.deepEqual(
    bList.map((item) => item.id),
    [bWait.id],
  );

  const cancelled = await call(h, 'sleep_cancel', { id: aWait.id }, a);
  assert.deepEqual(cancelled.cancelled, [aWait.id]);
  assert.deepEqual(await call(h, 'sleep_list', {}, a), []);
  assert.deepEqual(
    (await call(h, 'sleep_list', {}, b)).map((item) => item.id),
    [bWait.id],
  );
});

test('sleep without an agent rejects', async () => {
  const h = boot();
  await assert.rejects(call(h, 'sleep', { ms: 10 }, undefined), /live agent/);
});

test('/sleep lists and cancels through the invocation agent', async () => {
  const h = boot();
  const a = agentOf('a');
  const b = agentOf('b');
  h.agents.set('a', a);
  h.agents.set('b', b);

  const aWait = await call(h, 'sleep', { ms: 5000 }, a);
  await call(h, 'sleep', { ms: 5000 }, b);
  const command = h.commands.get('sleep');
  assert.ok(command);

  const listed = command.handler({ agent: a, rawInput: 'list' });
  assert.equal(listed.kind, 'success');
  assert.match(listed.text, new RegExp(aWait.id));

  const cancelled = command.handler({ agent: a, rawInput: `cancel ${aWait.id}` });
  assert.equal(cancelled.kind, 'success');
  assert.deepEqual(await call(h, 'sleep_list', {}, a), []);
  assert.equal((await call(h, 'sleep_list', {}, b)).length, 1);
});

test('a subagent gets a placeholder that is removed on fire', async () => {
  const h = boot();
  const child = agentOf('child', { depth: 1 });
  h.agents.set('child', child);

  const result = await call(h, 'sleep', { ms: 1000 }, child);
  assert.equal(result.mode, 'yield');
  assert.equal(child.inbox.nextStep.length, 0);

  child.status = 'idle';
  emit(h, 'agent/status', { agent: child, status: 'idle' });
  assert.equal(child.inbox.nextStep.length, 1);
  const placeholderId = child.inbox.nextStep[0].id;
  mock.timers.tick(1000);
  await Promise.resolve();

  assert.equal(child.inbox.nextStep.length, 0);
  assert.equal(
    child.delivered.some(([kind, message]) => kind === 'inject' && message.id === placeholderId),
    true,
  );
  assert.equal(child.delivered.at(-1)[0], 'followup');
});

test('the cleanup effect cancels timers and listeners', async () => {
  const h = boot();
  const a = agentOf('a');
  h.agents.set('a', a);

  await call(h, 'sleep', { ms: 5000 }, a);
  a.status = 'idle';
  emit(h, 'agent/status', { agent: a, status: 'idle' });
  assert.equal(a.maintenanceActive, true);

  cleanup();
  cleanup = undefined;

  mock.timers.tick(10_000);
  await Promise.resolve();

  assert.equal(a.delivered.length, 0);
  assert.equal(h.handlers.get('tools/execute').length, 0);
  assert.equal(h.handlers.get('agent/status').length, 0);
});

test('the store enforces the pending cap per agent', async () => {
  const h = boot({ maxPendingPerAgent: 1 });
  const a = agentOf('a');
  h.agents.set('a', a);

  await call(h, 'timeout', { ms: 5000 }, a);
  await assert.rejects(call(h, 'timeout', { ms: 5000 }, a), /too many pending waits/);
});

test('structured_output cancels pending timeouts but keeps sleeps', async () => {
  const h = boot();
  const a = agentOf('a');
  h.agents.set('a', a);

  const timeout = await call(h, 'timeout', { ms: 5000 }, a);
  const sleep = await call(h, 'sleep', { ms: 5000 }, a);
  assert.ok(timeout.id);
  assert.ok(sleep.id);

  for (const listener of h.handlers.get('tools/pre-execute') ?? []) {
    await listener({ name: 'structured_output', agent: a }, () => Promise.resolve({ kind: 'allow' }));
  }

  const pending = await call(h, 'sleep_list', {}, a);
  assert.deepEqual(
    pending.map((item) => item.kind),
    ['sleep'],
  );
});
