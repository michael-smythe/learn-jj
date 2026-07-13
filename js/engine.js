/*
 * engine.js — a teaching simulator of Jujutsu's core model.
 *
 * Models changes (with stable change IDs and rewritable commit IDs), the
 * working-copy commit (@), bookmarks, automatic descendant rebasing, and the
 * operation log. File contents are abstracted away: a change's "work" is
 * represented by its description.
 */
(function (global) {
'use strict';

const CHANGE_ALPHABET = 'klmnopqrstuvwxyz';
const ROOT_ID = 'zzzzzzzz';
const HEX = '0123456789abcdef';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class JJError extends Error {
  constructor(msg, hint) { super(msg); this.hint = hint; }
}

function tokenize(line) {
  const toks = []; let cur = ''; let q = null; let pending = false;
  for (const ch of line) {
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === '"' || ch === "'") { q = ch; pending = true; }
    else if (/\s/.test(ch)) { if (cur || pending) { toks.push(cur); cur = ''; pending = false; } }
    else cur += ch;
  }
  if (q) throw new JJError('Unclosed quote in command');
  if (cur || pending) toks.push(cur);
  return toks;
}

function parseArgs(tokens, spec) {
  const lookup = {};
  for (const [canon, def] of Object.entries(spec)) {
    lookup[canon] = canon;
    (def.aliases || []).forEach(a => { lookup[a] = canon; });
  }
  const flags = {}; const pos = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.length > 1 && tok[0] === '-' && tok !== '--') {
      let name = tok.replace(/^--?/, ''); let inlineVal = null;
      const eq = name.indexOf('=');
      if (eq >= 0) { inlineVal = name.slice(eq + 1); name = name.slice(0, eq); }
      const canon = lookup[name];
      if (!canon) throw new JJError(`Unexpected argument "${tok}"`, 'Type "help" to see what this playground supports.');
      const def = spec[canon];
      let val = true;
      if (def.value) {
        if (inlineVal !== null) val = inlineVal;
        else { i++; if (i >= tokens.length) throw new JJError(`Option "${tok}" requires a value`); val = tokens[i]; }
      }
      if (def.multi) (flags[canon] = flags[canon] || []).push(val);
      else flags[canon] = val;
    } else pos.push(tok);
  }
  return { flags, pos };
}

const TRUNK_NAMES = ['main', 'master', 'trunk'];
const isConflict = v => v !== null && typeof v === 'object' && 'conflict' in v;
const valEq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

class JJEngine {
  constructor(seed = 1) {
    this._rand = mulberry32((seed * 0x9E3779B9) >>> 0);
    this.counter = 0;
    this.changes = new Map();
    this.bookmarks = new Map();
    this.remote = new Map();      // name -> {id, commitId} (state of name@origin)
    this.remoteScript = [];       // scripted colleague activity, revealed by jj git fetch
    this.fetchCount = 0;
    this.ops = [];
    this.undoCursor = null;
    const root = { id: ROOT_ID, commitId: '00000000', desc: '', parents: [], immutable: true, files: {} };
    this.changes.set(ROOT_ID, root);
    const first = this._createChange([ROOT_ID], '');
    this.wc = first.id;
    this._recordOp('initialize repo');
  }

  setRemoteScript(script) { this.remoteScript = script || []; }

  /* ---------- id + change helpers ---------- */

  _randHex(n) { let s = ''; for (let i = 0; i < n; i++) s += HEX[(this._rand() * 16) | 0]; return s; }

  _newChangeId() {
    const c = this.counter++;
    let id = CHANGE_ALPHABET[(c >> 4) & 15] + CHANGE_ALPHABET[c & 15];
    for (let i = 0; i < 6; i++) id += CHANGE_ALPHABET[(this._rand() * 16) | 0];
    return id;
  }

  _createChange(parents, desc, files) {
    const ch = {
      id: this._newChangeId(), commitId: this._randHex(8), desc: desc || '',
      parents: parents.slice(), immutable: false,
      files: files ? JSON.parse(JSON.stringify(files)) : {},
    };
    this.changes.set(ch.id, ch);
    return ch;
  }

  get(id) { return this.changes.get(id); }

  childrenOf(id) {
    const out = [];
    for (const ch of this.changes.values()) if (ch.parents.includes(id)) out.push(ch.id);
    return out;
  }

  descendantsOf(id, incl = true) {
    const seen = new Set(incl ? [id] : []);
    const queue = [id];
    while (queue.length) {
      const cur = queue.shift();
      for (const kid of this.childrenOf(cur)) {
        if (!seen.has(kid)) { seen.add(kid); queue.push(kid); }
      }
    }
    if (!incl) seen.delete(id);
    return seen;
  }

  ancestorsOf(id, incl = true) {
    const seen = new Set();
    const start = this.get(id);
    const queue = incl ? [id] : (start ? start.parents.slice() : []);
    while (queue.length) {
      const cur = queue.shift();
      if (seen.has(cur)) continue;
      seen.add(cur);
      const c = this.get(cur);
      if (c) queue.push(...c.parents);
    }
    return seen;
  }

  bookmarksAt(id) {
    const out = [];
    for (const [name, target] of this.bookmarks) if (target === id) out.push(name);
    return out.sort();
  }

  remoteBookmarksAt(id) {
    const out = [];
    for (const [name, ref] of this.remote) if (ref.id === id) out.push(name);
    return out.sort();
  }

  /* ---------- file trees ----------
   * Each change carries patches: files[name] = {from, to} (to === null deletes).
   * The tree at a commit = merged parent trees + own patches. A patch whose
   * `from` no longer matches the parent value produces a conflict value, which
   * flows into descendants until some commit writes the file again — modelling
   * jj's "conflicts live in commits" design. */

  _lca(a, b) {
    const ancA = this.ancestorsOf(a, true);
    const shared = [...this.ancestorsOf(b, true)].filter(x => ancA.has(x));
    if (!shared.length) return null;
    const row = this._rows();
    shared.sort((x, y) => row[y] - row[x]);
    return shared[0];
  }

  _merge3(base, a, b) {
    const out = {};
    const keys = new Set([...Object.keys(base), ...Object.keys(a), ...Object.keys(b)]);
    for (const f of keys) {
      const bv = base[f] ?? null, av = a[f] ?? null, cv = b[f] ?? null;
      let v;
      if (valEq(av, cv)) v = av;
      else if (valEq(av, bv)) v = cv;
      else if (valEq(cv, bv)) v = av;
      else v = { conflict: { base: bv, sides: [av, cv] } };
      if (v !== null) out[f] = v;
    }
    return out;
  }

  computeTrees() {
    const row = this._rows();
    const order = [...this.changes.keys()].sort((a, b) => row[a] - row[b]);
    const trees = new Map();
    for (const id of order) {
      const c = this.get(id);
      let tree;
      const ps = c.parents.filter(p => trees.has(p));
      if (!ps.length) tree = {};
      else if (ps.length === 1) tree = { ...trees.get(ps[0]) };
      else {
        tree = trees.get(ps[0]);
        let accId = ps[0];
        for (let i = 1; i < ps.length; i++) {
          const baseId = this._lca(accId, ps[i]);
          tree = this._merge3(baseId ? trees.get(baseId) : {}, tree, trees.get(ps[i]));
          accId = baseId ?? accId;
        }
        tree = { ...tree };
      }
      for (const [f, patch] of Object.entries(c.files)) {
        const cur = tree[f] ?? null;
        const from = patch.from ?? null, to = patch.to ?? null;
        let next;
        if (isConflict(cur)) next = to;         // writing a conflicted file resolves it
        else if (valEq(cur, to)) next = to;
        else if (valEq(cur, from)) next = to;   // clean 3-way apply
        else next = { conflict: { base: from, sides: [cur, to] } };
        if (next === null) delete tree[f]; else tree[f] = next;
      }
      trees.set(id, tree);
    }
    return trees;
  }

