/**
 * Per-agent wait store and the idle keepalive.
 *
 * Every wait is owned by one exact Agent. Timers, the keepalive task, and the
 * wake always resolve through that owner, so two live sessions never see each
 * other's waits.
 *
 * The keepalive is what makes a yielded turn survivable: a delegated child
 * settles when it is idle with an empty inbox, and the headless runner exits
 * when `whenIdle()` resolves. `runMaintenance()` keeps `whenIdle()` pending
 * without holding a turn.
 *
 * @module sleep-plugin-dsh/store
 */

import { randomUUID } from 'node:crypto';

/** Wait ids are opaque and kind-prefixed. */
function newId(kind) {
  return `${kind}-${randomUUID().slice(0, 8)}`;
}

export class WaitStore {
  /** @type {Map<object, object>} */
  #agents = new Map();

  /** Agents already torn down; a disposed instance never gets a new wait. */
  #disposed = new WeakSet();

  #options;

  /**
   * @param options - timers, limits, delivery, and host callbacks.
   */
  constructor(options) {
    this.#options = options;
  }

  /**
   * Return (and create) one agent's state.
   * @param agent - exact owner.
   * @returns its state record.
   */
  #state(agent) {
    let state = this.#agents.get(agent);
    if (state === undefined) {
      state = {
        agent,
        waits: new Map(),
        keeper: null,
        keeperResolve: null,
        retry: null,
        placeholderId: undefined,
        disposed: false,
      };
      this.#agents.set(agent, state);
    }
    return state;
  }

  /**
   * Whether one state still has pending waits.
   * @param state - agent state.
   * @returns true while a wait is pending.
   */
  #pending(state) {
    for (const wait of state.waits.values()) if (wait.status === 'pending') return true;
    return false;
  }

  /**
   * Pending waits of one agent, in registration order.
   * @param agent - exact owner.
   * @returns detached projections.
   */
  list(agent) {
    const state = this.#agents.get(agent);
    if (state === undefined) return [];
    const now = this.#options.now();
    return [...state.waits.values()]
      .filter((wait) => wait.status === 'pending')
      .map((wait) => ({
        id: wait.id,
        kind: wait.kind,
        remainingMs: Math.max(0, wait.wakeAt - now),
        ...(wait.reason === undefined ? {} : { reason: wait.reason }),
      }));
  }

  /**
   * Register one wait and arm its native timer.
   * @param spec - kind, owner, duration, reason, and whether firing delivers a wake.
   * @returns the registered wait.
   */
  start(spec) {
    const { kind, agent, ms, reason, deliver } = spec;
    if (this.#disposed.has(agent)) throw new Error('the agent is already disposed');
    const state = this.#state(agent);
    if (state.disposed) throw new Error('the agent is already disposed');
    const pending = [...state.waits.values()].filter((wait) => wait.status === 'pending');
    if (pending.length >= this.#options.maxPendingPerAgent) {
      throw new Error(`too many pending waits (${this.#options.maxPendingPerAgent}); cancel one with sleep_cancel`);
    }
    const now = this.#options.now();
    const wait = {
      id: newId(kind),
      kind,
      agent,
      ms,
      reason,
      deliver,
      requestedAt: now,
      wakeAt: now + ms,
      status: 'pending',
      timer: undefined,
      placeholderId: undefined,
      waiters: [],
    };
    state.waits.set(wait.id, wait);
    wait.timer = this.#options.setTimer(() => this.#fire(wait), ms);
    return wait;
  }

  /**
   * Settle one wait without delivering a wake.
   * @param wait - wait to settle.
   * @param status - terminal status.
   */
  #settle(wait, status) {
    if (wait.status !== 'pending') return;
    wait.status = status;
    if (wait.timer !== undefined) this.#options.clearTimer(wait.timer);
    this.#agents.get(wait.agent)?.waits.delete(wait.id);
    const waiters = wait.waiters.splice(0);
    for (const resolve of waiters) resolve({ status });
  }

  /**
   * Fire one wait: settle it, deliver its wake, and release the keepalive.
   * @param wait - wait whose timer expired.
   */
  #fire(wait) {
    if (wait.status !== 'pending') return;
    const state = this.#agents.get(wait.agent);
    if (state !== undefined) this.#unplace(state);
    this.#settle(wait, 'fired');
    if (wait.deliver) {
      try {
        this.#options.deliver(wait);
      } catch (error) {
        this.#warn(`wake delivery failed: ${error?.message ?? error}`);
      }
    }
    this.#agents.get(wait.agent)?.keeperResolve?.('fired');
  }

  /**
   * Cancel one wait, or every wait of an agent.
   * @param agent - exact owner.
   * @param id - optional wait id; omitted cancels all.
   * @returns the cancelled ids.
   */
  cancel(agent, id) {
    const state = this.#agents.get(agent);
    if (state === undefined) return [];
    const targets =
      id === undefined ? [...state.waits.values()] : [state.waits.get(id)].filter((wait) => wait !== undefined);
    const cancelled = [];
    for (const wait of targets) {
      if (wait.status !== 'pending') continue;
      this.#settle(wait, 'cancelled');
      cancelled.push(wait.id);
    }
    if (cancelled.length > 0 && !this.#pending(state)) {
      this.#unplace(state);
      state.keeperResolve?.('cancel');
    }
    return cancelled;
  }

  /**
   * Cancel every pending wait of one kind for one agent.
   * @param agent - exact owner.
   * @param kind - wait kind to cancel.
   * @returns the cancelled ids.
   */
  cancelKind(agent, kind) {
    const state = this.#agents.get(agent);
    if (state === undefined) return [];
    const cancelled = [];
    for (const wait of [...state.waits.values()]) {
      if (wait.status !== 'pending' || wait.kind !== kind) continue;
      this.#settle(wait, 'cancelled');
      cancelled.push(wait.id);
    }
    if (cancelled.length > 0 && !this.#pending(state)) {
      this.#unplace(state);
      state.keeperResolve?.('cancel');
    }
    return cancelled;
  }

  /**
   * Cancel every pending wait of one agent with one terminal status.
   * @param state - agent state.
   * @param status - terminal status.
   * @returns the settled ids.
   */
  #cancelAll(state, status) {
    const ids = [];
    for (const wait of [...state.waits.values()]) {
      if (wait.status !== 'pending') continue;
      this.#settle(wait, status);
      ids.push(wait.id);
    }
    this.#unplace(state);
    return ids;
  }

  /**
   * Inject the pending-context placeholder that keeps a delegated activation
   * alive. Only an idle keeper needs it; injecting while the tool still runs
   * would leave `next-step` non-empty and stop the turn from concluding.
   * @param state - agent state.
   */
  #place(state) {
    if (state.placeholderId !== undefined || this.#options.placeholder === undefined) return;
    const wait = [...state.waits.values()].find((item) => item.status === 'pending' && item.deliver);
    if (wait === undefined) return;
    try {
      state.placeholderId = this.#options.placeholder(state.agent, wait);
    } catch (error) {
      this.#warn(`placeholder injection failed: ${error?.message ?? error}`);
    }
  }

  /**
   * Remove the placeholder before a wake is claimed.
   * @param state - agent state.
   */
  #unplace(state) {
    if (state.placeholderId === undefined) return;
    const id = state.placeholderId;
    state.placeholderId = undefined;
    try {
      this.#options.removePlaceholder?.(state.agent, id);
    } catch {
      /* inbox gone */
    }
  }

  /**
   * Arm one keepalive when the agent is idle with pending waits.
   * @param state - agent state.
   */
  #ensure(state) {
    const { agent } = state;
    if (state.disposed || state.keeper !== null || state.retry !== null) return;
    if (agent.status !== 'idle' || !this.#pending(state)) return;
    if (typeof agent.runMaintenance !== 'function') return;
    this.#place(state);
    const task = (signal) =>
      new Promise((resolve) => {
        state.keeperResolve = resolve;
        if (signal.aborted) {
          this.#onAbort(state);
          resolve('abort');
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            this.#onAbort(state);
            resolve('abort');
          },
          { once: true },
        );
      });
    let promise;
    try {
      promise = agent.runMaintenance(task);
    } catch {
      this.#scheduleRetry(state);
      return;
    }
    state.keeper = promise;
    Promise.resolve(promise)
      .catch(() => {})
      .finally(() => {
        state.keeper = null;
        state.keeperResolve = null;
        if (state.disposed || state.retry !== null) return;
        this.#unplace(state);
        if (this.#pending(state) && agent.status === 'idle') this.#ensure(state);
      });
  }

  /**
   * Retry a keepalive whose start lost to another maintenance task.
   * @param state - agent state.
   */
  #scheduleRetry(state) {
    if (state.retry !== null) return;
    state.retry = this.#options.setTimer(() => {
      state.retry = null;
      this.#ensure(state);
    }, 50);
  }

  /**
   * React to an agent lifecycle transition.
   * @param agent - transitioned agent.
   * @param status - destination status.
   */
  onStatus(agent, status) {
    if (status !== 'idle') return;
    const state = this.#agents.get(agent);
    if (state !== undefined) this.#ensure(state);
  }

  /**
   * End the keepalive early when a waking message arrives.
   * @param agent - receiving agent.
   * @param message - inserted message.
   */
  onInserted(agent, message) {
    if (!this.#options.wakeOnInput) return;
    const state = this.#agents.get(agent);
    if (state === undefined || state.keeperResolve === null) return;
    if (agent.inbox?.nextTurn?.includes(message) !== true) return;
    this.#unplace(state);
    state.keeperResolve('input');
  }

  /**
   * React to a cancellation of the maintenance task.
   * @param state - agent state.
   */
  #onAbort(state) {
    if (state.disposed) return;
    const ids = this.#cancelAll(state, 'aborted');
    if (ids.length > 0) {
      try {
        this.#options.onAborted?.(state.agent, ids);
      } catch (error) {
        this.#warn(`cancellation notice failed: ${error?.message ?? error}`);
      }
    }
  }

  /**
   * Tear down one agent's waits and keepalive.
   * @param agent - disposed agent.
   */
  disposeAgent(agent) {
    const state = this.#agents.get(agent);
    if (state === undefined) return;
    this.#disposed.add(agent);
    state.disposed = true;
    this.#unplace(state);
    if (state.retry !== null) this.#options.clearTimer(state.retry);
    state.retry = null;
    this.#cancelAll(state, 'aborted');
    const resolve = state.keeperResolve;
    state.keeperResolve = null;
    resolve?.('abort');
    this.#agents.delete(agent);
  }

  /** Tear down every agent. */
  disposeAll() {
    for (const agent of [...this.#agents.keys()]) this.disposeAgent(agent);
  }

  /**
   * Log one contained failure.
   * @param message - warning text.
   */
  #warn(message) {
    this.#options.logger?.warn?.(`sleep-plugin-dsh: ${message}`);
  }
}
