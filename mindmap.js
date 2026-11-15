// Mind map: centre topic in the middle, branches split left and right (like XMind / MindNode),
// smooth coloured curves, pan with one finger, pinch or ⌘/ctrl-scroll to zoom, tap a branch to fold it.
// The same layout is reused for the printable / GoodNotes PDF (staticMindMapHTML).

export const MM_PALETTE = ['#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#14b8a6', '#a855f7'];
const H_GAP = [76, 52, 38];     // horizontal gap after depth 0, 1, 2
const V_GAP = [26, 16, 8];      // vertical gap between siblings at depth 1, 2, 3
const STROKE = [4.5, 3, 2];
const PAD = 48;

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function buildTree(m) {
  // all keywords of a sub-point sit together in one row of chips (keeps the map short and easy to scan)
  const child = c => ({ label: c.label, depth: 2, kids: (c.leaves || []).length ? [{ label: c.leaves, depth: 3, kids: [] }] : [] });
  const branches = (m.branches || []).map((b, i) => ({ label: b.label, depth: 1, color: MM_PALETTE[i % MM_PALETTE.length], idx: i, kids: (b.children || []).map(child) }));
  const color = (t, c) => { t.color = c; t.kids.forEach(k => color(k, c)); };
  branches.forEach(b => color(b, b.color));
  // balance sides by size, keeping reading order: first ones on the right, the rest on the left
  const weight = t => 1 + t.kids.reduce((a, k) => a + weight(k), 0);
  const total = branches.reduce((a, b) => a + weight(b), 0);
  let acc = 0;
  branches.forEach(b => { b.side = acc < total / 2 || branches.length === 1 ? 1 : -1; acc += weight(b); });
  return { label: m.center, depth: 0, kids: branches, color: '#8b5cf6' };
}

function innerHTML(t, textOf) {
  if (t.depth === 3) {
    return t.label.map(l => { const { main, sub } = textOf(l); return `<span class="mmx-chip"><i class="mmx-dot"></i><b>${esc(main)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>`; }).join('');
  }
  const { main, sub } = textOf(t.label);
  return `<span class="mmx-t"><b>${esc(main)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>`;
}
function nodeEl(t, textOf) {
  const el = document.createElement('div');
  el.className = `mmx-n mmx-l${t.depth}` + (t.depth === 1 && t.kids.length ? ' foldable' : '');
  el.style.setProperty('--c', t.color);
  el.innerHTML = innerHTML(t, textOf);
  t.el = el;
  return el;
}

function layout(root, folded) {
  const visKids = t => (t.depth === 1 && folded.has(t.idx) ? [] : t.kids);
  const measure = t => { t.w = t.el.offsetWidth; t.h = t.el.offsetHeight; t.kids.forEach(measure); };
  measure(root);
  const sh = t => {
    const ks = visKids(t);
    if (!ks.length) return (t.sh = t.h);
    const gap = V_GAP[Math.min(t.depth, 2)];
    const sum = ks.reduce((a, k) => a + sh(k), 0) + gap * (ks.length - 1);
    return (t.sh = Math.max(t.h, sum));
  };
  const place = (t, edgeX, cy, dir) => {
    t.x = dir > 0 ? edgeX : edgeX - t.w;
    t.y = cy - t.h / 2;
    t.dir = dir;
    const ks = visKids(t);
    const gap = V_GAP[Math.min(t.depth, 2)];
    let y = cy - (ks.reduce((a, k) => a + k.sh, 0) + gap * (ks.length - 1)) / 2;
    const childEdge = dir > 0 ? t.x + t.w + H_GAP[Math.min(t.depth, 2)] : t.x - H_GAP[Math.min(t.depth, 2)];
    ks.forEach(k => { place(k, childEdge, y + k.sh / 2, dir); y += k.sh + gap; });
  };
  root.kids.forEach(sh);
  root.x = -root.w / 2; root.y = -root.h / 2; root.dir = 0;
  for (const side of [1, -1]) {
    const bs = root.kids.filter(b => b.side === side);
    const gap = V_GAP[0];
    let y = -(bs.reduce((a, b) => a + b.sh, 0) + gap * (bs.length - 1)) / 2;
    const edge = side > 0 ? root.x + root.w + H_GAP[0] : root.x - H_GAP[0];
    bs.forEach(b => { place(b, edge, y + b.sh / 2, side); y += b.sh + gap; });
  }
  // bounds → shift everything to positive coordinates
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const all = [];
  const walk = t => { all.push(t); minX = Math.min(minX, t.x); minY = Math.min(minY, t.y); maxX = Math.max(maxX, t.x + t.w); maxY = Math.max(maxY, t.y + t.h); visKids(t).forEach(walk); };
  walk(root);
  const dx = PAD - minX, dy = PAD - minY;
  all.forEach(t => { t.x += dx; t.y += dy; });
  const visible = new Set(all);
  const hide = t => { if (!visible.has(t)) t.hidden = true; else t.hidden = false; t.kids.forEach(hide); };
  hide(root);
  return { width: maxX - minX + PAD * 2, height: maxY - minY + PAD * 2, nodes: all, visKids };
}

