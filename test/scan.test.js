import assert from 'node:assert/strict';
import test from 'node:test';

import { findShellWaits } from '../lib/scan.js';

/**
 * Assert the waits found for each command.
 * @param cases - `[command, expected]` pairs.
 */
function expectAll(cases) {
  for (const [command, expected] of cases) {
    assert.deepEqual(findShellWaits(command), expected, JSON.stringify(command));
  }
}

test('finds waits in lists, loops, and pipelines', () => {
  expectAll([
    ['sleep 5', ['sleep']],
    ['sleep 12; date -Is', ['sleep']],
    ['for i in 1 2 3; do sleep 8; echo $i; done', ['sleep']],
    ['while ! curl -s localhost; do sleep 1; done', ['sleep']],
    ['until [ -f x ]; do\n  sleep 2\ndone', ['sleep']],
    ['dsh --port 0 >/tmp/w.log 2>&1 & sleep 12; echo', ['sleep']],
    ['pkill -f x 2>/dev/null; sleep 2; rm -rf /tmp/a', ['sleep']],
    ['x | sleep 1', ['sleep']],
    ['{ sleep 1; }', ['sleep']],
    ['if true; then sleep 1; fi', ['sleep']],
    ['! sleep 1', ['sleep']],
    ['case $1 in start) sleep 1;; stop) echo;; esac', ['sleep']],
    ['timeout 25 git ls-remote origin', ['timeout']],
    ['cd /x && timeout 5 /usr/local/bin/detent </dev/null >/tmp/o 2>/tmp/e; echo $?', ['timeout']],
    ['(timeout 90 dsh --x >/tmp/l 2>&1 &) ; sleep 3', ['timeout', 'sleep']],
    ['timeout 10 sleep 60 && echo', ['timeout', 'sleep']],
  ]);
});

test('finds waits behind assignments, paths, quotes, and wrappers', () => {
  expectAll([
    ['FOO=1 sleep 3', ['sleep']],
    ['env -i FOO=1 timeout 5 cmd', ['timeout']],
    ['nohup sleep 100 &', ['sleep']],
    ['sudo -u root timeout 5 x', ['timeout']],
    ['nice -n 10 sleep 5', ['sleep']],
    ['time sleep 1', ['sleep']],
    ['xargs -n 1 sleep < f', ['sleep']],
    ['/usr/bin/sleep 1', ['sleep']],
    ['\\sleep 1', ['sleep']],
    ["'sleep' 1", ['sleep']],
    ['2>/dev/null sleep 5', ['sleep']],
    ['gtimeout 5 x', ['timeout']],
  ]);
});

test('finds waits inside substitutions and nested scripts', () => {
  expectAll([
    ['echo $(sleep 1)', ['sleep']],
    ['echo "a $(timeout 3 cat) b"', ['timeout']],
    ['echo `sleep 1`', ['sleep']],
    ['diff <(sleep 1) b', ['sleep']],
    ['bash -c "sleep 5"', ['sleep']],
    ["sh -lc 'x; timeout 5 y'", ['timeout']],
    ['bash -euo pipefail -c "sleep 1"', ['sleep']],
    ['eval "sleep 3"', ['sleep']],
    ["bash <<'EOF'\nsleep 5\nEOF", ['sleep']],
    ['cat <<EOF | bash\ntimeout 3 x\nEOF', ['timeout']],
    ['echo "sleep 5" | sh', ['sleep']],
    ['bash <<< "sleep 2"', ['sleep']],
    ['cat <<EOF\n$(sleep 1)\nEOF', ['sleep']],
  ]);
});

test('finds waits in ssh remote commands', () => {
  expectAll([
    ['ssh host sleep 5', ['sleep']],
    ["ssh -o BatchMode=yes -l root 10.0.0.1 -- 'cd /x && docker compose up -d; sleep 25; docker ps'", ['sleep']],
    ["ssh -p 22 -i key host 'for i in 1 2; do st=x; sleep 10; done'", ['sleep']],
    ["ssh -qp22 host 'timeout 90 ./bin/rclone size r2:x'", ['timeout']],
    ['ssh -t host -- sleep 1', ['sleep']],
    ['ssh host', []],
    ['ssh -o ConnectTimeout=5 host uptime', []],
    ["ssh host 'grep sleep /var/log/x'", []],
  ]);
});

test('leaves sleep and timeout as data alone', () => {
  expectAll([
    ['grep -rn sleep lib/', []],
    ['rg "timeout" src', []],
    ['echo "sleep 5"', []],
    ["git commit -m 'fix sleep and timeout'", []],
    ["cat > f.txt <<'EOF'\nsleep 5\ntimeout 10 x\nEOF", []],
    ['cat > f.txt <<EOF\nsleep 5\nEOF', []],
    ['docker run img sleep infinity', []],
    ['kubectl exec p -- sleep 5', []],
    ['timeout=5 ./run', []],
    ['./run --timeout 5', []],
    ['make timeout', []],
    ['man timeout', []],
    ['ls lib/sleep.js; cat sleep_list', []],
    ['# sleep 5\necho ok', []],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell parameter expansion is the input under test.
    ['echo $((1+2)) ${x:-sleep}', []],
    ['for sleep in a b; do echo $sleep; done', []],
    ['case x in sleep) echo;; esac', []],
    ['function sleepy { echo; }', []],
    ['printf "%s" sleep', []],
    ['awk \'{print "sleep"}\' f', []],
  ]);
});

test('does not inspect script files or other interpreters', () => {
  expectAll([
    ['bash script.sh', []],
    ['python3 -c "import time; time.sleep(1)"', []],
  ]);
});

test('survives malformed and deeply nested input', () => {
  assert.deepEqual(findShellWaits('echo "unterminated'), []);
  assert.deepEqual(findShellWaits("sleep 1 'unterminated"), ['sleep']);
  assert.deepEqual(findShellWaits('echo $(sleep 1'), ['sleep']);
  const nested = `${'$('.repeat(40)}sleep 1${')'.repeat(40)}`;
  assert.doesNotThrow(() => findShellWaits(nested));
});