  /* Tree the working copy sees before its own patches. */
  _baseTreeOf(id, trees) {
    const c = this.get(id);
    const saved = c.files;
    c.files = {};
    const t = this.computeTrees().get(id);
    c.files = saved;
    return t || {};
  }

  _conflictedIds(trees) {
    trees = trees || this.computeTrees();
    const out = new Set();
    for (const [id, tree] of trees) {
      if (Object.values(tree).some(isConflict)) out.add(id);
    }
    return out;
  }

  /* ---------- immutability: root + everything on the pushed trunk ---------- */

  _trunkName() {
    for (const n of TRUNK_NAMES) if (this.remote.has(n)) return n;
    return null;
  }

  _immutableIds() {
    const set = new Set([ROOT_ID]);
    const trunk = this._trunkName();
    if (trunk) for (const a of this.ancestorsOf(this.remote.get(trunk).id, true)) set.add(a);
    return set;
  }

  _touch(ids) {
    for (const id of ids) {
      const c = this.get(id);
      if (c && !c.immutable) c.commitId = this._randHex(8);
    }
  }

  _rows() {
    const row = {}; const indeg = {}; const queue = [];
    for (const c of this.changes.values()) {
      indeg[c.id] = c.parents.length;
      if (!c.parents.length) { row[c.id] = 0; queue.push(c.id); }
    }
    while (queue.length) {
      const cur = queue.shift();
      for (const kid of this.childrenOf(cur)) {
        row[kid] = Math.max(row[kid] || 0, row[cur] + 1);
        if (--indeg[kid] === 0) queue.push(kid);
      }
    }
    return row;
  }

  short(id) { return id.slice(0, 3); }

  _descOf(c) { return c.desc ? c.desc : '(no description set)'; }

  _fmt(id) {
    const c = this.get(id);
    return `${this.short(id)} ${c.commitId.slice(0, 8)} ${this._descOf(c)}`;
  }

  _wcLines() {
    const lines = [{ t: `Working copy  (@) now at: ${this._fmt(this.wc)}`, c: 'ok' }];
    for (const p of this.get(this.wc).parents) {
      lines.push({ t: `Parent commit (@-)      : ${this._fmt(p)}`, c: 'dim' });
    }
    return lines;
  }

  /* Moving @ away from an empty, undescribed, childless, bookmark-free change
   * abandons it automatically — just like real jj. */
  _moveWC(newId, lines, protect) {
    const old = this.wc;
    this.wc = newId;
    if (!old || old === newId || (protect && protect.has(old))) return;
    const c = this.get(old);
    if (c && !c.immutable && !c.desc && Object.keys(c.files).length === 0 &&
        this.childrenOf(old).length === 0 && this.bookmarksAt(old).length === 0 &&
        this.remoteBookmarksAt(old).length === 0) {
      this.changes.delete(old);
      lines.push({ t: `(cleaned up the empty, undescribed change ${this.short(old)})`, c: 'dim' });
    }
  }

  _checkRewritable(id) {
    const c = this.get(id);
    if (this._immutableIds().has(id)) {
      throw new JJError(`Commit ${c.commitId.slice(0, 8)} is immutable`,
        id === ROOT_ID
          ? 'The root commit cannot be rewritten or edited.'
          : `Commits reachable from ${this._trunkName()}@origin are immutable — build on top with jj new, create an inverse commit with jj revert, or jj undo the push.`);
    }
  }

  /* ---------- revset resolution ---------- */

