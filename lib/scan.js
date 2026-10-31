/**
 * Shell-aware detection of `sleep` and `timeout` invocations.
 *
 * The scanner reads a bash command the way the shell would split it: quotes,
 * escapes, comments, operators, redirections, heredocs, command and process
 * substitutions. A name counts only in command position, after assignments,
 * reserved words, and prefix wrappers such as `env`, `nohup`, or `sudo`. The
 * scripts of `bash -c`, `eval`, and shells fed through stdin are scanned too.
 *
 * An `ssh` remote command is scanned as well: the remote wait still blocks
 * the bash call.
 *
 * `sleep` as data stays allowed: an argument (`grep sleep`), a quoted string
 * (`echo "sleep 5"`), heredoc text written to a file, or a container process
 * (`docker run img sleep infinity`).
 *
 * @module sleep-plugin-dsh/scan
 */

/** Command basenames mapped to the native tool that replaces them. */
const WAIT_NAMES = new Map([
  ['sleep', 'sleep'],
  ['gsleep', 'sleep'],
  ['timeout', 'timeout'],
  ['gtimeout', 'timeout'],
]);

/** Shells whose `-c` argument, heredoc, or piped stdin is itself a script. */
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'mksh', 'ash', 'yash', 'posh']);

/** Commands whose arguments a piped shell would read as its script. */
const PRINTERS = new Set(['echo', 'printf']);

/**
 * Prefix commands that run their operand as a command. `flags` lists options
 * that take a separate value; `positional` counts operands before the command.
 */
const WRAPPERS = new Map([
  ['env', { flags: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'], assignments: true }],
  ['command', { flags: [] }],
  ['builtin', { flags: [] }],
  ['exec', { flags: ['-a'] }],
  ['nohup', { flags: [] }],
  ['nice', { flags: ['-n', '--adjustment'] }],
  ['ionice', { flags: ['-c', '--class', '-n', '--classdata', '-t'] }],
  ['setsid', { flags: [] }],
  ['stdbuf', { flags: ['-i', '-o', '-e', '--input', '--output', '--error'] }],
  ['time', { flags: ['-f', '--format', '-o', '--output'] }],
  [
    'sudo',
    {
      flags: [
        '-u',
        '--user',
        '-g',
        '--group',
        '-C',
        '--close-from',
        '-D',
        '--chdir',
        '-h',
        '--host',
        '-p',
        '--prompt',
        '-r',
        '--role',
        '-t',
        '--type',
        '-U',
        '--other-user',
        '-T',
        '--command-timeout',
      ],
    },
  ],
  ['doas', { flags: ['-u', '-C'] }],
  ['chrt', { flags: [], positional: 1 }],
  ['taskset', { flags: [], positional: 1 }],
  ['flock', { flags: ['-w', '--timeout', '-E', '--conflict-exit-code'], positional: 1 }],
  [
    'xargs',
    {
      flags: [
        '-n',
        '--max-args',
        '-I',
        '-L',
        '--max-lines',
        '-P',
        '--max-procs',
        '-s',
        '--max-chars',
        '-d',
        '--delimiter',
        '-E',
        '-a',
        '--arg-file',
      ],
    },
  ],
  ['busybox', { flags: [] }],
  ['unbuffer', { flags: [] }],
  ['caffeinate', { flags: ['-t', '-w'] }],
]);

/** OpenSSH options that take a separate value. */
const SSH_VALUE_FLAGS = 'BbcDEeFIiJLlmOopQRSWw';

/** `timeout` also wraps a command: `timeout [opts] duration command`. */
const TIMEOUT_WRAPPER = { flags: ['-s', '--signal', '-k', '--kill-after'], positional: 1 };

/** Reserved words that keep the parser in command position. */
const RESERVED = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'coproc']);

/** Control and list operators that end one simple command. */
const OPERATORS = [
  '<<<',
  '<<-',
  ';;&',
  '&>>',
  '&&',
  '||',
  ';;',
  ';&',
  '|&',
  '<<',
  '>>',
  '<&',
  '>&',
  '<>',
  '>|',
  '&>',
  ';',
  '&',
  '|',
  '(',
  ')',
  '<',
  '>',
];

