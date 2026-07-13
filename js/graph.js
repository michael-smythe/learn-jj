/*
 * graph.js — SVG renderer for the jj change graph, with tweened transitions.
 * Root sits at the bottom; children stack upward (like jj log, newest on top).
 */
(function (global) {
'use strict';

const COL_GAP = 108;
const ROW_GAP = 92;
const R = 20;
const SVGNS = 'http://www.w3.org/2000/svg';

const stores = new WeakMap();

function layout(state) {
  const nodes = state.changes;
  const byId = new Map(nodes.map(c => [c.id, c]));
  const idx = new Map(nodes.map((c, i) => [c.id, i]));
  const children = new Map(nodes.map(c => [c.id, []]));
  for (const c of nodes) for (const p of c.parents) if (children.has(p)) children.get(p).push(c.id);

  // Rows: longest path from a root, via Kahn's algorithm.
  const row = new Map(); const indeg = new Map(); const queue = [];
  for (const c of nodes) {
    indeg.set(c.id, c.parents.filter(p => byId.has(p)).length);
    if (!indeg.get(c.id)) { row.set(c.id, 0); queue.push(c.id); }
  }
  while (queue.length) {
    const cur = queue.shift();
    for (const kid of children.get(cur)) {
      row.set(kid, Math.max(row.get(kid) || 0, row.get(cur) + 1));
      indeg.set(kid, indeg.get(kid) - 1);
      if (!indeg.get(kid)) queue.push(kid);
    }
  }

  // Columns: a chain keeps its first parent's column; siblings shift right.
  const order = [...nodes].sort((a, b) => (row.get(a.id) - row.get(b.id)) || (idx.get(a.id) - idx.get(b.id)));
  const col = new Map(); const occupied = new Set();
  for (const n of order) {
    const firstParent = n.parents.find(p => col.has(p));
    let c = firstParent !== undefined ? col.get(firstParent) : 0;
    while (occupied.has(c + ':' + row.get(n.id))) c++;
    col.set(n.id, c);
    occupied.add(c + ':' + row.get(n.id));
  }

  const pos = new Map();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const x = col.get(n.id) * COL_GAP;
    const y = -row.get(n.id) * ROW_GAP;
    pos.set(n.id, { x, y });
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const padL = 70, padR = 130, padT = 55, padB = 55;
  let vb = [minX - padL, minY - padT, (maxX - minX) + padL + padR, (maxY - minY) + padT + padB];
  const minW = 340, minH = 260;
  if (vb[2] < minW) { vb[0] -= (minW - vb[2]) / 2; vb[2] = minW; }
  if (vb[3] < minH) { vb[1] -= (minH - vb[3]) / 2; vb[3] = minH; }
  return { pos, vb };
}

function el(name, attrs, parent) {
  const e = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

function edgePath(a, b) {
  // a = child (above, smaller y), b = parent (below).
  const x1 = a.x, y1 = a.y + R, x2 = b.x, y2 = b.y - R;
  if (Math.abs(x1 - x2) < 0.5) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const my = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
}

function ease(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

function buildNode(c, state, opts) {
  const g = el('g', { class: 'node' });
  const isWC = c.id === state.wc;
  const isRoot = c.parents.length === 0;
  const bks = Object.entries(state.bookmarks).filter(([, t]) => t === c.id).map(([n]) => n).sort();
  const rbks = Object.entries(state.remoteBookmarks || {})
    .filter(([, ref]) => ref.id === c.id)
    .map(([n, ref]) => ({ name: n + '@origin', stale: ref.stale }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (isRoot) {
    el('rect', { x: -15, y: -15, width: 30, height: 30, rx: 4, transform: 'rotate(45)', class: 'nodeRoot' }, g);
    el('text', { y: 4, class: 'nodeDescText nodeRootText', 'text-anchor': 'middle' }, g).textContent = 'root';
  } else {
    if (isWC) el('circle', { r: R + 6, class: 'wcRing' }, g);
    let cls = c.desc || c.hasFiles ? 'nodeCircle described' : 'nodeCircle empty';
    if (c.conflicted) cls += ' conflicted';
    if (c.immutable) cls += ' immutable';
    el('circle', { r: R, class: cls }, g);
    const files = Object.keys(c.files || {});
    const raw = c.desc || (files.length ? files[0] : 'empty');
    const label = el('text', { y: 4, class: c.desc ? 'nodeDescText' : 'nodeEmptyText', 'text-anchor': 'middle' }, g);
    label.textContent = raw.length > 9 ? raw.slice(0, 8) + '…' : raw;
    if (c.conflicted) {
      const badge = el('g', { transform: `translate(${R - 4}, ${-R + 2})`, class: 'conflictBadge' }, g);
      el('circle', { r: 9 }, badge);
      el('text', { y: 4, 'text-anchor': 'middle' }, badge).textContent = '×';
    }
  }

  if (!opts.hideIds) {
    const idText = el('text', { y: R + 16, class: 'nodeId', 'text-anchor': 'middle' }, g);
    if (c.immutable && !isRoot) {
      const im = el('tspan', { class: 'immuMark' }, idText);
      im.textContent = '◆ ';
    }
    const hi = el('tspan', { class: 'nodeIdHi' }, idText);
    hi.textContent = c.id.slice(0, 2);
    const lo = el('tspan', { class: 'nodeIdLo' }, idText);
    lo.textContent = c.id.slice(2, 5);
  }

  if (isWC) {
    const badge = el('g', { class: 'wcBadge', transform: `translate(${-R - 24}, ${-R - 2})` }, g);
    el('rect', { x: -11, y: -11, width: 24, height: 22, rx: 6, class: 'wcBadgeBg' }, badge);
    el('text', { y: 5, x: 1, 'text-anchor': 'middle', class: 'wcBadgeText' }, badge).textContent = '@';
  }

  let chipRow = 0;
  bks.forEach(name => {
    const chip = el('g', { transform: `translate(${R + 10}, ${-10 + chipRow++ * 21})`, class: 'bookmarkChip' }, g);
    const w = 14 + name.length * 7.2;
    el('rect', { x: 0, y: 0, width: w, height: 17, rx: 8 }, chip);
    el('text', { x: w / 2, y: 12, 'text-anchor': 'middle' }, chip).textContent = name;
  });
  rbks.forEach(r => {
    const chip = el('g', {
      transform: `translate(${R + 10}, ${-10 + chipRow++ * 21})`,
      class: 'remoteChip' + (r.stale ? ' stale' : ''),
    }, g);
    const label = r.name + (r.stale ? ' *' : '');
    const w = 14 + label.length * 6.6;
    el('rect', { x: 0, y: 0, width: w, height: 17, rx: 8 }, chip);
    el('text', { x: w / 2, y: 12, 'text-anchor': 'middle' }, chip).textContent = label;
  });

  return g;
}

function render(svg, state, opts = {}) {
  let store = stores.get(svg);
  if (!store) { store = { pos: new Map(), vb: null, raf: null }; stores.set(svg, store); }
  if (store.raf) cancelAnimationFrame(store.raf);

  const { pos: target, vb: targetVb } = layout(state);
  const first = store.pos.size === 0;
  const startVb = store.vb || targetVb;

  svg.innerHTML = '';
  const gEdges = el('g', {}, svg);
  const gNodes = el('g', {}, svg);

  const edges = [];
  for (const c of state.changes) {
    for (const p of c.parents) {
      if (!target.has(p)) continue;
      edges.push({ from: c.id, to: p, elem: el('path', { class: 'edge' }, gEdges) });
    }
  }

  const nodeEls = [];
  for (const c of state.changes) {
    const g = buildNode(c, state, opts);
    gNodes.appendChild(g);
    const to = target.get(c.id);
    let from = store.pos.get(c.id);
    let isNew = false;
    if (!from) {
      isNew = true;
      const pWithPos = c.parents.find(p => store.pos.has(p));
      from = pWithPos ? { ...store.pos.get(pWithPos) } : { ...to };
    }
    nodeEls.push({ id: c.id, g, from, to, isNew });
  }

  const dur = first ? 0 : 480;
  const t0 = performance.now();
  const cur = new Map();

  const frame = now => {
    const k = dur === 0 ? 1 : ease(Math.min(1, (now - t0) / dur));
    for (const n of nodeEls) {
      const x = n.from.x + (n.to.x - n.from.x) * k;
      const y = n.from.y + (n.to.y - n.from.y) * k;
      cur.set(n.id, { x, y });
      n.g.setAttribute('transform', `translate(${x}, ${y})`);
      if (n.isNew) n.g.setAttribute('opacity', String(0.15 + 0.85 * k));
    }
    for (const e of edges) e.elem.setAttribute('d', edgePath(cur.get(e.from), cur.get(e.to)));
    const vb = startVb.map((v, i) => v + (targetVb[i] - v) * k);
    svg.setAttribute('viewBox', vb.join(' '));
    if (k < 1) store.raf = requestAnimationFrame(frame);
    else { store.pos = new Map([...target]); store.vb = targetVb; store.raf = null; }
  };
  store.raf = requestAnimationFrame(frame);
}

function resetView(svg) { stores.delete(svg); }

const GraphView = { render, resetView };
if (typeof module !== 'undefined' && module.exports) module.exports = GraphView;
else global.GraphView = GraphView;
})(typeof window !== 'undefined' ? window : globalThis);
