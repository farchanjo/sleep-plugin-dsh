# sleep-plugin-dsh

Native sleep and timeout waits for DSH. A `sleep` runs on a Node timer, the turn yields, and the exact owning Agent is woken in its own session when the timer fires.

Plugin-only. No dsh change, no fork, no edit to another plugin.

## What it does

| Surface | Behavior |
|---|---|
| `sleep(ms, reason?)` | Starts a native timer; on a yield, ends the turn and wakes the caller when it fires. |
| `timeout(ms, reason?)` | Arms a watchdog. Does not end the turn. Fires a notice at the next step, or wakes the caller if idle. |
| `sleep_list()` | Lists the calling Agent's pending waits and remaining time. |
| `sleep_cancel(id?)` | Cancels one wait by id, or every wait of the calling Agent. |
| `/sleep` | UI command: lists or cancels waits of the receiving session without a model call. |
| `bash sleep ...` | Replaced by the native wait when the command is a pure wait. |
| any other bash `sleep` / `timeout` | Denied before the shell starts, with a pointer to the native tools. |

The wake is a plugin-sourced user message. It carries the wait id, the elapsed time, and the optional reason. `sleep` always uses a waking follow-up; `timeout` uses next-step context while running and a waking follow-up when idle. A woken turn continues the paused task with its history intact.

```text
sleep         { "ms": 30000, "reason": "waiting for the build" }
timeout       { "ms": 600000, "reason": "build watchdog" }
sleep_cancel  { "id": "timeout-1a2b3c4d" }
```

## Why it exists

`bash sleep` costs a process, a shell, quoting, and a blocked turn. `timeout` has the same cost and only works while the shell is alive.

This plugin gives waits a native timer and a lifecycle:

- no process, no shell, platform-neutral timers;
- the turn is idle while waiting, not held by a tool call;
- the wake targets the exact Agent, including delegated children;
- an armed goal blocks the yield instead of burning an automatic round;
- a pure shell wait is routed to the same native path when the plugin is loaded;
- every other shell `sleep` or `timeout` is denied, so the shell never holds a wait.

## Install

```bash
dsh plugin --profile dsh-tui add /root/dev/sleep-plugin-dsh
dsh plugin --profile web add /root/dev/sleep-plugin-dsh
```

Restart dsh after adding the row.

Remove with:

```bash
dsh plugin --profile dsh-tui remove sleep-plugin-dsh
dsh plugin --profile web remove sleep-plugin-dsh
```

The package is a local bundle. The profile manifest and lockfile are the only configuration files the install changes.

## Plugin-only contract

The plugin uses public runtime extension points only:

| Point | Use |
|---|---|
| `ctx.tools.register` | The four tools. |
| `ctx.on('tools/pre-execute', ...)` | Shell wait gate: a `deny` decision for bash calls that run `sleep` or `timeout`. |
| `ctx.on('tools/execute', ...)` | Fail-open shell interception, registered by this plugin. |
| `ctx.tools.get('bash', agent)` | Reads the live bash definition. The bash plugin is never mutated. |
| `validateJsonSchemaValue` | Validates the synthetic bash result before dispatch. |
| `agent.concludeTurn()` | Ends the turn at the tool result. |
| `agent.followup()` / `agent.inject()` | Delivers the wake or the watchdog notice. |
| `agent.runMaintenance()` | Keeps the Agent alive while idle. |
| `ctx.commands.register` | `/sleep`. |
| `ctx.systemPrompt.section` | Model guidance. |

Unloading the plugin removes the gate, the wrapper, the tools, the command, the prompt section, every timer, and every keepalive.

## Yield semantics

A yielding `sleep` runs this sequence:

1. Validate `ms` and the per-Agent pending cap.
2. Register the wait under the exact `exec.agent` and arm `setTimeout`.
3. Call `exec.concludeTurn()` and return the tool result.
4. The turn ends. The Agent becomes idle.
5. An `agent/status` listener starts `agent.runMaintenance()`. Before the task, a delegated child receives the pending placeholder. The maintenance task stays pending until the timer fires, a next-turn message arrives, or the Agent is cancelled. It keeps `whenIdle()` pending.
6. When the timer fires, the wait is removed, the placeholder is dropped, and `agent.followup()` queues the wake.
7. The maintenance ends, the wake driver opens a new turn on the same Agent, and the model resumes.

The wait result says that the turn ends and when the wake arrives. The wake is not `inject`: `inject` adds context but does not wake an idle driver.

### Keepalive

`runMaintenance()` is the reason a yielded turn survives:

- a delegated child settles when it is idle with an empty inbox, so a plain `followup` after settlement would hit a disposed Agent;
- the headless runner exits when `whenIdle()` resolves, so a pending timer would die with the process.

