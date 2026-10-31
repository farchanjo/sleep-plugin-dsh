import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, mock } from 'node:test';

import { WaitStore } from '../lib/store.js';

/** Settle promise microtasks without advancing fake time. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Minimal Agent double. `runMaintenance` invokes the task synchronously (like
 * the real loop), aborts through its own controller, and marks the agent
 * running again when a waking message is queued.
 * @param id - agent identity.
 * @returns the fake agent and its maintenance controls.
 */
function makeAgent(id) {
  const controller = new AbortController();
  const agent = {
    id,
    status: 'idle',
    session: { header: { cwd: '/tmp/project', delegationDepth: 0 } },
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
    delivered: [],
    maintenanceStarts: 0,
    maintenanceEnds: 0,
    maintenanceActive: false,
    maintenanceController: controller,
    followup(message) {
      agent.delivered.push(['followup', message]);
      agent.inbox.nextTurn.push(message);
      agent.status = 'running';
    },
    inject(message) {
      agent.delivered.push(['inject', message]);
      agent.inbox.nextStep.push(message);
    },
    runMaintenance(task) {
      if (agent.maintenanceActive) throw new Error('maintenance already active');
      agent.maintenanceActive = true;
      agent.maintenanceStarts += 1;
      const signal = controller.signal;
      const done = Promise.resolve(task(signal)).finally(() => {
        agent.maintenanceActive = false;
        agent.maintenanceEnds += 1;
        if (agent.inbox.nextTurn.length > 0) agent.status = 'running';
      });
      return done;
    },
  };
  return agent;
}

/**
 * Store plus recording hooks.
 * @param overrides - option overrides.
 * @returns the store and hook logs.
 */
function makeStore(overrides = {}) {
  const delivered = [];
  const placeholders = [];
  const removed = [];
  const aborted = [];
  const store = new WaitStore({
    maxPendingPerAgent: 8,
    wakeOnInput: true,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (timer) => clearTimeout(timer),
    deliver: (wait) => delivered.push(wait),
    placeholder: (_agent, wait) => {
      placeholders.push(wait.id);
      return `ph-${wait.id}`;
    },
    removePlaceholder: (_agent, id) => removed.push(id),
    onAborted: (agent, ids) => aborted.push([agent, ids]),
    logger: { warn() {} },
    ...overrides,
  });
  return { store, delivered, placeholders, removed, aborted };
}

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
});

afterEach(() => {
  mock.timers.reset();
});

test('start arms a timer and list reports the remaining time', () => {
  const agent = makeAgent('a');
  const { store, placeholders } = makeStore();
  const wait = store.start({ kind: 'sleep', agent, ms: 500, reason: 'wait', deliver: false });
  assert.equal(wait.wakeAt, 1500);
  assert.equal(wait.status, 'pending');
  assert.deepEqual(store.list(agent), [{ id: wait.id, kind: 'sleep', remainingMs: 500, reason: 'wait' }]);
  assert.equal(placeholders.length, 0);
  store.disposeAll();
});

test('fire delivers once, removes the wait, and releases waiters', async () => {
  const agent = makeAgent('a');
  const { store, delivered } = makeStore();
  const wait = store.start({ kind: 'sleep', agent, ms: 500, deliver: true });
  const waiter = new Promise((resolve) => wait.waiters.push(resolve));

  mock.timers.tick(500);
  await flush();

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].id, wait.id);
  assert.deepEqual(store.list(agent), []);
  assert.deepEqual(await waiter, { status: 'fired' });

  mock.timers.tick(5000);
  await flush();
  assert.equal(delivered.length, 1);
  store.disposeAll();
});

test('cancel by id and cancel-all settle without delivery', async () => {
  const agent = makeAgent('a');
  const { store, delivered } = makeStore();
  const first = store.start({ kind: 'sleep', agent, ms: 500, deliver: true });
  const second = store.start({ kind: 'timeout', agent, ms: 900, deliver: true });
  const waiter = new Promise((resolve) => first.waiters.push(resolve));

  assert.deepEqual(store.cancel(agent, first.id), [first.id]);
  assert.deepEqual(await waiter, { status: 'cancelled' });
  assert.equal(store.list(agent).length, 1);

  assert.deepEqual(store.cancel(agent), [second.id]);
  assert.deepEqual(store.list(agent), []);
  mock.timers.tick(5000);
  await flush();
  assert.equal(delivered.length, 0);
  store.disposeAll();
});

test('the per-agent pending cap rejects the next start', () => {
  const agent = makeAgent('a');
  const { store } = makeStore({ maxPendingPerAgent: 1 });
  store.start({ kind: 'sleep', agent, ms: 500, deliver: false });
  assert.throws(() => store.start({ kind: 'sleep', agent, ms: 500, deliver: false }), /too many pending waits/);
  store.disposeAll();
});

test('idle status arms maintenance only while a wait is pending', async () => {
  const agent = makeAgent('a');
  const { store, delivered } = makeStore();
  store.onStatus(agent, 'idle');
  assert.equal(agent.maintenanceStarts, 0);

  store.start({ kind: 'sleep', agent, ms: 500, deliver: true });
  store.onStatus(agent, 'idle');
  assert.equal(agent.maintenanceStarts, 1);

  mock.timers.tick(500);
  await flush();
  assert.equal(delivered.length, 1);
  assert.equal(agent.maintenanceEnds, 1);
  assert.equal(agent.maintenanceActive, false);
  store.disposeAll();
});