/** Operators whose next word is a redirection target, not a command word. */
const REDIRECTS = new Set(['<', '>', '>>', '<&', '>&', '<>', '>|', '&>', '&>>', '<<', '<<-', '<<<']);

/** Characters that end an unquoted word. */
const WORD_BREAK = new Set([' ', '\t', '\r', '\n', ';', '&', '|', '(', ')', '<', '>']);

/** Placeholder for an expansion whose value is unknown before run time. */
const DYNAMIC = '\u0000';

/** Recursion bound for nested substitutions and scripts. */
const MAX_DEPTH = 12;

/** Raised when nesting exceeds {@link MAX_DEPTH}; the scan keeps what it found. */
class ScanDepthError extends Error {}

/**
 * Read one `$...` or backtick expansion.
 * @param src - source text.
 * @param at - index of `$` or the backtick.
 * @param depth - recursion depth.
 * @returns the placeholder value, nested token lists, and the end index; undefined for a plain `$`.
 */
function readExpansion(src, at, depth) {
  if (src[at] === '`') {
    let raw = '';
    let k = at + 1;
    while (k < src.length && src[k] !== '`') {
      if (src[k] === '\\' && k + 1 < src.length) {
        const next = src[k + 1];
        raw += next === '`' || next === '\\' || next === '$' ? next : `\\${next}`;
        k += 2;
      } else {
        raw += src[k];
        k += 1;
      }
    }
    return { value: DYNAMIC, subs: [lex(raw, 0, false, depth + 1).tokens], end: k + 1 };
  }
  if (src[at] !== '$') return undefined;
  if (src[at + 1] === '(' && src[at + 2] === '(') {
    let level = 0;
    let k = at + 1;
    for (; k < src.length; k += 1) {
      if (src[k] === '(') level += 1;
      else if (src[k] === ')') {
        level -= 1;
        if (level === 0) break;
      }
    }
    return { value: DYNAMIC, subs: [], end: k + 1 };
  }
  if (src[at + 1] === '(') {
    const inner = lex(src, at + 2, true, depth + 1);
    return { value: DYNAMIC, subs: [inner.tokens], end: inner.end };
  }
  if (src[at + 1] === '{') {
    let level = 0;
    let k = at + 1;
    for (; k < src.length; k += 1) {
      if (src[k] === '\\') k += 1;
      else if (src[k] === '{') level += 1;
      else if (src[k] === '}') {
        level -= 1;
        if (level === 0) break;
      }
    }
    return { value: DYNAMIC, subs: [], end: k + 1 };
  }
  return undefined;
}

/**
 * Read double-quoted text, or a whole unquoted heredoc body.
 * @param src - source text.
 * @param start - first index after the opening quote.
 * @param depth - recursion depth.
 * @param quote - closing character, or undefined to read to the end.
 * @returns the literal value, nested token lists, and the end index.
 */
function readDouble(src, start, depth, quote) {
  let value = '';
  const subs = [];
  let k = start;
  while (k < src.length) {
    const c = src[k];
    if (quote !== undefined && c === quote) return { value, subs, end: k + 1 };
    if (c === '\\') {
      const next = src[k + 1];
      if (next === '\n') {
        k += 2;
        continue;
      }
      value += next === '$' || next === '`' || next === '"' || next === '\\' ? next : `\\${next ?? ''}`;
      k += 2;
      continue;
    }
    if (c === '$' || c === '`') {
      const expansion = readExpansion(src, k, depth);
      if (expansion !== undefined) {
        value += expansion.value;
        subs.push(...expansion.subs);
        k = expansion.end;
        continue;
      }
    }
    value += c;
    k += 1;
  }
  return { value, subs, end: src.length };
}

/**
 * Read one shell word, removing quotes and collecting nested commands.
 * @param src - source text.
 * @param start - first index of the word.
 * @param depth - recursion depth.
 * @returns the unquoted value, nested token lists, quote flag, and end index.
 */