The maintenance task makes both observers wait. It is one task per Agent, restarted after each wake if other waits remain. If another maintenance task already owns the Agent, the plugin retries after 50 ms.

### Armed goals

An active goal with an armed round driver would queue a new round as soon as the Agent idles. A yielding sleep would spend a round for nothing.

`modeFor()` checks `ctx.goals.get(agent)`:

- `phase === 'active'` and `activation === 'armed'`: the sleep **blocks** in the tool call, and the round continues.
- otherwise: the sleep yields.
- `goalMode: "yield"` ignores the check.
- Without the goals service, the sleep yields.

The result mode reports `blocked-goal` when the goal rule applied.

### Delegated children

A delegated child gets the placeholder when its keeper starts, never while the tool call is still running: a pending `next-step` item would stop `concludeTurn` from closing the turn. That covers a yielded `sleep`; because both kinds share the keeper, a delivering `timeout` also gets one.

The placeholder message reads:

```
Native wait pending until <ISO time> (<id>). The wake notice continues this run;
do not call structured_output before then.
```

The placeholder serves three purposes:

- it keeps the activation non-empty even if the keepalive fails;
- it makes the structured-output guard refuse an early submission;
- it is removed when the timer fires, a waking message arrives, or the wait is cancelled.

Only yield mode injects it for a sleep; a blocked sleep never does. A delivering `timeout` also injects it, so cancel a watchdog with `sleep_cancel` before `structured_output` when the run is done.

## Timeout semantics

`timeout` is a watchdog, not a pause.

- The tool returns immediately and the turn continues.
- While the Agent is running, firing uses `inject()` so the notice enters at the next step boundary.
- While the Agent is idle, firing uses `followup()` and wakes it.
- A pending timeout keeps an idle Agent alive through the same maintenance path.
- A delegated run that calls `structured_output` cancels its pending timeouts automatically, so they do not delay the parent.
- The timeout does not interrupt a tool that is already stuck; it delivers at the next step.

## Cancellation and input

| Event | Effect |
|---|---|
| `sleep_cancel(id)` | Cancels the wait, clears the timer, drops the placeholder. |
| `sleep_cancel()` | Cancels every wait of the calling Agent. |
| `/sleep cancel [id]` | The same from the UI, without a model call. |
| Agent cancellation while idle in maintenance | Cancels every wait, injects a cancellation notice, leaves the Agent idle. |
| Agent disposal | Cancels every wait and removes the Agent state. Other Agents are untouched. |
| Plugin unload | Cancels every wait of every Agent. |

A waking message can end the keepalive early. With `wakeOnInput: true`, an inserted message in `inbox.nextTurn` ends the maintenance without cancelling the timer. The Agent handles the message, then the timer remains pending. This covers a user message and a completed background job.

The early wake does not cancel the wait. The model or the user cancels it with `sleep_cancel` when it no longer matters.

## Shell waits

While the plugin is loaded, the shell never holds a wait. Two listeners enforce it:

1. The gate runs on `tools/pre-execute`. It lets a pure wait through to the wrapper and denies every other bash call that would run `sleep` or `timeout`.
2. The wrapper runs on `tools/execute` and replaces the pure wait with the native timer before the shell starts.

### Accepted and replaced

| Command | Result |
|---|---|
| `sleep 5` | Native 5 s sleep. |
| `sleep 0.5` | Native 500 ms sleep. |
| `sleep 1m` | Native 60 s sleep. |
| `sleep 1 2` | Native 3 s sleep; durations sum. |
| `sleep 5;` | Native 5 s sleep; one trailing `;` is stripped. |
| `timeout 10 sleep 60` | Native 10 s sleep, reported as a timeout hit with exit 124. |
| `timeout 10 sleep 5` | Native 5 s sleep, exit 0. |

### Denied

A bash call that runs `sleep` or `timeout` and is not replaced gets a policy denial. The model sees `Error: sleep-plugin-dsh: ...` and the error identity `ShellWaitDenied` / `SHELL_WAIT_DENIED`. The text names the native replacement:

| Shell form | Replacement named in the denial |
|---|---|
| `sleep` anywhere in the command | The `sleep` tool. To poll, one check per bash call with a `sleep` tool call between checks, or `run_in_background: true` and the job notice. |
| `timeout N cmd` | The bash `timeoutMs` argument bounds the command; the `timeout` tool is the watchdog. |

Examples of denied calls:

| Command | Why it is not replaced |
|---|---|
| `sleep 5 && echo ok` | More than one command. |
| `for i in 1 2 3; do check; sleep 5; done` | A polling loop. |
| `server & sleep 12; curl ...` | A wait inside a list. |
| `timeout 25 git ls-remote origin` | The wrapped command needs a shell. |
| `bash -c 'sleep 5'`, `ssh host 'sleep 25; docker ps'` | A nested or remote script waits. |
| `sleep infinity`, `sleep 0`, `timeout -k 5 10 sleep 20` | Outside the strict grammar. |
| `sleep 5` with `run_in_background: true` | The job would hold the wait. |
| `sleep 5` with `sandbox_permissions` | No escalation is needed to wait. |
| `sleep 5` with a `timeoutMs` shorter than the wait | The bash deadline would win. |
| `sleep 5` while `interceptShell` is false or the bash contract changed | The wrapper cannot replace it. |