function paths(root, visKids) {
  const out = [];
  const link = (p, k) => {
    const dir = k.dir;
    const x1 = dir > 0 ? p.x + p.w : p.x, y1 = p.y + p.h / 2;
    const x2 = dir > 0 ? k.x : k.x + k.w, y2 = k.y + k.h / 2;
    const mx = (x1 + x2) / 2;
    const sw = STROKE[Math.min(p.depth, 2)];
    const op = p.depth >= 2 ? 0.55 : 0.85;
    out.push(`<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} C${mx.toFixed(1)} ${y1.toFixed(1)} ${mx.toFixed(1)} ${y2.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}" stroke="${k.color}" stroke-width="${sw}" stroke-opacity="${op}" fill="none" stroke-linecap="round"/>`);
  };
  const walk = t => visKids(t).forEach(k => { link(t, k); walk(k); });
  walk(root);
  return out.join('');
}

function render(stage, svg, root, folded) {
  const L = layout(root, folded);
  stage.style.width = L.width + 'px';
  stage.style.height = L.height + 'px';
  svg.setAttribute('width', L.width); svg.setAttribute('height', L.height);
  svg.setAttribute('viewBox', `0 0 ${L.width} ${L.height}`);
  svg.innerHTML = paths(root, L.visKids);
  const all = []; const walk = t => { all.push(t); t.kids.forEach(walk); }; walk(root);
  all.forEach(t => {
    t.el.style.transform = `translate(${t.x}px, ${t.y}px)`;
    t.el.classList.toggle('gone', !!t.hidden);
    if (t.depth === 1) { t.el.classList.toggle('folded', folded.has(t.idx)); t.el.classList.toggle('side-left', t.dir < 0); }
  });
  return L;
}

