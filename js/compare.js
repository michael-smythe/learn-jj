/*
 * compare.js — structural state comparison for win detection and the
 * "check" command. Pure functions over JJEngine.getState() snapshots; no
 * engine internals. Loaded before engine.js (which re-exports these).
 */
(function (global) {
'use strict';

/* Structural comparison: reduce a state to its "significant" nodes (root,
 * described changes, bookmark targets, and — optionally — @), each keyed by
 * description, with edges to the nearest significant ancestors. Change and
 * commit IDs are ignored, matching jj's philosophy that IDs are incidental. */
function analyzeState(state, opts = {}) {
  const checkWC = opts.checkWC !== false;
  const byId = new Map(state.changes.map(c => [c.id, c]));
  const bkAt = {};
  for (const [name, val] of Object.entries(state.bookmarks)) {
    const conflicted = typeof val !== 'string';
    const targets = conflicted ? val.conflict : [val];
    for (const t of targets) (bkAt[t] = bkAt[t] || []).push(name + (conflicted ? '??' : ''));
  }
  for (const k of Object.keys(bkAt)) bkAt[k].sort();
  const rbAt = {};
  for (const [name, ref] of Object.entries(state.remoteBookmarks || {})) {
    (rbAt[ref.id] = rbAt[ref.id] || []).push({ name, stale: !!ref.stale });
  }
  for (const k of Object.keys(rbAt)) rbAt[k].sort((a, b) => a.name.localeCompare(b.name));

  const isSig = id => {
    const c = byId.get(id);
    if (!c) return false;
    return c.parents.length === 0 || !!c.desc || !!bkAt[id] || !!rbAt[id] ||
      Object.keys(c.files || {}).length > 0 || (checkWC && id === state.wc);
  };
  const keyOf = id => {
    const c = byId.get(id);
    if (c.parents.length === 0) return 'ROOT';
    if (c.desc) return 'D:' + c.desc;
    if (bkAt[id]) return 'B:' + bkAt[id].join(',');
    if (rbAt[id]) return 'R:' + rbAt[id].map(r => r.name).join(',');
    const fs = Object.keys(c.files || {});
    if (fs.length) return 'F:' + fs.sort().join(',');
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
    for (const [f, v] of Object.entries(c.tree || {})) tree[f] = (v && typeof v === 'object') ? { conflict: true } : v;
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
      if (JSON.stringify(uv) === JSON.stringify(gv)) continue;
      const isConf = v => v && typeof v === 'object';
      if (isConf(uv)) msgs.push(`"${f}" in ${friendly(key)} has an unresolved conflict — resolve it by writing the file (echo <content> > ${f}).`);
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

const JJCompare = { analyzeState, canonState, diffStates };
if (typeof module !== 'undefined' && module.exports) module.exports = JJCompare;
else global.JJCompare = JJCompare;
})(typeof window !== 'undefined' ? window : globalThis);
