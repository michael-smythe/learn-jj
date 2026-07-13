/*
 * levels.js — level definitions.
 *
 * Each level replays `start` on a fresh, seeded engine, so the change IDs in
 * the start state are deterministic (kk, kl, km, … in creation order) and can
 * be referenced literally in solutions and hints. The goal state is derived by
 * replaying start + solution, which guarantees every goal is reachable.
 */
(function (global) {
'use strict';

const SEQUENCES = [
  { id: 'basics', title: 'The Basics', blurb: 'The working copy is a commit. Everything follows from that.' },
  { id: 'bookmarks', title: 'Bookmarks', blurb: 'Like git branches, except they stay where you put them.' },
  { id: 'rebase', title: 'Moving Work Around', blurb: 'Rebase subtrees, extract commits, merge — all without a checkout.' },
  { id: 'power', title: 'Superpowers', blurb: 'The operation log, undo, and history surgery.' },
  { id: 'files', title: 'Files & the Auto-Snapshot', blurb: 'No staging area, no untracked limbo — and how to keep secrets out.' },
  { id: 'remotes', title: 'GitHub & GitLab', blurb: 'Bookmarks become branches: push, fetch, and the PR loop without force-push fear.' },
  { id: 'conflicts', title: 'Conflicts Without Fear', blurb: 'Conflicts are recorded in commits, not emergencies that block you.' },
  { id: 'oops', title: 'Oops: Secrets & History Surgery', blurb: 'Committed something you shouldn\'t have? Fix it at every stage.' },
];

const LEVELS = [
  /* ------------------------------------------------ basics ---- */
  {
    id: 'basics-1', seq: 'basics', title: 'Hello, working copy',
    cards: [
      `<p><strong>Welcome!</strong> This is an interactive playground for
       <a href="https://jj-vcs.github.io/jj/latest/" target="_blank" rel="noreferrer">Jujutsu (jj)</a>,
       inspired by Peter Cottle's wonderful
       <a href="https://learngitbranching.js.org" target="_blank" rel="noreferrer">Learn Git Branching</a>.</p>
       <p>The single most important idea in jj: <strong>your working copy is itself a commit</strong>,
       shown as <code>@</code> in the graph. There is no staging area and no "uncommitted changes" —
       as you edit files, <code>@</code> automatically absorbs your work.</p>
       <p class="cardNote">In this playground a change's <em>content</em> is abstracted away:
       what matters is its <strong>description</strong> and its place in the graph.
       Dashed circles are changes with no description yet.</p>`,
      `<p>Two commands to start:</p>
       <p><code>jj describe -m "message"</code> — give the current change a description.<br>
       <code>jj new</code> — finish up and start a fresh, empty change on top of <code>@</code>.</p>
       <p>Notice what's missing: no <code>git add</code>, no <code>git commit</code>, no stash.
       Describing and moving on <em>is</em> the workflow.</p>
       <p>Type commands in the terminal on the left. <code>jj log</code> and
       <code>jj st</code> work too. Type <code>help</code> anytime.</p>`,
    ],
    objective: 'Describe the working copy as "A", then start a new empty change on top of it.',
    hint: 'jj describe -m "A" names the current change; jj new starts the next one.',
    start: [],
    solution: ['jj describe -m "A"', 'jj new'],
  },
  {
    id: 'basics-2', seq: 'basics', title: 'jj commit',
    cards: [
      `<p><code>jj commit -m "msg"</code> is simply <code>jj describe -m "msg"</code> +
       <code>jj new</code> in one step: it names the current change and starts the next one.</p>
       <p>Because the working copy is always a commit, "committing" in jj is just
       <em>labelling work you already have</em> — nothing to stage, nothing to forget.</p>`,
    ],
    objective: 'Create two finished changes "A" and "B", ending on a fresh empty change on top.',
    hint: 'Two commands: jj commit -m "A", then jj commit -m "B".',
    start: [],
    solution: ['jj commit -m "A"', 'jj commit -m "B"'],
  },
  {
    id: 'basics-3', seq: 'basics', title: 'Branching without branches',
    cards: [
      `<p>In git, working "somewhere else" means creating a branch and checking it out.
       In jj you just start a change wherever you want:</p>
       <p><code>jj new &lt;revision&gt;</code> — begin a new change on top of <em>any</em> revision.</p>
       <p>Revisions are addressed by their <strong>change ID</strong> — the letters under each node.
       The first two letters (shown bright) are enough to identify a change.</p>`,
      `<p>One more jj nicety you'll see in action here: if you move <code>@</code> away from a change
       that is empty and undescribed, jj cleans it up automatically. No litter.</p>
       <p class="cardNote">Heads up: the <b>@</b> badge in the Goal panel matters — finish with
       <code>@</code> still on C. If you overshoot with an extra <code>jj new</code>, step back with
       <code>jj undo</code>, or jump straight there with <code>jj edit</code>.</p>`,
    ],
    objective: 'Start a new change described "C" on top of A, leaving @ on C — making B and C siblings.',
    hint: 'Read A\'s change ID from the graph: jj new kk -m "C"',
    start: ['jj commit -m "A"', 'jj commit -m "B"'],
    solution: ['jj new kk -m "C"'],
  },
  {
    id: 'basics-4', seq: 'basics', title: 'Squash',
    cards: [
      `<p><code>jj squash</code> folds a change into its parent — it's jj's
       <code>commit --amend</code>, generalized.</p>
       <p>Plain <code>jj squash</code> folds <code>@</code> into its parent.
       <code>jj squash -r &lt;rev&gt;</code> folds <em>any</em> revision into its parent —
       and every descendant is <strong>rebased automatically</strong>. You never
       "check out" anything to amend it.</p>`,
    ],
    objective: 'Fold B into its parent A, leaving the chain A ← C.',
    hint: 'jj squash -r kl (kl is B\'s change ID).',
    start: ['jj commit -m "A"', 'jj commit -m "B"', 'jj commit -m "C"'],
    solution: ['jj squash -r kl'],
  },
  {
    id: 'basics-5', seq: 'basics', title: 'Abandon ship',
    cards: [
      `<p><code>jj abandon &lt;rev&gt;</code> removes a change from history.</p>
       <p>Here's the magic: its children are <strong>automatically rebased onto its parents</strong>.
       Nothing is orphaned, there's no detached HEAD, no reflog spelunking.
       Watch B heal onto A the moment the experiment disappears.</p>`,
    ],
    objective: 'Abandon the "experiment" change. B should end up directly on A.',
    hint: 'jj abandon kl — then watch the auto-rebase.',
    start: ['jj commit -m "A"', 'jj commit -m "experiment"', 'jj commit -m "B"'],
    solution: ['jj abandon kl'],
  },

  /* --------------------------------------------- bookmarks ---- */
  {
    id: 'bookmarks-1', seq: 'bookmarks', title: 'Name a spot',
    cards: [
      `<p>jj has no "current branch". Named pointers are called <strong>bookmarks</strong>:
       like git branches, they mark a revision — but you are never "on" one.</p>
       <p><code>jj bookmark create &lt;name&gt; -r &lt;rev&gt;</code> creates one.
       <code>jj bookmark list</code> shows them. Mostly you need bookmarks to talk to
       git remotes; day-to-day jj work runs happily on change IDs alone.</p>`,
    ],
    objective: 'Create a bookmark "main" pointing at B.',
    hint: 'jj bookmark create main -r kl',
    start: ['jj commit -m "A"', 'jj commit -m "B"'],
    solution: ['jj bookmark create main -r kl'],
  },
  {
    id: 'bookmarks-2', seq: 'bookmarks', title: 'Bookmarks stay put',
    cards: [
      `<p>The big mindset shift from git: committing does <strong>not</strong> move any bookmark.
       In git, your branch follows you around; in jj, bookmarks stay where you put them
       until you move them explicitly:</p>
       <p><code>jj bookmark set &lt;name&gt; -r &lt;rev&gt;</code></p>
       <p>The revset <code>@-</code> means "the parent of <code>@</code>" — perfect right after
       finishing a change, when <code>@</code> is a fresh empty commit on top of your work.</p>`,
    ],
    objective: 'Create a change "C" on top of B, then move main to point at it.',
    hint: 'jj commit -m "C", then jj bookmark set main -r @-',
    start: ['jj commit -m "A"', 'jj commit -m "B"', 'jj bookmark set main -r @-'],
    solution: ['jj commit -m "C"', 'jj bookmark set main -r @-'],
  },

  /* ------------------------------------------------ rebase ---- */
  {
    id: 'rebase-1', seq: 'rebase', title: 'Rebase a stack',
    cards: [
      `<p>Rebasing is where jj shines. One command moves whole subtrees:</p>
       <p><code>jj rebase -s &lt;rev&gt; -d &lt;dest&gt;</code> — move <em>rev and all its
       descendants</em> onto dest.</p>
       <p>Compare with git: no checkout first, no "rebase in progress" state, no
       stopping halfway. Even conflicts wouldn't stop it — jj records them
       <em>inside</em> commits to resolve whenever you like (a story for another day).
       And <code>@</code>? It just rides along with the moved commits.</p>`,
    ],
    objective: 'Rebase the feature stack (C and its child D) onto main.',
    hint: 'jj rebase -s kn -d main (kn is C). Also try -b @ -d main — same result here.',
    start: [
      'jj commit -m "A"', 'jj commit -m "B"', 'jj bookmark set main -r @-',
      'jj new kk -m "C"', 'jj new -m "D"', 'jj bookmark create feat -r @',
    ],
    solution: ['jj rebase -s kn -d main'],
  },
  {
    id: 'rebase-2', seq: 'rebase', title: 'Extract a commit',
    cards: [
      `<p><code>jj rebase -r &lt;rev&gt; -d &lt;dest&gt;</code> moves <em>exactly one</em> revision.</p>
       <p>Its children are automatically grafted onto its parents — so <code>-r</code> lets you
       <strong>pluck a commit out of the middle of a stack</strong> and drop it anywhere,
       while the stack heals itself behind it. In git this is an interactive rebase
       with a plan file; in jj it's one flag.</p>`,
    ],
    objective: 'B is a debug commit stuck mid-stack. Move it on top of D; C should heal onto A.',
    hint: 'jj rebase -r kl -d kn (kl is B, kn is D).',
    start: ['jj commit -m "A"', 'jj commit -m "B"', 'jj commit -m "C"', 'jj commit -m "D"'],
    solution: ['jj rebase -r kl -d kn'],
  },
  {
    id: 'rebase-3', seq: 'rebase', title: 'Merges are just changes',
    cards: [
      `<p>There is no <code>jj merge</code>. To merge, create a change with more than one parent:</p>
       <p><code>jj new &lt;rev1&gt; &lt;rev2&gt; -m "msg"</code></p>
       <p>That's the whole feature. A merge commit isn't special — it's an ordinary change
       that happens to have two parents. (Three or more work too, if you enjoy octopi.)</p>`,
    ],
    objective: 'Create a merge change "M" whose parents are B and C.',
    hint: 'jj new kl kn -m "M"',
    start: ['jj commit -m "A"', 'jj commit -m "B"', 'jj new kk -m "C"'],
    solution: ['jj new kl kn -m "M"'],
  },

  /* ------------------------------------------------- power ---- */
  {
    id: 'power-1', seq: 'power', title: 'Undo. Yes, really.',
    cards: [
      `<p>Every jj command is recorded in the <strong>operation log</strong>. See it with
       <code>jj op log</code>.</p>
       <p><code>jj undo</code> reverses the most recent operation — <em>any</em> operation:
       an abandon, a rebase, a bookmark move. Run it again and it steps further back.
       This is repo-wide, effortless undo; git has nothing like it.</p>
       <p>Uh oh — someone just abandoned B by mistake. The graph looks like B never
       existed… but the op log remembers.</p>`,
    ],
    objective: 'B was abandoned by accident. Bring it back.',
    hint: 'jj op log shows what happened; jj undo reverses it.',
    start: ['jj commit -m "A"', 'jj commit -m "B"', 'jj abandon kl'],
    solution: ['jj undo'],
  },
  {
    id: 'power-2', seq: 'power', title: 'Insert a change',
    cards: [
      `<p>Need a commit <em>between</em> two existing ones? jj can insert directly:</p>
       <p><code>jj new -B &lt;rev&gt; -m "msg"</code> — insert <em>before</em> rev
       (<code>-A</code> inserts <em>after</em>).</p>
       <p>Descendants are — you guessed it — rebased automatically. <code>@</code> moves
       into the freshly inserted change so you can do the work.</p>`,
    ],
    objective: 'Insert a change "H" (a hotfix) between A and B.',
    hint: 'jj new -B kl -m "H" (kl is B).',
    start: ['jj commit -m "A"', 'jj commit -m "B"'],
    solution: ['jj new -B kl -m "H"'],
  },
  {
    id: 'power-3', seq: 'power', title: 'Grand finale',
    cards: [
      `<p>Time to put it all together. The repo is a mess:</p>
       <ul><li><strong>X</strong> is junk that should be abandoned,</li>
       <li>the <strong>C – D</strong> stack belongs on top of main (B),</li>
       <li><strong>main</strong> should then point at D,</li>
       <li>and you should end on a fresh empty change on top of it all.</li></ul>
       <p>Everything you need: <code>abandon</code>, <code>rebase -s</code>,
       <code>bookmark set</code>, <code>new</code>. Good luck!</p>`,
    ],
    objective: 'Abandon X; rebase C–D onto main; move main to D; end on a fresh change on top.',
    hint: 'jj abandon kp · jj rebase -s kn -d main · jj bookmark set main -r ko · jj new main',
    start: [
      'jj commit -m "A"', 'jj commit -m "B"', 'jj bookmark set main -r @-',
      'jj new kk -m "C"', 'jj new -m "D"', 'jj new kk -m "X"',
    ],
    solution: ['jj abandon kp', 'jj rebase -s kn -d main', 'jj bookmark set main -r ko', 'jj new main'],
  },
  /* ------------------------------------------------- files ---- */
  {
    id: 'files-1', seq: 'files', title: 'Everything is tracked',
    cards: [
      `<p>Until now we've abstracted files away. Time to make them real — because jj's
       biggest day-one surprise lives here: <strong>there is no untracked state and no staging area.</strong></p>
       <p>The moment a file exists in your working directory, the next jj command snapshots it
       into <code>@</code>. No <code>git add</code>, no <code>-A</code>, no "changes not staged for commit".</p>
       <p>This playground gives you a tiny shell: <code>echo &lt;content&gt; &gt; &lt;file&gt;</code> writes a file,
       <code>cat</code> reads it, <code>ls</code> lists files, <code>rm</code> deletes. Try
       <code>jj st</code> after writing something.</p>`,
    ],
    objective: 'Write "hello world" into notes.txt, then commit the change as "notes".',
    hint: 'echo hello world > notes.txt, then jj commit -m "notes". Try jj st in between.',
    start: [],
    solution: ['echo hello world > notes.txt', 'jj commit -m "notes"'],
  },
  {
    id: 'files-2', seq: 'files', title: 'Keep secrets out',
    cards: [
      `<p>Auto-tracking cuts both ways: write <code>secrets.env</code> and it is <em>instantly</em>
       in <code>@</code>. In git it would sit untracked until you add it; in jj you must actively
       keep it out.</p>
       <p>The tools are the same as git's, in a fixed order:</p>
       <p>1. <code>echo secrets.env &gt; .gitignore</code> — ignore it (jj respects .gitignore).<br>
       2. <code>jj file untrack secrets.env</code> — pull it back out of <code>@</code>'s snapshot.
       The file stays on disk, like <code>git rm --cached</code>.</p>
       <p>jj refuses to untrack a file that isn't ignored — it would just snapshot it right back.</p>`,
    ],
    objective: 'You wrote API_KEY=123 into secrets.env. Get it out of @, then commit .gitignore as "add gitignore".',
    hint: 'echo secrets.env > .gitignore · jj file untrack secrets.env · jj commit -m "add gitignore"',
    start: ['echo v1 > app.js', 'jj commit -m "app"', 'echo API_KEY=123 > secrets.env'],
    solution: ['echo secrets.env > .gitignore', 'jj file untrack secrets.env', 'jj commit -m "add gitignore"'],
  },
  {
    id: 'files-3', seq: 'files', title: 'Edit the past directly',
    cards: [
      `<p>Commit A shipped <code>config.txt = debug</code> — should have been <code>release</code>.
       In git you'd do an interactive rebase with an <code>edit</code> stop, or a fixup commit.
       In jj you just… go there and fix it:</p>
       <p><code>jj edit &lt;rev&gt;</code> — make the old commit your working copy.<br>
       <code>echo release &gt; config.txt</code> — the fix is absorbed into that commit.<br>
       <code>jj new &lt;tip&gt;</code> — head back on top.</p>
       <p>Every descendant is rebased automatically <em>with its content recomputed</em>.
       Watch B's commit ID change while its change ID stays put.</p>`,
    ],
    objective: 'Fix history: make commit A contain config.txt = "release", then end on a fresh change on top of B.',
    hint: 'jj edit kk · echo release > config.txt · jj new kl',
    start: ['echo debug > config.txt', 'jj commit -m "A"', 'echo blue > theme.txt', 'jj commit -m "B"'],
    solution: ['jj edit kk', 'echo release > config.txt', 'jj new kl'],
  },

  /* ----------------------------------------------- remotes ---- */
  {
    id: 'remotes-1', seq: 'remotes', title: 'Publish a branch',
    cards: [
      `<p>How does bookmark-land talk to GitHub/GitLab? Simple mapping:
       <strong>a jj bookmark <em>is</em> a git branch</strong> when it reaches the remote.
       <code>main</code> here becomes <code>main</code> on GitHub. Your teammates on git never
       know you're using jj.</p>
       <p><code>jj git push -b main</code> pushes the bookmark to origin, creating the
       branch there and marking it <em>tracked</em>. (A plain <code>jj git push</code> only
       moves bookmarks that already track a remote branch — jj refuses to invent new remote
       branches without <code>-b</code> or <code>--all</code>.) After the push you'll see a
       teal <code>main@origin</code> chip — the remote-tracking view, git's
       <code>origin/main</code>.</p>`,
      `<p>Two guard rails you get for free — jj refuses to push commits that
       <em>have no description</em> or <em>contain conflicts</em>. And once commits land on
       <code>main@origin</code> they turn <strong>immutable (◆)</strong>: jj won't let you rewrite
       shared trunk history by accident. This is the "protected branch" concept, enforced client-side.</p>`,
    ],
    objective: 'Push main to origin, creating the branch there.',
    hint: 'jj git push -b main',
    start: ['jj commit -m "A"', 'jj commit -m "B"', 'jj bookmark create main -r @-'],
    solution: ['jj git push -b main'],
  },
  {
    id: 'remotes-2', seq: 'remotes', title: 'The PR fixup loop',
    cards: [
      `<p>You opened a PR from bookmark <code>feat</code>. Review says: <em>"rename login.js
       to login-form.js"</em>.</p>
       <p>The git ritual: commit a fixup, interactive-rebase to squash it, then
       <code>git push --force-with-lease</code> and hope. The jj version: <strong>just edit the
       commit</strong> — <code>@</code> is already on it — and push again.</p>
       <p>Because you rewrote the commit, <code>feat@origin</code> shows a dashed
       <code>*</code> chip: the remote is stale. <code>jj git push</code> moves the branch
       (jj always pushes rewrites with force-with-lease semantics — safe by default,
       no flag to remember).</p>`,
    ],
    objective: 'Address the review: replace login.js with login-form.js (content "v1"), then update the PR branch on origin.',
    hint: 'rm login.js · echo v1 > login-form.js · jj git push',
    start: [
      'jj commit -m "A"', 'jj bookmark create main -r @-', 'jj git push -b main',
      'jj describe -m "C: add login"', 'echo v1 > login.js',
      'jj bookmark create feat', 'jj git push -b feat',
    ],
    solution: ['rm login.js', 'echo v1 > login-form.js', 'jj git push'],
  },
  {
    id: 'remotes-3', seq: 'remotes', title: 'Fetch, rebase, carry on',
    cards: [
      `<p>The daily loop with a busy trunk: a teammate merged something while you were working.</p>
       <p><code>jj git fetch</code> — pull down origin's news. <code>main@origin</code> moves, and
       your local <code>main</code> bookmark follows it automatically (it's <em>tracking</em> the
       remote, like git's pull --ff-only, minus the merge-commit hazards).</p>
       <p>Then put your stack back on top: <code>jj rebase -b @ -d main</code>. Note what's absent:
       no stash, no checkout, no "please commit your changes first". Your working copy is a commit —
       it just rebases along with everything else.</p>`,
    ],
    objective: 'Fetch the teammate\'s work, then rebase your feature stack (C and D) onto the updated main.',
    hint: 'jj git fetch · jj rebase -b @ -d main',
    start: [
      'jj commit -m "A"', 'jj bookmark create main -r @-', 'jj git push -b main',
      'jj new main -m "C: feature"', 'echo c1 > feature.txt',
      'jj new -m "D: more feature"', 'echo c2 > feature2.txt',
    ],
    remote: [[{ on: 'main', desc: 'teammate: hotfix', files: { 'hotfix.txt': 'fix' } }]],
    solution: ['jj git fetch', 'jj rebase -b @ -d main'],
  },

  /* --------------------------------------------- conflicts ---- */
  {
    id: 'conflicts-1', seq: 'conflicts', title: 'Your first conflict',
    cards: [
      `<p>B changed <code>fruit.txt</code> to <em>bananas</em>; your change C (on A) says
       <em>cherries</em>. Rebase C onto B and — in git — everything stops: conflict markers in
       your working tree, a rebase mid-flight, <code>--continue</code> or <code>--abort</code>.</p>
       <p>In jj <strong>the rebase always completes</strong>. The conflict is recorded <em>inside</em>
       the commit (the red × node). Nothing is blocking; you can log, switch, even push other
       branches — the conflict just waits.</p>
       <p>To resolve here: with <code>@</code> on the conflicted change, inspect it
       (<code>cat fruit.txt</code> shows real conflict markers, <code>jj st</code> lists conflicted
       paths) and simply write the file: <code>echo cherries &gt; fruit.txt</code>.</p>`,
    ],
    objective: 'Rebase C onto B; then resolve the conflict, keeping "cherries".',
    hint: 'jj rebase -s kn -d kl · cat fruit.txt · echo cherries > fruit.txt',
    start: [
      'echo apples > fruit.txt', 'jj commit -m "A"',
      'echo bananas > fruit.txt', 'jj commit -m "B"',
      'jj new kk -m "C"', 'echo cherries > fruit.txt',
    ],
    solution: ['jj rebase -s kn -d kl', 'echo cherries > fruit.txt'],
  },
  {
    id: 'conflicts-2', seq: 'conflicts', title: 'Anatomy of a 3-way merge',
    cards: [
      `<p>The classic situation: two branches grew from the same commit, and <em>both</em>
       edited <code>config.txt</code>. Combining them is a <strong>3-way merge</strong>,
       and every merge tool on earth uses the same three inputs:</p>
       <ul>
       <li><strong>base</strong> — the common ancestor (<code>timeout=30</code> here),</li>
       <li><strong>side #1</strong> — one branch's version (<code>timeout=60</code>),</li>
       <li><strong>side #2</strong> — the other branch's (<code>timeout=10</code>).</li></ul>
       <p>If only one side changed a file, the merge takes it silently. If <em>both</em>
       changed it differently from base — like here — that's a conflict, and a human decides.</p>`,
      `<p><strong>How git handles this:</strong> <code>git merge</code> stops mid-flight.
       Conflict markers land in your working tree, the index holds all three versions
       (stages 1/2/3), and the repo is "in a merge" until you resolve and commit —
       or bail out with <code>--abort</code>.</p>
       <p><strong>How jj handles it:</strong> <code>jj new side-a side-b -m "…"</code> creates
       the merge commit <em>immediately</em>, with the conflict recorded inside it (red ×).
       Nothing blocks. The three versions travel with the commit until you settle them.</p>`,
      `<p>Your walkthrough:</p>
       <p>1. <code>jj new side-a side-b -m "merge: settle timeout"</code> — make the merge.<br>
       2. <code>cat config.txt</code> — read the conflict: the markers literally show
       <em>side #1</em>, <em>base</em>, and <em>side #2</em>.<br>
       3. <code>jj st</code> — see the conflicted path listed.<br>
       4. Decide, and write the answer: <code>echo timeout=60 &gt; config.txt</code>.</p>
       <p>That's the entire ceremony. (jj also supports the git-style flow: <code>jj new</code>
       on top, fix, <code>jj squash</code> the fix down — the hint jj prints walks you through it.)</p>`,
    ],
    objective: 'Merge side-a and side-b into "merge: settle timeout", inspect the conflict with cat/jj st, and resolve config.txt to "timeout=60".',
    hint: 'jj new side-a side-b -m "merge: settle timeout" · cat config.txt · echo timeout=60 > config.txt',
    start: [
      'echo timeout=30 > config.txt', 'jj commit -m "base: default config"',
      'echo timeout=60 > config.txt', 'jj describe -m "raise timeout"',
      'jj bookmark create side-a',
      'jj new kk -m "lower timeout"', 'echo timeout=10 > config.txt',
      'jj bookmark create side-b',
    ],
    solution: ['jj new side-a side-b -m "merge: settle timeout"', 'echo timeout=60 > config.txt'],
  },
  {
    id: 'conflicts-3', seq: 'conflicts', title: 'Heal a whole stack',
    cards: [
      `<p>The party trick. Rebase a two-commit stack (C ← D) onto B: C conflicts, and D —
       built on C — <strong>inherits</strong> the conflict. Two red ×.</p>
       <p>In git you'd resolve the same conflict once per commit as the rebase replays.
       In jj you fix it <em>once, at the source</em>: <code>jj edit</code> the first conflicted
       commit, write the file, and every descendant recomputes and heals automatically.</p>`,
    ],
    objective: 'Rebase the C–D stack onto B; fix the conflict in C (keep "v3"); end with @ back on D.',
    hint: 'jj rebase -s kn -d kl · jj edit kn · echo v3 > config.txt · jj edit ko',
    start: [
      'echo v1 > config.txt', 'jj commit -m "A"',
      'echo v2 > config.txt', 'jj commit -m "B"',
      'jj new kk -m "C"', 'echo v3 > config.txt',
      'jj new -m "D"', 'echo done > notes.txt',
    ],
    solution: ['jj rebase -s kn -d kl', 'jj edit kn', 'echo v3 > config.txt', 'jj edit ko'],
  },

  /* -------------------------------------------------- oops ---- */
  {
    id: 'oops-1', seq: 'oops', title: 'A secret in history (unpushed)',
    cards: [
      `<p>Commit B accidentally includes <code>secrets.env</code>. It hasn't left your machine,
       so the fix is honest history surgery — and jj makes it a three-liner:</p>
       <p><code>jj edit &lt;B&gt;</code> · <code>rm secrets.env</code> · <code>jj new &lt;tip&gt;</code></p>
       <p>The git equivalent is <code>rebase -i</code> with an edit stop, or
       <code>filter-repo</code> for deeper cases. Here, descendants rebase automatically and the
       file vanishes from every later snapshot. Because nothing was pushed, nobody ever sees it —
       this is the <em>good</em> timeline. (Prevention recap: .gitignore + jj file untrack.)</p>`,
    ],
    objective: 'Remove secrets.env from commit B entirely, then end on a fresh change on top of C.',
    hint: 'jj edit kl · rm secrets.env · jj new km',
    start: [
      'echo hello > readme.md', 'jj commit -m "A"',
      'echo KEY=abc123 > secrets.env', 'echo blue > theme.txt', 'jj commit -m "B"',
      'echo done > notes.txt', 'jj commit -m "C"',
    ],
    solution: ['jj edit kl', 'rm secrets.env', 'jj new km'],
  },
  {
    id: 'oops-2', seq: 'oops', title: 'Pushed… to your own PR branch',
    cards: [
      `<p>Worse: the secret is already on origin, on your feature branch. Two truths, in order:</p>
       <p><strong>1. The token is burned.</strong> It was public, even briefly — rotate it.
       No amount of history editing un-leaks a secret.</p>
       <p><strong>2. Clean the branch anyway</strong> so the merged history is clean:
       fix the commit (<code>rm secrets.env</code> — <code>@</code> is on it), and
       <code>jj git push</code>. Feature branches aren't trunk, so they stay mutable, and jj
       force-pushes rewrites safely by default. This is the same PR-fixup move you already know.</p>`,
    ],
    objective: 'Remove secrets.env from the feature commit and update feat on origin. (And in real life: rotate the token!)',
    hint: 'rm secrets.env · jj git push',
    start: [
      'jj commit -m "A"', 'jj bookmark create main -r @-', 'jj git push -b main',
      'jj describe -m "F: deploy script"', 'echo run > deploy.sh', 'echo TOKEN=xyz > secrets.env',
      'jj bookmark create feat', 'jj git push -b feat',
    ],
    solution: ['rm secrets.env', 'jj git push'],
  },
  {
    id: 'oops-3', seq: 'oops', title: 'Pushed to main: the revert',
    cards: [
      `<p>Worst case: the secret is on <code>main@origin</code>. Those commits are
       <strong>immutable (◆)</strong> — try <code>jj edit kl</code> and jj will refuse.
       That's the point: rewriting shared trunk history breaks every teammate's repo and
       requires a coordinated force-push (git's filter-repo/BFG day).</p>
       <p>The sane play is the same as git's: <strong>revert forward</strong>.
       <code>jj revert -r &lt;bad&gt; -d main</code> creates an inverse commit that deletes the file;
       move main to it and push.</p>
       <p>Be clear-eyed: the secret is still in the old commit on origin, visible to anyone.
       <strong>Rotate the credential.</strong> The revert fixes the tip; rotation fixes the leak.</p>`,
    ],
    objective: 'Revert the bad commit onto main, move main to the revert, and push.',
    hint: 'jj revert -r kl -d main · jj bookmark set main -r kn · jj git push',
    start: [
      'echo hello > app.js', 'jj commit -m "A"',
      'echo KEY=oops > secrets.env', 'jj commit -m "add deploy config"',
      'jj bookmark create main -r @-', 'jj git push -b main',
    ],
    solution: ['jj revert -r kl -d main', 'jj bookmark set main -r kn', 'jj git push'],
  },
];

const LevelData = { SEQUENCES, LEVELS };
if (typeof module !== 'undefined' && module.exports) module.exports = LevelData;
else global.LevelData = LevelData;
})(typeof window !== 'undefined' ? window : globalThis);