/** Interactive mind map. textOf(label) → { main, sub } in the language the reader chose. */
export function mindMapView(m, textOf, { motion = true, onFold } = {}) {
  const root = buildTree(m);
  const folded = new Set();
  const view = document.createElement('div'); view.className = 'mmx';
  const stage = document.createElement('div'); stage.className = 'mmx-stage';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.classList.add('mmx-lines');
  stage.append(svg);
  const all = []; const walk = t => { all.push(t); stage.append(nodeEl(t, textOf)); t.kids.forEach(walk); }; walk(root);
  view.append(stage);

  // view transform
  let s = 1, tx = 0, ty = 0, L = null;
  const apply = (anim) => {
    stage.style.transition = anim && motion ? 'transform .45s cubic-bezier(.3,.7,.4,1)' : 'none';
    stage.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
  };
  // Fit the whole map, but never smaller than readable; if it doesn't fit, centre on the main topic.
  const fit = (anim = true) => {
    if (!L) return;
    const vw = view.clientWidth, vh = view.clientHeight;
    const whole = Math.min(vw / L.width, vh / L.height);
    s = Math.min(1.1, Math.max(0.62, whole));
    if (whole >= 0.62) { tx = (vw - L.width * s) / 2; ty = (vh - L.height * s) / 2; }
    else { tx = vw / 2 - (root.x + root.w / 2) * s; ty = vh / 2 - (root.y + root.h / 2) * s; }
    apply(anim);
  };
  const overview = () => {
    if (!L) return;
    const vw = view.clientWidth, vh = view.clientHeight;
    s = Math.max(0.2, Math.min(1.1, vw / L.width, vh / L.height));
    tx = (vw - L.width * s) / 2; ty = (vh - L.height * s) / 2;
    apply(true);
  };
  const zoomAt = (k, cx, cy, anim) => {
    const ns = Math.min(2.5, Math.max(0.2, s * k));
    tx = cx - (cx - tx) * (ns / s); ty = cy - (cy - ty) * (ns / s); s = ns;
    apply(anim);
  };
  const relayout = (anim) => { L = render(stage, svg, root, folded); if (anim) fit(true); };

  // pointers: drag to pan, two fingers to pinch, tap a branch to fold
  const pts = new Map();
  let start = null, pinch = null, moved = false;
  view.addEventListener('pointerdown', e => {
    view.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    if (pts.size === 1) start = { x: e.clientX, y: e.clientY, tx, ty, target: e.target.closest('.mmx-n') };
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const r = view.getBoundingClientRect();
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s, cx: (a.x + b.x) / 2 - r.left, cy: (a.y + b.y) / 2 - r.top, tx, ty };
    }
  });
  view.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2 && pinch) {
      const [a, b] = [...pts.values()];
      const k = Math.hypot(a.x - b.x, a.y - b.y) / pinch.d;
      const ns = Math.min(2.5, Math.max(0.2, pinch.s * k));
      tx = pinch.cx - (pinch.cx - pinch.tx) * (ns / pinch.s); ty = pinch.cy - (pinch.cy - pinch.ty) * (ns / pinch.s); s = ns;
      moved = true; apply(false);
    } else if (pts.size === 1 && start) {
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
      if (moved) { tx = start.tx + dx; ty = start.ty + dy; apply(false); }
    }
  });
  const up = e => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (!pts.size) {
      if (!moved && start && start.target && start.target.classList.contains('foldable')) {
        const t = all.find(x => x.el === start.target);
        if (t) { folded.has(t.idx) ? folded.delete(t.idx) : folded.add(t.idx); relayout(true); onFold && onFold(t.el); }
      }
      start = null;
    }
  };
  view.addEventListener('pointerup', up);
  view.addEventListener('pointercancel', up);
  view.addEventListener('wheel', e => {
    e.preventDefault();
    const r = view.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top, false);
    else { tx -= e.deltaX; ty -= e.deltaY; apply(false); }
  }, { passive: false });
  view.addEventListener('dblclick', e => { const r = view.getBoundingClientRect(); zoomAt(1.6, e.clientX - r.left, e.clientY - r.top, true); });

  // lay out once the map is on screen (sizes are measured from the real nodes)
  const ro = new ResizeObserver(() => { if (!view.isConnected) return; if (!L) relayout(false); fit(false); });
  ro.observe(view);
  view.mm = {
    zoomIn: () => zoomAt(1.3, view.clientWidth / 2, view.clientHeight / 2, true),
    zoomOut: () => zoomAt(1 / 1.3, view.clientWidth / 2, view.clientHeight / 2, true),
    fit: () => overview(),
    expandAll: () => { folded.clear(); relayout(true); },
    collapseAll: () => { root.kids.forEach(b => b.kids.length && folded.add(b.idx)); relayout(true); },
  };
  return view;
}

