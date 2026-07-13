/*
 * conformance.mjs — checks that the simulator reacts the way real jj does.
 *
 * Replays each golden-transcript scenario (test/transcripts.json, generated
 * from the real jj binary by tools/gen-transcripts.mjs) through the simulator
 * and asserts, per step:
 *
 *   1. outcome parity — real success ⇒ simulator success, real error ⇒ error;
 *   2. message parity — every line real jj printed must appear in the
 *      simulator's output, after normalizing change IDs, hashes, timestamps,
 *      and emails. Extra simulator lines (playground pedagogy) are allowed.
 *
 * Steps whose output the playground intentionally simplifies (the jj log
 * graph, op log metadata, conflict-marker style) are checked for outcome
 * parity only.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const JJ = require('../js/engine.js');
const T = require('./transcripts.json');

const SEED = 777;

// Scripted "colleague" activity matching the git steps in remote scenarios.
const REMOTE_SCRIPTS = {
  'remote-fetch': [[{ on: 'main', desc: 'teammate: hotfix', files: { 'hotfix.txt': 'fix' } }]],
};

// Lines of real output the simulator does not (or cannot) mirror.
const IGNORE = [
  /^Added \d+ files, modified \d+ files, removed \d+ files$/,
  /^  tip: (a|some) similar subcommand/,   // clap suggestion sets/order differ
  /^Hint: For more information, see:/,     // doc URLs
  /^      - /,
  /^Hint: Rejected commit: «c» «h» \(no description set\)$/, // wc summary drift
];

// Steps checked for outcome only (playground intentionally differs).
const STATUS_ONLY = cmd =>
  cmd === 'jj log' || cmd.startsWith('jj log ') ||
  cmd.startsWith('jj op log') ||
  cmd.startsWith('sh: cat') ||
  cmd.startsWith('sh: git');

function normalize(text) {
  return text.split('\n').map(l => l
    .replace(/\b[0-9a-f]{8,64}\b/g, '«h»')
    .replace(/\b[k-z]{8}\b/g, '«c»')
    .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?(?: [+-]\d{2}:?\d{2})?/g, '«t»')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '«e»')
    .trimEnd()
  ).filter(l => l.trim().length);
}

function toSimCommand(cmd) {
  if (cmd.startsWith('sh: ')) {
    const body = cmd.slice(4);
    if (body.startsWith('echo ') || body.startsWith('cat ') || body.startsWith('rm ') || body === 'ls') return body;
    return null; // git plumbing for the fake colleague — handled by remote scripts
  }
  return cmd;
}

let failures = 0;
let checkedSteps = 0;
let checkedLines = 0;

for (const scenario of T.scenarios) {
  const engine = new JJ.JJEngine(SEED);
  engine.setRemoteScript(REMOTE_SCRIPTS[scenario.name] || []);
  for (const step of scenario.steps) {
    const sim = toSimCommand(step.cmd);
    if (sim === null) continue;
    const res = engine.run(sim);
    if (step.hidden) {
      if (!res.ok) {
        failures++;
        console.error(`FAIL  ${scenario.name} :: setup "${step.cmd}" failed in simulator:\n      ${res.lines.map(l => l.t).join('\n      ')}`);
      }
      continue;
    }
    checkedSteps++;
    const realOk = step.exit === 0;
    if (realOk !== res.ok) {
      failures++;
      console.error(`FAIL  ${scenario.name} :: "${step.cmd}" — real jj ${realOk ? 'succeeded' : 'errored'}, simulator ${res.ok ? 'succeeded' : 'errored'}`);
      continue;
    }
    if (STATUS_ONLY(step.cmd)) { console.log(`ok    ${scenario.name} :: ${step.cmd} (outcome only)`); continue; }

    const realLines = normalize(step.stdout + step.stderr).filter(l => !IGNORE.some(re => re.test(l)));
    const simLines = new Set(normalize(res.lines.map(x => x.t).join('\n')));
    const missing = realLines.filter(l => !simLines.has(l));
    checkedLines += realLines.length;
    if (missing.length) {
      failures++;
      console.error(`FAIL  ${scenario.name} :: "${step.cmd}" — simulator missing ${missing.length} line(s):`);
      missing.forEach(l => console.error(`        real: ${l}`));
      console.error(`      sim said:`);
      [...simLines].forEach(l => console.error(`        sim:  ${l}`));
    } else {
      console.log(`ok    ${scenario.name} :: ${step.cmd} (${realLines.length} lines)`);
    }
  }
}

console.log(`\nConformance vs ${T.version}: ${checkedSteps} steps, ${checkedLines} real output lines checked.`);
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('Simulator output conforms.');
