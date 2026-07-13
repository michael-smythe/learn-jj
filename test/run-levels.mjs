// Validates every level: start state replays cleanly, the level is not
// already solved at load, and the published solution reaches the goal.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const JJ = require('../js/engine.js');
const { LEVELS } = require('../js/levels.js');

const SEED = 20260712;
let failures = 0;

function replay(cmds, label, remote) {
  const e = new JJ.JJEngine(SEED);
  e.setRemoteScript(remote || []);
  for (const cmd of cmds) {
    const res = e.run(cmd);
    if (!res.ok) {
      throw new Error(`${label}: command failed: ${cmd}\n  ${res.lines.map(l => l.t).join('\n  ')}`);
    }
  }
  return e;
}

for (const lv of LEVELS) {
  try {
    const startEngine = replay(lv.start, `${lv.id} start`, lv.remote);
    const goalEngine = replay([...lv.start, ...lv.solution], `${lv.id} goal`, lv.remote);
    const opts = { checkWC: lv.checkWC !== false };
    const startCanon = JJ.canonState(startEngine.getState(), opts);
    const goalCanon = JJ.canonState(goalEngine.getState(), opts);
    if (startCanon === goalCanon) {
      throw new Error(`${lv.id}: level is already solved at load!\n${startCanon}`);
    }
    // Replay solution on a fresh start engine (mirrors what a player does).
    const player = replay(lv.start, `${lv.id} player-start`, lv.remote);
    for (const cmd of lv.solution) {
      const res = player.run(cmd);
      if (!res.ok) throw new Error(`${lv.id}: solution command failed: ${cmd}\n  ${res.lines.map(l => l.t).join('\n  ')}`);
    }
    const playerCanon = JJ.canonState(player.getState(), opts);
    if (playerCanon !== goalCanon) {
      throw new Error(`${lv.id}: solution does not reach goal.\n--- player ---\n${playerCanon}\n--- goal ---\n${goalCanon}`);
    }
    console.log(`PASS  ${lv.id}  (par ${lv.solution.length})`);
  } catch (e) {
    failures++;
    console.error(`FAIL  ${lv.id}\n  ${e.message.split('\n').join('\n  ')}`);
  }
}

// A few engine unit checks beyond the levels.
function expect(cond, msg) {
  if (!cond) { failures++; console.error('FAIL  unit: ' + msg); }
  else console.log('PASS  unit: ' + msg);
}

{
  const e = new JJ.JJEngine(1);
  expect(!e.run('jj describe').ok, 'describe without -m errors');
  expect(!e.run('jj edit zz').ok, 'editing root is refused');
  expect(!e.run('jj abandon zz').ok, 'abandoning root is refused');
  expect(e.run('jj commit -m "A"').ok, 'commit works');
  expect(e.run('jj commit -m "B"').ok, 'second commit works');
  expect(!e.run('jj bogus').ok, 'unknown subcommand errors');
  const before = JSON.stringify(e.getState());
  expect(!e.run('jj rebase -s kk -d kk').ok, 'rebase onto itself errors');
  expect(JSON.stringify(e.getState()) === before, 'failed command leaves state untouched');
  expect(e.run('jj undo').ok, 'undo works');
  expect(e.run('jj undo').ok, 'second undo steps further back');
  expect(!e.run('jj undo').ok, 'undo past initial op errors');
}

{
  // @- and suffix revsets
  const e = new JJ.JJEngine(1);
  e.run('jj commit -m "A"');
  e.run('jj commit -m "B"');
  expect(e.resolve('@-') === e.resolve('desc(B)'), '@- resolves to parent');
  expect(e.resolve('@--') === e.resolve('desc(A)'), '@-- resolves to grandparent');
}

{
  // merge + squash guard
  const e = new JJ.JJEngine(1);
  e.run('jj commit -m "A"');
  e.run('jj new zz -m "B"');
  const r = e.run('jj new desc(A) desc(B) -m "M"');
  expect(r.ok, 'merge via jj new with two parents');
  expect(!e.run('jj squash').ok, 'squashing a merge is refused');
}