/** Printable copy (PDF / GoodNotes): the same layout, scaled to the page width, no interaction. */
export function staticMindMapHTML(m, textOf, maxWidth = 1000, maxHeight = 0) {
  const root = buildTree(m);
  const box = document.createElement('div');
  box.className = 'mmx-measure';
  box.style.cssText = 'position:fixed;left:-20000px;top:0;visibility:hidden;';
  const stage = document.createElement('div'); stage.className = 'mmx-stage';
  const walk = t => { stage.append(nodeEl(t, textOf)); t.kids.forEach(walk); }; walk(root);
  box.append(stage); document.body.append(box);
  const L = layout(root, new Set());
  // A wide map on a tall page: turn it sideways so it can use the long edge of the paper.
  const flat = Math.min(1, maxWidth / L.width);
  const turned = maxHeight ? Math.min(1, maxHeight / L.width, maxWidth / L.height) : 0;
  const rotate = turned > flat * 1.2;
  const k = rotate ? turned : flat;
  const nodes = [];
  const w2 = t => { nodes.push(t); t.kids.forEach(w2); }; w2(root);
  const boxW = rotate ? L.height * k : L.width * k, boxH = rotate ? L.width * k : L.height * k;
  const tf = rotate ? `translate(${(L.height * k).toFixed(1)}px,0) rotate(90deg) scale(${k.toFixed(4)})` : `scale(${k.toFixed(4)})`;
  const html = `<div class="mmx-print${rotate ? ' turned' : ''}" style="width:${boxW.toFixed(0)}px;height:${boxH.toFixed(0)}px">
<div style="position:relative;width:${L.width}px;height:${L.height}px;transform:${tf};transform-origin:0 0">
<svg width="${L.width}" height="${L.height}" style="position:absolute;inset:0">${paths(root, L.visKids)}</svg>
${nodes.map(t => `<div class="mmx-n mmx-l${t.depth}" style="--c:${t.color};position:absolute;left:0;top:0;transform:translate(${t.x}px,${t.y}px)">${innerHTML(t, textOf)}</div>`).join('')}
</div></div>`;
  box.remove();
  return html;
}

/** Node styles shared by the screen and the printable copy. */
export const MM_NODE_CSS = `
.mmx-n { position: absolute; left: 0; top: 0; display: flex; align-items: center; gap: 7px; width: max-content; max-width: 230px; box-sizing: border-box; line-height: 1.3; white-space: normal; }
.mmx-t { display: flex; flex-direction: column; min-width: 0; }
.mmx-t b { font-weight: 650; overflow-wrap: anywhere; }
.mmx-t small { font-size: .74em; opacity: .72; font-weight: 500; margin-top: 1px; overflow-wrap: anywhere; }
.mmx-l0 { max-width: 260px; padding: 16px 24px; border-radius: 26px; color: #fff; font-size: 19px; text-align: center; justify-content: center;
  background: radial-gradient(circle at 28% 22%, rgba(255,255,255,.45), transparent 46%), linear-gradient(140deg, #b69cff, #8b5cf6 55%, #7c3aed);
  box-shadow: 0 14px 34px -12px rgba(124,58,237,.65), inset 0 1px 0 rgba(255,255,255,.5); }
.mmx-l0 .mmx-t b { font-weight: 800; }
.mmx-l1 { padding: 10px 16px; border-radius: 18px; color: #fff; font-size: 15.5px;
  background: linear-gradient(140deg, color-mix(in srgb, var(--c) 82%, #fff), var(--c));
  box-shadow: 0 10px 22px -10px color-mix(in srgb, var(--c) 80%, transparent), inset 0 1px 0 rgba(255,255,255,.4); }
.mmx-l1 .mmx-t b { font-weight: 750; }
.mmx-l2 { padding: 8px 13px; border-radius: 14px; font-size: 14px; color: #1f1b2e; background: #fff;
  border: 1.5px solid color-mix(in srgb, var(--c) 45%, #fff); border-left: 4px solid var(--c);
  box-shadow: 0 6px 16px -10px rgba(30,20,60,.35); }
.mmx-l3 { display: flex; flex-wrap: wrap; gap: 5px; max-width: 230px; font-size: 12.5px; color: #3b3650; }
.mmx-chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 999px; line-height: 1.3;
  background: color-mix(in srgb, var(--c) 12%, #fff); border: 1px solid color-mix(in srgb, var(--c) 28%, transparent); }
.mmx-chip b { font-weight: 600; }
.mmx-chip small { opacity: .7; font-size: .9em; }
.mmx-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--c); flex-shrink: 0; }
`;
