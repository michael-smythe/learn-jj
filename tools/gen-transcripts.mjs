/*
 * gen-transcripts.mjs — golden-transcript generator.
 *
 * Runs the REAL jj binary through scripted scenarios in throwaway repos and
 * records each command's verbatim stdout/stderr into test/transcripts.json.
 * The conformance test (test/conformance.mjs) then checks that the simulator
 * reacts the way real jj does. Fixtures are committed, so the test suite does
 * not require jj to be installed — only regeneration does.
 *
 *   node tools/gen-transcripts.mjs
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'transcripts.json');

const JJ_BASE = [
  '--color', 'never',
  '--config', 'user.name="Learn JJ"',
  '--config', 'user.email="learn@example.com"',
  '--config', 'ui.paginate="never"',
  '--config', 'ui.editor="true"',
];
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Colleague', GIT_AUTHOR_EMAIL: 'col@example.com',
  GIT_COMMITTER_NAME: 'Colleague', GIT_COMMITTER_EMAIL: 'col@example.com',
};

function tokenize(line) {
  const toks = []; let cur = ''; let q = null; let pending = false;
  for (const ch of line) {
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === '"' || ch === "'") { q = ch; pending = true; }
    else if (/\s/.test(ch)) { if (cur || pending) { toks.push(cur); cur = ''; pending = false; } }
    else cur += ch;
  }
  if (cur || pending) toks.push(cur);
  return toks;
}

/*
 * Scenario steps:
 *   'jj …'            → run real jj (tokenized, no shell)
 *   'sh: …'           → run through /bin/sh -c (file writes, git, etc.)
 *   { in: 'sub', run } → run in a sibling directory instead of repo/
 * Steps prefixed with '#' set up state without being recorded.
 */
const SCENARIOS = [
  {
    name: 'basics-describe-new',
    steps: ['jj st', 'jj describe -m "A"', 'jj new', 'jj log'],
  },
  {
    name: 'commit-flow',
    steps: ['jj commit -m "A"', 'jj commit -m "B"', 'jj log'],
  },
  {
    name: 'new-on-rev-auto-abandon',
    steps: [
      '#jj commit -m "A"', '#jj commit -m "B"',
      'jj new subject("A") -m "C"', 'jj log',
    ],
  },
  {
    name: 'squash',
    steps: [
      '#jj commit -m "A"', '#jj commit -m "B"', '#jj commit -m "C"',
      'jj squash -r subject("B")', 'jj log',
    ],
  },
  {
    name: 'abandon-heals-descendants',
    steps: [
      '#jj commit -m "A"', '#jj commit -m "experiment"', '#jj commit -m "B"',
      'jj abandon subject("experiment")', 'jj log',
    ],
  },
  {
    name: 'rebase-s',
    steps: [
      '#jj commit -m "A"', '#jj commit -m "B"', '#jj bookmark create main -r @-',
      '#jj new subject("A") -m "C"', '#jj new -m "D"',
      'jj rebase -s subject("C") -d main', 'jj log',
    ],
  },
  {
    name: 'rebase-r-extract',
    steps: [
      '#jj commit -m "A"', '#jj commit -m "B"', '#jj commit -m "C"', '#jj commit -m "D"',
      'jj rebase -r subject("B") -d subject("D")', 'jj log',
    ],
  },
  {
    name: 'merge-two-parents',
    steps: [
      '#jj commit -m "A"', '#jj commit -m "B"', '#jj new subject("A") -m "C"',
      'jj new subject("B") subject("C") -m "M"', 'jj log',
      'jj squash -r subject("M")',
    ],
  },
  {
    name: 'bookmarks',
    steps: [
      '#jj commit -m "A"', '#jj commit -m "B"',
      'jj bookmark create main -r subject("B")',
      'jj bookmark create main -r subject("A")',
      'jj bookmark set main -r subject("A")',
      'jj bookmark move main --to subject("B")',
      'jj bookmark list',
      'jj bookmark delete main',
      'jj bookmark delete nope',
    ],
  },
  {
    name: 'undo-oplog',
    steps: [
      '#jj commit -m "A"', '#jj commit -m "B"',
      'jj abandon subject("B")',
      'jj undo',
      'jj undo',
      'jj undo',
      'jj op log --limit 6',
      'jj log',
    ],
  },
  {
    name: 'immutability-root',
    steps: [
      'jj edit root()',
      'jj describe -r root() -m "x"',
      'jj abandon root()',
    ],
  },
  {
    name: 'clap-errors',
    steps: [
      'jj comit -m "A"',
      'jj new --bogus',
      'jj rebase -d',
      'jj bookmark create',
      'jj edit',
    ],
  },
  {
    name: 'duplicate',
    steps: ['#jj commit -m "A"', '#jj commit -m "B"', 'jj duplicate subject("B")', 'jj log'],
  },
  {
    name: 'conflict-rebase-resolve',
    steps: [
      'sh: echo apples > fruit.txt', '#jj commit -m "A"',
      'sh: echo bananas > fruit.txt', '#jj commit -m "B"',
      '#jj new subject("A") -m "C"', 'sh: echo cherries > fruit.txt',
      'jj rebase -s subject("C") -d subject("B")',
      'jj st',
      'sh: cat fruit.txt',
      'jj log',
      'sh: echo cherries > fruit.txt',
      'jj st',
      'jj log',
    ],
  },
  {
    name: 'untrack',
    steps: [
      'sh: echo KEY=123 > secrets.env',
      'jj file untrack secrets.env',
      'sh: echo secrets.env > .gitignore',
      'jj file untrack secrets.env',
      'jj st',
    ],
  },
  {
    name: 'remote-push',
    setupOrigin: true,
    steps: [
      '#jj commit -m "A"', '#jj commit -m "B"',
      '#jj bookmark create main -r @-',
      'jj git push',
      'jj git push --bookmark main',
      'jj git push --bookmark main',
      'jj describe -r subject("A") -m "rewrite attempt"',
      'jj bookmark create feat',
      'jj git push --bookmark feat',
      'jj log',
    ],
  },
  {
    name: 'remote-feature-loop',
    setupOrigin: true,
    steps: [
      '#jj commit -m "A"', '#jj bookmark create main -r @-', '#jj git push --bookmark main',
      '#jj new main -m "F1"', '#jj bookmark create feat', '#jj git push --bookmark feat',
      'jj describe -m "F1 v2"',
      'jj git push',
      'jj bookmark set main -r @',
      'jj log',
    ],
  },
  {
    name: 'remote-fetch',
    setupOrigin: true,
    steps: [
      '#jj commit -m "A"', '#jj bookmark create main -r @-', '#jj git push --bookmark main',
      { in: '.', run: 'sh: git clone -q origin.git colleague' },
      { in: 'colleague', run: 'sh: echo fix > hotfix.txt && git add -A && git commit -qm "teammate: hotfix" && git push -q' },
      'jj git fetch',
      'jj log',
      'jj git fetch',
    ],
  },
];