{
  // diffStates + near-miss nudge condition, on the basics-3 scenario:
  // player creates C correctly but then runs an extra command that moves @
  // onto a fresh empty change above C.
  const start = ['jj commit -m "A"', 'jj commit -m "B"'];
  const goal = new JJ.JJEngine(7);
  [...start, 'jj new kk -m "C"'].forEach(c => goal.run(c));
  const player = new JJ.JJEngine(7);
  [...start, 'jj new kk', 'jj commit -m "C"'].forEach(c => player.run(c));

  const diffs = JJ.diffStates(player.getState(), goal.getState(), {});
  expect(diffs.length > 0, 'near-miss produces diff messages');
  expect(diffs.some(m => m.includes('@')), 'near-miss diff mentions @');
  expect(
    JJ.canonState(player.getState(), { checkWC: false }) === JJ.canonState(goal.getState(), { checkWC: false }),
    'near-miss matches when ignoring @ (nudge condition)'
  );
  player.run('jj edit kn'); // C's change ID; empty leftover @ is auto-cleaned
  expect(
    JJ.canonState(player.getState(), { checkWC: true }) === JJ.canonState(goal.getState(), { checkWC: true }),
    'jj edit onto C completes the level after the near-miss'
  );
  expect(JJ.diffStates(player.getState(), goal.getState(), {}).length === 0, 'exact match yields no diffs');

  // wrong-parent case: C on B instead of A
  const wrong = new JJ.JJEngine(7);
  [...start, 'jj new kl -m "C"'].forEach(c => wrong.run(c));
  const wdiffs = JJ.diffStates(wrong.getState(), goal.getState(), {});
  expect(wdiffs.some(m => m.includes('"C"') && m.includes('"A"')), 'wrong-parent diff names the change and wanted parent');
}

{
  // Files: auto-snapshot, conflicts, resolution, untrack rules.
  const e = new JJ.JJEngine(3);
  e.run('echo apples > fruit.txt');
  e.run('jj commit -m "A"');
  e.run('echo bananas > fruit.txt');
  e.run('jj commit -m "B"');
  e.run('jj new kk -m "C"');
  e.run('echo cherries > fruit.txt');
  let st = e.getState();
  expect(st.changes.every(c => !c.conflicted), 'no conflicts before rebase');
  e.run('jj rebase -s kn -d kl');
  st = e.getState();
  const cNode = st.changes.find(c => c.desc === 'C');
  expect(cNode.conflicted, 'rebase onto divergent edit creates a conflict');
  expect(!!(cNode.tree['fruit.txt'] && typeof cNode.tree['fruit.txt'] === 'object'), 'conflicted tree value is marked');
  const cat = e.run('cat fruit.txt');
  expect(cat.ok && cat.lines.some(l => l.t.includes('<<<<<<<')), 'cat shows conflict markers');
  e.run('echo cherries > fruit.txt');
  st = e.getState();
  expect(!st.changes.find(c => c.desc === 'C').conflicted, 'writing the file resolves the conflict');
  expect(st.changes.find(c => c.desc === 'C').tree['fruit.txt'] === 'cherries', 'resolved value is kept');

  // untrack requires gitignore
  const u = new JJ.JJEngine(4);
  u.run('echo KEY > secrets.env');
  expect(!u.run('jj file untrack secrets.env').ok, 'untrack refused without .gitignore');
  u.run('echo secrets.env > .gitignore');
  expect(u.run('jj file untrack secrets.env').ok, 'untrack works once ignored');
  expect(!('secrets.env' in u.getState().changes.find(c => c.id === u.wc).tree), 'untracked file gone from @');
}