function readWord(src, start, depth) {
  let value = '';
  const subs = [];
  let quoted = false;
  let k = start;
  while (k < src.length) {
    const c = src[k];
    if ((c === '<' || c === '>') && src[k + 1] === '(') {
      const inner = lex(src, k + 2, true, depth + 1);
      subs.push(inner.tokens);
      value += DYNAMIC;
      k = inner.end;
      continue;
    }
    if (WORD_BREAK.has(c)) break;
    if (c === '\\') {
      if (src[k + 1] === '\n') {
        k += 2;
        continue;
      }
      value += src[k + 1] ?? '';
      quoted = true;
      k += 2;
      continue;
    }
    if (c === "'") {
      const close = src.indexOf("'", k + 1);
      const end = close < 0 ? src.length : close;
      value += src.slice(k + 1, end);
      quoted = true;
      k = end + 1;
      continue;
    }
    if (c === '$' && src[k + 1] === "'") {
      let end = k + 2;
      while (end < src.length && src[end] !== "'") end += src[end] === '\\' ? 2 : 1;
      value += src.slice(k + 2, end);
      quoted = true;
      k = end + 1;
      continue;
    }
    if (c === '"' || (c === '$' && src[k + 1] === '"')) {
      const text = readDouble(src, c === '"' ? k + 1 : k + 2, depth, '"');
      value += text.value;
      subs.push(...text.subs);
      quoted = true;
      k = text.end;
      continue;
    }
    if (c === '$' || c === '`') {
      const expansion = readExpansion(src, k, depth);
      if (expansion !== undefined) {
        value += expansion.value;
        subs.push(...expansion.subs);
        k = expansion.end;
        continue;
      }
    }
    value += c;
    k += 1;
  }
  return { value, subs, quoted, end: k };
}

/**
 * Match an operator, including a leading file-descriptor number.
 * @param src - source text.
 * @param at - token start.
 * @returns the operator text, or undefined.
 */
function readOperator(src, at) {
  let k = at;
  while (k < src.length && src[k] >= '0' && src[k] <= '9') k += 1;
  if (k > at && src[k] !== '<' && src[k] !== '>') return undefined;
  for (const op of OPERATORS) {
    if (src.startsWith(op, k)) return src.slice(at, k + op.length);
  }
  return undefined;
}

/**
 * Read the bodies of the heredocs opened on the line that just ended.
 * @param src - source text.
 * @param start - index after the newline.
 * @param records - heredocs in open order.
 * @param depth - recursion depth.
 * @returns the index after the last body.
 */
function readHeredocBodies(src, start, records, depth) {
  let k = start;
  for (const record of records) {
    const lines = [];
    while (k < src.length) {
      const newline = src.indexOf('\n', k);
      const end = newline < 0 ? src.length : newline;
      const line = src.slice(k, end);
      k = newline < 0 ? src.length : newline + 1;
      const text = record.strip ? line.replace(/^\t+/, '') : line;
      if (text.replace(/\r$/, '') === record.delimiter) break;
      lines.push(text);
    }
    record.body = lines.join('\n');
    if (!record.quoted) record.subs = readDouble(record.body, 0, depth + 1, undefined).subs;
  }
  return k;
}

/**
 * Split shell source into word and operator tokens.
 * @param src - source text.
 * @param start - first index.
 * @param inParen - stop after the `)` that closes a substitution.
 * @param depth - recursion depth.
 * @returns tokens and the index after the range.
 */
function lex(src, start, inParen, depth) {
  if (depth > MAX_DEPTH) throw new ScanDepthError('shell nesting too deep');
  const tokens = [];
  const pending = [];
  let heredocOp;
  let parens = 0;
  let k = start;
  while (k < src.length) {
    const c = src[k];
    if (c === ' ' || c === '\t' || c === '\r') {
      k += 1;
      continue;
    }
    if (c === '\\' && src[k + 1] === '\n') {
      k += 2;
      continue;
    }
    if (c === '\n') {
      tokens.push({ type: 'op', value: '\n' });
      k += 1;
      if (pending.length > 0) k = readHeredocBodies(src, k, pending.splice(0), depth);
      continue;
    }
    if (c === '#') {
      while (k < src.length && src[k] !== '\n') k += 1;
      continue;
    }
    if (inParen && c === ')' && parens === 0) return { tokens, end: k + 1 };
    const op = (c === '<' || c === '>') && src[k + 1] === '(' ? undefined : readOperator(src, k);
    if (op !== undefined) {
      if (op === '(') parens += 1;
      else if (op === ')') parens -= 1;
      const bare = op.replace(/^\d+/, '');
      if (bare === '<<' || bare === '<<-') heredocOp = bare;
      tokens.push({ type: 'op', value: bare });
      k += op.length;
      continue;
    }
    const word = readWord(src, k, depth);
    const token = { type: 'word', value: word.value, subs: word.subs };
    if (heredocOp !== undefined) {
      token.heredoc = { delimiter: word.value, strip: heredocOp === '<<-', quoted: word.quoted, body: '', subs: [] };
      pending.push(token.heredoc);
      heredocOp = undefined;
    }
    tokens.push(token);
    k = word.end > k ? word.end : k + 1;
  }
  return { tokens, end: src.length };
}

