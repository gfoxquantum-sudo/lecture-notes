// Handwriting pad for the outline notes: write with Apple Pencil, a stylus or a finger.
// Strokes are saved as points relative to the pad's width, so they stay in place on any screen and stay sharp when exported.

const COLORS = [['ink', '#1f1b2e', '黑'], ['blue', '#2563eb', '藍'], ['red', '#dc2626', '紅'], ['hl', '#facc15', '螢光筆']];
const colorOf = k => (COLORS.find(c => c[0] === k) || COLORS[0])[1];

function drawStroke(ctx, s, W) {
  const p = s.pts;
  if (!p.length) return;
  const hl = s.c === 'hl';
  ctx.strokeStyle = ctx.fillStyle = colorOf(s.c);
  ctx.globalAlpha = hl ? 0.38 : 1;
  ctx.lineCap = ctx.lineJoin = 'round';
  const base = (s.w || 2.4) * (W / 700) * (hl ? 5 : 1);
  const X = i => p[i][0] * W, Y = i => p[i][1] * W;
  const width = i => base * (hl ? 1 : 0.55 + 0.9 * (p[i][2] == null ? 0.5 : p[i][2]));
  if (p.length === 1) { ctx.beginPath(); ctx.arc(X(0), Y(0), width(0) / 2, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1; return; }
  for (let i = 1; i < p.length; i++) {
    const mx0 = i === 1 ? X(0) : (X(i - 1) + X(i - 2)) / 2, my0 = i === 1 ? Y(0) : (Y(i - 1) + Y(i - 2)) / 2;
    const mx1 = (X(i) + X(i - 1)) / 2, my1 = (Y(i) + Y(i - 1)) / 2;
    ctx.beginPath(); ctx.lineWidth = width(i);
    ctx.moveTo(mx0, my0); ctx.quadraticCurveTo(X(i - 1), Y(i - 1), i === p.length - 1 ? X(i) : mx1, i === p.length - 1 ? Y(i) : my1);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** A PNG of the handwriting (transparent background) for the exported PDF; null when nothing was written. */
export function inkImage(data, width = 1400) {
  if (!data || !data.strokes || !data.strokes.length) return null;
  const c = document.createElement('canvas');
  c.width = width; c.height = Math.round(width * data.h);
  const ctx = c.getContext('2d');
  for (const s of data.strokes) drawStroke(ctx, s, width);
  return { src: c.toDataURL('image/png'), ratio: data.h };
}
export const hasInk = data => !!(data && data.strokes && data.strokes.length);

/**
 * @param data   { h: height ÷ width, strokes: [{ c, w, pts: [[x, y, pressure]] }] } — changed in place
 * @param onChange called (debounced by the caller) after every edit
 */
export function inkPad(data, { onChange, h, icon, penOnly, onPenSeen }) {
  let tool = 'ink', drawing = null, fingerOk = !penOnly;
  const canvas = h('canvas', { class: 'ink-canvas' });
  const ctx = canvas.getContext('2d');
  const W = () => canvas.clientWidth || 1;
  const redraw = () => { const w = W(); ctx.setTransform(devicePixelRatio || 1, 0, 0, devicePixelRatio || 1, 0, 0); ctx.clearRect(0, 0, w, w * data.h); for (const s of data.strokes) drawStroke(ctx, s, w); };
  const resize = () => {
    const w = canvas.parentElement ? canvas.parentElement.clientWidth : 0;
    if (!w) return;
    const d = devicePixelRatio || 1;
    canvas.style.height = Math.round(w * data.h) + 'px';
    canvas.width = Math.round(w * d); canvas.height = Math.round(w * data.h * d);
    redraw();
  };
  const pt = e => { const r = canvas.getBoundingClientRect(); return [+(((e.clientX - r.left) / r.width)).toFixed(4), +(((e.clientY - r.top) / r.width)).toFixed(4), e.pointerType === 'pen' ? +(e.pressure || 0.5).toFixed(2) : 0.5]; };
  const erase = e => {
    const [x, y] = pt(e), rad = 14 / W();
    const before = data.strokes.length;
    data.strokes = data.strokes.filter(s => !s.pts.some(q => Math.hypot(q[0] - x, q[1] - y) < rad));
    if (data.strokes.length !== before) { redraw(); onChange(); }
  };
  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType === 'pen' && fingerOk && !penOnly) { penOnly = true; fingerOk = false; sync(); onPenSeen && onPenSeen(); }   // a pencil showed up: fingers go back to scrolling
    if (e.pointerType === 'touch' && !fingerOk) return;
    if (e.button > 0) return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (tool === 'eraser') { drawing = { erase: true, id: e.pointerId }; erase(e); return; }
    drawing = { id: e.pointerId, s: { c: tool, w: 2.4, pts: [pt(e)] } };
    data.strokes.push(drawing.s); redraw();
  });
  canvas.addEventListener('pointermove', e => {
    if (!drawing || e.pointerId !== drawing.id) return;
    e.preventDefault();
    if (drawing.erase) { erase(e); return; }
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs.length ? evs : [e]) {
      const q = pt(ev), last = drawing.s.pts[drawing.s.pts.length - 1];
      if (Math.hypot(q[0] - last[0], q[1] - last[1]) * W() < 1.2) continue;
      drawing.s.pts.push(q);
    }
    redraw();
  });
  const end = e => { if (!drawing || e.pointerId !== drawing.id) return; const was = drawing; drawing = null; if (!was.erase) onChange(); };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  // iPad: a pencil must not scroll the page while it writes, but a finger still should when only the pencil writes.
  canvas.addEventListener('touchstart', e => { if (fingerOk || [...e.touches].some(t => t.touchType === 'stylus')) e.preventDefault(); }, { passive: false });
  canvas.addEventListener('touchmove', e => { if (drawing) e.preventDefault(); }, { passive: false });

  const btn = (ic, label, fn, cls = '') => h('button', { class: 'ink-btn ' + cls, type: 'button', title: label, 'aria-label': label, onclick: fn }, ic ? icon(ic) : null);
  const swatches = COLORS.map(([k, col, label]) => h('button', { class: 'ink-dot' + (k === 'hl' ? ' hl' : ''), type: 'button', style: `--c:${col}`, title: label, 'aria-label': label, 'data-tool': k, onclick: () => { tool = k; sync(); } }));
  const eraser = btn('eraser', '橡皮擦', () => { tool = 'eraser'; sync(); }); eraser.dataset.tool = 'eraser';
  const finger = btn('hand', '手指也能寫', () => { fingerOk = !fingerOk; sync(); });
  const bar = h('div', { class: 'ink-bar' }, swatches, eraser,
    h('span', { class: 'ink-gap' }),
    finger,
    btn('undo-2', '復原上一筆', () => { if (data.strokes.pop()) { redraw(); onChange(); } }),
    btn('chevrons-up-down', '加長書寫區', () => { data.h = Math.min(3, +(data.h + 0.28).toFixed(2)); resize(); onChange(); }),
    btn('trash-2', '清除這一格', () => { if (!data.strokes.length || confirm('清除這一格的手寫內容？')) { data.strokes = []; data.h = 0.42; resize(); onChange(); } }));
  function sync() {
    bar.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === tool));
    finger.classList.toggle('on', fingerOk);
    canvas.style.touchAction = fingerOk ? 'none' : 'pan-y pinch-zoom';
    canvas.classList.toggle('erasing', tool === 'eraser');
  }
  sync();
  const el = h('div', { class: 'ink-pad' }, bar, h('div', { class: 'ink-paper' }, canvas));
  new ResizeObserver(resize).observe(el);
  return el;
}
