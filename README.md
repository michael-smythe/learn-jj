# learn-jj

[![CI](https://github.com/michael-smythe/learn-jj/actions/workflows/ci.yml/badge.svg)](https://github.com/michael-smythe/learn-jj/actions/workflows/ci.yml)
[![jj-drift](https://github.com/michael-smythe/learn-jj/actions/workflows/jj-drift.yml/badge.svg)](https://github.com/michael-smythe/learn-jj/actions/workflows/jj-drift.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Live site: https://michael-smythe.github.io/learn-jj/**

An interactive website for learning [Jujutsu (jj)](https://jj-vcs.github.io/jj/latest/),
in the spirit of [Learn Git Branching](https://learngitbranching.js.org): type jj commands
in a terminal, watch the change graph respond, match the goal state to clear each level.

## What it teaches

34 levels across 11 sequences:

1. **The Basics** — the working copy as a commit (`@`), `describe`, `new`, `commit`,
   `squash`, `abandon`, and automatic descendant rebasing.
2. **Bookmarks** — `bookmark create/set`, why they don't move on their own, and the
   anonymous-heads workflow (name things only when they leave your machine).
3. **Moving Work Around** — `rebase -s`, `rebase -r` (commit extraction), merges via
   `jj new` with multiple parents.
4. **Superpowers** — the operation log and `jj undo`, `jj new -B` insertion, and a
   combined finale.
5. **Files & the Auto-Snapshot** — no staging area or untracked state; keeping files
   out with `.gitignore` + `jj file untrack`; editing file content deep in history.
6. **GitHub & GitLab** — bookmarks as remote branches: `jj git push -b <name>` and
   tracked bookmarks, the PR-fixup loop (rewrite + repush, no force-push ritual),
   `jj git fetch` + rebase onto a moving trunk, and trunk immutability (◆).
7. **Conflicts Without Fear** — conflicts recorded inside commits: rebases/merges
   never stop, `cat` shows real conflict markers, resolving once heals whole stacks.
8. **Oops: Secrets & History Surgery** — removing a secret before pushing, from a
   pushed feature branch (rewrite + repush), and from immutable trunk (`jj revert`
   + rotate the credential).
9. **History Surgery II** — `jj absorb` (auto-amend into the right ancestors),
   `jj split` by paths, and backporting with `jj duplicate` + rebase.
10. **The jj ⨯ git Field Guide** — why `jj undo` cannot un-push (the op log is
    local; fetch proves it); colocated-repo survival: detached HEAD is normal,
    read-only git is safe, history-rewriting git commands are not; bookmark
    conflicts (`main??`) when both sides move a branch; and divergent changes
    (`??`, two commits sharing a change ID) with the pick-a-side recovery.
11. **Graduation** — a full day: fetch, rebase onto a moved trunk, resolve the
    conflict at the source, absorb a review fix, push.

Plus a free-play sandbox (`sandbox` in the terminal or via level select).

## Running

It's a static site — no build step, no dependencies:

```sh
npm start          # python3 -m http.server 8677 -d .
# open http://localhost:8677
```

## How it works

- `js/compare.js` — structural state comparison: reduces a repo to its significant
  nodes (descriptions, bookmarks, @, file trees) so win detection ignores incidental
  IDs, and produces the plain-English diffs behind the `check` command.
- `js/engine.js` — a teaching simulator of jj's model: changes with stable change IDs and
  rewritable commit IDs, revsets (`@`, `@-`, prefixes, bookmarks, `description(x)`),
  auto-rebase of descendants, auto-cleanup of empty undescribed working copies, and a
  snapshot-based operation log powering `jj undo` / `jj op log`. Files are modelled as
  per-change patches (`{from, to}` per file) with 3-way-merge tree computation, so
  rebases and merges produce jj-style in-commit conflicts that descendants inherit and
  resolution heals. A simulated `origin` remote provides `jj git push/fetch`, stale-branch
  tracking, scripted "teammate" activity per level, and trunk-based immutability.
- `js/graph.js` — SVG DAG renderer with tweened layout transitions (root at bottom,
  like `jj log` upside-down-free).
- `js/levels.js` — level definitions. Start states replay on a seeded engine, so change
  IDs are deterministic (`kk`, `kl`, `km`, … in creation order) and solutions can
  reference them literally. Goals are derived by replaying start + solution, so every
  goal is reachable by construction.
- `js/main.js` — terminal, level flow, win detection (structural graph comparison that
  ignores IDs), progress in localStorage.

## Tests

```sh
npm test                    # all three suites
npm run test:levels         # every level solution reaches its goal + engine units
npm run test:conformance    # simulator output vs real-jj golden transcripts
npm run test:fuzz           # determinism, invariants, undo round-trips, parser units
```

`run-levels` validates that every level's start state replays, isn't already solved at
load, and that the published solution reaches the goal — plus engine unit checks.

`conformance` replays golden transcripts captured from the **real jj binary**
(`test/transcripts.json`) through the simulator and asserts outcome parity (success vs
error) and message parity (every line real jj printed must appear in the simulator's
output, after normalizing IDs/hashes/timestamps).

`fuzz` runs hundreds of random command sequences asserting the engine never throws,
graph invariants hold after every command, same-seed runs are byte-identical, and
undoing everything always reproduces the initial state.

CI (`.github/workflows/ci.yml`) runs all three on every push — the fixtures are
committed, so CI needs no jj binary.

## Keeping up with new jj releases

The simulator imitates a specific jj version (recorded in `test/transcripts.json`).
When jj ships a new release:

```sh
brew upgrade jj        # or however you install jj
npm run transcripts    # re-capture golden transcripts from the real binary
npm test               # conformance shows exactly what changed
```

If jj changed its output or behavior, the conformance failures are the worklist:
align `js/engine.js` (and levels, if flags changed), then commit the regenerated
fixtures. A scheduled GitHub Action (`.github/workflows/jj-drift.yml`) does this
check weekly against the latest jj release and opens an issue when drift appears.

## Single-file bundle

```sh
node tools/build-single.mjs   # → dist/learn-jj.html
```

Produces one self-contained HTML file with everything inlined.

When shipping changes to `js/` or `style.css`, run `npm run bump` — it bumps the
`?v=N` cache-buster on the asset URLs in `index.html` so browsers pick up the new
files immediately.

## Contributing

Issues and PRs are welcome. The bar for engine changes: `npm test` stays green, and
any new simulated command lands with a golden-transcript scenario in
`tools/gen-transcripts.mjs` so its output is verified against real jj. Levels live in
`js/levels.js`; their change IDs are deterministic (`kk`, `kl`, … in creation order),
and `test/run-levels.mjs` proves every published solution works.

## License

[MIT](LICENSE). Not affiliated with the jj project.

## Acknowledgements

This project is directly inspired by [Learn Git Branching](https://learngitbranching.js.org)
by [Peter Cottle](https://github.com/pcottle) ([pcottle/learnGitBranching](https://github.com/pcottle/learnGitBranching)) —
the interactive "type commands, watch the graph respond, match the goal" format that taught
a generation of developers git is entirely his idea. This site borrows that format with
gratitude and applies it to [Jujutsu](https://jj-vcs.github.io/jj/latest/). No code is
shared between the projects; learn-jj is an independent implementation.

Thanks also to the [jj contributors](https://github.com/jj-vcs/jj) for building a VCS
worth teaching.