test('a next-turn message ends maintenance without cancelling the timer', async () => {
  const agent = makeAgent('a');
  const { store, delivered } = makeStore();
  store.start({ kind: 'sleep', agent, ms: 500, deliver: true });
  store.onStatus(agent, 'idle');
  assert.equal(agent.maintenanceStarts, 1);

  const message = { id: 'm1' };
  agent.inbox.nextTurn.push(message);
  store.onInserted(agent, message);
  await flush();

  assert.equal(agent.maintenanceEnds, 1);
  assert.equal(store.list(agent).length, 1, 'the timer keeps running');
  assert.equal(delivered.length, 0);

  mock.timers.tick(500);
  await flush();
  assert.equal(delivered.length, 1);
  store.disposeAll();
});

test('disposeAgent aborts maintenance, clears timers, and resolves waiters as aborted', async () => {
  const agent = makeAgent('a');
  const { store, delivered, aborted } = makeStore();
  const wait = store.start({ kind: 'sleep', agent, ms: 500, deliver: false });
  const waiter = new Promise((resolve) => wait.waiters.push(resolve));
  store.onStatus(agent, 'idle');

  store.disposeAgent(agent);
  assert.deepEqual(await waiter, { status: 'aborted' });
  assert.equal(agent.maintenanceEnds, 1);
  assert.deepEqual(store.list(agent), []);
  assert.equal(aborted.length, 0, 'disposal is not a user cancellation');

  mock.timers.tick(5000);
  await flush();
  assert.equal(delivered.length, 0);
});

test('a maintenance abort cancels waits and reports their ids', async () => {
  const agent = makeAgent('a');
  const { store, delivered, aborted } = makeStore();
  const wait = store.start({ kind: 'sleep', agent, ms: 500, deliver: true });
  store.onStatus(agent, 'idle');

  agent.maintenanceController.abort();
  await flush();

  assert.equal(aborted.length, 1);
  assert.deepEqual(aborted[0][1], [wait.id]);
  assert.equal(agent.maintenanceEnds, 1);
  assert.deepEqual(store.list(agent), []);
  assert.equal(delivered.length, 0);
  mock.timers.tick(5000);
  await flush();
  assert.equal(delivered.length, 0);
  store.disposeAll();
});

test('two agents keep independent timers and cancellation', async () => {
  const first = makeAgent('a');
  const second = makeAgent('b');
  const { store, delivered } = makeStore();
  store.start({ kind: 'sleep', agent: first, ms: 500, deliver: true });
  store.start({ kind: 'sleep', agent: second, ms: 1000, deliver: true });

  mock.timers.tick(500);
  await flush();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].agent, first);

  store.cancel(first);
  assert.equal(store.list(second).length, 1);

  mock.timers.tick(500);
  await flush();
  assert.equal(delivered.length, 2);
  assert.equal(delivered[1].agent, second);
  store.disposeAll();
});

test('placeholders exist only while a delivering wait holds the keeper', async () => {
  const agent = makeAgent('a');
  const { store, placeholders, removed } = makeStore();
  const blocking = store.start({ kind: 'sleep', agent, ms: 500, deliver: false });
  store.onStatus(agent, 'idle');
  assert.equal(placeholders.length, 0);
  store.cancel(agent, blocking.id);
  await flush();

  const fired = store.start({ kind: 'sleep', agent, ms: 500, deliver: true });
  store.onStatus(agent, 'idle');
  assert.deepEqual(placeholders, [fired.id]);
  mock.timers.tick(500);
  await flush();
  assert.deepEqual(removed, [`ph-${fired.id}`]);

  const cancelled = store.start({ kind: 'sleep', agent, ms: 500, deliver: true });
  store.onStatus(agent, 'idle');
  store.cancel(agent, cancelled.id);
  await flush();
  assert.deepEqual(removed, [`ph-${fired.id}`, `ph-${cancelled.id}`]);
  store.disposeAll();
});

test('wakeOnInput false leaves maintenance armed until the timer fires', async () => {
  const agent = makeAgent('a');
  const { store, delivered } = makeStore({ wakeOnInput: false });
  store.start({ kind: 'sleep', agent, ms: 500, deliver: true });
  store.onStatus(agent, 'idle');

  const message = { id: 'm1' };
  agent.inbox.nextTurn.push(message);
  store.onInserted(agent, message);
  await flush();
  assert.equal(agent.maintenanceEnds, 0);

  mock.timers.tick(500);
  await flush();
  assert.equal(delivered.length, 1);
  assert.equal(agent.maintenanceEnds, 1);
  store.disposeAll();
});

test('a lost maintenance start retries instead of dropping the wait', async () => {
  const agent = makeAgent('a');
  const { store, delivered } = makeStore();
  store.start({ kind: 'sleep', agent, ms: 500, deliver: true });

  agent.maintenanceActive = true;
  store.onStatus(agent, 'idle');
  assert.equal(agent.maintenanceStarts, 0);

  agent.maintenanceActive = false;
  mock.timers.tick(50);
  await flush();
  assert.equal(agent.maintenanceStarts, 1);
  assert.equal(agent.maintenanceActive, true);

  mock.timers.tick(500);
  await flush();
  assert.equal(delivered.length, 1);
  assert.equal(agent.maintenanceEnds, 1);
  store.disposeAll();
});