A pure wait the gate let through can still fail to start, for example over `maxPendingPerAgent`. The wrapper then returns the same error identity instead of handing the wait to the shell.

### Allowed

The gate denies a name only where the shell would run it. `sleep` and `timeout` as data stay allowed:

| Command | Reason |
|---|---|
| `grep -rn sleep lib/`, `man timeout`, `./run --timeout 5` | An argument. |
| `echo "sleep 5"`, `git commit -m 'fix sleep'` | A quoted string. |
| `cat > f.sh <<'EOF'` with `sleep 5` in the body | Heredoc text written to a file. |
| `timeout=5 ./run`, `for sleep in a b` | A variable name. |
| `docker run img sleep infinity`, `kubectl exec p -- sleep 5` | A container process. |
| any `pwsh` call, a call without an Agent | Out of scope. |

### Detection

`lib/scan.js` splits the command the way bash does:

- quotes, escapes, `$'...'`, comments, and line continuations;
- control operators, pipelines, subshells, brace groups, and `if`/`while`/`until`/`for`/`case` bodies;
- redirections, including `2>/dev/null` before the command name;
- command substitution `$(...)` and backticks, process substitution `<(...)`, also inside double quotes and unquoted heredocs;
- assignments before the command, absolute paths (`/usr/bin/sleep`), and quoted names (`'sleep'`, `\sleep`);
- wrappers: `env`, `command`, `builtin`, `exec`, `nohup`, `nice`, `ionice`, `setsid`, `stdbuf`, `time`, `sudo`, `doas`, `chrt`, `taskset`, `flock`, `xargs`, `busybox`, `unbuffer`, `caffeinate`, and `timeout` itself;
- nested scripts: `sh`/`bash`/`zsh`/... `-c`, `eval`, a shell fed by a heredoc, a here-string, or a pipe from `echo`/`printf`/a heredoc, and the remote command of `ssh`.

`gsleep` and `gtimeout` count as `sleep` and `timeout`.

### Fail-open steps

Before any timer starts, the wrapper:

1. Checks the tool name, the Agent, and `interceptShell`.
2. Parses the command strictly.
3. Requires `ms <= maxMs`.
4. Reads the live bash output schema with `ctx.tools.get('bash', agent)`.
5. Builds a foreground bash value and validates it with `validateJsonSchemaValue`.

On any violation, missing field, or throw, it calls `next()` and the shell runs untouched. If `concludeTurn` is missing, the wrapper still uses the native timer but blocks the turn.

The synthetic value follows the shipped bash foreground union: `kind`, `cwd`, `exitCode`, `signal`, `timedOut`, `aborted`, `timeoutMs`, `stdout`, `stderr`. The bash renderer produces the model text; the bash presentation metadata supplies the card directory. The model text says the wait was native and whether the turn yielded.

The wrapper is deduplicated per execution with a `WeakMap`, so a retrying outer wrapper does not arm two timers for one call.

A wrapper registered before this one can skip `next()` and bypass the interception. The shell then runs normally.

The gate is fail-open too: a throw in the scanner or the schema lookup logs a warning and allows the call. A plugin bug never blocks an unrelated bash command.

## Configuration

The row config is read once at mount. Invalid values fail the mount.

| Key | Default | Meaning |
|---|---|---|
| `yieldByDefault` | `true` | `false` makes every `sleep` block in the tool call, intercepted shell sleeps included. |
| `goalMode` | `"block"` | `"block"` blocks on an armed goal; `"yield"` ignores goals. |
| `interceptShell` | `true` | Master switch for the shell wrapper. |
| `denyShellWaits` | `true` | Deny bash calls that run `sleep` or `timeout` and are not replaced. Also switches the prompt section to the deny wording. |
| `wakeOnInput` | `true` | A next-turn message ends the keepalive early. |
| `maxMs` | `604800000` | Longest accepted wait, 7 days. Capped at Node's `2147483647`. |
| `maxPendingPerAgent` | `8` | Pending waits per Agent before `sleep`/`timeout` fails. Capped at 128. |

The bundle patch inserts the row with the defaults. No config is needed. Override a field by row id in the profile patch:

```yaml
- id: sleep-plugin-dsh
  config:
    yieldByDefault: true
    goalMode: block
    interceptShell: true
    denyShellWaits: true
    wakeOnInput: true
    maxMs: 604800000
    maxPendingPerAgent: 8
```

