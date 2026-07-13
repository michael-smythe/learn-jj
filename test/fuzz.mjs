/*
 * fuzz.mjs — property-based checks on the engine.
 *
 * 1. Determinism: same seed + same commands ⇒ byte-identical state.
 * 2. No-throw: random command soup never throws (errors must surface as
 *    {ok: false}, never exceptions), and every step preserves invariants:
 *    parents exist, the graph is acyclic, @ exists, bookmarks point at live
 *    changes.
 * 3. Undo round-trip: after any command sequence, undoing all the way back
 *    reproduces the initial canonical state (the op log's core promise).
 * 4. Tokenizer / flag-parser unit cases.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const JJ = require('../js/engine.js');

let failures = 0;
function expect(cond, msg) {
  if (!cond) { failures++; console.error('FAIL  ' + msg); }
  else console.log('PASS  ' + msg);
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- determinism ---------------- */
{
  const script = [
    'jj commit -m "A"', 'echo v1 > f.txt', 'jj commit -m "B"',
    'jj new kk -m "C"', 'echo v2 > f.txt', 'jj bookmark create feat',
    'jj git push -b feat', 'jj rebase -s kn -d kl', 'echo v2 > f.txt',
    'jj git fetch', 'jj undo', 'jj absorb', 'jj st',
  ];
  const a = new JJ.JJEngine(99), b = new JJ.JJEngine(99);
  const remote = [[{ on: 'feat', desc: 'teammate', files: { 't.txt': 'x' } }]];
  a.setRemoteScript(remote); b.setRemoteScript(remote);
  for (const c of script) { a.run(c); b.run(c); }
  expect(JSON.stringify(a.getState()) === JSON.stringify(b.getState()),
    'determinism: same seed + commands => identical state');
}

/* ---------------- invariants ---------------- */
function checkInvariants(engine, step, seed) {
  const st = engine.getState();
  const ids = new Set(st.changes.map(c => c.id));
  for (const c of st.changes) {
    for (const p of c.parents) {
      if (!ids.has(p)) throw new Error(`step ${step} seed ${seed}: ${c.id} has missing parent ${p}`);
    }
    if (new Set(c.parents).size !== c.parents.length) {
      throw new Error(`step ${step} seed ${seed}: ${c.id} has duplicate parents [${c.parents}]`);
    }
  }
  // Remote view must never dangle.
  for (const [name, ref] of Object.entries(st.remoteBookmarks)) {
    if (!ids.has(ref.id)) throw new Error(`step ${step} seed ${seed}: ${name}@origin dangles at ${ref.id}`);
  }
  if (!ids.has(st.wc)) throw new Error(`step ${step} seed ${seed}: @ points at missing change ${st.wc}`);
  for (const [name, val] of Object.entries(st.bookmarks)) {
    const targets = typeof val === 'string' ? [val] : val.conflict;
    for (const t of targets) {
      if (!ids.has(t)) throw new Error(`step ${step} seed ${seed}: bookmark ${name} targets missing ${t}`);
    }
  }
  // Acyclicity: Kahn must consume every node.
  const indeg = new Map(st.changes.map(c => [c.id, c.parents.length]));
  const kids = new Map(st.changes.map(c => [c.id, []]));
  for (const c of st.changes) for (const p of c.parents) kids.get(p).push(c.id);
  const q = st.changes.filter(c => !c.parents.length).map(c => c.id);
  let seen = 0;
  while (q.length) {
    const cur = q.shift(); seen++;
    for (const k of kids.get(cur)) { indeg.set(k, indeg.get(k) - 1); if (!indeg.get(k)) q.push(k); }
  }
  if (seen !== st.changes.length) throw new Error(`step ${step} seed ${seed}: graph has a cycle`);
}

