/* main.js — UI: terminal, level management, goal pane, modals, progress. */
(function () {
'use strict';

const { JJEngine, canonState, diffStates } = window.JJ;
const { SEQUENCES, LEVELS } = window.LevelData;
const SEED = 20260712;

const $ = s => document.querySelector(s);
const termOut = $('#termOut');
const termInput = $('#termInput');
const mainSvg = $('#mainGraph');
const goalSvg = $('#goalGraph');

const state = {
  engine: null,
  level: null,        // null = sandbox
  goalState: null,
  goalCanon: null,
  solved: false,
  cmdCount: 0,
  history: [],
  histIdx: -1,
};

/* ---------------- progress (localStorage, optional) ---------------- */
function loadProgress() {
  try { return JSON.parse(localStorage.getItem('learnjj-progress') || '{}'); }
  catch { return {}; }
}
function saveProgress(p) {
  try { localStorage.setItem('learnjj-progress', JSON.stringify(p)); } catch {}
}

/* ---------------- terminal ---------------- */
function print(text, cls) {
  const div = document.createElement('div');
  div.className = 'tline' + (cls ? ' t-' + cls : '');
  div.textContent = text;
  termOut.appendChild(div);
  termOut.scrollTop = termOut.scrollHeight;
}
function printLines(lines) { for (const l of lines) print(l.t, l.c); }

function echo(cmd) { print('$ ' + cmd, 'cmd'); }

const HELP = [
  ['jj new [rev…] [-m msg]', 'start a change (multiple revs = merge; -B/-A rev = insert before/after)'],
  ['jj describe -m "msg"', 'describe @ (or -r rev)'],
  ['jj commit -m "msg"', 'describe @ and start the next change'],
  ['jj edit <rev>', 'make an existing change the working copy'],
  ['jj squash [-r rev]', 'fold a change into its parent'],
  ['jj abandon [rev…]', 'remove changes; descendants auto-rebase'],
  ['jj rebase (-r|-s|-b) <rev> -d <dest>', 'move one rev / a subtree / a branch'],
  ['jj bookmark create|set|move|delete|list', 'manage bookmarks'],
  ['jj duplicate [rev]', 'copy a change'],
  ['jj undo · jj op log', 'the operation log & repo-wide undo'],
  ['jj git push [-b name|--all] · jj git fetch', 'talk to origin (GitHub/GitLab)'],
  ['jj file untrack <file>', 'stop tracking a file (add it to .gitignore first)'],
  ['jj revert -r <rev> -d <dest>', 'create an inverse commit (for immutable history)'],
  ['echo <text> > <file> · cat <file> · ls · rm <file>', 'tiny shell — files snapshot into @ automatically'],
  ['jj log · jj st · jj resolve', 'inspect the repo / conflict help'],
  ['check', 'compare your graph with the goal and list what differs'],
  ['levels · hint · solution · reset · objective · clear', 'playground commands'],
];
function showHelp() {
  print('Commands in this playground:', 'ok');
  for (const [cmd, what] of HELP) { print('  ' + cmd, 'cmd2'); print('      ' + what, 'dim'); }
}

/* ---------------- level management ---------------- */
function replayEngine(cmds, remoteScript) {
  const e = new JJEngine(SEED);
  e.setRemoteScript(remoteScript || []);
  for (const c of cmds) e.run(c);
  return e;
}

function levelById(id) { return LEVELS.find(l => l.id === id); }
function levelIndex(lv) { return LEVELS.indexOf(lv); }

function loadLevel(lv, { showIntro = true } = {}) {
  state.level = lv;
  state.engine = replayEngine(lv.start, lv.remote);
  const goalEngine = replayEngine([...lv.start, ...lv.solution], lv.remote);
  state.goalState = goalEngine.getState();
  state.goalCanon = canonState(state.goalState, { checkWC: lv.checkWC !== false });
  state.solved = false;
  state.cmdCount = 0;
  window.GraphView.resetView(mainSvg);
  window.GraphView.resetView(goalSvg);
  location.hash = lv.id;

  const seq = SEQUENCES.find(s => s.id === lv.seq);
  $('#levelName').textContent = `${seq.title} · ${levelIndex(lv) + 1}. ${lv.title}`;
  $('#objectiveText').textContent = lv.objective;
  $('#goalPane').classList.remove('hidden');
  $('#winBanner').classList.add('hidden');
  document.body.classList.remove('sandbox');

  state.usesFiles = [...lv.start, ...lv.solution].some(c => /^(echo|rm|cat|ls)\b|jj file /.test(c));
  termOut.innerHTML = '';
  print(`— Level: ${lv.title} —`, 'ok');
  print('Objective: ' + lv.objective, 'dim');
  if (state.usesFiles) {
    print('This level has a mock working directory (see the "working dir" strip above).', 'dim');
    print('Interact with it:  ls · cat <file> · echo <content> > <file> · rm <file>', 'dim');
  }
  print('Type "help" for commands, "hint" if stuck.', 'dim');
  renderAll();
  if (showIntro) openIntro(lv);
  termInput.focus();
}

function loadSandbox() {
  state.level = null;
  state.engine = new JJEngine(SEED);
  state.usesFiles = true;
  state.goalState = null;
  state.solved = false;
  state.cmdCount = 0;
  window.GraphView.resetView(mainSvg);
  location.hash = 'sandbox';
  $('#levelName').textContent = 'Sandbox';
  $('#objectiveText').textContent = 'Free play — no goal. Every command is fair game.';
  $('#goalPane').classList.add('hidden');
  $('#winBanner').classList.add('hidden');
  document.body.classList.add('sandbox');
  termOut.innerHTML = '';
  print('— Sandbox — a fresh repo, no goal. Go wild.', 'ok');
  renderAll();
  termInput.focus();
}

function renderFiles() {
  const bar = $('#filesBar');
  const list = $('#filesList');
  const st = state.engine.getState();
  const wcChange = st.changes.find(c => c.id === st.wc);
  const tree = (wcChange && wcChange.tree) || {};
  const names = Object.keys(tree).sort();
  const show = names.length > 0 || state.usesFiles;
  bar.classList.toggle('hidden', !show);
  if (!show) return;
  list.innerHTML = '';
  if (!names.length) {
    const s = document.createElement('span');
    s.className = 'fileEmpty';
    s.textContent = 'empty — create a file:  echo hello > notes.txt';
    list.appendChild(s);
    return;
  }
  for (const n of names) {
    const conflicted = tree[n] === '!conflict';
    const chip = document.createElement('button');
    chip.className = 'fileChip' + (conflicted ? ' conflict' : '');
    chip.textContent = (conflicted ? '× ' : '') + n;
    chip.title = (conflicted ? 'unresolved conflict — ' : '') + 'click to cat ' + n;
    chip.onclick = () => exec('cat ' + n);
    list.appendChild(chip);
  }
}

function renderAll() {
  window.GraphView.render(mainSvg, state.engine.getState());
  if (state.level) window.GraphView.render(goalSvg, state.goalState, { small: true });
  renderFiles();
}

function runCheck() {
  if (!state.level) { print('No goal in the sandbox — nothing to compare.', 'dim'); return; }
  if (state.solved) { print('Already solved ✓ — keep experimenting or type "next".', 'ok'); return; }
  const msgs = diffStates(state.engine.getState(), state.goalState, { checkWC: state.level.checkWC !== false });
  if (!msgs.length) { print('Everything matches the goal!', 'ok'); checkWin(); return; }
  print('Comparing with the goal:', 'ok');
  msgs.forEach(m => print('  · ' + m, 'dim'));
}

function checkWin() {
  if (!state.level || state.solved) return;
  const canon = canonState(state.engine.getState(), { checkWC: state.level.checkWC !== false });
  if (canon !== state.goalCanon) {
    // Near-miss nudge: the shape matches but @ isn't where the goal wants it.
    const relaxedU = canonState(state.engine.getState(), { checkWC: false });
    const relaxedG = canonState(state.goalState, { checkWC: false });
    if (relaxedU === relaxedG) {
      print('Almost! The graph shape matches the goal — but @ is not where the goal wants it (compare the @ badge in the Goal panel). Type "check" for details.', 'dim');
    }
    return;
  }
  state.solved = true;
  const p = loadProgress();
  const prev = p[state.level.id];
  p[state.level.id] = { solved: true, best: Math.min(prev?.best ?? Infinity, state.cmdCount) };
  saveProgress(p);
  $('#winBanner').classList.remove('hidden');
  setTimeout(() => openWin(), 550);
}

/* ---------------- command execution ---------------- */
function exec(raw) {
  const line = raw.trim();
  if (!line) return;
  echo(line);
  state.history.push(line);
  state.histIdx = state.history.length;

  const bare = line.toLowerCase();
  if (bare === 'help' || bare === 'jj help' || bare === '?') return showHelp();
  if (bare === 'clear') { termOut.innerHTML = ''; return; }
  if (bare === 'levels') return openLevels();
  if (bare === 'reset') { state.level ? loadLevel(state.level, { showIntro: false }) : loadSandbox(); return; }
  if (bare === 'sandbox') return loadSandbox();
  if (bare === 'objective') { print('Objective: ' + ($('#objectiveText').textContent), 'ok'); return; }
  if (bare === 'check' || bare === 'compare') return runCheck();
  if (bare === 'hint') {
    print(state.level ? 'Hint: ' + state.level.hint : 'No hints in the sandbox — you make the rules.', 'dim');
    return;
  }
  if (bare === 'solution') {
    if (!state.level) { print('No solution in the sandbox.', 'dim'); return; }
    print('One solution (' + state.level.solution.length + ' commands):', 'ok');
    state.level.solution.forEach(c => print('  ' + c, 'cmd2'));
    return;
  }
  if (bare === 'next') {
    const idx = state.level ? levelIndex(state.level) : -1;
    if (idx >= 0 && idx + 1 < LEVELS.length) loadLevel(LEVELS[idx + 1]);
    else print('No next level — try "levels" or "sandbox".', 'dim');
    return;
  }
  if (bare.startsWith('git ') || bare === 'git') {
    print('This is a jj playground — but fair guess!', 'err');
    print('Hint: real jj works inside git repos too (jj git init --colocate). Try the jj spelling — e.g. jj git push. "help" lists commands.', 'dim');
    return;
  }
  if (!/^(jj|echo|cat|rm|ls)( |$)/.test(bare)) {
    print(`Unknown command "${line.split(' ')[0]}". Type "help".`, 'err');
    return;
  }

  const res = state.engine.run(line);
  printLines(res.lines);
  if (res.mutated) state.cmdCount++;
  renderAll();
  checkWin();
}

/* ---------------- modals ---------------- */
function openModal(id) { $('#' + id).classList.remove('hidden'); }
function closeModals() { document.querySelectorAll('.overlay').forEach(o => o.classList.add('hidden')); termInput.focus(); }

function openIntro(lv) {
  let idx = 0;
  const body = $('#introBody');
  const render = () => {
    body.innerHTML = lv.cards[idx];
    $('#introTitle').textContent = lv.title;
    $('#introDots').textContent = lv.cards.map((_, i) => (i === idx ? '●' : '○')).join(' ');
    $('#introPrev').disabled = idx === 0;
    $('#introNext').textContent = idx === lv.cards.length - 1 ? 'Start ▸' : 'Next ▸';
  };
  $('#introPrev').onclick = () => { if (idx > 0) { idx--; render(); } };
  $('#introNext').onclick = () => { if (idx < lv.cards.length - 1) { idx++; render(); } else closeModals(); };
  render();
  openModal('introModal');
}

function openWin() {
  const lv = state.level;
  const par = lv.solution.length;
  $('#winStats').textContent =
    `Solved in ${state.cmdCount} command${state.cmdCount === 1 ? '' : 's'} — par is ${par}.` +
    (state.cmdCount <= par ? ' 🏆 Optimal!' : '');
  const idx = levelIndex(lv);
  $('#winNext').style.display = idx + 1 < LEVELS.length ? '' : 'none';
  openModal('winModal');
}

function openLevels() {
  const wrap = $('#levelList');
  wrap.innerHTML = '';
  const progress = loadProgress();
  for (const seq of SEQUENCES) {
    const h = document.createElement('div');
    h.className = 'seqHeader';
    h.innerHTML = `<div class="seqTitle">${seq.title}</div><div class="seqBlurb">${seq.blurb}</div>`;
    wrap.appendChild(h);
    const grid = document.createElement('div');
    grid.className = 'levelGrid';
    LEVELS.filter(l => l.seq === seq.id).forEach(lv => {
      const solved = progress[lv.id]?.solved;
      const btn = document.createElement('button');
      btn.className = 'levelCard' + (solved ? ' solved' : '');
      btn.innerHTML = `<span class="lvNum">${levelIndex(lv) + 1}</span><span class="lvTitle">${lv.title}</span><span class="lvCheck">${solved ? '✓' : ''}</span>`;
      btn.onclick = () => { closeModals(); loadLevel(lv); };
      grid.appendChild(btn);
    });
    wrap.appendChild(grid);
  }
  const sand = document.createElement('button');
  sand.className = 'levelCard sandboxCard';
  sand.innerHTML = `<span class="lvNum">∞</span><span class="lvTitle">Sandbox — free play</span><span class="lvCheck"></span>`;
  sand.onclick = () => { closeModals(); loadSandbox(); };
  wrap.appendChild(sand);
  const credit = document.createElement('div');
  credit.className = 'creditLine';
  credit.innerHTML = `Format inspired by <a href="https://learngitbranching.js.org" target="_blank" rel="noreferrer">Learn Git Branching</a>
    by <a href="https://github.com/pcottle" target="_blank" rel="noreferrer">Peter Cottle</a> ♥
    · <a href="https://github.com/michael-smythe/learn-jj" target="_blank" rel="noreferrer">learn-jj source</a>`;
  wrap.appendChild(credit);
  openModal('levelsModal');
}

/* ---------------- wiring ---------------- */
termInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const v = termInput.value;
    termInput.value = '';
    exec(v);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (state.histIdx > 0) { state.histIdx--; termInput.value = state.history[state.histIdx] || ''; }
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (state.histIdx < state.history.length) { state.histIdx++; termInput.value = state.history[state.histIdx] || ''; }
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModals();
  if (document.activeElement !== termInput && !e.metaKey && !e.ctrlKey && !e.altKey &&
      e.key.length === 1 && !document.querySelector('.overlay:not(.hidden)')) {
    termInput.focus();
  }
});
$('#terminal').addEventListener('click', () => termInput.focus());

$('#btnLevels').onclick = openLevels;
$('#btnHint').onclick = () => exec('hint');
$('#btnReset').onclick = () => exec('reset');
$('#btnHelp').onclick = () => { showHelp(); termInput.focus(); };
$('#btnGoalToggle').onclick = () => $('#goalPane').classList.toggle('collapsed');
$('#btnIntroAgain').onclick = () => { if (state.level) openIntro(state.level); };
$('#winNext').onclick = () => { closeModals(); exec('next'); };
$('#winStay').onclick = closeModals;
$('#winLevels').onclick = () => { closeModals(); openLevels(); };
document.querySelectorAll('.overlay').forEach(o => {
  o.addEventListener('mousedown', e => { if (e.target === o) closeModals(); });
});
document.querySelectorAll('.modalClose').forEach(b => { b.onclick = closeModals; });

/* ---------------- boot ---------------- */
(function boot() {
  const hash = location.hash.replace('#', '');
  if (hash === 'sandbox') return loadSandbox();
  const lv = levelById(hash);
  if (lv) return loadLevel(lv);
  const progress = loadProgress();
  const firstUnsolved = LEVELS.find(l => !progress[l.id]?.solved) || LEVELS[0];
  loadLevel(firstUnsolved);
})();
})();