/**
 * Whether a word is a shell variable assignment.
 * @param word - unquoted word value.
 * @returns true for `NAME=value` and `NAME[i]+=value` forms.
 */
function isAssignment(word) {
  return /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(word);
}

/**
 * The basename of a command word.
 * @param word - unquoted word value.
 * @returns the text after the last slash.
 */
function baseName(word) {
  return word.slice(word.lastIndexOf('/') + 1);
}

/**
 * Skip a wrapper's options and fixed operands.
 * @param spec - wrapper description.
 * @param words - simple-command words.
 * @param start - index after the wrapper name.
 * @returns the index of the wrapped command.
 */
function skipWrapperOperands(spec, words, start) {
  let k = start;
  while (k < words.length) {
    const word = words[k];
    if (word === '--') {
      k += 1;
      break;
    }
    if (spec.assignments === true && isAssignment(word)) {
      k += 1;
      continue;
    }
    if (word.length > 1 && word.startsWith('-')) {
      k += spec.flags.includes(word) ? 2 : 1;
      continue;
    }
    break;
  }
  return Math.min(words.length, k + (spec.positional ?? 0));
}

/**
 * Collect the scripts a shell command runs.
 * @param words - simple-command words.
 * @param start - index after the shell name.
 * @param stdin - text the command receives on stdin.
 * @returns script sources to scan.
 */
function shellScripts(words, start, stdin) {
  for (let k = start; k < words.length; k += 1) {
    const word = words[k];
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(word)) return words[k + 1] === undefined ? [] : [words[k + 1]];
    if (word === '-' || word === '--') return stdin;
    if (word.startsWith('-') || word.startsWith('+')) {
      if (/^[-+][A-Za-z]*[oO]$/.test(word)) k += 1;
      continue;
    }
    // A script file operand: its content is not inspected.
    return [];
  }
  return stdin;
}

/**
 * Skip OpenSSH options, including clusters such as `-qp 22`.
 * @param words - simple-command words.
 * @param start - first candidate index.
 * @returns the index of the first non-option word.
 */
function skipSshOptions(words, start) {
  let k = start;
  while (k < words.length) {
    const word = words[k];
    if (word === '--' || word.length < 2 || !word.startsWith('-')) break;
    k += 1;
    if (/^-[A-Za-z0-9]+$/.test(word)) {
      const letters = word.slice(1);
      const valueAt = [...letters].findIndex((letter) => SSH_VALUE_FLAGS.includes(letter));
      // `-p 22` takes the next word; `-p22` and `-qp22` carry their value.
      if (valueAt === letters.length - 1) k += 1;
    }
  }
  return k;
}

/**
 * The remote command of an `ssh` call, which the remote shell runs.
 * @param words - simple-command words.
 * @param start - index after `ssh`.
 * @returns the remote command source, or undefined for an interactive login.
 */
function sshRemoteCommand(words, start) {
  let k = skipSshOptions(words, start);
  if (words[k] === '--') k += 1;
  k += 1; // destination
  k = skipSshOptions(words, k);
  if (words[k] === '--') k += 1;
  return k < words.length ? words.slice(k).join(' ') : undefined;
}

/**
 * Resolve one simple command and record every wait it runs.
 * @param command - words and stdin of the command.
 * @param previous - the pipeline stage feeding its stdin, if any.
 * @param found - result set.
 * @param depth - recursion depth.
 */