/* ---------------- random command soup + undo round-trip ---------------- */
function fuzzRun(seed, steps) {
  const rnd = mulberry32(seed);
  const pick = arr => arr[Math.floor(rnd() * arr.length)];
  const e = new JJ.JJEngine(seed);
  e.setRemoteScript([[{ on: 'main', desc: 'teammate', files: { 't.txt': 'x' } }]]);
  const initialCanon = JJ.canonState(e.getState());

  const files = ['a.txt', 'b.txt', '.gitignore'];
  const names = ['main', 'feat', 'wip'];
  for (let i = 0; i < steps; i++) {
    const st = e.getState();
    const anyId = () => pick(st.changes).id;
    const cmds = [
      () => `jj commit -m "c${i}"`,
      () => 'jj new',
      () => `jj new ${anyId()}`,
      () => `jj new ${anyId()} ${anyId()} -m "m${i}"`,
      () => `jj edit ${anyId()}`,
      () => `jj describe -r ${anyId()} -m "d${i}"`,
      () => `jj abandon ${anyId()}`,
      () => `jj squash -r ${anyId()}`,
      () => `jj rebase -r ${anyId()} -d ${anyId()}`,
      () => `jj rebase -s ${anyId()} -d ${anyId()}`,
      () => `jj duplicate ${anyId()}`,
      () => `echo v${i} > ${pick(files)}`,
      () => `rm ${pick(files)}`,
      () => `jj file untrack ${pick(files)}`,
      () => 'jj absorb',
      () => `jj split ${pick(files)}`,
      () => `jj bookmark create ${pick(names)} -r ${anyId()}`,
      () => `jj bookmark set ${pick(names)} -r ${anyId()}`,
      () => `jj bookmark delete ${pick(names)}`,
      () => 'jj git push --all',
      () => 'jj git push',
      () => 'jj git fetch',
      () => 'jj undo',
      () => 'jj st',
      () => 'jj log',
    ];
    const cmd = pick(cmds)();
    const res = e.run(cmd);           // throws => fuzz failure
    if (typeof res.ok !== 'boolean') throw new Error(`step ${i}: run() returned malformed result for: ${cmd}`);
    checkInvariants(e, i, seed);
  }
  // Undo everything; must land exactly on the initial state.
  let guard = 0;
  while (e.run('jj undo').ok) {
    if (++guard > steps + 50) throw new Error(`seed ${seed}: undo did not terminate`);
  }
  const finalCanon = JJ.canonState(e.getState());
  if (finalCanon !== initialCanon) {
    throw new Error(`seed ${seed}: undo round-trip mismatch\n--- initial ---\n${initialCanon}\n--- after undo-all ---\n${finalCanon}`);
  }
}

for (const seed of [7, 1234, 987654]) {
  try {
    fuzzRun(seed, 150);
    expect(true, `fuzz seed ${seed}: 150 commands, invariants + undo round-trip`);
  } catch (err) {
    expect(false, `fuzz seed ${seed}: ${err.message}`);
  }
}

/* ---------------- tokenizer / parser units ---------------- */
{
  const t = JJ.tokenize;
  expect(JSON.stringify(t('jj describe -m "hello world"')) === '["jj","describe","-m","hello world"]', 'tokenize: quoted strings');
  expect(JSON.stringify(t('jj describe -m ""')) === '["jj","describe","-m",""]', 'tokenize: empty quoted string survives');
  expect(JSON.stringify(t("echo a  b   > f")) === '["echo","a","b",">","f"]', 'tokenize: whitespace runs collapse');
  const e = new JJ.JJEngine(1);
  expect(e.run('jj describe -m=inline').ok, 'parseArgs: --flag=value form');
  expect(!e.run('jj new --bogus').ok, 'parseArgs: unknown flag is a clap error');
  expect(!e.run('jj rebase -d').ok, 'parseArgs: missing flag value is a clap error');
  expect(!e.run('jj describe -m').ok, 'parseArgs: dangling -m is a clap error');
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nFuzz + determinism checks passed.');
