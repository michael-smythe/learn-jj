# learn-jj

**Live site: https://michael-smythe.github.io/learn-jj/**

An interactive website for learning [Jujutsu (jj)](https://jj-vcs.github.io/jj/latest/),
in the spirit of [Learn Git Branching](https://learngitbranching.js.org): type jj commands
in a terminal, watch the change graph respond, match the goal state to clear each level.

## What it teaches

25 levels across 8 sequences:

1. **The Basics** — the working copy as a commit (`@`), `describe`, `new`, `commit`,
   `squash`, `abandon`, and automatic descendant rebasing.
2. **Bookmarks** — `bookmark create/set`, and why they don't move on their own.
3. **Moving Work Around** — `rebase -s`, `rebase -r` (commit extraction), merges via
   `jj new` with multiple parents.
4. **Superpowers** — the operation log and `jj undo`, `jj new -B` insertion, and a
   combined finale.
5. **Files & the Auto-Snapshot** — no staging area or untracked state; keeping files
   out with `.gitignore` + `jj file untrack`; editing file content deep in history.
6. **GitHub & GitLab** — bookmarks as remote branches: `jj git push --allow-new`,
   the PR-fixup loop (rewrite + repush, no force-push ritual), `jj git fetch` +
   rebase onto a moving trunk, and trunk immutability (◆).
7. **Conflicts Without Fear** — conflicts recorded inside commits: rebases/merges
   never stop, `cat` shows real conflict markers, resolving once heals whole stacks.
8. **Oops: Secrets & History Surgery** — removing a secret before pushing, from a
   pushed feature branch (rewrite + repush), and from immutable trunk (`jj revert`
   + rotate the credential).

Plus a free-play sandbox (`sandbox` in the terminal or via level select).

## Running

It's a static site — no build step, no dependencies:

```sh
python3 -m http.server 8677 -d .
# open http://localhost:8677
```

## How it works

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
node test/run-levels.mjs
```

Validates that every level's start state replays, isn't already solved at load, and that
the published solution reaches the goal — plus engine unit checks.

## Single-file bundle

```sh
node tools/build-single.mjs   # → dist/learn-jj.html
```

Produces one self-contained HTML file with everything inlined.

## Acknowledgements

This project is directly inspired by [Learn Git Branching](https://learngitbranching.js.org)
by [Peter Cottle](https://github.com/pcottle) ([pcottle/learnGitBranching](https://github.com/pcottle/learnGitBranching)) —
the interactive "type commands, watch the graph respond, match the goal" format that taught
a generation of developers git is entirely his idea. This site borrows that format with
gratitude and applies it to [Jujutsu](https://jj-vcs.github.io/jj/latest/). No code is
shared between the projects; learn-jj is an independent implementation.

Thanks also to the [jj contributors](https://github.com/jj-vcs/jj) for building a VCS
worth teaching.