{
  // Remote: push guards, immutability, fetch tracking, stale chips.
  const e = new JJ.JJEngine(5);
  e.setRemoteScript([[{ on: 'main', desc: 'teammate', files: { 't.txt': 'x' } }]]);
  e.run('jj commit -m "A"');
  e.run('jj bookmark create main -r @-');
  {
    const r = e.run('jj git push');
    expect(r.ok && r.lines.some(l => l.t.includes('Refusing to create new remote bookmark')),
      'plain push refuses to create new remote branch (warning, like jj 0.43)');
  }
  expect(e.run('jj git push -b main').ok, 'push -b creates and tracks the branch');
  expect(!e.run('jj describe -r kk -m "rewrite"').ok, 'pushed trunk commit is immutable');
  expect(!e.run('jj edit kk').ok, 'cannot edit immutable commit');
  const before = e.getState().remoteBookmarks.main.id;
  expect(e.run('jj git fetch').ok, 'fetch works');
  const after = e.getState();
  expect(after.remoteBookmarks.main.id !== before, 'fetch moved main@origin');
  expect(after.bookmarks.main === after.remoteBookmarks.main.id, 'local main tracked the fetch');
  const f2 = e.run('jj git fetch');
  expect(f2.ok && f2.lines.some(l => l.t === 'Nothing changed.'), 'second fetch is a no-op');

  // pushing an undescribed commit is refused
  const p = new JJ.JJEngine(6);
  p.run('jj bookmark create feat');
  expect(!p.run('jj git push -b feat').ok, 'push refuses commits with no description');

  // stale remote chip after rewrite + revert inverse
  const q = new JJ.JJEngine(8);
  q.run('jj describe -m "F"');
  q.run('echo TOKEN > secrets.env');
  q.run('jj bookmark create feat');
  q.run('jj git push -b feat');
  expect(!q.getState().remoteBookmarks.feat.stale, 'freshly pushed branch is not stale');
  q.run('rm secrets.env');
  expect(q.getState().remoteBookmarks.feat.stale, 'rewriting a pushed commit marks remote stale');
  expect(q.run('jj git push').ok, 're-push after rewrite works');
  expect(!q.getState().remoteBookmarks.feat.stale, 're-push clears staleness');
}

{
  // Revert produces an inverse commit.
  const e = new JJ.JJEngine(9);
  e.run('echo v > app.js');
  e.run('jj commit -m "A"');
  e.run('echo KEY > secrets.env');
  e.run('jj commit -m "bad"');
  e.run('jj bookmark create main -r @-');
  e.run('jj git push -b main');
  expect(!e.run('jj edit kl').ok, 'trunk commit immutable after push');
  expect(e.run('jj revert -r kl -d main').ok, 'revert works');
  const st = e.getState();
  const rev = st.changes.find(c => c.desc.startsWith('Revert'));
  expect(rev && !('secrets.env' in rev.tree), 'revert removes the file from its tree');
  expect('secrets.env' in st.changes.find(c => c.desc === 'bad').tree, 'original commit still has the file (history preserved)');
}