Kill switch:

```yaml
- id: sleep-plugin-dsh
  config:
    interceptShell: false
    denyShellWaits: false
```

The tools and `/sleep` keep working; `bash sleep` and `bash timeout` return to the shell. With only `interceptShell: false`, a pure `bash sleep` is denied instead of replaced.

## Contexts

Every wait belongs to one exact `Agent` object:

- the tool result carries the wait id of that Agent;
- the wake reads the same owner, checks `ctx.agents.get(id) === agent` when that service exists, and calls its `followup` or `inject`;
- `sleep_list` and `sleep_cancel` only see the calling Agent's waits;
- `/sleep` only sees the receiving session's Agent;
- disposal cleans one Agent and leaves the rest;
- a headless run stays alive through the same keepalive and exits only after the last wait settles and its wake turn ends.

The root session and a delegated child never share a timer, a keepalive, a placeholder, or a cancellation.

## Compatibility

- No dsh file is patched. Every hook is registered at runtime and removed at unload.
- Optional services are read with `ctx.get` or `ctx.inject`. A missing goals, commands, systemPrompt, or workingDirectory service only disables that slice; without the agents registry, waits still arm and wakes are attempted against the stored Agent, so a disposed owner degrades to a caught delivery failure.
- Yield degrades to a blocking native wait when `concludeTurn`, `followup`, `inject`, or `runMaintenance` is absent.
- The shell path degrades to the shell when parsing, schema lookup, or validation fails.
- Tools and the command are inert without a live Agent.

An upgrade can remove a capability; it does not turn the plugin into a hard failure.

## Limits

- **In memory.** Timers and keepalives die with the process. A restart loses pending waits. There is no durable store or re-arm.
- **Watchdog only.** `timeout` cannot kill or interrupt a tool call that is already running. It delivers at the next step.
- **PTC.** Inside `run_code`, `concludeTurn` applies when the program ends, not at the `sleep` call.
- **`pwsh`.** Neither intercepted nor denied in this version.
- **Scanner reach.** The gate reads the command text only. It does not open script files (`bash script.sh`, `source x`), resolve dynamic names (`$cmd 5`), or read other interpreters (`python3 -c 'time.sleep(5)'`). The denial and the prompt section forbid those workarounds; nothing enforces it.
- **Other tools.** Only the `bash` tool is gated. A wait run through another tool, such as an MCP `ssh_exec`, is not seen.
- **bash contract.** The synthetic result is validated at runtime. A schema change makes the wrapper step aside; with `denyShellWaits` the gate then denies the pure wait instead of running it in the shell.
- **Token cost.** A wake is a model request. A sleep is not free.
- **One maintenance per Agent.** Another plugin's maintenance can delay the keeper by one retry.
- **No mediated permissions.** The plugin uses no fs, network, or storage.

## Tests

```bash
pnpm install
pnpm test
pnpm lint
```

The suite uses `node:test`, fake timers, and a fake Agent/context. It targets:

- duration and command parsing;
- yield, `concludeTurn`, keepalive start, and wake;
- watchdog inject versus idle wake;
- goal blocking and host degradation;
- subagent placeholder injection and removal;
- cancellation, disposal, and Agent isolation;
- pending caps and invalid durations;
- accepted interception and schema fallback to `next()`;
- shell wait detection: command position, wrappers, substitutions, heredocs, nested and remote scripts, and data that must stay allowed;
- the deny gate: denial text and identity, pass-through for pure waits, and the pending-cap failure;
- `/sleep` list and cancel, scoped to one Agent.

## Files

| File | Role |
|---|---|
| `lib/index.js` | Plugin entry: config, tools, prompt, command, listeners, cleanup. |
| `lib/store.js` | Per-Agent wait store and maintenance keepalive. |
| `lib/intercept.js` | `tools/pre-execute` shell wait gate and fail-open `tools/execute` shell wrapper. |
| `lib/parse.js` | Strict `sleep` and `timeout ... sleep` parsers. |
| `lib/scan.js` | Shell-aware detection of `sleep` and `timeout` invocations. |
| `lib/messages.js` | Wake, placeholder, and cancellation messages. |
| `lib/config.js` | Config defaults, coercion, and hard limits. |
| `cordis.patch.yml` | Bundle row with the seed config. |
| `dsh-plugin.json` | Host manifest, command contract, and permission. |
| `test/` | Unit tests. |

## Manifest and permissions

The host manifest declares the `commands.dsh/v1alpha1#Command` contract and the `commands.invoke` permission for `/sleep`. No grants file is needed; no mediated capability is used.

Runtime dependencies are pinned to the harness line:

- `@deepseek-ai/dsh-tools`
- `@deepseek-ai/dsh-llm`

Built against dsh `0.2.1-rc.2`.