  resolve(expr) {
    let e = (expr || '').trim().replace(/^["']|["']$/g, '');
    if (!e) throw new JJError('Empty revision');
    const sufs = [];
    while (e.endsWith('-') || e.endsWith('+')) { sufs.push(e.slice(-1)); e = e.slice(0, -1); }
    sufs.reverse();
    let cur = this._resolveBase(e, expr);
    for (const s of sufs) {
      if (s === '-') {
        const ps = this.get(cur).parents;
        if (!ps.length) throw new JJError(`"${expr}" resolved to no revisions (the root commit has no parents)`);
        if (ps.length > 1) throw new JJError(`"${expr}" resolved to more than one revision`, 'That change is a merge — refer to the parent you want by its change ID.');
        cur = ps[0];
      } else {
        const cs = this.childrenOf(cur);
        if (!cs.length) throw new JJError(`"${expr}" resolved to no revisions (no children)`);
        if (cs.length > 1) throw new JJError(`"${expr}" resolved to more than one revision`, 'That change has several children — refer to the one you want by its change ID.');
        cur = cs[0];
      }
    }
    return cur;
  }

  _resolveBase(e, orig) {
    if (e === '@') return this.wc;
    if (e === 'root()') return ROOT_ID;
    const dm = e.match(/^desc(?:ription)?\((.*)\)$/);
    if (dm) {
      const pat = dm[1].replace(/^["']|["']$/g, '');
      let hits = [...this.changes.values()].filter(c => c.desc === pat).map(c => c.id);
      if (!hits.length) hits = [...this.changes.values()].filter(c => c.desc.includes(pat) && c.desc).map(c => c.id);
      if (!hits.length) throw new JJError(`Revset "${orig}" didn't resolve to any revisions`);
      if (hits.length > 1) throw new JJError(`Revset "${orig}" resolved to more than one revision`);
      return hits[0];
    }
    if (this.bookmarks.has(e)) return this.bookmarks.get(e);
    if (/^[k-z]+$/.test(e)) {
      const hits = [...this.changes.keys()].filter(id => id.startsWith(e));
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) throw new JJError(`Change ID prefix "${e}" is ambiguous`, 'Add more letters from the ID shown in the graph.');
    }
    throw new JJError(`Revision "${orig}" doesn't exist`, 'Use a change ID from the graph, a bookmark name, @, or suffixes like @-.');
  }

  /* ---------- op log ---------- */

  _snapshot() {
    return {
      wc: this.wc,
      changes: [...this.changes.values()].map(c => ({ ...c, parents: c.parents.slice(), files: JSON.parse(JSON.stringify(c.files)) })),
      bookmarks: [...this.bookmarks],
      remote: [...this.remote].map(([n, r]) => [n, { ...r }]),
      fetchCount: this.fetchCount,
    };
  }

  _restore(snap) {
    this.changes = new Map(snap.changes.map(c => [c.id, { ...c, parents: c.parents.slice(), files: JSON.parse(JSON.stringify(c.files)) }]));
    this.bookmarks = new Map(snap.bookmarks);
    this.remote = new Map((snap.remote || []).map(([n, r]) => [n, { ...r }]));
    this.fetchCount = snap.fetchCount || 0;
    this.wc = snap.wc;
  }

  _recordOp(desc) {
    this.ops.push({ id: this._randHex(12), desc, snap: this._snapshot() });
  }

  _restoreLast() {
    if (this.ops.length) this._restore(this.ops[this.ops.length - 1].snap);
  }

  /* ---------- command dispatch ---------- */

  run(line) {
    let tokens;
    try { tokens = tokenize(line); }
    catch (e) { return { ok: false, lines: [{ t: 'Error: ' + e.message, c: 'err' }] }; }
    if (!tokens.length) return { ok: true, lines: [] };

    const shell = { echo: '_shEcho', cat: '_shCat', rm: '_shRm', ls: '_shLs' };
    let method, args;
    if (tokens[0] !== 'jj') {
      method = shell[tokens[0]];
      args = tokens.slice(1);
      if (!method) return { ok: false, lines: [{ t: `Unknown command "${tokens[0]}"`, c: 'err' }] };
    } else {
      const sub = tokens[1];
      args = tokens.slice(2);
      const table = {
        new: '_cmdNew', describe: '_cmdDescribe', desc: '_cmdDescribe',
        commit: '_cmdCommit', edit: '_cmdEdit', abandon: '_cmdAbandon',
        squash: '_cmdSquash', rebase: '_cmdRebase', bookmark: '_cmdBookmark',
        b: '_cmdBookmark', duplicate: '_cmdDuplicate', undo: '_cmdUndo',
        op: '_cmdOp', operation: '_cmdOp', log: '_cmdLog', status: '_cmdStatus', st: '_cmdStatus',
        git: '_cmdGit', revert: '_cmdRevert', backout: '_cmdRevert',
        file: '_cmdFile', resolve: '_cmdResolve',
      };
      if (!sub) {
        return { ok: true, lines: [{ t: 'jj — a version control system (playground). Type "help" for commands.', c: 'dim' }] };
      }
      method = table[sub];
      if (!method) {
        return { ok: false, lines: [
          { t: `Error: unrecognized subcommand "${sub}"`, c: 'err' },
          { t: 'Hint: type "help" to see what this playground supports.', c: 'dim' },
        ] };
      }
    }
    const conflictsBefore = this._conflictedIds();
    try {
      const res = this[method](args);
      if (res.op) {
        this._recordOp(res.op);
        if (!res.keepUndoCursor) this.undoCursor = null;
        const after = this._conflictedIds();
        const appeared = [...after].filter(id => !conflictsBefore.has(id)).map(id => this.short(id));
        const resolved = [...conflictsBefore].filter(id => !after.has(id) && this.changes.has(id)).map(id => this.short(id));
        if (appeared.length) res.lines.push({ t: `New conflicts appeared in these commits: ${appeared.join(', ')}`, c: 'err' });
        if (resolved.length) res.lines.push({ t: `Existing conflicts were resolved or abandoned: ${resolved.join(', ')}`, c: 'ok' });
      }
      return { ok: true, lines: res.lines, mutated: !!res.op };
    } catch (e) {
      if (e instanceof JJError) {
        this._restoreLast();
        const lines = [{ t: 'Error: ' + e.message, c: 'err' }];
        if (e.hint) lines.push({ t: 'Hint: ' + e.hint, c: 'dim' });
        return { ok: false, lines };
      }
      throw e;
    }
  }

  /* ---------- commands ---------- */

  _cmdNew(args) {
    const { flags, pos } = parseArgs(args, {
      m: { value: true, aliases: ['message'] },
      B: { value: true, aliases: ['insert-before'] },
      A: { value: true, aliases: ['insert-after'] },
      'no-edit': {},
    });
    if (flags.B && flags.A) throw new JJError('This playground supports either --insert-before or --insert-after, not both');
    const msg = typeof flags.m === 'string' ? flags.m : '';
    const lines = [];
    let node;
    let rebased = 0;
    if (flags.B) {
      const target = this.resolve(flags.B);
      this._checkRewritable(target);
      const tc = this.get(target);
      node = this._createChange(tc.parents, msg);
      tc.parents = [node.id];
      const moved = this.descendantsOf(target, true);
      rebased = moved.size;
      this._touch(moved);
      this._moveWC(node.id, lines, new Set([target]));
    } else if (flags.A) {
      const target = this.resolve(flags.A);
      node = this._createChange([target], msg);
      const touched = new Set();
      for (const kidId of this.childrenOf(target)) {
        if (kidId === node.id) continue;
        const kid = this.get(kidId);
        this._checkRewritable(kidId);
        kid.parents = kid.parents.map(p => (p === target ? node.id : p));
        for (const d of this.descendantsOf(kidId, true)) touched.add(d);
      }
      rebased = touched.size;
      this._touch(touched);
      this._moveWC(node.id, lines, new Set([target]));
    } else {
      let parents = pos.length ? pos.map(p => this.resolve(p)) : [this.wc];
      parents = [...new Set(parents)];
      node = this._createChange(parents, msg);
      this._moveWC(node.id, lines);
    }
    if (rebased) lines.push({ t: `Rebased ${rebased} descendant commits`, c: 'dim' });
    lines.push(...this._wcLines());
    return { op: 'new empty commit', lines };
  }

  _cmdDescribe(args) {
    const { flags } = parseArgs(args, {
      m: { value: true, aliases: ['message'] },
      r: { value: true, aliases: ['revision'] },
    });
    if (typeof flags.m !== 'string') {
      throw new JJError('A description is required', 'This playground has no editor — pass one with -m "my description".');
    }
    const rev = flags.r ? this.resolve(flags.r) : this.wc;
    this._checkRewritable(rev);
    this.get(rev).desc = flags.m;
    this._touch(this.descendantsOf(rev, true));
    const lines = [];
    if (rev === this.wc) lines.push(...this._wcLines());
    else lines.push({ t: `Described ${this.short(rev)} as "${flags.m}"`, c: 'ok' });
    return { op: `describe commit ${this.short(rev)}`, lines };
  }

  _cmdCommit(args) {
    const { flags } = parseArgs(args, { m: { value: true, aliases: ['message'] } });
    if (typeof flags.m !== 'string') {
      throw new JJError('A description is required', 'This playground has no editor — use jj commit -m "my description".');
    }
    const cur = this.get(this.wc);
    cur.desc = flags.m;
    this._touch(this.descendantsOf(this.wc, true));
    const node = this._createChange([this.wc], '');
    this.wc = node.id;
    return { op: `commit working copy: "${flags.m}"`, lines: this._wcLines() };
  }

  _cmdEdit(args) {
    const { pos } = parseArgs(args, {});
    if (!pos.length) throw new JJError('jj edit needs a revision, e.g. jj edit kl');
    const rev = this.resolve(pos[0]);
    const c = this.get(rev);
    if (this._immutableIds().has(rev)) {
      throw new JJError(`Commit ${c.commitId.slice(0, 8)} is immutable`,
        `Use "jj new ${this.short(rev)}" to create a new change on top of it instead${rev === 'zzzzzzzz' ? '' : ', or jj revert to invert it'}.`);
    }
    if (rev === this.wc) return { op: null, lines: [{ t: 'Already editing that change.', c: 'dim' }] };
    const lines = [];
    this._moveWC(rev, lines);
    lines.push(...this._wcLines());
    return { op: `edit commit ${this.short(rev)}`, lines };
  }

  _cmdAbandon(args) {
    const { pos } = parseArgs(args, {});
    const targets = pos.length ? pos.map(p => this.resolve(p)) : [this.wc];
    const set = new Set(targets);
    for (const t of set) this._checkRewritable(t);

    const touch = new Set();
    for (const t of set) for (const d of this.descendantsOf(t, false)) touch.add(d);

    const lines = [];
    const row = this._rows();
    const ordered = [...set].sort((a, b) => row[b] - row[a]); // children first
    const replacement = new Map();
    const wcWasAbandoned = set.has(this.wc);
    const oldWcParents = this.get(this.wc).parents.slice();

    for (const x of ordered) {
      const xc = this.get(x);
      for (const kidId of this.childrenOf(x)) {
        const kid = this.get(kidId);
        const np = [];
        for (const p of kid.parents) {
          if (p === x) { for (const q of xc.parents) if (!np.includes(q) && q !== kidId) np.push(q); }
          else if (!np.includes(p)) np.push(p);
        }
        kid.parents = np.length ? np : [ROOT_ID];
      }
      for (const name of this.bookmarksAt(x)) {
        const to = xc.parents[0] || ROOT_ID;
        this.bookmarks.set(name, to);
        lines.push({ t: `Moved bookmark ${name} to ${this.short(to)}`, c: 'dim' });
      }
      replacement.set(x, xc.parents.slice());
      lines.unshift({ t: `Abandoned commit ${this.short(x)} ${this._descOf(xc)}`, c: 'ok' });
      this.changes.delete(x);
    }

    // Fix any bookmarks that cascaded onto a change abandoned later.
    for (const [name, target] of this.bookmarks) {
      let cur = target;
      while (replacement.has(cur)) cur = replacement.get(cur)[0] || ROOT_ID;
      if (cur !== target) this.bookmarks.set(name, cur);
    }

    const alive = [...touch].filter(id => this.changes.has(id));
    this._touch(alive);
    if (alive.length) lines.push({ t: `Rebased ${alive.length} descendant commits onto parents of abandoned commits`, c: 'dim' });

    if (wcWasAbandoned) {
      const expand = ids => {
        const out = [];
        for (const id of ids) {
          if (replacement.has(id)) out.push(...expand(replacement.get(id)));
          else if (!out.includes(id)) out.push(id);
        }
        return out;
      };
      let parents = expand(this.get.call(this, this.wc) ? [this.wc] : oldWcParents);
      if (!parents.length) parents = [ROOT_ID];
      const node = this._createChange(parents, '');
      this.wc = node.id;
      lines.push(...this._wcLines());
    }
    const what = [...set].map(id => this.short(id)).join(', ');
    return { op: `abandon commit ${what}`, lines };
  }

  _cmdSquash(args) {
    const { flags } = parseArgs(args, {
      r: { value: true, aliases: ['revision'] },
      m: { value: true, aliases: ['message'] },
    });
    const rev = flags.r ? this.resolve(flags.r) : this.wc;
    this._checkRewritable(rev);
    const rc = this.get(rev);
    if (rc.parents.length !== 1) throw new JJError('Cannot squash merge commits', 'The change has more than one parent.');
    const parentId = rc.parents[0];
    this._checkRewritable(parentId);
    const parent = this.get(parentId);

    const lines = [];
    if (typeof flags.m === 'string') parent.desc = flags.m;
    else if (!parent.desc) parent.desc = rc.desc;
    else if (rc.desc) lines.push({ t: `(kept the parent's description "${parent.desc}" — pass -m to set a combined one)`, c: 'dim' });
    for (const [f, p] of Object.entries(rc.files)) {
      parent.files[f] = parent.files[f]
        ? { from: parent.files[f].from, to: p.to ?? null }
        : { from: p.from ?? null, to: p.to ?? null };
    }

    for (const kidId of this.childrenOf(rev)) {
      const kid = this.get(kidId);
      const np = [];
      for (const p of kid.parents) {
        if (p === rev) { if (!np.includes(parentId)) np.push(parentId); }
        else if (!np.includes(p)) np.push(p);
      }
      kid.parents = np;
    }
    for (const name of this.bookmarksAt(rev)) this.bookmarks.set(name, parentId);
    const wasWC = rev === this.wc;
    this.changes.delete(rev);
    if (wasWC) {
      const node = this._createChange([parentId], '');
      this.wc = node.id;
    }
    this._touch(this.descendantsOf(parentId, true));
    lines.unshift({ t: `Squashed ${this.short(rev)} into ${this.short(parentId)} ${this._descOf(parent)}`, c: 'ok' });
    lines.push(...this._wcLines());
    return { op: `squash commit ${this.short(rev)}`, lines };
  }

  _cmdRebase(args) {
    const { flags } = parseArgs(args, {
      r: { value: true, aliases: ['revision'] },
      s: { value: true, aliases: ['source'] },
      b: { value: true, aliases: ['branch'] },
      d: { value: true, multi: true, aliases: ['destination'] },
    });
    const modes = ['r', 's', 'b'].filter(k => flags[k]);
    if (modes.length > 1) throw new JJError('Use only one of -r, -s, -b');
    let dests = (flags.d || []).map(d => this.resolve(d));
    dests = [...new Set(dests)];
    if (!dests.length) throw new JJError('A destination is required', 'Add -d <revision>, e.g. jj rebase -s kn -d main');

    const mode = modes[0] || 'b';
    const target = flags[mode] ? this.resolve(flags[mode]) : this.wc;

    let moveSet;
    if (mode === 'r') moveSet = new Set([target]);
    else if (mode === 's') moveSet = this.descendantsOf(target, true);
    else {
      const ancT = this.ancestorsOf(target, true);
      const ancD = new Set();
      for (const d of dests) for (const a of this.ancestorsOf(d, true)) ancD.add(a);
      const branch = [...ancT].filter(x => !ancD.has(x));
      if (!branch.length) return { op: null, lines: [{ t: 'Nothing changed.', c: 'dim' }] };
      const roots = branch.filter(x => this.get(x).parents.every(p => !branch.includes(p)));
      moveSet = new Set();
      for (const r of roots) for (const d of this.descendantsOf(r, true)) moveSet.add(d);
    }
    for (const id of moveSet) this._checkRewritable(id);
    if (mode !== 'r') {
      for (const d of dests) if (moveSet.has(d)) {
        throw new JJError(`Cannot rebase ${this.short(target)} onto ${this.short(d)}: the destination is part of what's being moved`);
      }
    }

    const sameParents = (a, b) => a.length === b.length && a.every(p => b.includes(p));
    const touch = new Set();
    const lines = [];
    let healed = 0;

    if (mode === 'r') {
      const tc = this.get(target);
      const kids = this.childrenOf(target);
      if (sameParents(tc.parents, dests) && !kids.length) {
        return { op: null, lines: [{ t: 'Nothing changed.', c: 'dim' }] };
      }
      for (const kidId of kids) {
        const kid = this.get(kidId);
        const np = [];
        for (const p of kid.parents) {
          if (p === target) { for (const q of tc.parents) if (!np.includes(q) && q !== kidId) np.push(q); }
          else if (!np.includes(p)) np.push(p);
        }
        kid.parents = np.length ? np : [ROOT_ID];
        for (const d of this.descendantsOf(kidId, true)) touch.add(d);
        healed++;
      }
      tc.parents = dests.slice();
      if (this.ancestorsOf(target, false).has(target)) {
        throw new JJError(`Cannot rebase ${this.short(target)} onto ${this.short(dests[0])}: that would create a cycle`);
      }
    } else {
      const roots = [...moveSet].filter(x => this.get(x).parents.every(p => !moveSet.has(p)));
      let changed = false;
      for (const r of roots) {
        const rc = this.get(r);
        if (!sameParents(rc.parents, dests)) { rc.parents = dests.slice(); changed = true; }
      }
      if (!changed) return { op: null, lines: [{ t: 'Nothing changed.', c: 'dim' }] };
      if (dests.some(d => this.ancestorsOf(d, false).has(d) || this.ancestorsOf(d, true).size === 0)) {
        throw new JJError('That rebase would create a cycle');
      }
    }

    for (const id of moveSet) for (const d of this.descendantsOf(id, true)) touch.add(d);
    this._touch(touch);
    lines.push({ t: `Rebased ${moveSet.size} commits onto ${this.short(dests[0])}${dests.length > 1 ? ` (+${dests.length - 1} more parents)` : ''}`, c: 'ok' });
    if (healed) lines.push({ t: `Rebased ${healed} descendant commits onto parent of ${this.short(target)}`, c: 'dim' });
    if (touch.has(this.wc) || moveSet.has(this.wc)) lines.push(...this._wcLines());
    return { op: `rebase ${moveSet.size} commits`, lines };
  }

  _cmdBookmark(args) {
    const sub = args[0] || 'list';
    const rest = args.slice(1);
    const { flags, pos } = parseArgs(rest, {
      r: { value: true, aliases: ['revision'] },
      to: { value: true },
    });
    const nameOk = n => /^[A-Za-z][\w./-]*$/.test(n) && n !== 'root';

    if (sub === 'list' || sub === 'l') {
      const lines = [...this.bookmarks.keys()].sort().map(name => ({
        t: `${name}: ${this._fmt(this.bookmarks.get(name))}`, c: '',
      }));
      if (!lines.length) lines.push({ t: '(no bookmarks)', c: 'dim' });
      return { op: null, lines };
    }
    if (sub === 'create' || sub === 'set' || sub === 'c' || sub === 's') {
      const create = sub === 'create' || sub === 'c';
      const name = pos[0];
      if (!name) throw new JJError(`jj bookmark ${sub} needs a name`);
      if (!nameOk(name)) throw new JJError(`Invalid bookmark name "${name}"`);
      if (create && this.bookmarks.has(name)) {
        throw new JJError(`Bookmark already exists: ${name}`, `Use "jj bookmark set ${name} -r <rev>" to move it.`);
      }
      const rev = flags.r ? this.resolve(flags.r) : this.wc;
      if (rev === ROOT_ID) throw new JJError('Cannot point a bookmark at the root commit');
      const existed = this.bookmarks.has(name);
      this.bookmarks.set(name, rev);
      return {
        op: `${existed ? 'move' : 'create'} bookmark ${name}`,
        lines: [{ t: `${existed ? 'Moved' : 'Created'} 1 bookmarks ${existed ? 'to' : 'pointing to'} ${this._fmt(rev)}`, c: 'ok' }],
      };
    }
    if (sub === 'move' || sub === 'm') {
      const name = pos[0];
      if (!name || !this.bookmarks.has(name)) throw new JJError(`No such bookmark: ${name || '(none given)'}`);
      if (!flags.to) throw new JJError('jj bookmark move needs --to <rev>');
      const rev = this.resolve(flags.to);
      if (rev === ROOT_ID) throw new JJError('Cannot point a bookmark at the root commit');
      this.bookmarks.set(name, rev);
      return { op: `move bookmark ${name}`, lines: [{ t: `Moved 1 bookmarks to ${this._fmt(rev)}`, c: 'ok' }] };
    }
    if (sub === 'delete' || sub === 'd') {
      const name = pos[0];
      if (!name || !this.bookmarks.has(name)) throw new JJError(`No such bookmark: ${name || '(none given)'}`);
      this.bookmarks.delete(name);
      return { op: `delete bookmark ${name}`, lines: [{ t: `Deleted 1 bookmarks.`, c: 'ok' }] };
    }
    throw new JJError(`Unknown bookmark subcommand "${sub}"`, 'Supported: create, set, move, delete, list.');
  }

  _cmdDuplicate(args) {
    const { pos } = parseArgs(args, {});
    const rev = pos.length ? this.resolve(pos[0]) : this.wc;
    this._checkRewritable(rev);
    const rc = this.get(rev);
    const node = this._createChange(rc.parents, rc.desc, rc.files);
    return {
      op: `duplicate commit ${this.short(rev)}`,
      lines: [{ t: `Duplicated ${this.short(rev)} as ${this.short(node.id)} ${this._descOf(node)}`, c: 'ok' }],
    };
  }

  /* ---------- files: shell-style commands operating on @ ---------- */

  _fmtVal(v) {
    if (!isConflict(v)) return v;
    const c = v.conflict;
    return `<<<<<<< side #1\n${c.sides[0] ?? '(absent)'}\n||||||| base\n${c.base ?? '(absent)'}\n=======\n${c.sides[1] ?? '(absent)'}\n>>>>>>> side #2`;
  }

  _shEcho(args) {
    const sep = args.findIndex(a => a === '>' || a === '>>');
    if (sep < 0 || sep === args.length - 1) {
      throw new JJError('Usage: echo <content> > <file>', 'Writes the file in your working copy — jj snapshots it into @ automatically.');
    }
    const append = args[sep] === '>>';
    const file = args[sep + 1];
    let value = args.slice(0, sep).join(' ');
    this._checkRewritable(this.wc);
    const base = this._baseTreeOf(this.wc, null);
    let from = base[file] ?? null;
    if (isConflict(from)) from = from.conflict.base;
    if (append) {
      const trees = this.computeTrees();
      const cur = trees.get(this.wc)[file];
      if (cur && !isConflict(cur)) value = cur + ' ' + value;
    }
    this.get(this.wc).files[file] = { from, to: value };
    this._touch(this.descendantsOf(this.wc, true));
    return {
      op: 'snapshot working copy',
      lines: [{ t: `Wrote ${file}. jj noticed and snapshotted it into @ (${this.short(this.wc)}) — no add, no staging.`, c: 'ok' }],
    };
  }

  _shRm(args) {
    const file = args[0];
    if (!file) throw new JJError('Usage: rm <file>');
    this._checkRewritable(this.wc);
    const trees = this.computeTrees();
    const tree = trees.get(this.wc);
    if (!(file in tree)) throw new JJError(`No such file in @: ${file}`);
    const c = this.get(this.wc);
    const base = this._baseTreeOf(this.wc, null);
    const baseVal = base[file] ?? null;
    if (baseVal === null) delete c.files[file];       // existed only via @'s own edit
    else c.files[file] = { from: isConflict(baseVal) ? baseVal.conflict.base : baseVal, to: null };
    this._touch(this.descendantsOf(this.wc, true));
    return { op: 'snapshot working copy', lines: [{ t: `Deleted ${file}; @ (${this.short(this.wc)}) now records the removal.`, c: 'ok' }] };
  }

  _shCat(args) {
    const file = args[0];
    if (!file) throw new JJError('Usage: cat <file>');
    const tree = this.computeTrees().get(this.wc);
    if (!(file in tree)) throw new JJError(`No such file in @: ${file}`);
    const v = tree[file];
    const lines = this._fmtVal(v).split('\n').map(t => ({ t, c: isConflict(v) ? 'err' : '' }));
    return { op: null, lines };
  }

  _shLs() {
    const tree = this.computeTrees().get(this.wc);
    const names = Object.keys(tree).sort();
    if (!names.length) return { op: null, lines: [{ t: '(no files at @)', c: 'dim' }] };
    return { op: null, lines: names.map(f => ({ t: `${f}${isConflict(tree[f]) ? '   ← conflict' : ''}`, c: isConflict(tree[f]) ? 'err' : '' })) };
  }

  _cmdFile(args) {
    const sub = args[0];
    if (sub === 'list' || !sub) return this._shLs();
    if (sub === 'untrack') {
      const file = args[1];
      if (!file) throw new JJError('Usage: jj file untrack <file>');
      this._checkRewritable(this.wc);
      const tree = this.computeTrees().get(this.wc);
      if (!(file in tree)) throw new JJError(`No such file in @: ${file}`);
      const gi = tree['.gitignore'];
      const patterns = gi && !isConflict(gi) ? gi.split(/\s+/) : [];
      if (!patterns.includes(file)) {
        throw new JJError(`'${file}' is not ignored, so jj would immediately snapshot it right back`,
          `Add it to .gitignore first: echo ${file} > .gitignore (or >> to append). Same rule as real jj.`);
      }
      const c = this.get(this.wc);
      const base = this._baseTreeOf(this.wc, null);
      const baseVal = base[file] ?? null;
      if (baseVal === null) delete c.files[file];
      else c.files[file] = { from: isConflict(baseVal) ? baseVal.conflict.base : baseVal, to: null };
      this._touch(this.descendantsOf(this.wc, true));
      return { op: `untrack ${file}`, lines: [
        { t: `Stopped tracking ${file} — removed from @'s snapshot.`, c: 'ok' },
        { t: '(the file still exists on disk; it is now ignored, like git rm --cached)', c: 'dim' },
      ] };
    }
    throw new JJError(`Unknown file subcommand "${sub}"`, 'Supported: jj file list, jj file untrack <file>.');
  }

  _cmdResolve() {
    return { op: null, lines: [
      { t: 'In this playground you resolve a conflict by writing the file while @ is on (or on top of) the conflicted change:', c: 'dim' },
      { t: '    echo <the content you want> > <file>', c: 'cmd2' },
      { t: 'Descendants recompute automatically once the conflict is gone.', c: 'dim' },
    ] };
  }

  /* ---------- remote: a simulated GitHub/GitLab "origin" ---------- */

  _cmdGit(args) {
    const sub = args[0];
    if (sub === 'push') return this._gitPush(args.slice(1));
    if (sub === 'fetch') return this._gitFetch();
    if (sub === 'init' || sub === 'clone') {
      return { op: null, lines: [{ t: 'This playground repo is already git-backed and has an "origin" remote.', c: 'dim' }] };
    }
    throw new JJError(`Unknown git subcommand "${sub}"`, 'Supported: jj git push [--allow-new] [-b name], jj git fetch.');
  }

  _gitPush(rest) {
    const { flags } = parseArgs(rest, {
      b: { value: true, multi: true, aliases: ['bookmark'] },
      'allow-new': {}, 'allow-empty-description': {},
    });
    let names = flags.b || [...this.bookmarks.keys()];
    if (flags.b) {
      for (const n of names) if (!this.bookmarks.has(n)) throw new JJError(`No such bookmark: ${n}`);
    }
    const trees = this.computeTrees();
    const changed = [];
    for (const name of names) {
      const target = this.bookmarks.get(name);
      const cur = this.remote.get(name);
      if (cur && cur.id === target && cur.commitId === this.get(target).commitId) continue;
      if (!cur && !flags['allow-new']) {
        throw new JJError(`Refusing to create new remote bookmark ${name}@origin`,
          `Pass --allow-new to create the branch on origin (real jj safety flag): jj git push --allow-new -b ${name}`);
      }
      // Validate the commits that would land on origin.
      for (const id of this.ancestorsOf(target, true)) {
        if (id === ROOT_ID) continue;
        const c = this.get(id);
        if (Object.values(trees.get(id) || {}).some(isConflict)) {
          throw new JJError(`Won't push commit ${c.commitId.slice(0, 8)} since it has conflicts`, 'Resolve the conflict first — origin should never see conflict markers.');
        }
        if (!c.desc && !flags['allow-empty-description']) {
          throw new JJError(`Won't push commit ${c.commitId.slice(0, 8)} since it has no description`, 'jj describe it first — every commit on origin needs a message.');
        }
      }
      changed.push(name);
    }
    if (!changed.length) return { op: null, lines: [{ t: 'Nothing changed.', c: 'dim' }] };
    const lines = [{ t: 'Changes to push to origin:', c: 'ok' }];
    for (const name of changed) {
      const target = this.bookmarks.get(name);
      const cur = this.remote.get(name);
      lines.push({
        t: cur
          ? `  Move ${name} from ${cur.commitId.slice(0, 8)} to ${this.get(target).commitId.slice(0, 8)}`
          : `  Add ${name} → ${this.get(target).commitId.slice(0, 8)} (new branch on origin)`,
        c: '',
      });
      this.remote.set(name, { id: target, commitId: this.get(target).commitId });
    }
    const trunk = this._trunkName();
    if (trunk && changed.includes(trunk)) {
      lines.push({ t: `Commits reachable from ${trunk}@origin are now immutable (◆) — shared history is protected.`, c: 'dim' });
    }
    return { op: `push bookmarks ${changed.join(', ')} to origin`, lines };
  }

  _gitFetch() {
    if (this.fetchCount >= this.remoteScript.length) {
      return { op: null, lines: [{ t: 'Nothing changed.', c: 'dim' }] };
    }
    const batch = this.remoteScript[this.fetchCount];
    this.fetchCount++;
    const lines = [];
    for (const ev of batch) {
      const cur = this.remote.get(ev.on);
      const parentId = cur ? cur.id : this.bookmarks.get(ev.on);
      if (!parentId) throw new JJError(`Remote has no branch "${ev.on}" to update`);
      const trees = this.computeTrees();
      const ptree = trees.get(parentId) || {};
      const files = {};
      for (const [f, v] of Object.entries(ev.files || {})) {
        let from = ptree[f] ?? null;
        if (isConflict(from)) from = from.conflict.base;
        files[f] = { from, to: v };
      }
      const node = this._createChange([parentId], ev.desc, files);
      const oldRemoteId = cur ? cur.id : null;
      this.remote.set(ev.on, { id: node.id, commitId: node.commitId });
      lines.push({ t: `bookmark: ${ev.on}@origin [updated] — new commit ${this.short(node.id)} "${ev.desc}"`, c: 'ok' });
      if (this.bookmarks.get(ev.on) === oldRemoteId || this.bookmarks.get(ev.on) === parentId) {
        this.bookmarks.set(ev.on, node.id);
        lines.push({ t: `  (local bookmark ${ev.on} tracked the update and moved too)`, c: 'dim' });
      }
    }
    return { op: 'fetch from origin', lines };
  }

  _cmdRevert(args) {
    const { flags } = parseArgs(args, {
      r: { value: true, aliases: ['revision'] },
      d: { value: true, aliases: ['destination'] },
    });
    if (!flags.r) throw new JJError('jj revert needs -r <rev> (the commit to invert)');
    const rev = this.resolve(flags.r);
    if (rev === ROOT_ID) throw new JJError('Cannot revert the root commit');
    const dest = flags.d ? this.resolve(flags.d) : this.wc;
    const rc = this.get(rev);
    const files = {};
    for (const [f, p] of Object.entries(rc.files)) files[f] = { from: p.to ?? null, to: p.from ?? null };
    const node = this._createChange([dest], `Revert "${rc.desc || this.short(rev)}"`, files);
    return {
      op: `revert commit ${this.short(rev)}`,
      lines: [
        { t: `Created ${this.short(node.id)} on ${this.short(dest)}: inverse of ${this.short(rev)} "${rc.desc}"`, c: 'ok' },
        { t: '(revert adds an inverse commit — the original stays in history)', c: 'dim' },
      ],
    };
  }

  _cmdUndo() {
    const base = this.undoCursor === null ? this.ops.length - 1 : this.undoCursor;
    const targetIdx = base - 1;
    if (targetIdx < 0) throw new JJError('Nothing to undo (already at the initial operation)');
    const undone = this.ops[base];
    this._restore(this.ops[targetIdx].snap);
    this.undoCursor = targetIdx;
    return {
      op: `undo operation: ${undone.desc}`,
      keepUndoCursor: true,
      lines: [{ t: `Undid operation: ${undone.desc}`, c: 'ok' }, ...this._wcLines()],
    };
  }

  _cmdOp(args) {
    const sub = args[0];
    if (sub === 'log' || !sub) {
      const lines = [];
      for (let i = this.ops.length - 1; i >= 0; i--) {
        const o = this.ops[i];
        lines.push({ t: `${i === this.ops.length - 1 ? '@ ' : '○ '}${o.id}  ${o.desc}`, c: i === this.ops.length - 1 ? 'ok' : '' });
      }
      return { op: null, lines };
    }
    if (sub === 'restore') {
      const prefix = args[1];
      if (!prefix) throw new JJError('jj op restore needs an operation ID (see jj op log)');
      const hits = this.ops.filter(o => o.id.startsWith(prefix));
      if (!hits.length) throw new JJError(`No operation matching "${prefix}"`);
      if (hits.length > 1) throw new JJError(`Operation ID prefix "${prefix}" is ambiguous`);
      this._restore(hits[0].snap);
      return { op: `restore to operation ${hits[0].id.slice(0, 8)}`, lines: [{ t: `Restored to operation ${hits[0].id}`, c: 'ok' }, ...this._wcLines()] };
    }
    throw new JJError(`Unknown op subcommand "${sub}"`, 'Supported: jj op log, jj op restore <id>.');
  }

  _cmdLog() {
    const row = this._rows();
    const idx = new Map([...this.changes.keys()].map((id, i) => [id, i]));
    const nodes = [...this.changes.values()].sort((a, b) => (row[b.id] - row[a.id]) || (idx.get(b.id) - idx.get(a.id)));
    const immutable = this._immutableIds();
    const conflicted = this._conflictedIds();
    const lines = nodes.map(c => {
      const sym = conflicted.has(c.id) ? '×' : c.id === this.wc ? '@' : (immutable.has(c.id) ? '◆' : '○');
      const bks = [
        ...this.bookmarksAt(c.id),
        ...this.remoteBookmarksAt(c.id).map(n => n + '@origin'),
      ];
      const bk = bks.length ? ' ' + bks.join(' ') : '';
      const flag = conflicted.has(c.id) ? ' (conflict)' : '';
      return {
        t: `${sym}  ${this.short(c.id)} ${c.commitId.slice(0, 8)}${bk} ${c.id === ROOT_ID ? 'root()' : this._descOf(c)}${flag}`,
        c: conflicted.has(c.id) ? 'err' : c.id === this.wc ? 'ok' : '',
      };
    });
    return { op: null, lines };
  }

  _cmdStatus() {
    const c = this.get(this.wc);
    const lines = [];
    const entries = Object.entries(c.files);
    if (!entries.length) lines.push({ t: 'The working copy has no changes.', c: 'dim' });
    else {
      lines.push({ t: 'Working copy changes:', c: '' });
      for (const [f, p] of entries) {
        const kind = (p.from ?? null) === null ? 'A' : (p.to ?? null) === null ? 'D' : 'M';
        lines.push({ t: `  ${kind} ${f}`, c: kind === 'D' ? 'err' : 'ok' });
      }
    }
    const tree = this.computeTrees().get(this.wc);
    const conflicted = Object.keys(tree).filter(f => isConflict(tree[f]));
    if (conflicted.length) {
      lines.push({ t: 'There are unresolved conflicts at these paths:', c: 'err' });
      conflicted.forEach(f => lines.push({ t: `  ${f}    (write the file to resolve: echo <content> > ${f})`, c: 'err' }));
    }
    lines.push({ t: `Working copy  (@) : ${this._fmt(this.wc)}`, c: 'ok' });
    lines.push(...c.parents.map(p => ({ t: `Parent commit (@-): ${this._fmt(p)}`, c: 'dim' })));
    return { op: null, lines };
  }

  /* ---------- state for rendering / comparison ---------- */

  getState() {
    const bookmarks = {};
    for (const [name, target] of this.bookmarks) bookmarks[name] = target;
    const remoteBookmarks = {};
    for (const [name, ref] of this.remote) {
      if (!this.changes.has(ref.id)) continue;
      remoteBookmarks[name] = { id: ref.id, stale: this.get(ref.id).commitId !== ref.commitId };
    }
    const trees = this.computeTrees();
    const immutable = this._immutableIds();
    return {
      changes: [...this.changes.values()].map(c => {
        const tree = trees.get(c.id) || {};
        const treeView = {};
        for (const [f, v] of Object.entries(tree)) treeView[f] = isConflict(v) ? '!conflict' : v;
        return {
          ...c,
          parents: c.parents.slice(),
          files: JSON.parse(JSON.stringify(c.files)),
          tree: treeView,
          conflicted: Object.values(tree).some(isConflict),
          immutable: immutable.has(c.id),
          hasFiles: Object.keys(c.files).length > 0,
        };
      }),
      wc: this.wc,
      bookmarks,
      remoteBookmarks,
    };
  }
}

/* Structural comparison: reduce a state to its "significant" nodes (root,
 * described changes, bookmark targets, and — optionally — @), each keyed by
 * description, with edges to the nearest significant ancestors. Change and
 * commit IDs are ignored, matching jj's philosophy that IDs are incidental. */
function analyzeState(state, opts = {}) {
  const checkWC = opts.checkWC !== false;
  const byId = new Map(state.changes.map(c => [c.id, c]));
  const bkAt = {};
  for (const [name, target] of Object.entries(state.bookmarks)) (bkAt[target] = bkAt[target] || []).push(name);
  for (const k of Object.keys(bkAt)) bkAt[k].sort();
  const rbAt = {};
  for (const [name, ref] of Object.entries(state.remoteBookmarks || {})) {
    (rbAt[ref.id] = rbAt[ref.id] || []).push({ name, stale: !!ref.stale });
  }
  for (const k of Object.keys(rbAt)) rbAt[k].sort((a, b) => a.name.localeCompare(b.name));

  const isSig = id => {
    const c = byId.get(id);
    if (!c) return false;
    return c.id === ROOT_ID || !!c.desc || !!bkAt[id] || !!rbAt[id] || (checkWC && id === state.wc);
  };
  const keyOf = id => {
    const c = byId.get(id);
    if (c.id === ROOT_ID) return 'ROOT';
    if (c.desc) return 'D:' + c.desc;
    if (bkAt[id]) return 'B:' + bkAt[id].join(',');
    if (rbAt[id]) return 'R:' + rbAt[id].map(r => r.name).join(',');
    return '@';
  };
  const sigAncestors = id => {
    const out = new Set(); const seen = new Set();
    const walk = pid => {
      if (seen.has(pid)) return;
      seen.add(pid);
      if (isSig(pid)) { out.add(keyOf(pid)); return; }
      const c = byId.get(pid);
      if (c) c.parents.forEach(walk);
    };
    byId.get(id).parents.forEach(walk);
    return [...out].sort();
  };

  const nodes = [];
  for (const c of state.changes) {
    if (!isSig(c.id)) continue;
    const tree = {};
    for (const [f, v] of Object.entries(c.tree || {})) tree[f] = v === '!conflict' ? '!' : v;
    nodes.push({
      id: c.id,
      key: keyOf(c.id),
      parents: sigAncestors(c.id),
      bookmarks: (bkAt[c.id] || []),
      rbk: (rbAt[c.id] || []),
      tree,
      conflicted: !!c.conflicted,
      wc: c.id === state.wc,
    });
  }
  return { nodes, checkWC };
}

function canonState(state, opts = {}) {
  const { nodes, checkWC } = analyzeState(state, opts);
  return nodes.map(n => {
    const parts = [
      n.key,
      'p=' + n.parents.join('|'),
      'bk=' + n.bookmarks.join(','),
      'rbk=' + n.rbk.map(r => r.name + (r.stale ? '~' : '')).join(','),
      'tree=' + JSON.stringify(Object.entries(n.tree).sort((a, b) => a[0].localeCompare(b[0]))),
    ];
    if (checkWC) parts.push('wc=' + (n.wc ? 1 : 0));
    return parts.join(' ; ');
  }).sort().join('\n');
}

/* Human-readable differences between a player's state and the goal state.
 * Returns an array of plain-English messages; empty means they match. */
function diffStates(userState, goalState, opts = {}) {
  const U = analyzeState(userState, opts).nodes;
  const G = analyzeState(goalState, opts).nodes;
  const checkWC = opts.checkWC !== false;
  const friendly = k =>
    k === 'ROOT' ? 'root'
    : k === '@' ? 'an empty, undescribed change'
    : k.startsWith('D:') ? `"${k.slice(2)}"`
    : `the change holding bookmark "${k.slice(2)}"`;
  const plist = ps => ps.length ? ps.map(friendly).join(' + ') : '(nothing)';
  const group = arr => {
    const m = new Map();
    for (const n of arr) { if (!m.has(n.key)) m.set(n.key, []); m.get(n.key).push(n); }
    return m;
  };
  const uBy = group(U), gBy = group(G);
  const msgs = [];

  for (const [key, gs] of gBy) {
    const us = uBy.get(key) || [];
    if (!us.length) {
      msgs.push(key === '@'
        ? `The goal ends on a fresh empty change (@) on top of ${plist(gs[0].parents)} — finish with jj new.`
        : `Your graph is missing a change described ${friendly(key)} on top of ${plist(gs[0].parents)}.`);
      continue;
    }
    if (us.length !== gs.length) {
      msgs.push(`You have ${us.length} changes matching ${friendly(key)}; the goal has ${gs.length}.`);
      continue;
    }
    if (us[0].parents.join('|') !== gs[0].parents.join('|')) {
      msgs.push(`${friendly(key)} sits on ${plist(us[0].parents)}, but the goal wants it on ${plist(gs[0].parents)}.`);
    }
    // File-tree differences at this node.
    const uf = us[0].tree || {}, gf = gs[0].tree || {};
    for (const f of new Set([...Object.keys(uf), ...Object.keys(gf)])) {
      const uv = uf[f], gv = gf[f];
      if (uv === gv) continue;
      if (uv === '!') msgs.push(`"${f}" in ${friendly(key)} has an unresolved conflict — resolve it by writing the file (echo <content> > ${f}).`);
      else if (gv === undefined) msgs.push(`${friendly(key)} shouldn't contain "${f}" — remove it (rm ${f}) or fix the commit that adds it.`);
      else if (uv === undefined) msgs.push(`${friendly(key)} should contain "${f}" = "${gv}".`);
      else msgs.push(`"${f}" in ${friendly(key)} contains "${uv}", but the goal wants "${gv}".`);
    }
  }
  for (const [key, us] of uBy) {
    if (gBy.has(key)) continue;
    msgs.push(key === '@'
      ? `@ is on an extra empty change (on top of ${plist(us[0].parents)}) that the goal doesn't have — jj undo, or jj edit the change @ should be on.`
      : `You have an extra change ${friendly(key)} that isn't in the goal — jj abandon it, or jj undo.`);
  }
  if (checkWC) {
    const uk = (U.find(n => n.wc) || {}).key || null;
    const gk = (G.find(n => n.wc) || {}).key || null;
    if (uk !== gk && gk) {
      msgs.push(`@ should end up on ${gk === '@' ? 'the fresh empty change on top' : friendly(gk)}` +
        (uk ? `, but yours is on ${friendly(uk)}.` : '.'));
    }
  }
  const bmap = nodes => {
    const m = new Map();
    for (const n of nodes) for (const b of n.bookmarks) m.set(b, n.key);
    return m;
  };
  const ub = bmap(U), gb = bmap(G);
  for (const [name, key] of gb) {
    if (!ub.has(name)) msgs.push(`Missing bookmark "${name}" — the goal has it on ${friendly(key)}.`);
    else if (ub.get(name) !== key) msgs.push(`Bookmark "${name}" points at ${friendly(ub.get(name))}, but the goal wants it on ${friendly(key)}.`);
  }
  for (const name of ub.keys()) {
    if (!gb.has(name)) msgs.push(`You have a bookmark "${name}" that isn't in the goal — jj bookmark delete ${name}.`);
  }
  // Remote bookmarks (origin branches).
  const rmap = nodes => {
    const m = new Map();
    for (const n of nodes) for (const r of n.rbk) m.set(r.name, { key: n.key, stale: r.stale });
    return m;
  };
  const ur = rmap(U), gr = rmap(G);
  for (const [name, g] of gr) {
    const u = ur.get(name);
    if (!u) msgs.push(`origin has no branch "${name}" yet — the goal wants ${name}@origin on ${friendly(g.key)} (jj git push --allow-new).`);
    else if (u.key !== g.key) msgs.push(`${name}@origin points at ${friendly(u.key)}, but the goal wants it on ${friendly(g.key)} — jj git push after moving the bookmark.`);
    else if (u.stale && !g.stale) msgs.push(`${name}@origin is stale — you rewrote the commit locally but haven't pushed (jj git push).`);
  }
  for (const name of ur.keys()) {
    if (!gr.has(name)) msgs.push(`origin has a branch "${name}" that isn't in the goal.`);
  }
  return msgs;
}

const JJ = { JJEngine, JJError, tokenize, canonState, analyzeState, diffStates, ROOT_ID };
if (typeof module !== 'undefined' && module.exports) module.exports = JJ;
else global.JJ = JJ;
})(typeof window !== 'undefined' ? window : globalThis);