{
  // Regressions from the adversarial review (2026-07).
  // F1: abandoning a merge @ plus both parents must not duplicate parents.
  const e = new JJ.JJEngine(1);
  ['jj commit -m "A"', 'jj describe -m "B"', 'jj new desc(A) -m "C"',
   'jj new desc(B) desc(C) -m "M"', 'jj abandon @ desc(B) desc(C)'].forEach(c => e.run(c));
  const wc = e.getState().changes.find(c => c.id === e.wc);
  expect(new Set(wc.parents).size === wc.parents.length, 'abandon(merge+parents) leaves no duplicate parents');

  // F2: rebase -r already at destination is a no-op even with children.
  const r = new JJ.JJEngine(2);
  ['jj commit -m "A"', 'jj commit -m "B"', 'jj commit -m "C"'].forEach(c => r.run(c));
  const before = JJ.canonState(r.getState());
  const out = r.run('jj rebase -r desc(A) -d root()');
  expect(out.ok && JJ.canonState(r.getState()) === before, 'rebase -r already-in-place changes nothing');

  // F8: jj commit cannot rewrite an immutable working copy.
  const im = new JJ.JJEngine(3);
  ['jj describe -m "F"', 'jj bookmark create main', 'jj git push -b main'].forEach(c => im.run(c));
  expect(!im.run('jj commit -m "sneaky rewrite"').ok, 'jj commit refuses immutable @');

  // F3: squash preserves the other side of a conflicted bookmark.
  const s = new JJ.JJEngine(4);
  s.setRemoteScript([[{ on: 'feat', desc: 'teammate', files: { 't.txt': 'x' } }]]);
  ['jj commit -m "base"', 'jj bookmark create feat -r @-', 'jj git push -b feat',
   'jj commit -m "mine1"', 'jj commit -m "mine2"', 'jj bookmark set feat -r @-',
   'jj git fetch'].forEach(c => s.run(c));
  s.run('jj squash -r desc(mine2)');
  const featVal = s.getState().bookmarks.feat;
  expect(typeof featVal === 'object' && featVal.conflict.length === 2, 'squash keeps conflicted bookmark conflicted');

  // F7/F9: undo of a fetch, then fetch again, restores cleanly (no crash, no dangle).
  const u = new JJ.JJEngine(5);
  u.setRemoteScript([[{ on: 'main', desc: 'teammate', files: { 't.txt': 'x' } }]]);
  ['jj commit -m "A"', 'jj bookmark create main -r @-', 'jj git push -b main'].forEach(c => u.run(c));
  expect(u.run('jj git fetch').ok && u.run('jj undo').ok, 'undo of fetch works');
  const refetch = u.run('jj git fetch');
  expect(refetch.ok && refetch.lines.some(l => l.t.includes('main@origin [updated]')), 're-fetch after undo restores the server state');

  // F9: abandoning a remote-referenced commit drops the view; fetch restores it.
  const a = new JJ.JJEngine(6);
  ['jj describe -m "F"', 'echo v > f.txt', 'jj bookmark create feat', 'jj git push -b feat'].forEach(c => a.run(c));
  a.run('jj abandon @');
  expect(!('feat' in a.getState().remoteBookmarks), 'abandon drops the dangling origin view');
  const back = a.run('jj git fetch');
  expect(back.ok && 'feat' in a.getState().remoteBookmarks, 'fetch respawns the abandoned-but-pushed commit');

  // F10: the hint's jj git push --deleted actually works.
  expect(a.run('jj bookmark delete feat').ok || true, 'setup: delete local feat');
  const del = a.run('jj git push --deleted');
  expect(del.ok && !('feat' in a.getState().remoteBookmarks), 'jj git push --deleted removes the remote branch');

  // F11: a literal file containing "!conflict" is not mistaken for a conflict.
  const lit = new JJ.JJEngine(7);
  lit.run('echo !conflict > f.txt');
  const tree = lit.getState().changes.find(c => c.id === lit.wc).tree;
  expect(tree['f.txt'] === '!conflict' && typeof tree['f.txt'] === 'string', 'literal !conflict content stays a string');

  // F15: anonymous file-only commits are visible to win detection.
  const w1 = new JJ.JJEngine(8); w1.run('jj commit -m "A"');
  const w2 = new JJ.JJEngine(8); w2.run('jj commit -m "A"');
  w2.run('echo junk > junk.txt'); w2.run('jj new');
  expect(JJ.canonState(w1.getState()) !== JJ.canonState(w2.getState()), 'anonymous file-bearing commits affect the canon');

  // F4: jj new --no-edit leaves @ in place.
  const ne = new JJ.JJEngine(9); ne.run('jj commit -m "A"');
  const wcBefore = ne.wc;
  expect(ne.run('jj new desc(A) --no-edit').ok && ne.wc === wcBefore, 'jj new --no-edit does not move @');
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll checks passed.');
