/**
 * Drives the real composer sink outside the browser.
 *
 * The sink is fed exactly what the runtime feeds it: `inputActions` as a prop,
 * and the draft through the `useInput` hook — a session slot is provided as
 * `ctx.uiSession.provide({ hooks: ['conversation', 'input'], props:
 * ['inputActions'] })`, so `props.input` does not exist. Reading it anyway makes
 * `setDraft` rewrite the draft from a phantom empty string and silently discard
 * whatever the user had typed.
 *
 * No browser, no React, no dependencies: a fake module loader captures the
 * client factory and stub hooks record the effect the sink registers.
 *
 *   node test/sink.test.mjs
 */
const CLIENT = new URL('../client.js', import.meta.url);

/* ------------------------------------------------------------------ *
 * stub React: one stable ref object per call-site, reused per render  *
 * ------------------------------------------------------------------ */

const refs = [];
let refIdx = 0;
let pendingEffect = null;

const React = {
  createElement: () => null,
  useRef: (initial) => {
    const i = refIdx++;
    if (!refs[i]) refs[i] = { current: initial };
    return refs[i];
  },
  useEffect: (fn) => { pendingEffect = fn; },
  useState: (value) => [value, () => {}],
  useCallback: (fn) => fn,
};

/* ------------------------------------------------------------------ *
 * load the real client half                                          *
 * ------------------------------------------------------------------ */

let definition = null;
globalThis.window = { __ModuleLoader__: { load(def) { definition = def; } } };
await import(CLIENT.href);
if (!definition) throw new Error('client.js never called __ModuleLoader__.load');

const plugin = definition.factory((name) => {
  if (name === 'react') return React;
  throw new Error('unexpected require: ' + name);
});

const registered = [];
plugin.apply({
  effect: (fn) => fn(),
  locale: { register: () => () => {}, bind: () => (key) => key },
  slots: {
    inject: (_slot, fn) => fn(),
    register: (options, Component) => {
      registered.push({ options, Component });
      return () => {};
    },
  },
});

const entry = registered.find((r) => r.options.id === 'quote-reply.sink');
if (!entry) throw new Error('the sink was never registered');
const QuoteSink = entry.Component;

/* ------------------------------------------------------------------ *
 * mount once, capture the handler the sink registers                  *
 * ------------------------------------------------------------------ */

let handler = null;
let liveInput = { draft: '', draftRev: 0, occurrences: [] };
const useInput = (select) => select(liveInput);

const realAdd = Set.prototype.add;
Set.prototype.add = function (value) {
  if (typeof value === 'function' && handler === null) handler = value;
  return realAdd.call(this, value);
};
refIdx = 0;
QuoteSink({ inputActions: {}, useInput });
pendingEffect();
Set.prototype.add = realAdd;
if (!handler) throw new Error('the sink registered no handler');

/* ------------------------------------------------------------------ *
 * drive it                                                           *
 * ------------------------------------------------------------------ */

function dispatch(options) {
  const {
    raw = 'hello',
    draft = '',
    draftRev = 5,
    occurrences = [],
    span,
    captureThrows = false,
    setDraftThrows = false,
    withoutActions = false,
    withoutUseInput = false,
  } = options;

  liveInput = { draft, draftRev, occurrences };

  const calls = [];
  const actions = {
    captureInsertion() {
      if (captureThrows) throw new Error('editor unavailable');
      return span === undefined ? null : span;
    },
    setDraft(text) {
      calls.push(['setDraft', text]);
      if (setDraftThrows) throw new Error('stale draft');
    },
    insertText(text, captured) {
      calls.push(['insertText', text, captured]);
      return true;
    },
  };

  const props = { useInput };
  if (!withoutActions) props.inputActions = actions;
  if (withoutUseInput) delete props.useInput;

  refIdx = 0;
  QuoteSink(props);
  return { accepted: handler(raw), calls };
}

const MID = { start: 1, end: 1, draftRev: 5 };
const END = { start: 3, end: 3, draftRev: 5 };
const show = (calls) => JSON.stringify(calls.map(([name, text]) => [name, text]));

/* name, options, expected first call, expected first argument, expected last call */
const cases = [
  ['empty draft, caret at 0', { draft: '', span: { start: 0, end: 0, draftRev: 5 } }, 'setDraft', '> hello\n\n'],
  ['typed draft, caret at 1 (mid-draft)', { draft: 'abc', span: MID }, 'setDraft', 'a\n> hello\n\nbc'],
  ['typed draft, caret at the end', { draft: 'abc', span: END }, 'setDraft', 'abc\n> hello\n\n'],
  ['typed draft survives when the caret is unknown', { draft: 'already typed', span: null }, 'setDraft', 'already typed\n> hello\n\n'],
  ['unknown draft never rewrites the draft', { draft: 'x', withoutUseInput: true, span: MID }, 'insertText', null, { never: 'setDraft' }],
  ['stale caret revision falls back to the end', { draft: 'abc', span: { start: 1, end: 1, draftRev: 4 } }, 'setDraft', 'abc\n> hello\n\n'],
  ['editor throwing falls back to the end', { draft: 'abc', captureThrows: true }, 'setDraft', 'abc\n> hello\n\n'],
  ['an open selection falls back to the end', { draft: 'abc', span: { start: 0, end: 2, draftRev: 5 } }, 'setDraft', 'abc\n> hello\n\n'],
  ['a reference chip keeps the insert path', { draft: '@x', occurrences: [{}], span: MID }, 'insertText', null, { never: 'setDraft' }],
  ['a throwing setDraft degrades to insertText', { draft: 'abc', span: END, setDraftThrows: true }, 'setDraft', null, { last: 'insertText' }],
  ['blank selection is refused', { raw: '   \n  ' }, 'none', null],
  ['a missing inputActions is refused', { withoutActions: true }, 'none', null],
];

let failures = 0;
for (const [name, options, firstCall, firstArg, extra] of cases) {
  let result;
  try {
    result = dispatch(options);
  } catch (err) {
    console.log(`FAIL  ${name} — threw: ${err.message}`);
    failures++;
    continue;
  }

  const first = result.calls.length ? result.calls[0][0] : 'none';
  const last = result.calls.length ? result.calls[result.calls.length - 1][0] : 'none';
  let ok = first === firstCall;
  if (ok && firstArg !== null && firstArg !== undefined) ok = result.calls[0][1] === firstArg;
  if (ok && extra?.last) ok = last === extra.last;
  if (ok && extra?.never) ok = !result.calls.some(([called]) => called === extra.never);

  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  console.log(`        accepted=${result.accepted}  calls=${show(result.calls)}`);
  if (!ok) {
    failures++;
    if (firstArg !== null && firstArg !== undefined) console.log(`        expected ${firstCall}(${JSON.stringify(firstArg)})`);
    if (extra?.last) console.log(`        expected last call ${extra.last}`);
    if (extra?.never) console.log(`        expected ${extra.never} never to be called`);
  }
}

console.log(failures === 0 ? `\n${cases.length}/${cases.length} passed` : `\n${failures} failing`);
process.exit(failures === 0 ? 0 : 1);