function runScenario(scenario) {
  const root = mkdtempSync(join(tmpdir(), 'jj-transcript-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  spawnSync('jj', [...JJ_BASE, 'git', 'init'], { cwd: repo, env: GIT_ENV });
  if (scenario.setupOrigin) {
    spawnSync('git', ['init', '--bare', '-q', join(root, 'origin.git')], { env: GIT_ENV });
    spawnSync('jj', [...JJ_BASE, 'git', 'remote', 'add', 'origin', join(root, 'origin.git')], { cwd: repo, env: GIT_ENV });
  }

  const steps = [];
  for (let raw of scenario.steps) {
    let cwd = repo;
    if (typeof raw === 'object') {
      cwd = raw.in === '.' ? root : join(root, raw.in);
      raw = raw.run;
    }
    const hidden = raw.startsWith('#');
    const cmd = hidden ? raw.slice(1) : raw;
    let res;
    if (cmd.startsWith('sh: ')) {
      res = spawnSync('/bin/sh', ['-c', cmd.slice(4)], { cwd, env: GIT_ENV, encoding: 'utf8' });
    } else {
      const toks = tokenize(cmd);
      if (toks[0] !== 'jj') throw new Error('bad step: ' + cmd);
      res = spawnSync('jj', [...JJ_BASE, ...toks.slice(1)], { cwd, env: GIT_ENV, encoding: 'utf8' });
    }
    if (!hidden) {
      steps.push({
        cmd,
        exit: res.status,
        stdout: res.stdout || '',
        stderr: res.stderr || '',
      });
    } else {
      if (res.status !== 0) {
        throw new Error(`setup step failed in ${scenario.name}: ${cmd}\n${res.stderr}`);
      }
      steps.push({ cmd, hidden: true });
    }
  }
  rmSync(root, { recursive: true, force: true });
  return { name: scenario.name, steps };
}

const version = spawnSync('jj', ['--version'], { encoding: 'utf8' }).stdout.trim();
console.log(`Generating transcripts with ${version} …`);
const scenarios = SCENARIOS.map(s => {
  const r = runScenario(s);
  console.log(`  ${s.name}: ${r.steps.length} steps`);
  return r;
});
writeFileSync(OUT, JSON.stringify({ version, generated: new Date().toISOString(), scenarios }, null, 2));
console.log(`Wrote ${OUT}`);