function resolveCommand(command, previous, found, depth) {
  const { words } = command;
  let k = 0;
  while (k < words.length) {
    const name = baseName(words[k]);
    const kind = WAIT_NAMES.get(name);
    if (kind !== undefined) {
      found.add(kind);
      if (kind === 'sleep') return;
      k = skipWrapperOperands(TIMEOUT_WRAPPER, words, k + 1);
      continue;
    }
    const wrapper = WRAPPERS.get(name);
    if (wrapper !== undefined) {
      k = skipWrapperOperands(wrapper, words, k + 1);
      continue;
    }
    if (SHELLS.has(name)) {
      const stdin = [...command.stdin];
      if (previous !== undefined) {
        stdin.push(...previous.stdin);
        if (PRINTERS.has(baseName(previous.words[0] ?? ''))) stdin.push(previous.words.slice(1).join(' '));
      }
      for (const script of shellScripts(words, k + 1, stdin)) scanSource(script, found, depth + 1);
      return;
    }
    if (name === 'eval') scanSource(words.slice(k + 1).join(' '), found, depth + 1);
    if (name === 'ssh') {
      // The remote wait still blocks this bash call.
      const remote = sshRemoteCommand(words, k + 1);
      if (remote !== undefined) scanSource(remote, found, depth + 1);
    }
    return;
  }
}

/**
 * Walk tokens, split simple commands, and resolve each one.
 * @param tokens - lexer output.
 * @param found - result set.
 * @param depth - recursion depth.
 */
function analyze(tokens, found, depth) {
  if (depth > MAX_DEPTH) throw new ScanDepthError('shell nesting too deep');
  let command = { words: [], stdin: [] };
  let previous;
  let redirect;
  let mode = 'command';
  let caseDepth = 0;

  const finish = (piped) => {
    resolveCommand(command, previous, found, depth);
    previous = piped ? command : undefined;
    command = { words: [], stdin: [] };
  };

  for (const token of tokens) {
    if (token.type === 'word') {
      for (const sub of token.subs) analyze(sub, found, depth + 1);
      if (token.heredoc !== undefined) {
        command.stdin.push(token.heredoc.body);
        for (const sub of token.heredoc.subs) analyze(sub, found, depth + 1);
      }
      if (redirect !== undefined) {
        if (redirect === '<<<') command.stdin.push(token.value);
        redirect = undefined;
        continue;
      }
      const word = token.value;
      if (mode === 'header') {
        if (word === 'do') mode = 'command';
        continue;
      }
      if (mode === 'case-word') {
        if (word === 'in') mode = 'case-pattern';
        continue;
      }
      if (mode === 'case-pattern') {
        if (word === 'esac') {
          caseDepth = Math.max(0, caseDepth - 1);
          mode = 'command';
        }
        continue;
      }
      if (mode === 'function-name') {
        mode = 'command';
        continue;
      }
      if (command.words.length === 0) {
        if (isAssignment(word) || RESERVED.has(word)) continue;
        if (word === 'esac') {
          caseDepth = Math.max(0, caseDepth - 1);
          continue;
        }
        if (word === 'for' || word === 'select') {
          mode = 'header';
          continue;
        }
        if (word === 'case') {
          caseDepth += 1;
          mode = 'case-word';
          continue;
        }
        if (word === 'function') {
          mode = 'function-name';
          continue;
        }
      }
      command.words.push(word);
      continue;
    }

    const op = token.value;
    if (REDIRECTS.has(op)) {
      redirect = op;
      continue;
    }
    if (mode === 'case-pattern') {
      if (op === ')') mode = 'command';
      continue;
    }
    if (mode === 'case-word') continue;
    if (mode === 'header' && (op === ';' || op === '\n')) mode = 'command';
    finish(op === '|' || op === '|&');
    if ((op === ';;' || op === ';&' || op === ';;&') && caseDepth > 0) mode = 'case-pattern';
  }
  finish(false);
}

/**
 * Scan one source text into the result set.
 * @param source - shell source.
 * @param found - result set.
 * @param depth - recursion depth.
 */
function scanSource(source, found, depth) {
  analyze(lex(source, 0, false, depth).tokens, found, depth);
}

/**
 * Find the shell waits a bash command would run.
 * @param command - bash command text.
 * @returns the native replacements needed, in discovery order: `sleep`, `timeout`, or both.
 */
export function findShellWaits(command) {
  const found = new Set();
  try {
    scanSource(String(command), found, 0);
  } catch (error) {
    if (!(error instanceof ScanDepthError)) throw error;
  }
  return [...found];
}
