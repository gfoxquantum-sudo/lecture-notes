// 蛤說啥 (Say What?) — record a lecture, live captions with speaker labels, bilingual notes.
// Two plans:
//   免費版 (free): browser speech recognition + on-device notes engine (+ Chrome's built-in translator when available)
//   進階版 (pro):  Soniox live captions with speaker labels and translation + Claude notes
// All data stays on this device (IndexedDB). API keys stay in this browser's localStorage
// and are only sent to Soniox (speech) and Anthropic (notes).

import { ICONS } from './icons.js';
import { buildFreeNotes, fillTranslations } from './free-notes.js';
import { playSound, SOUND_STYLES } from './sounds.js';
import { parseDue, buildICS, googleCalendarUrl } from './calendar.js';
import * as Account from './account.js';
import * as Tutor from './tutor.js';
import { mindMapView, staticMindMapHTML, MM_NODE_CSS } from './mindmap.js';
import { notesDocument } from './export-doc.js';

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.3.0/+esm';
const OPENCC_URL = 'https://cdn.jsdelivr.net/npm/opencc-js@1.4.2/dist/esm/cn2t.js';
const JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';
const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/pdf.worker.min.mjs';
const SONIOX_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';
const MODEL = 'claude-opus-5-5';

/* ================= small helpers ================= */
const $ = (s, el = document) => el.querySelector(s);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : String(k));
  }
  return el;
}
function icon(name, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', ('i ' + cls).trim());
  s.innerHTML = ICONS[name] || '';
  return s;
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const fmtTime = ms => {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return (hh ? hh + ':' + String(mm).padStart(2, '0') : String(mm).padStart(2, '0')) + ':' + String(ss).padStart(2, '0');
};
const fmtDate = ts => new Date(ts).toLocaleDateString('zh-TW', { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' });
const fmtDuration = ms => { const m = Math.round((ms || 0) / 60000); return m < 60 ? m + ' 分鐘' : (m / 60).toFixed(1) + ' 小時'; };
function toast(msg, opts = {}) {
  const t = $('#toast');
  t.replaceChildren(icon(opts.icon || 'check'), h('span', null, msg));
  t.classList.add('show');
  jelly(t, 0.6, 600);
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), opts.ms || 2600);
}
// Running inside the iPhone app? Then recording, calendar, haptics and printing go through native code.
const NATIVE = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.native && window.__nativeApp);
const native = (cmd, args = {}) => window.webkit.messageHandlers.native.postMessage({ cmd, args });
const buzz = (style = 'light') => { if (NATIVE) native('haptic', { style }).catch(() => {}); else if (navigator.vibrate) navigator.vibrate(style === 'medium' ? 15 : style === 'success' ? [10, 40, 10] : 6); };
const sfx = kind => { if (Store.get('sound', true)) playSound(kind, { style: Store.get('soundStyle', 'bubble'), volume: Store.get('volume', 0.5) }); };
const Store = {
  get(k, d) { try { const v = localStorage.getItem('ln.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ln.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const blobToB64 = blob => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1]);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});
const wait = ms => new Promise(r => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
function hashHue(s) { let x = 0; for (const c of s || '') x = (x * 31 + c.charCodeAt(0)) >>> 0; return x % 360; }
const courseColor = name => `hsl(${hashHue(name || '未分類')} 58% 50%)`;

/* ================= appearance ================= */
const darkMql = matchMedia('(prefers-color-scheme: dark)');
const resolvedTheme = () => { const t = Store.get('theme', 'system'); return t === 'system' ? (darkMql.matches ? 'dark' : 'light') : t; };
function applyAppearance() {
  const r = document.documentElement;
  r.dataset.theme = resolvedTheme();
  r.dataset.accent = Store.get('accent', 'violet');
  r.dataset.motion = Store.get('motion', true) ? 'on' : 'off';
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(r).getPropertyValue('--bg').trim() || '#f5f4ef';
}
darkMql.addEventListener('change', () => { if (Store.get('theme', 'system') === 'system') applyAppearance(); });
function setTheme(pref, ev) {
  const before = resolvedTheme();
  Store.set('theme', pref);
  const after = resolvedTheme();
  const animate = before !== after && document.startViewTransition && Store.get('motion', true) && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!animate) { applyAppearance(); return; }
  // A slow, soft crossfade between the two themes (the animation itself lives in CSS).
  void ev;
  const root = document.documentElement;
  root.classList.add('vt-theme');
  document.startViewTransition(() => applyAppearance()).finished.finally(() => root.classList.remove('vt-theme'));
}
function themeButton() {
  return h('button', {
    class: 'btn icon ghost theme-btn', 'aria-label': '切換深色／淺色',
    onclick: e => setTheme(resolvedTheme() === 'dark' ? 'light' : 'dark', e),
  }, h('span', { class: 'ic' }, icon('sun', 'sun'), icon('moon', 'moon')));
}

/* ================= UI components ================= */
// Segmented control / tabs with a sliding indicator.
function seg(options, value, onChange, cls = 'seg') {
  const wrap = h('div', { class: cls, role: 'tablist' }, h('span', { class: 'seg-ind' }),
    options.map(o => h('button', {
      class: o.v === value ? 'on' : '', role: 'tab', 'aria-selected': String(o.v === value), 'data-v': o.v, title: o.title || null,
      onclick: e => { if (wrap._dragged || o.v === wrap.dataset.value) return; selectSeg(wrap, o.v); onChange(o.v, e); },
    }, o.icon ? icon(o.icon) : null, o.label ? h('span', null, o.label) : null)));
  wrap.dataset.value = value;
  // Scrolling tab rows keep their swipe-to-scroll; everything else can be dragged like a slider.
  if (!wrap.classList.contains('tabs') || wrap.classList.contains('even')) makeDraggable(wrap, onChange);
  return wrap;
}
function makeDraggable(wrap, onChange) {
  wrap.classList.add('draggable');
  wrap.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const btns = [...wrap.querySelectorAll(':scope > button')];
    const ind = wrap.querySelector(':scope > .seg-ind');
    if (!ind || btns.length < 2) return;
    const startX = e.clientX;
    let dragging = false, target = wrap.querySelector(':scope > button.on') || btns[0];
    const move = ev => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) < 6) return;
        dragging = true; wrap.classList.add('dragging');
        try { wrap.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      }
      ev.preventDefault();
      const r = wrap.getBoundingClientRect();
      const x = ev.clientX - r.left;
      let near = btns[0], best = Infinity;
      for (const b of btns) { const c = b.offsetLeft + b.offsetWidth / 2; const d = Math.abs(c - x); if (d < best) { best = d; near = b; } }
      const first = btns[0], last = btns[btns.length - 1];
      const w = near.offsetWidth;
      const left = Math.max(first.offsetLeft, Math.min(last.offsetLeft + last.offsetWidth - w, x - w / 2));
      ind.style.width = w + 'px';
      ind.style.transform = `translateX(${left}px)`;
      // Stretch the pill with drag speed, like pulling jelly.
      const now = performance.now(), dt = Math.max(1, now - (move.t || now - 16));
      const v = Math.abs(ev.clientX - (move.x == null ? ev.clientX : move.x)) / dt;
      move.t = now; move.x = ev.clientX;
      const sx = 1 + Math.min(0.32, v * 0.22);
      ind.style.scale = `${sx.toFixed(3)} ${(1 / Math.sqrt(sx)).toFixed(3)}`;
      btns.forEach(b => b.classList.toggle('hover', b === near));
      if (near !== target) { target = near; sfx('nav'); buzz('select'); }
    };
    const up = ev => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      btns.forEach(b => b.classList.remove('hover'));
      if (!dragging) return;
      wrap.classList.remove('dragging');
      ind.style.scale = '';
      jelly(ind, 1.1, 700);
      wrap._dragged = true; setTimeout(() => { wrap._dragged = false; }, 0);
      const v = target.dataset.v;
      if (v !== wrap.dataset.value) { selectSeg(wrap, v); onChange(v, ev); } else placeInd(wrap);
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}
function selectSeg(wrap, v) {
  if (wrap.dataset.value !== v) { const ind = wrap.querySelector(':scope > .seg-ind'); if (ind && !wrap.classList.contains('dragging')) setTimeout(() => jelly(ind, 0.8, 600), 180); }
  wrap.dataset.value = v;
  wrap.querySelectorAll(':scope > button').forEach(b => { const on = b.dataset.v === v; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
  placeInd(wrap);
}
function placeInd(wrap) {
  const ind = wrap.querySelector(':scope > .seg-ind');
  const on = wrap.querySelector(':scope > button.on');
  if (!ind) return;
  if (!on || !on.offsetWidth) { ind.style.opacity = '0'; return; }
  ind.style.opacity = '1';
  if (!ind.dataset.ready) {
    ind.style.transition = 'none';
    ind.style.width = on.offsetWidth + 'px'; ind.style.transform = `translateX(${on.offsetLeft}px)`;
    void ind.offsetWidth; ind.style.transition = ''; ind.dataset.ready = '1';
    return;
  }
  ind.style.width = on.offsetWidth + 'px'; ind.style.transform = `translateX(${on.offsetLeft}px)`;
  if (wrap.classList.contains('tabs')) on.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
}
const placeAllInd = () => document.querySelectorAll('.seg, .tabs').forEach(placeInd);
const afterRender = () => requestAnimationFrame(() => requestAnimationFrame(placeAllInd));
window.addEventListener('resize', () => placeAllInd());
if (document.fonts && document.fonts.ready) document.fonts.ready.then(placeAllInd);

function switchEl(checked, onChange, label) {
  return h('label', { class: 'switch' },
    h('input', { type: 'checkbox', role: 'switch', 'aria-label': label, checked, onchange: e => { onChange(e.target.checked); sfx(e.target.checked ? 'on' : 'off'); buzz('soft'); } }),
    h('span', { class: 'track' }, h('span', { class: 'knob' }, icon('check'))));
}

// Click sounds: every tappable thing makes a soft sound (switches play on/off from their change handler).
document.addEventListener('pointerdown', e => {
  const t = e.target.closest && e.target.closest('button, a, .card, label.switch, input[type="range"], select');
  if (!t || t.disabled || t.closest('label.switch') || t.matches('input[type="range"]')) return;
  if (t.closest('.tabs, .seg, .mobile-tabs')) sfx('nav');
  else if (t.classList.contains('rec-btn') || t.classList.contains('fcard')) return; // these have their own sounds
  else sfx('tap');
}, { capture: true });

// Card tilt with a light glare that follows the pointer (mouse/trackpad only).
const canHover = matchMedia('(hover: hover) and (pointer: fine)');
document.addEventListener('pointermove', e => {
  if (!canHover.matches || document.documentElement.dataset.motion === 'off') return;
  const c = e.target.closest && e.target.closest('.card');
  document.querySelectorAll('.card.tilt').forEach(x => { if (x !== c) { x.classList.remove('tilt'); x.style.removeProperty('--rx'); x.style.removeProperty('--ry'); } });
  if (!c) return;
  const r = c.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
  c.classList.add('tilt');
  c.style.setProperty('--ry', ((px - .5) * 10).toFixed(2) + 'deg');
  c.style.setProperty('--rx', ((.5 - py) * 8).toFixed(2) + 'deg');
  c.style.setProperty('--mx', (px * 100).toFixed(1) + '%');
  c.style.setProperty('--my', (py * 100).toFixed(1) + '%');
});

// ---- jelly liquid glass ----
const motionOn = () => document.documentElement.dataset.motion !== 'off' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
// Squash-and-stretch wobble, like poking a jelly. Uses the separate `scale` property so it never fights other transforms.
const JELLY_FRAMES = [
  { scale: '1 1' }, { scale: '1.09 0.9', offset: 0.18 }, { scale: '0.94 1.07', offset: 0.36 }, { scale: '1.04 0.97', offset: 0.54 },
  { scale: '0.985 1.015', offset: 0.72 }, { scale: '1.005 0.995', offset: 0.86 }, { scale: '1 1' },
];
// New content arriving: rises in and settles with a jelly wobble.
function jellyIn(el, from = 'below') {
  if (!el || !motionOn() || !el.animate) return;
  const y = from === 'below' ? '18px' : '-12px';
  el.animate([
    { opacity: 0, scale: '0.92 0.9', translate: `0 ${y}` },
    { opacity: 1, scale: '1.035 0.965', translate: '0 0', offset: 0.32 },
    { scale: '0.98 1.025', offset: 0.52 }, { scale: '1.01 0.99', offset: 0.72 }, { scale: '1 1', translate: '0 0' },
  ], { duration: 640, easing: 'cubic-bezier(.3,.7,.4,1)' });
}
function jelly(el, strength = 1, dur = 650) {
  if (!el || !motionOn() || !el.animate) return;
  const f = strength === 1 ? JELLY_FRAMES : JELLY_FRAMES.map(k => ({ ...k, scale: k.scale.split(' ').map(v => (1 + (Number(v) - 1) * strength).toFixed(3)).join(' ') }));
  el.animate(f, { duration: dur, easing: 'linear', composite: 'replace' });
}
const JELLY_SEL = '.btn, .card, .chip, .badge, .swatch, .spk-chip, .stat, .seg > button, .tabs > button, .rec-btn, .player .play, .player .skip, .speed, .sticker, .mm-node, .time-chip, .switch .track, .plan';
document.addEventListener('pointerup', e => {
  const t = e.target.closest && e.target.closest(JELLY_SEL);
  if (!t || t.disabled) return;
  if (t.matches('.seg > button, .tabs > button')) return; // the sliding pill wobbles instead
  jelly(t, t.matches('.card, .plan') ? 0.45 : t.matches('.switch .track') ? 0.7 : 1);
});
// One shared light source: the mouse on computers, the phone's tilt on phones.
let lightQueued = false, lightPos = { x: innerWidth * 0.3, y: innerHeight * 0.2 };
function setLight(x, y) {
  lightPos = { x, y };
  if (lightQueued) return;
  lightQueued = true;
  requestAnimationFrame(() => {
    lightQueued = false;
    const st = document.documentElement.style;
    st.setProperty('--lx', lightPos.x.toFixed(0) + 'px'); st.setProperty('--ly', lightPos.y.toFixed(0) + 'px');
    st.setProperty('--px', (lightPos.x / innerWidth * 2 - 1).toFixed(3)); st.setProperty('--py', (lightPos.y / innerHeight * 2 - 1).toFixed(3));
  });
}
document.addEventListener('pointermove', e => { if (e.pointerType !== 'touch' && motionOn()) setLight(e.clientX, e.clientY); }, { passive: true });
window.addEventListener('deviceorientation', e => {
  if (e.gamma == null || !Store.get('gyro', true) || !motionOn()) return;
  const gx = Math.max(-1, Math.min(1, e.gamma / 25));
  const gy = Math.max(-1, Math.min(1, ((e.beta || 0) - 45) / 25));
  setLight(innerWidth * (gx + 1) / 2, innerHeight * (gy + 1) / 2);
});
async function askGyro() {
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      return (await DeviceOrientationEvent.requestPermission()) === 'granted';
    }
  } catch { return false; }
  return true;
}
// Jelly blobs that float and slowly change shape in the background.
function renderJellyBlobs() {
  if ($('.jelly-blobs')) return;
  const spec = [
    ['var(--accent)', '18vmax', '6%', '58%', '17s', '0s'], ['var(--accent-2)', '11vmax', '72%', '14%', '13s', '-4s'],
    ['#ffb38a', '8vmax', '80%', '66%', '15s', '-8s'], ['#8ec5ff', '13vmax', '-4%', '8%', '19s', '-2s'], ['#c4a7ff', '6vmax', '42%', '82%', '12s', '-6s'],
  ];
  document.body.prepend(h('div', { class: 'jelly-blobs', 'aria-hidden': 'true' },
    spec.map(([c, w, x, y, t, dl]) => h('i', { style: `--c:${c};--w:${w};--x:${x};--y:${y};--t:${t};--dl:${dl}` }))));
}
// Liquid refraction filter. Only Chromium can use an SVG filter as a backdrop, so other browsers keep plain frosted glass.
function setupRefraction() {
  const isChromium = !!(navigator.userAgentData && navigator.userAgentData.brands && navigator.userAgentData.brands.some(b => /Chromium/.test(b.brand)));
  if (!isChromium) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.setAttribute('aria-hidden', 'true');
  svg.style.position = 'absolute';
  svg.innerHTML = '<filter id="liquid-glass" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.006 0.011" numOctaves="2" seed="7" result="n"/><feGaussianBlur in="n" stdDeviation="2.5" result="nb"/><feDisplacementMap in="SourceGraphic" in2="nb" scale="26" xChannelSelector="R" yChannelSelector="G"/></filter>';
  document.body.append(svg);
  document.documentElement.classList.add('refract');
}

// Floating doodles in the background.
function renderDoodles() {
  if ($('.doodles')) return;
  const names = ['pencil', 'book', 'lightbulb', 'music', 'star', 'sparkle', 'coffee', 'graduation-cap', 'notebook-pen', 'headphones', 'atom', 'globe', 'heart', 'bookmark', 'brain', 'rocket'];
  let seed = 7;
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const box = h('div', { class: 'doodles', 'aria-hidden': 'true' });
  names.forEach((n, i) => {
    const s = icon(n);
    s.style.cssText = `left:${(i % 4) * 25 + rnd() * 18 + 2}%;top:${Math.floor(i / 4) * 25 + rnd() * 16 + 3}%;--s:${22 + rnd() * 22}px;--r:${(rnd() * 50 - 25).toFixed(0)}deg;--t:${11 + rnd() * 9}s;--dl:${(-rnd() * 10).toFixed(1)}s`;
    box.append(s);
  });
  document.body.prepend(box);
}

// Notes ready: a glassy jelly drop falls in, lands with a squish, wobbles with a check inside,
// then pops into little jelly droplets that float away.
function bloom() {
  if (!motionOn()) return;
  const chk = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chk.setAttribute('viewBox', '0 0 24 24'); chk.setAttribute('fill', 'none'); chk.setAttribute('stroke', 'currentColor');
  chk.setAttribute('stroke-width', '2.8'); chk.setAttribute('stroke-linecap', 'round'); chk.setAttribute('stroke-linejoin', 'round');
  chk.innerHTML = '<path d="M5 12.5l4.5 4.5L19 7.5" pathLength="1"/>';
  const blob = h('div', { class: 'jd-blob' }, h('div', { class: 'jd-shine' }), chk);
  const el = h('div', { class: 'jelly-done', 'aria-hidden': 'true' }, blob);
  document.body.append(el);
  // 1. pop out of the centre like a jelly bubble, overshoot and wobble
  blob.animate([
    { scale: '0 0', opacity: 0 },
    { scale: '1.28 1.28', opacity: 1, offset: 0.22 },
    { scale: '0.84 1.12', offset: 0.36 },
    { scale: '1.12 0.88', offset: 0.5 },
    { scale: '0.95 1.05', offset: 0.64 },
    { scale: '1.03 0.97', offset: 0.8 },
    { scale: '1 1', opacity: 1 },
  ], { duration: 1050, easing: 'cubic-bezier(.3,.7,.4,1)', fill: 'forwards' });
  // a soft ring ripples out behind it
  const ring = h('i', { class: 'jd-ring' });
  el.prepend(ring);
  ring.animate([{ scale: '0.4', opacity: 0.55 }, { scale: '2.4', opacity: 0 }], { duration: 900, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' });
  wait(1050)
    .then(() => wait(650))
    .then(() => {
      // 3. pop into droplets
      const colors = ['var(--accent)', 'var(--accent-2)', '#ffb38a', '#8ec5ff', '#c4a7ff'];
      for (let n = 0; n < 12; n++) {
        const a = (n / 12) * Math.PI * 2 + Math.random() * .4;
        const dist = 90 + Math.random() * 90;
        const d = h('i', { class: 'jd-drop', style: `--c:${colors[n % colors.length]};--s:${(14 + Math.random() * 18).toFixed(0)}px` });
        el.append(d);
        const dx = Math.cos(a) * dist, dy = Math.sin(a) * dist;
        d.animate([
          { translate: '0 0', scale: '0.3 0.3', opacity: 0 },
          { translate: `${dx.toFixed(0)}px ${dy.toFixed(0)}px`, scale: '1.15 0.85', opacity: 1, offset: 0.25 },
          { translate: `${(dx * 1.1).toFixed(0)}px ${(dy - 30).toFixed(0)}px`, scale: '0.9 1.1', opacity: 0.95, offset: 0.45 },
          { translate: `${(dx * 1.2).toFixed(0)}px ${(dy - 220).toFixed(0)}px`, scale: '1 1', opacity: 0 },
        ], { duration: 1700 + Math.random() * 600, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' });
      }
      return blob.animate([{ scale: '1 1', opacity: 1 }, { scale: '1.22 0.82', opacity: 1, offset: 0.35 }, { scale: '0.2 0.2', opacity: 0 }], { duration: 380, easing: 'ease-in', fill: 'forwards' }).finished;
    })
    .then(() => wait(2200))
    .finally(() => el.remove());
}

// Subject → icon for course stickers.
const SUBJECTS = [
  [/經濟|金融|會計|財務|管理|行銷|商|econ|financ|account|business|market/i, 'chart-line'],
  [/數學|微積分|統計|代數|幾何|math|calculus|statistic|algebra/i, 'sigma'],
  [/程式|資工|電腦|計算機|資料|演算法|軟體|program|comput|code|data|algorithm/i, 'code'],
  [/生物|生命|生態|biolog|life/i, 'leaf'],
  [/基因|遺傳|分子|gene/i, 'dna'],
  [/化學|chem/i, 'flask-conical'],
  [/物理|physic/i, 'atom'],
  [/歷史|history|文明/i, 'landmark'],
  [/法律|法學|law|憲法/i, 'scale'],
  [/醫|護理|藥|health|medic|nurs/i, 'stethoscope'],
  [/心理|psych|認知/i, 'brain'],
  [/音樂|music/i, 'music'],
  [/藝術|美術|設計|art|design/i, 'palette'],
  [/英文|語言|英語|日文|中文|文學|english|language|literature/i, 'languages'],
  [/地理|國際|政治|社會|global|politic|sociolog/i, 'globe'],
];
const subjectIcon = name => { for (const [re, ic] of SUBJECTS) if (re.test(name || '')) return ic; return 'book'; };
const sticker = (ic, style = '') => h('span', { class: 'sticker', style }, icon(ic));

// Ripple on every button press.
document.addEventListener('pointerdown', e => {
  const b = e.target.closest && e.target.closest('.btn');
  if (!b || b.disabled || document.documentElement.dataset.motion === 'off') return;
  const r = b.getBoundingClientRect();
  const d = Math.max(r.width, r.height) * 2.2;
  const s = h('span', { class: 'ripple', style: `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px` });
  b.append(s); setTimeout(() => s.remove(), 650);
});

function openDialog(content, { cls = '', onClose } = {}) {
  const d = h('dialog', { class: cls }, content);
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    d.classList.add('closing');
    setTimeout(() => { try { d.close(); } catch { /* ignore */ } d.remove(); onClose && onClose(); }, 220);
  };
  d.addEventListener('cancel', e => { e.preventDefault(); close(); });
  d.addEventListener('click', e => {
    if (e.target !== d) return;
    const r = d.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
  });
  d.closeDialog = close;
  document.body.append(d);
  d.showModal();
  // Keep focus on the sheet itself so no button shows a focus ring on open.
  d.tabIndex = -1; d.focus({ preventScroll: true });
  afterRender();
  return d;
}

/* ================= Traditional Chinese conversion ================= */
let toTW = s => s;
import(OPENCC_URL).then(m => {
  try { const conv = m.Converter({ from: 'cn', to: 'twp' }); toTW = s => (s ? conv(s) : s); rerenderTranscript(); } catch { /* keep identity */ }
}).catch(() => { /* offline: keep text as-is */ });

/* ================= IndexedDB ================= */
const DB = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('lecture-notes', 2);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('lectures')) db.createObjectStore('lectures', { keyPath: 'id' });
        // Audio is written here every few seconds while recording, so a crash never loses a long lecture.
        if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { autoIncrement: true }).createIndex('lec', 'lec');
      };
      r.onsuccess = () => { this._db = r.result; res(r.result); };
      r.onerror = () => rej(r.error);
    });
  },
  async tx(mode, fn, store = 'lectures') {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  },
  all() { return this.tx('readonly', s => s.getAll()); },
  get(id) { return this.tx('readonly', s => s.get(id)); },
  put(o) { return this.tx('readwrite', s => s.put(o)); },
  del(id) { return this.tx('readwrite', s => s.delete(id)); },
  addChunk(c) { return this.tx('readwrite', s => s.add(c), 'chunks'); },
  chunksFor(lec) { return this.tx('readonly', s => s.index('lec').getAll(lec), 'chunks'); },
  async dropChunks(lec) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction('chunks', 'readwrite');
      const idx = t.objectStore('chunks').index('lec');
      idx.openCursor(IDBKeyRange.only(lec)).onsuccess = e => { const cur = e.target.result; if (cur) { cur.delete(); cur.continue(); } };
      t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    });
  },
};
// Rebuild audio from chunks left behind by a recording that was cut off (app closed, phone died).
async function recoverChunks(lec) {
  let chunks = [];
  try { chunks = await DB.chunksFor(lec.id); } catch { return false; }
  if (!chunks.length) return false;
  const parts = new Map();
  for (const c of chunks) { if (!parts.has(c.part)) parts.set(c.part, []); parts.get(c.part).push(c); }
  lec.audioParts = lec.audioParts || [];
  for (const [offset, list] of parts) {
    if (lec.audioParts.some(p => p.offset === offset)) continue;
    list.sort((a, b) => a.seq - b.seq);
    lec.audioParts.push({ blob: new Blob(list.map(c => c.blob), { type: list[0].blob.type || 'audio/webm' }), offset });
  }
  lec.audioParts.sort((a, b) => a.offset - b.offset);
  await saveLecture(lec);
  await DB.dropChunks(lec.id);
  return true;
}
function cleanForSave(lec) { return { ...lec, segments: lec.segments.map(({ _pend, ...s }) => s) }; }
async function saveLecture(lec) { lec.updated = Date.now(); await DB.put(cleanForSave(lec)); }

/* ================= app state & settings ================= */
const state = {
  view: 'home',
  lecture: null,
  lang: Store.get('lang', 'both'),       // 'zh' | 'en' | 'both'
  mobileTab: 'live',                      // 'live' | 'notes' | 'files'
  rightTab: 'notes',
  noteTab: 'overview',
  rec: null,
  gen: null,                              // { steps, cur, detail } while generating notes
  openFile: null,
  search: '',
};
const settings = () => ({
  plan: Store.get('plan', null),
  sonioxKey: Store.get('sonioxKey', ''),
  anthropicKey: Store.get('anthropicKey', ''),
  translate: Store.get('translate', true),
  mainLang: Store.get('mainLang', 'zh'),
  saveAudio: Store.get('saveAudio', true),
  detail: Store.get('detail', 'standard'),
});
const isPro = () => settings().plan === 'pro';
const proReady = () => { const c = settings(); return { stt: c.plan === 'pro' && !!c.sonioxKey, notes: c.plan === 'pro' && !!c.anthropicKey }; };

/* ================= on-device translation (Chrome built-in Translator) ================= */
const trCache = {};
const localTranslateSupported = () => 'Translator' in self;
async function getLocalTranslator(from, to) {
  if (!localTranslateSupported()) return null;
  const key = from + '>' + to;
  if (trCache[key] !== undefined) return trCache[key];
  const codes = { zh: ['zh-Hant', 'zh'], en: ['en'] };
  for (const s of codes[from]) for (const t of codes[to]) {
    try {
      const a = await withTimeout(self.Translator.availability({ sourceLanguage: s, targetLanguage: t }), 4000);
      if (a === 'unavailable') continue;
      // The language pack may need a download; don't let a stalled download block the notes.
      const tr = await withTimeout(self.Translator.create({ sourceLanguage: s, targetLanguage: t }), 10000);
      trCache[key] = tr; return tr;
    } catch { /* try next code */ }
  }
  trCache[key] = null; return null;
}
async function localTranslate(text, from, to) {
  const tr = await getLocalTranslator(from, to);
  if (!tr) throw new Error('這個瀏覽器沒有內建翻譯');
  const out = await withTimeout(tr.translate(text), 8000);
  return to === 'zh' ? toTW(out) : out;
}

/* ================= speakers ================= */
const SPK_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)'];
const spkMemo = { key: '', times: null };
function talkTimes(lec) {
  const key = lec.id + '|' + lec.segments.length + '|' + (lec.segments.length ? lec.segments[lec.segments.length - 1].text.length : 0);
  if (spkMemo.key === key) return spkMemo.times;
  const t = {};
  for (const s of lec.segments) t[s.speaker] = (t[s.speaker] || 0) + Math.max(1, (s.end || 0) - (s.start || 0)) + s.text.length * 30;
  spkMemo.key = key; spkMemo.times = t;
  return t;
}
function professorId(lec) {
  lec.speakers = lec.speakers || {};
  const manual = Object.entries(lec.speakers).find(([, v]) => v.role === 'professor');
  if (manual) return manual[0];
  if (lec.notes && lec.notes.professor_speaker && lec.segments.some(s => s.speaker === lec.notes.professor_speaker)) return lec.notes.professor_speaker;
  const t = talkTimes(lec);
  let best = null;
  for (const [k, v] of Object.entries(t)) if (best == null || v > t[best]) best = k;
  return best;
}
function speakerInfo(lec, id) {
  lec.speakers = lec.speakers || {};
  const manual = lec.speakers[id];
  const prof = professorId(lec);
  const others = Object.keys(talkTimes(lec)).filter(k => k !== prof).sort((a, b) => Number(a) - Number(b));
  const isProf = id === prof && id !== '?';
  const idx = others.indexOf(id);
  const name = manual && manual.name ? manual.name : id === '?' ? '講者' : isProf ? '教授' : '同學 ' + String.fromCharCode(65 + Math.max(0, idx));
  const color = id === '?' ? 'var(--accent)' : isProf ? 'var(--accent)' : SPK_COLORS[Math.max(0, idx) % SPK_COLORS.length];
  return { id, name, isProf, color };
}
const avatarEl = who => h('span', { class: 'avatar', style: `--c:${who.color}` },
  who.isProf ? icon('graduation-cap') : who.id === '?' ? icon('mic') : who.name.slice(-1));

/* ================= audio capture ================= */
class MicCapture {
  async start({ onPcm, onLevel, keepAudio, onChunk }) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    });
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch { /* ignore */ } }
    await this.ctx.audioWorklet.addModule('pcm-worklet.js');
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm16k', { processorOptions: { inRate: this.ctx.sampleRate } });
    this.paused = false;
    this.node.port.onmessage = e => {
      onLevel && onLevel(this.paused ? 0 : e.data.level);
      if (!this.paused) onPcm(e.data.pcm);
    };
    const mute = this.ctx.createGain(); mute.gain.value = 0;
    this.src.connect(this.node); this.node.connect(mute); mute.connect(this.ctx.destination);
    this.chunks = [];
    if (keepAudio && window.MediaRecorder) {
      try {
        const types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'];
        const mimeType = types.find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
        this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType, audioBitsPerSecond: 32000 } : undefined);
        let seq = 0;
        this.recorder.ondataavailable = e => { if (e.data && e.data.size) { this.chunks.push(e.data); onChunk && onChunk(e.data, seq++); } };
        this.recorder.start(5000);
      } catch { this.recorder = null; }
    }
  }
  pause() { this.paused = true; try { this.recorder && this.recorder.state === 'recording' && this.recorder.pause(); } catch { /* ignore */ } }
  resume() { this.paused = false; try { this.recorder && this.recorder.state === 'paused' && this.recorder.resume(); } catch { /* ignore */ } }
  async stop() {
    let blob = null;
    if (this.recorder && this.recorder.state !== 'inactive') {
      await new Promise(res => { this.recorder.onstop = res; this.recorder.stop(); });
    }
    if (this.chunks && this.chunks.length) blob = new Blob(this.chunks, { type: this.recorder && this.recorder.mimeType || 'audio/webm' });
    try { this.src && this.src.disconnect(); this.node && this.node.disconnect(); } catch { /* ignore */ }
    this.stream && this.stream.getTracks().forEach(t => t.stop());
    try { await this.ctx.close(); } catch { /* ignore */ }
    return blob;
  }
}

/* ================= Soniox real-time session (pro) ================= */
/* ---------- vocabulary hints: help speech recognition with this course's names and terms ---------- */
const VOCAB_STOP = new Set('the and for that this with from have will are was were been being into about which their there these those what when where your than then them they also each other such only more most some very just like over under page slide slides chapter figure table example examples using used use based between through after before during because while within without however therefore'.split(' '));
async function speechVocab(lec) {
  const terms = new Map();
  const add = (t, w = 1) => {
    t = String(t || '').replace(/\s+/g, ' ').trim();
    if (t.length < 2 || t.length > 40) return;
    const k = t.toLowerCase();
    const cur = terms.get(k);
    terms.set(k, { t: cur ? cur.t : t, w: (cur ? cur.w : 0) + w });
  };
  const fromNotes = (n, w) => (n && n.key_terms || []).forEach(k => { add(k.term_en, w); add(k.term_zh, w); });
  if (lec.course) add(lec.course, 6);
  fromNotes(lec.notes, 4);
  try {
    if (lec.course) (await DB.all()).filter(l => l.id !== lec.id && l.course === lec.course && l.notes).slice(0, 12).forEach(l => fromNotes(l.notes, 3));
  } catch { /* first lecture */ }
  // English names and terms from the professor's slides: capitalised phrases, and words that keep coming up
  const slides = (lec.files || []).map(f => f.text || '').join('\n');
  const freq = new Map();
  for (const m of slides.matchAll(/\b[A-Za-z][A-Za-z0-9'-]{3,}\b/g)) { const w = m[0]; if (!VOCAB_STOP.has(w.toLowerCase())) freq.set(w, (freq.get(w) || 0) + 1); }
  for (const [w, c] of freq) if (c >= 3) add(w, Math.min(3, c / 3));
  for (const m of slides.matchAll(/\b(?:[A-Z][a-zA-Z0-9-]+\s){1,2}[A-Z][a-zA-Z0-9-]+\b/g)) add(m[0], 2);
  const list = [...terms.values()].sort((a, b) => b.w - a.w).slice(0, 90).map(x => x.t);
  const general = [{ key: 'setting', value: '大學課堂，教授用中文和英文講課' }];
  if (lec.course) general.push({ key: 'course', value: lec.course });
  if (lec.title && !/^新課堂/.test(lec.title)) general.push({ key: 'topic', value: lec.title });
  const text = slides.replace(/\s+/g, ' ').trim().slice(0, 5000);
  const context = { general, terms: list };
  if (text) context.text = text;
  return { terms: list, context };
}

class SonioxSession {
  constructor({ key, translate, mainLang, context, onTokens, onError, onClose }) {
    Object.assign(this, { key, translate, mainLang, context, onTokens, onError, onClose });
    this.queue = [];
    this.done = null;
  }
  start() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(SONIOX_URL, ['soniox-api-key', this.key]);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
        const cfg = {
          model: 'stt-rt-v6',
          audio_format: 'pcm_s16le', sample_rate: 16000, num_channels: 1,
          language_hints: this.mainLang === 'en' ? ['en', 'zh'] : ['zh', 'en'],
          enable_speaker_diarization: true,
          enable_language_identification: true,
        };
        if (this.translate) cfg.translation = { type: 'two_way', language_a: 'zh', language_b: 'en' };
        if (this.context && (this.context.terms.length || this.context.text)) cfg.context = this.context;
        ws.send(JSON.stringify(cfg));
        for (const b of this.queue) ws.send(b);
        this.queue = [];
        resolve();
      };
      ws.onmessage = e => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.error_type || m.error_code) { this.onError && this.onError(m.error_message || m.error_type || '語音辨識錯誤'); return; }
        if (m.tokens && m.tokens.length) this.onTokens(m.tokens);
        if (m.finished && this.done) this.done();
      };
      ws.onerror = () => { if (!opened) reject(new Error('無法連線到 Soniox')); };
      ws.onclose = ev => { if (this.done) this.done(); this.onClose && this.onClose(ev); };
    });
  }
  send(buf) {
    if (!this.ws) return;
    if (this.ws.readyState === 1) this.ws.send(buf);
    else if (this.ws.readyState === 0) this.queue.push(buf);
  }
  keepalive() { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'keepalive' })); }
  end() {
    return new Promise(res => {
      if (!this.ws || this.ws.readyState > 1) return res();
      const timer = setTimeout(() => { try { this.ws.close(); } catch { /* ignore */ } res(); }, 10000);
      this.done = () => { clearTimeout(timer); this.done = null; res(); };
      try { this.ws.send(''); } catch { res(); }
    });
  }
  close() { try { this.ws && this.ws.close(); } catch { /* ignore */ } }
}

/* ================= Browser speech recognition (free) ================= */
class BrowserSTT {
  constructor({ lang, onFinal, onInterim, onError }) {
    Object.assign(this, { lang, onFinal, onInterim, onError });
    this.SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  }
  static supported() { return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }
  start() {
    this.active = true;
    const r = new this.SR();
    r.lang = this.lang; r.continuous = true; r.interimResults = true;
    r.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) this.onFinal(res[0].transcript);
        else interim += res[0].transcript;
      }
      this.onInterim(interim);
    };
    r.onerror = e => { if (e.error !== 'no-speech' && e.error !== 'aborted') this.onError(e.error); };
    r.onend = () => { if (this.active) { try { r.start(); } catch { /* ignore */ } } };
    this.r = r;
    r.start();
  }
  pause() { this.active = false; try { this.r.stop(); } catch { /* ignore */ } }
  resume() { this.start(); }
  stop() { this.active = false; try { this.r.stop(); } catch { /* ignore */ } }
}

/* ================= Recorder controller ================= */
class Recorder {
  constructor(lec) {
    this.lec = lec;
    this.status = 'idle';     // idle | connecting | recording | paused | stopping
    this.nonFinal = { text: '', tr: '' };
    this.elapsedBase = lec.durationMs || 0;
    this.offset = lec.durationMs || 0;
    this.offset0 = lec.durationMs || 0;
    this.level = 0;
    this.levels = [];
    this.closed = true;
    this.inTr = false;
    this.dirty = new Set();
  }
  elapsed() {
    if (this.native) return this.offset0 + (this.nativeElapsed || 0);
    return this.elapsedBase + (this.status === 'recording' && this.runStart ? performance.now() - this.runStart : 0);
  }
  // iPhone app: the phone records (also in the background); we collect what it heard a few times a second.
  async startNative(cfg) {
    this.native = true;
    this.mode = proReady().stt ? 'soniox' : 'free';
    if (this.mode === 'soniox' && !(await ensureAIConsent())) this.mode = 'free';
    this.status = 'connecting'; renderRecorder();
    try {
      await native('recorder.start', {
        lecture: this.lec.id, offset: this.offset0, mode: this.mode, sonioxKey: cfg.sonioxKey, translate: cfg.translate,
        mainLang: cfg.mainLang, lang: cfg.mainLang === 'en' ? 'en-US' : 'zh-TW', keepAudio: cfg.saveAudio,
        title: this.lec.title, liveCaptions: Store.get('liveCaptions', true),
        ...(await speechVocab(this.lec).then(v => ({ vocab: v.terms, context: v.context })).catch(() => ({}))),
        accurateSpeech: Store.get('accurateSpeech', true),
      });
    } catch (err) {
      this.status = 'idle'; renderRecorder();
      toast('無法開始錄音：' + (err.message || err), { icon: 'info', ms: 6000 });
      return;
    }
    this.nativeElapsed = 0;
    this.parts = [];
    this.status = 'recording';
    sfx('start'); buzz('medium');
    this.ticker = setInterval(() => renderRecorder(true), 100);
    this.drainer = setInterval(() => this.drainNative(), 200);
    this.saver = setInterval(() => { this.lec.durationMs = this.elapsed(); saveLecture(this.lec); }, 15000);
    renderRecorder();
  }
  async drainNative(list) {
    if (!list) {
      if (this.draining) return;
      this.draining = true;
      try { list = await native('recorder.drain'); } catch { list = []; } finally { this.draining = false; }
    }
    for (const ev of list || []) this.handleNative(ev);
  }
  handleNative(ev) {
    switch (ev.type) {
      case 'level':
        this.level = ev.level; this.levels.push(ev.level); if (this.levels.length > 400) this.levels.splice(0, 200);
        this.nativeElapsed = ev.elapsed;
        break;
      case 'soniox': {
        let m; try { m = JSON.parse(ev.json); } catch { break; }
        if (m.tokens && m.tokens.length) this.onTokens(m.tokens);
        break;
      }
      case 'soniox-reset': this.offset = this.offset0 + ev.offset; this.closed = true; this.inTr = false; break;
      case 'interim': this.nonFinal = { text: ev.text, tr: '' }; scheduleRender(); break;
      case 'final': this.addFreeSegment(ev.text, this.offset0 + ev.start, this.offset0 + ev.end); break;
      case 'part': this.parts.push(importNativePart(this.lec, ev.file, ev.offset)); break;
      case 'error': toast(ev.message || '錄音發生錯誤', { icon: 'info', ms: 5000 }); break;
      case 'interrupted': toast('錄音被來電或其他 App 打斷了', { icon: 'info', ms: 4000 }); break;
      case 'resumed': toast('錄音已繼續', { icon: 'mic' }); break;
      default: break;
    }
  }
  async start() {
    const cfg = settings();
    if (NATIVE) return this.startNative(cfg);
    this.mode = proReady().stt ? 'soniox' : 'free';
    if (this.mode === 'soniox' && !(await ensureAIConsent())) this.mode = 'free';
    if (this.mode === 'free' && !BrowserSTT.supported()) {
      toast('這個瀏覽器沒有內建語音辨識，請改用 Chrome 或 Safari，或改用進階版', { icon: 'info', ms: 5000 }); return;
    }
    if (cfg.plan === 'pro' && !cfg.sonioxKey) toast('還沒填 Soniox 金鑰，先用免費辨識', { icon: 'info', ms: 4000 });
    try {
      const est = await navigator.storage.estimate();
      if (est.quota - est.usage < 300 * 1024 * 1024) toast('裝置空間不多了，長時間錄音可能存不下', { icon: 'info', ms: 5000 });
    } catch { /* unknown */ }
    this.status = 'connecting'; renderRecorder();
    try {
      this.micOpts = {
        keepAudio: cfg.saveAudio,
        onChunk: (blob, seq) => { DB.addChunk({ lec: this.lec.id, part: this.offset0, seq, blob }).catch(() => { /* storage full */ }); },
        onLevel: l => { this.level = l; this.levels.push(l); if (this.levels.length > 400) this.levels.splice(0, 200); },
        onPcm: buf => { if (this.mode === 'soniox' && this.session) this.session.send(buf); },
      };
      this.mic = new MicCapture();
      await this.mic.start(this.micOpts);
      this.watchMic();
      if (this.mode === 'soniox') {
        this.session = new SonioxSession({
          key: cfg.sonioxKey, translate: cfg.translate, mainLang: cfg.mainLang, context: (await speechVocab(this.lec).catch(() => null) || {}).context,
          onTokens: t => this.onTokens(t),
          onError: msg => toast('語音辨識：' + msg, { icon: 'info', ms: 5000 }),
          onClose: () => { if (this.status === 'recording' || this.status === 'paused') this.reconnect(); },
        });
        await this.session.start();
      } else {
        this.browser = new BrowserSTT({
          lang: cfg.mainLang === 'en' ? 'en-US' : 'zh-TW',
          onFinal: text => this.addFreeSegment(text),
          onInterim: text => { this.nonFinal = { text, tr: '' }; scheduleRender(); },
          onError: err => toast('語音辨識：' + (err === 'not-allowed' ? '請允許使用麥克風' : err), { icon: 'info' }),
        });
        this.browser.start();
      }
    } catch (err) {
      this.status = 'idle';
      try { this.mic && await this.mic.stop(); } catch { /* ignore */ }
      renderRecorder();
      toast(err && err.name === 'NotAllowedError' ? '請允許使用麥克風' : '無法開始錄音：' + (err.message || err), { icon: 'info', ms: 5000 });
      return;
    }
    this.status = 'recording';
    this.runStart = performance.now();
    sfx('start');
    buzz('medium');
    this.ticker = setInterval(() => renderRecorder(true), 100);
    this.saver = setInterval(() => { this.lec.durationMs = this.elapsed(); saveLecture(this.lec); }, 15000);
    this.keeper = setInterval(() => { if (this.status === 'paused' && this.session) this.session.keepalive(); }, 8000);
    requestWakeLock();
    renderRecorder();
  }
  // iPhone/iPad suspend a web app's microphone when you switch apps. When we come back,
  // check the microphone and, if it was cut off, start a new audio part and carry on.
  watchMic() {
    const tr = this.mic && this.mic.stream && this.mic.stream.getAudioTracks()[0];
    if (tr) { tr.onended = () => this.heal(); tr.onunmute = () => this.heal(); }
    if (this.mic && this.mic.ctx) this.mic.ctx.onstatechange = () => { if (document.visibilityState === 'visible') this.heal(); };
  }
  micHealthy() {
    const tr = this.mic && this.mic.stream && this.mic.stream.getAudioTracks()[0];
    return !!(tr && tr.readyState === 'live' && !tr.muted && this.mic.ctx && this.mic.ctx.state === 'running');
  }
  async heal() {
    if (this.native) return;
    if ((this.status !== 'recording' && this.status !== 'paused') || this.healing || document.visibilityState !== 'visible') return;
    if (this.micHealthy()) return;
    this.healing = true;
    try {
      const tr = this.mic.stream.getAudioTracks()[0];
      if (tr && tr.readyState === 'live' && !tr.muted) { try { await this.mic.ctx.resume(); } catch { /* fall through */ } }
      if (this.micHealthy()) return;
      const wasPaused = this.status === 'paused';
      const oldPart = this.offset0;
      const blob = await this.mic.stop();
      if (blob) { this.lec.audioParts = this.lec.audioParts || []; this.lec.audioParts.push({ blob, offset: oldPart }); await saveLecture(this.lec); await DB.dropChunks(this.lec.id).catch(() => {}); }
      this.offset0 = Math.round(this.elapsed());
      this.mic = new MicCapture();
      await this.mic.start(this.micOpts);
      this.watchMic();
      if (wasPaused) this.mic.pause();
      if (this.session) this.session.close(); // the close handler reconnects with the new time offset
      if (this.browser && !wasPaused) { this.browser.stop(); this.browser.start(); }
      const gap = this.hiddenAt ? Math.round((Date.now() - this.hiddenAt) / 1000) : 0;
      toast(gap > 3 ? `剛剛離開 ${gap >= 60 ? Math.floor(gap / 60) + ' 分 ' : ''}${gap % 60} 秒，錄音已自動接續` : '錄音已自動接續', { icon: 'mic', ms: 4000 });
      sfx('on');
    } catch {
      toast('回到 App 後沒辦法自動接續，請按結束再重新錄音', { icon: 'info', ms: 6000 });
    } finally { this.healing = false; }
  }
  async reconnect() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    toast('連線中斷，重新連線…', { icon: 'refresh-cw' });
    this.offset = this.elapsed(); // a new session restarts its clock at 0
    this.closed = true; this.inTr = false;
    try { await this.session.start(); } catch { toast('重新連線失敗，請檢查網路', { icon: 'info', ms: 5000 }); }
    this.reconnecting = false;
  }
  onTokens(tokens) {
    let nfText = '', nfTr = '';
    for (const t of tokens) {
      if (!t.text || t.text === '<end>' || t.text === '<fin>') continue;
      if (t.is_final) this.applyFinal(t);
      else if (t.translation_status === 'translation') nfTr += t.text;
      else nfText += t.text;
    }
    this.nonFinal = { text: nfText, tr: nfTr };
    scheduleRender();
  }
  applyFinal(t) {
    const segs = this.lec.segments;
    if (t.translation_status === 'translation') {
      if (!this.inTr) { this.inTr = true; this.trTarget = segs.find(s => s._pend) || segs[segs.length - 1]; }
      if (this.trTarget) { this.trTarget.tr = (this.trTarget.tr || '') + t.text; this.dirty.add(this.trTarget.id); }
      return;
    }
    if (this.inTr) { this.inTr = false; for (const s of segs) delete s._pend; this.closed = true; }
    let cur = segs[segs.length - 1];
    const spk = String(t.speaker || (cur && cur.speaker) || '1');
    const start = (t.start_ms || 0) + this.offset;
    if (!cur || this.closed || cur.speaker !== spk) {
      if (!t.text.trim() && cur && !this.closed) { cur.text += t.text; return; }
      cur = { id: uid(), speaker: spk, start, end: start, lang: t.language || '', text: '', tr: '' };
      segs.push(cur);
      this.closed = false;
    }
    cur.text += t.text;
    if (t.end_ms != null) cur.end = t.end_ms + this.offset;
    if (!cur.lang && t.language) cur.lang = t.language;
    cur._pend = true;
    if (!settings().translate && cur.text.length > 80 && /[。．.!?？！]\s*$/.test(cur.text)) this.closed = true;
    this.dirty.add(cur.id);
  }
  addFreeSegment(text, startMs, endMs) {
    if (!text.trim()) return;
    const now = endMs != null ? endMs : this.elapsed();
    const isZh = /[一-鿿]/.test(text);
    const seg = { id: uid(), speaker: '?', start: startMs != null ? startMs : Math.max(0, now - 4000), end: now, lang: isZh ? 'zh' : 'en', text: text.trim(), tr: '' };
    this.lec.segments.push(seg);
    this.dirty.add(seg.id);
    this.nonFinal = { text: '', tr: '' };
    scheduleRender();
    if (settings().translate && localTranslateSupported()) {
      localTranslate(isZh ? toTW(seg.text) : seg.text, isZh ? 'zh' : 'en', isZh ? 'en' : 'zh')
        .then(tr => { seg.tr = tr; this.dirty.add(seg.id); scheduleRender(); }).catch(() => { /* no local translator */ });
    }
  }
  pause() {
    if (this.status !== 'recording') return;
    sfx('off');
    this.elapsedBase = this.elapsed();
    this.status = 'paused';
    if (this.native) { native('recorder.pause').catch(() => {}); renderRecorder(); return; }
    this.mic.pause();
    if (this.browser) this.browser.pause();
    renderRecorder();
  }
  resume() {
    if (this.status !== 'paused') return;
    sfx('on');
    this.runStart = performance.now();
    this.status = 'recording';
    if (this.native) { native('recorder.resume').catch(() => {}); renderRecorder(); return; }
    this.mic.resume();
    if (this.browser) this.browser.resume();
    renderRecorder();
  }
  async stop() {
    if (this.status === 'idle' || this.status === 'stopping') return;
    if (this.native) return this.stopNative();
    this.elapsedBase = this.elapsed();
    this.status = 'stopping'; renderRecorder();
    clearInterval(this.ticker); clearInterval(this.saver); clearInterval(this.keeper);
    const audioP = this.mic.stop();
    if (this.session) { await this.session.end(); this.session.close(); }
    if (this.browser) this.browser.stop();
    const audio = await audioP;
    for (const s of this.lec.segments) delete s._pend;
    this.nonFinal = { text: '', tr: '' };
    this.lec.durationMs = this.elapsedBase;
    if (audio) { this.lec.audioParts = this.lec.audioParts || []; this.lec.audioParts.push({ blob: audio, offset: this.offset0 }); }
    await saveLecture(this.lec);
    if (audio) await DB.dropChunks(this.lec.id).catch(() => {});
    sfx('stop');
    this.status = 'idle';
    releaseWakeLock();
    state.rec = null;
    if (state.view === 'lecture' && state.lecture === this.lec) { renderTranscriptPane(); renderRightPane(); player.detach(); renderPlayer(); }
    toast('錄音已儲存', { icon: 'check' });
  }
}

Recorder.prototype.stopNative = async function () {
  this.status = 'stopping'; renderRecorder();
  clearInterval(this.ticker); clearInterval(this.saver); clearInterval(this.drainer);
  await this.drainNative();
  let res = {};
  try { res = await native('recorder.stop'); } catch { /* keep what we have */ }
  await this.drainNative(res.events || []);
  if (res.elapsed != null) this.nativeElapsed = res.elapsed;
  await Promise.all(this.parts || []);
  for (const s of this.lec.segments) delete s._pend;
  this.nonFinal = { text: '', tr: '' };
  this.lec.durationMs = this.elapsed();
  await saveLecture(this.lec);
  sfx('stop'); buzz('success');
  this.status = 'idle';
  state.rec = null;
  if (state.view === 'lecture' && state.lecture === this.lec) { renderTranscriptPane(); renderRightPane(); player.detach(); renderPlayer(); }
  toast('錄音已儲存', { icon: 'check' });
};
// Bring a finished piece of native audio into the lecture, then remove the phone's copy.
async function importNativePart(lec, file, offset) {
  try {
    const res = await fetch('app://localhost/recordings/' + encodeURIComponent(file));
    if (!res.ok) return;
    const blob = new Blob([await res.arrayBuffer()], { type: 'audio/mp4' });
    lec.audioParts = lec.audioParts || [];
    if (!lec.audioParts.some(p => p.offset === offset)) lec.audioParts.push({ blob, offset });
    lec.audioParts.sort((a, b) => a.offset - b.offset);
    await saveLecture(lec);
    await native('recordings.delete', { file });
  } catch { /* stays on disk; picked up as a leftover next time */ }
}
async function recoverNativeParts(lec) {
  if (!NATIVE) return false;
  let list = [];
  try { list = await native('recordings.orphans'); } catch { return false; }
  const mine = (list || []).filter(o => o.lecture === lec.id);
  for (const o of mine) await importNativePart(lec, o.file, o.offset);
  return mine.length > 0;
}

let wakeLock = null;
async function requestWakeLock() { try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* not allowed */ } }
function releaseWakeLock() { try { wakeLock && wakeLock.release(); } catch { /* ignore */ } wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  const r = state.rec;
  if (!r || r.status === 'idle') return;
  if (document.visibilityState === 'hidden') { r.hiddenAt = Date.now(); return; }
  if (r.native) { r.drainNative(); renderRecorder(); return; }
  if (r.status === 'recording') requestWakeLock();
  setTimeout(() => r.heal(), 300);
  renderRecorder();
});
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
window.addEventListener('beforeunload', e => { if (state.rec && state.rec.status !== 'idle') { e.preventDefault(); e.returnValue = ''; } });

/* ================= file handling ================= */
const ACCEPT = '.pdf,.pptx,.docx,.txt,.md,.png,.jpg,.jpeg,.webp,.gif,application/pdf,image/*';
const FILE_STYLE = {
  pdf: { icon: 'file-text', c: '#e5484d', label: 'PDF' },
  pptx: { icon: 'presentation', c: '#e07a2e', label: '簡報' },
  docx: { icon: 'file-text', c: '#2f6fdb', label: 'Word' },
  image: { icon: 'image', c: '#9b51e0', label: '圖片' },
  text: { icon: 'file', c: '#6b7280', label: '文字' },
};
function fileKind(f) {
  const n = (f.name || '').toLowerCase();
  if (f.type === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (n.endsWith('.pptx')) return 'pptx';
  if (n.endsWith('.docx')) return 'docx';
  if (/^image\/(png|jpeg|webp|gif)$/.test(f.type) || /\.(png|jpe?g|webp|gif)$/.test(n)) return 'image';
  if (n.endsWith('.txt') || n.endsWith('.md') || (f.type || '').startsWith('text/')) return 'text';
  return 'other';
}
async function extractOfficeText(blob, kind) {
  const { default: JSZip } = await import(JSZIP_URL);
  const zip = await JSZip.loadAsync(blob);
  const decode = xml => xml.replace(/<a:br\/>|<w:br\/>/g, '\n').replace(/<\/a:p>|<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
  if (kind === 'docx') { const f = zip.file('word/document.xml'); return f ? decode(await f.async('string')) : ''; }
  const slides = Object.keys(zip.files).filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  const out = [];
  for (const p of slides) {
    const n = p.match(/slide(\d+)/)[1];
    let txt = decode(await zip.file(p).async('string'));
    const notes = zip.file('ppt/notesSlides/notesSlide' + n + '.xml');
    if (notes) { const nt = decode(await notes.async('string')).replace(/^\d+$/m, '').trim(); if (nt) txt += '\n[講者備註] ' + nt; }
    out.push('--- 投影片 ' + n + ' ---\n' + txt);
  }
  return out.join('\n\n');
}
async function extractPdfText(blob) {
  const pdfjs = await import(PDFJS_URL);
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  const out = [];
  for (let i = 1; i <= Math.min(doc.numPages, 150); i++) {
    const page = await doc.getPage(i);
    const c = await page.getTextContent();
    const txt = c.items.map(it => it.str + (it.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+\n/g, '\n').trim();
    out.push('--- 投影片 ' + i + ' ---\n' + txt);
  }
  return out.join('\n\n');
}
async function addFiles(fileList) {
  const lec = state.lecture; if (!lec) return;
  lec.files = lec.files || [];
  for (const f of fileList) {
    const kind = fileKind(f);
    if (kind === 'other') { toast('不支援：' + f.name, { icon: 'info', ms: 4000 }); continue; }
    const entry = { id: uid(), name: f.name, type: f.type, kind, size: f.size, blob: f, added: Date.now() };
    try {
      if (kind === 'pptx' || kind === 'docx') entry.text = await extractOfficeText(f, kind);
      else if (kind === 'pdf') entry.text = await extractPdfText(f);
      else if (kind === 'text') entry.text = await f.text();
    } catch { if (kind !== 'pdf') toast('讀不到 ' + f.name + ' 的文字', { icon: 'info' }); }
    lec.files.push(entry);
  }
  await saveLecture(lec);
  toast('已加入講義', { icon: 'paperclip' });
  renderRightPane();
}

/* ================= notes generation ================= */
const B = { type: 'object', properties: { zh: { type: 'string' }, en: { type: 'string' } }, required: ['zh', 'en'], additionalProperties: false };
const obj = (props) => ({ type: 'object', properties: props, required: Object.keys(props), additionalProperties: false });
const arr = items => ({ type: 'array', items });
const NOTES_SCHEMA = obj({
  title: B, one_line: B, overview: B,
  professor_speaker: { type: 'string' },
  learning_objectives: arr(B),
  outline: arr(obj({ heading: B, time: { type: 'string' }, points: arr(obj({ text: B, emphasis: { type: 'boolean' }, source: { type: 'string', enum: ['lecture', 'slides', 'both'] } })) })),
  mind_map: obj({ center: B, branches: arr(obj({ label: B, children: arr(obj({ label: B, leaves: arr(B) })) })) }),
  key_terms: arr(obj({ term_en: { type: 'string' }, term_zh: { type: 'string' }, definition: B })),
  tables: arr(obj({ title: B, columns: arr(B), rows: arr(obj({ cells: arr(B) })) })),
  exam_focus: arr(obj({ point: B, why: B, time: { type: 'string' } })),
  class_qa: arr(obj({ question: B, answer: B, asked_by: { type: 'string' } })),
  review_questions: arr(obj({ question: B, answer: B })),
  todo: arr(B),
  summary: B,
});

const SYSTEM_PROMPT = `你是一位頂尖的大學助教，專門把課堂錄音逐字稿和教授的講義整理成「有結構、可以拿來複習考試」的筆記。

輸出規則：
- 每個 {zh, en} 欄位都要同時給「繁體中文（台灣用語）」與「英文」，兩者意思一致；專有名詞在中文裡第一次出現時附上英文原文。
- 以教授講的內容為主軸。逐字稿裡標為教授的說話者是主要來源；其他說話者通常是學生的提問或討論，放進 class_qa。
- 講義（投影片、PDF）用來校正逐字稿的辨識錯誤、補足公式與專有名詞，但不要把講義上教授沒講到的內容當成重點；講義才有的內容 source 標 "slides"。
- 逐字稿有辨識錯誤是正常的，依上下文與講義判斷正確的詞。
- outline 依照上課的時間順序分段，time 用逐字稿的時間標記（mm:ss 或 h:mm:ss），沒有就給空字串。長時間的課（超過 1 小時）大約每 10–15 分鐘一段，3–4 小時的課可以有 15 段以上。每段 3–8 個要點，要點寫成完整、可獨立理解的句子，不要只寫關鍵字。
- emphasis = true 只用在教授明確強調的內容（例如「這很重要」「考試會考」「大家要記得」、重複講好幾次的觀念）。
- exam_focus 收錄最可能考的觀念，why 說明判斷依據（例如教授說了什麼）。
- mind_map：center 是本堂課主題，3–7 個 branches，每個 branch 2–5 個 children，leaves 是簡短關鍵詞（每個 child 0–4 個）。標籤要短（中文 12 字以內）。
- tables：只在內容真的適合比較時才做表格（例如方法比較、優缺點、分類），每個表格 2–5 欄；沒有適合的就給空陣列。
- review_questions：5–10 題康乃爾筆記式的自我測驗問題，附簡潔答案。
- professor_speaker：判斷哪個說話者編號是教授，填入編號字串；無法判斷就填空字串。
- todo：作業、報告、考試日期、教授交代要準備的事；沒有就給空陣列。
- 不要編造逐字稿和講義裡沒有的事實。`;

function transcriptForPrompt(lec) {
  const lines = [];
  let last = null;
  for (const s of lec.segments) {
    const who = speakerInfo(lec, s.speaker);
    const label = (who.isProf ? '教授' : who.name) + '（說話者 ' + s.speaker + '）';
    const text = s.lang === 'zh' ? toTW(s.text) : s.text;
    if (last && last.speaker === s.speaker) last.text += ' ' + text.trim();
    else { last = { speaker: s.speaker, label, time: fmtTime(s.start), text: text.trim() }; lines.push(last); }
  }
  return lines.map(l => `[${l.time}] ${l.label}: ${l.text}`).join('\n');
}
async function getClient() {
  const key = settings().anthropicKey;
  if (!key) throw new Error('請先到「設定」填入 Anthropic API 金鑰');
  const { default: Anthropic } = await import(SDK_URL);
  return new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 2 });
}
async function streamJSON(client, params, onChars) {
  const run = async useFallback => {
    const p = useFallback ? { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : params;
    const stream = useFallback ? client.beta.messages.stream(p) : client.messages.stream(p);
    stream.on('text', (_d, snap) => onChars && onChars(snap.length));
    return stream.finalMessage();
  };
  let msg;
  try { msg = await run(true); } catch (err) {
    if (err && err.status === 400 && /fallback/i.test(err.message || '')) msg = await run(false);
    else throw err;
  }
  if (msg.stop_reason === 'refusal') throw new Error('Claude 拒絕處理這份內容');
  if (msg.stop_reason === 'max_tokens') throw new Error('內容太長，筆記被截斷了，請重試或減少上傳的檔案');
  return JSON.parse(msg.content.filter(b => b.type === 'text').map(b => b.text).join(''));
}
function setGenStep(i, detail) {
  if (!state.gen) return;
  state.gen.cur = i;
  if (detail != null) state.gen.detail = detail;
  const list = $('#gen-steps');
  if (list) list.querySelectorAll('li').forEach((li, k) => {
    li.className = k < i ? 'done' : k === i ? 'now' : '';
    li.querySelector('.s').replaceChildren(k < i ? icon('check') : '');
  });
  const d = $('#gen-progress'); if (d) d.textContent = state.gen.detail || '';
}
async function generateNotes() {
  const lec = state.lecture;
  if (state.gen) return;
  const hasTranscript = lec.segments.some(s => s.text.trim());
  const files = lec.files || [];
  if (!hasTranscript && !files.length) { toast('還沒有逐字稿或講義可以整理', { icon: 'info' }); return; }
  let useClaude = proReady().notes;
  if (useClaude && !(await ensureAIConsent())) useClaude = false;
  state.gen = useClaude
    ? { engine: 'claude', steps: ['整理逐字稿與講義', 'Claude 閱讀內容', '撰寫中英對照筆記', '完成'], cur: 0, detail: '' }
    : { engine: 'free', steps: ['分析逐字稿與講義', '找出重點與考點', '建立心智圖與測驗', localTranslateSupported() ? '翻譯成中英對照' : '完成'], cur: 0, detail: '' };
  renderNotesPane();
  try {
    const notes = useClaude ? await claudeNotes(lec, files, hasTranscript) : await freeNotes(lec, files);
    lec.notes = notes;
    lec.notesAt = Date.now();
    const t = notes.title.zh || notes.title.en;
    if (t && (lec.title.startsWith('新課堂') || /^\d{1,2}\/\d{1,2}/.test(lec.title))) lec.title = t;
    await saveLecture(lec);
    setGenStep(state.gen.steps.length);
    await wait(350);
    state.noteTab = 'overview';
    sfx('done'); bloom();
    toast('筆記完成', { icon: 'sparkles' });
  } catch (err) {
    console.error(err);
    toast('整理筆記失敗：' + (err.message || err), { icon: 'info', ms: 7000 });
  } finally {
    state.gen = null;
    if (state.lecture === lec && state.view === 'lecture') { renderLectureHead(); renderRightPane(); }
  }
}
async function claudeNotes(lec, files, hasTranscript) {
  const client = await getClient();
  const content = [];
  let bytes = 0;
  for (const f of files) {
    if (f.kind === 'pdf') {
      bytes += f.size;
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: await blobToB64(f.blob) }, title: f.name });
    } else if (f.kind === 'image') {
      bytes += f.size;
      const mt = f.type || (f.name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg');
      content.push({ type: 'image', source: { type: 'base64', media_type: mt, data: await blobToB64(f.blob) } });
    } else if (f.text) {
      content.push({ type: 'document', source: { type: 'text', media_type: 'text/plain', data: f.text.slice(0, 400000) }, title: f.name });
    }
  }
  if (bytes > 22 * 1024 * 1024) throw new Error('講義檔案太大（超過約 22 MB），請只上傳本堂課相關的部分');
  const detail = { brief: '精簡：只留最核心的內容。', standard: '標準詳細程度。', detailed: '詳細：盡量保留教授舉的例子、推導與細節。' }[settings().detail] || '';
  const spk = Object.keys(talkTimes(lec)).map(id => { const i = speakerInfo(lec, id); return `說話者 ${id}：${i.name}${i.isProf ? '（目前判定為教授）' : ''}`; }).join('\n');
  content.push({
    type: 'text',
    text: `課程：${lec.course || '（未填）'}\n本堂標題：${lec.title}\n上課日期：${fmtDate(lec.created)}\n詳細程度：${detail}\n\n說話者：\n${spk || '（無）'}\n\n${files.length ? '上面附上的是教授的講義／檔案。\n\n' : ''}以下是課堂逐字稿（時間 mm:ss）：\n<transcript>\n${hasTranscript ? transcriptForPrompt(lec) : '（沒有錄音逐字稿，只根據講義整理預習筆記）'}\n</transcript>\n\n請整理成筆記。`,
  });
  setGenStep(1, '把逐字稿和講義交給 Claude…');
  const notes = await streamJSON(client, {
    model: MODEL,
    max_tokens: 64000,
    system: SYSTEM_PROMPT,
    output_config: { effort: 'high', format: { type: 'json_schema', schema: NOTES_SCHEMA } },
    messages: [{ role: 'user', content }],
  }, n => setGenStep(2, `已寫 ${n.toLocaleString()} 字元`));
  notes.engine = 'claude';
  return notes;
}
async function freeNotes(lec, files) {
  await wait(250);
  const slidesText = files.map(f => f.text || '').join('\n');
  const prof = lec.segments.some(s => s.speaker !== '?') ? professorId(lec) : '';
  const sentencesIn = lec.segments.map(s => ({ text: s.lang === 'en' ? s.text : toTW(s.text), start: s.start, speaker: s.speaker }));
  setGenStep(1); await wait(300);
  const notes = buildFreeNotes({ sentencesIn, slidesText, title: lec.title.startsWith('新課堂') ? '' : lec.title, professorId: prof, fmtTime });
  setGenStep(2); await wait(300);
  if (localTranslateSupported() && Store.get('translate', true)) {
    setGenStep(3, '使用瀏覽器內建翻譯（第一次可能要下載語言包）');
    const ok = await getLocalTranslator('zh', 'en').catch(() => null);
    if (ok) {
      try { await fillTranslations(notes, localTranslate, (i, n) => setGenStep(3, `翻譯中 ${i}/${n}`)); } catch { /* keep single language */ }
    } else setGenStep(3, '這個瀏覽器的翻譯還沒準備好，先只用原文');
  }
  notes.engine = 'free';
  return notes;
}

async function translateTranscript() {
  const lec = state.lecture;
  const todo = lec.segments.filter(s => s.text.trim() && !(s.tr && s.tr.trim()));
  if (!todo.length) { toast('逐字稿都已經有翻譯了'); return; }
  state.translating = true; renderSpeakers();
  try {
    if (proReady().notes && await ensureAIConsent()) {
      const client = await getClient();
      for (let i = 0; i < todo.length; i += 60) {
        const batch = todo.slice(i, i + 60);
        toast(`翻譯中… ${Math.min(i + 60, todo.length)}/${todo.length}`, { icon: 'languages', ms: 60000 });
        const res = await streamJSON(client, {
          model: MODEL, max_tokens: 32000,
          output_config: { effort: 'low', format: { type: 'json_schema', schema: obj({ items: arr(obj({ id: { type: 'string' }, tr: { type: 'string' } })) }) } },
          system: '你是課堂口譯員。把每一句翻譯成另一種語言：中文句子翻成英文，英文句子翻成繁體中文（台灣用語）。保持口語但通順，修正明顯的語音辨識錯字。每個 id 都要回傳。',
          messages: [{ role: 'user', content: JSON.stringify(batch.map(s => ({ id: s.id, text: s.lang === 'zh' ? toTW(s.text) : s.text }))) }],
        });
        const map = new Map(res.items.map(x => [x.id, x.tr]));
        for (const s of batch) if (map.has(s.id)) s.tr = map.get(s.id);
        await saveLecture(lec); rerenderTranscript();
      }
    } else if (localTranslateSupported()) {
      let n = 0;
      for (const s of todo) {
        const zh = s.lang !== 'en';
        s.tr = await localTranslate(zh ? toTW(s.text) : s.text, zh ? 'zh' : 'en', zh ? 'en' : 'zh');
        if (++n % 10 === 0) { toast(`翻譯中… ${n}/${todo.length}`, { icon: 'languages', ms: 60000 }); rerenderTranscript(); }
      }
      await saveLecture(lec); rerenderTranscript();
    } else throw new Error('這個裝置沒有免費翻譯可用，請改用電腦版 Chrome 或進階版');
    toast('翻譯完成', { icon: 'languages' });
  } catch (err) {
    toast('翻譯失敗：' + (err.message || err), { icon: 'info', ms: 6000 });
  } finally { state.translating = false; renderSpeakers(); }
}

/* ================= bilingual rendering ================= */
function bi(o, cls = '') {
  if (!o) return '';
  const zh = o.zh || '', en = o.en || '';
  if (state.lang === 'zh') return h('span', { class: 'bi ' + cls }, zh || en);
  if (state.lang === 'en') return h('span', { class: 'bi ' + cls }, en || zh);
  return h('span', { class: 'bi ' + cls }, zh || en, zh && en && en !== zh ? h('span', { class: 'en' }, en) : null);
}
function segSides(s) {
  const orig = s.lang === 'en' ? s.text : toTW(s.text);
  const tr = s.tr ? (s.lang === 'en' ? toTW(s.tr) : s.tr) : '';
  return s.lang === 'en' ? { zh: tr, en: orig } : { zh: orig, en: tr };
}
function planBadge() {
  const pro = isPro();
  return h('button', { class: 'badge ' + (pro ? 'pro' : 'free'), onclick: () => showPlans(), title: '比較方案' },
    icon(pro ? 'crown' : 'gift'), pro ? '進階版' : '免費版');
}

/* ================= consent before anything goes to an outside AI service ================= */
function ensureAIConsent() {
  if (Store.get('aiConsent', false)) return Promise.resolve(true);
  return new Promise(resolve => {
    let decided = false, dlg;
    const done = ok => { if (decided) return; decided = true; if (ok) Store.set('aiConsent', true); dlg.closeDialog(); resolve(ok); };
    const item = (ic, color, title, text) => h('div', { class: 'row-item', style: 'padding:10px 0;min-height:0' },
      h('span', { class: 'ri-ico', style: `--c:${color}` }, icon(ic)), h('div', { class: 'ri-text' }, h('b', null, title), h('span', null, text)));
    dlg = openDialog([
      h('div', { class: 'cal-head' }, h('span', { class: 'sticker', style: '--sz:46px;--r:-8deg;animation:none' }, icon('shield-check')),
        h('div', null, h('h3', { style: 'margin:0' }, '進階版會用到外部 AI 服務'), h('div', { class: 'muted small' }, '開始之前，請先確認你同意以下資料傳送'))),
      h('div', { style: 'margin-top:12px' },
        item('audio-lines', '#5b5ce2', 'Soniox（語音辨識）', '錄音會即時傳給 Soniox，轉成逐字稿和翻譯。'),
        item('sparkles', '#d4820f', 'Anthropic（Claude）', '整理筆記或補翻譯時，會把逐字稿和你上傳的講義傳給 Claude。'),
        item('lock', '#1f9d55', '其他資料留在你的裝置', '課堂和筆記都存在這台裝置，只有處理當下需要的內容會傳出去；這兩家公司依各自的隱私政策處理收到的資料。')),
      h('p', { class: 'muted small', style: 'margin:10px 0 0' }, '不同意的話，可以繼續使用免費版：' + (NATIVE ? '語音辨識在 iPhone 上進行，' : '') + '筆記在裝置上自動整理，不會傳給 AI 公司。'),
      h('div', { class: 'cal-actions' },
        h('button', { class: 'btn primary lg block', onclick: () => done(true) }, icon('check'), '我同意，繼續'),
        h('button', { class: 'btn ghost block', onclick: () => done(false) }, '不同意')),
    ], { cls: 'sheet', onClose: () => { if (!decided) { decided = true; resolve(false); } } });
  });
}

/* ================= welcome → sign in → plans (first launch, plan badge, settings) ================= */
const BRAND = {
  apple: '<svg viewBox="0 0 24 24" class="brand-ico" aria-hidden="true"><path fill="currentColor" d="M16.37 1.43c0 1.14-.49 2.27-1.18 3.08-.74.9-1.99 1.57-2.99 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.57-2.27 1.21-2.98.8-.94 2.14-1.64 3.25-1.68.03.13.05.28.05.43zm4.56 15.71c-.03.07-.46 1.58-1.52 3.12-.94 1.34-1.94 2.71-3.43 2.71-1.52 0-1.9-.88-3.63-.88-1.7 0-2.3.91-3.67.91-1.38 0-2.33-1.26-3.43-2.8C4 18.38 2.96 15.57 2.96 12.92c0-4.28 2.8-6.55 5.55-6.55 1.45 0 2.68.95 3.6.95.87 0 2.22-1.01 3.9-1.01.61 0 2.89.06 4.37 2.19-.13.09-2.38 1.37-2.38 4.19 0 3.26 2.85 4.42 2.96 4.45z"/></svg>',
  google: '<svg viewBox="0 0 48 48" class="brand-ico" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z"/></svg>',
};
const brandIcon = k => { const t = document.createElement('template'); t.innerHTML = BRAND[k]; return t.content.firstChild; };
const ntd = n => 'NT$' + n.toLocaleString('en-US');
function avatar(a, size = 36) {
  return h('span', { class: 'avatar ' + (a ? a.provider : 'guest'), style: `--sz:${size}px` },
    a ? (a.name || '?').trim().charAt(0).toUpperCase() : icon('user-round'),
    a ? h('span', { class: 'av-badge' }, brandIcon(a.provider)) : null);
}

function signInButtons(onDone, { compact = false } = {}) {
  const btn = (provider, label) => {
    const b = h('button', { class: 'btn lg block sso ' + provider, onclick: async () => {
      if (b.classList.contains('busy')) return;
      b.classList.add('busy'); b.disabled = true;
      try {
        const a = await Account.signIn(provider);
        buzz('success');
        if (Store.get('plan', null) !== 'pro' && Account.subscription()) Store.set('plan', 'pro');
        toast(`已登入：${a.name}` + (Account.PREVIEW ? '（預覽模擬）' : ''), { icon: 'check' });
        onDone && onDone(a);
      } catch (e) { toast(e.message || '登入失敗', { icon: 'info' }); }
      finally { b.classList.remove('busy'); b.disabled = false; }
    } }, h('span', { class: 'sso-ico' }, brandIcon(provider)), h('span', null, label), h('span', { class: 'sso-spin' }));
    return b;
  };
  return h('div', { class: 'sso-stack' + (compact ? ' compact' : '') },
    btn('apple', '用 Apple 登入'),
    btn('google', '用 Google 登入'));
}

function legalLinks() {
  return h('div', { class: 'legal' },
    h('a', { href: '#', onclick: e => { e.preventDefault(); toast('使用條款頁面會在上架前補上', { icon: 'info' }); } }, '使用條款'), ' · ',
    h('a', { href: '#', onclick: e => { e.preventDefault(); toast('隱私權政策頁面會在上架前補上', { icon: 'info' }); } }, '隱私權政策'));
}

function showPlans({ first = false, step } = {}) {
  let cur = step || (first ? 'welcome' : 'plans');
  let billing = 'monthly';
  let afterSignIn = null;
  const body = h('div', { class: 'ob-body' });
  const dots = h('div', { class: 'ob-dots' }, ['welcome', 'signin', 'plans'].map(s => h('i', { 'data-s': s })));
  let dlg;
  const finish = () => {
    Store.set('onboarded', true);
    if (!Store.get('plan', null)) Store.set('plan', 'free');
    dlg.closeDialog();
  };
  const show = (s, dir = 1) => {
    cur = s;
    dots.querySelectorAll('i').forEach(i => i.classList.toggle('on', i.dataset.s === s));
    dots.hidden = !first;
    body.replaceChildren(VIEWS[s]());
    body.scrollTop = 0; dlg && (dlg.scrollTop = 0);
    if (body.firstChild) jellyIn(body.firstChild, dir > 0 ? 'below' : 'above');
    afterRender();
  };

  const VIEWS = {
    welcome: () => h('div', { class: 'ob-step welcome' },
      h('div', { class: 'ob-art', 'aria-hidden': 'true' },
        h('span', { class: 'ob-glow' }),
        sticker('notebook-pen', '--sz:86px;--r:-6deg'),
        sticker('mic', '--sz:50px;--r:12deg;--a:#f5a524;--b:#ef4f6b;--dl:-1.2s'),
        sticker('languages', '--sz:44px;--r:-14deg;--a:#5b8def;--b:#8b5cf6;--dl:-2.4s'),
        sticker('sparkles', '--sz:40px;--r:10deg;--a:#14b8a6;--b:#22a3c4;--dl:-3.6s')),
      h('h2', null, '上課，只要專心聽'),
      h('p', { class: 'ob-sub' }, '錄音、即時字幕、中英對照筆記，蛤說啥幫你一次整理好。'),
      h('div', { class: 'ob-feats' },
        [['captions', '#17946f', '即時字幕', '教授說什麼，馬上看得到'],
          ['list-tree', '#d4820f', '有條理的筆記', '大綱、考點、心智圖、表格'],
          ['users', '#5b5ce2', '分辨講者', '教授和同學的發言分開']].map(([ic, c, t, d], j) =>
          h('div', { class: 'ob-feat', style: `--j:${j}` }, h('span', { class: 'ri-ico', style: `--c:${c}` }, icon(ic)), h('div', null, h('b', null, t), h('span', null, d))))),
      h('div', { class: 'ob-actions' },
        h('button', { class: 'btn primary lg block', onclick: () => show(Account.account() ? 'plans' : 'signin') }, '開始使用', icon('chevron-right')))),

    signin: () => {
      const a = Account.account();
      return h('div', { class: 'ob-step signin' },
        !first ? h('button', { class: 'btn icon ghost ob-back', 'aria-label': '返回', onclick: () => show('plans', -1) }, icon('chevron-left')) : null,
        h('div', { class: 'ob-art small', 'aria-hidden': 'true' }, h('span', { class: 'ob-glow' }), avatar(a, 78)),
        h('h2', null, afterSignIn ? '先登入，才能訂閱' : '登入蛤說啥'),
        h('p', { class: 'ob-sub' }, afterSignIn ? '訂閱會綁在你的帳號上，換手機、重新安裝都能恢復。' : '登入後可以訂閱進階版，之後換裝置也能恢復方案。'),
        signInButtons(() => { const next = afterSignIn; afterSignIn = null; show('plans'); if (next) setTimeout(next, 450); }),
        h('div', { class: 'ob-or' }, h('span', null, '或')),
        h('button', { class: 'btn ghost block', onclick: () => { afterSignIn = null; first ? show('plans') : show('plans', -1); } },
          first ? '先不登入，用免費版看看' : '先不要'),
        h('p', { class: 'muted small ob-note' }, icon('lock'), ' 只用來辨識你的帳號，不會讀取信件或聯絡人。', Account.PREVIEW ? ' 預覽版會模擬登入。' : ''),
        legalLinks());
    },

    plans: () => {
      const a = Account.account();
      const sub = Account.subscription();
      const plan = Store.get('plan', null);
      const P = Account.PRODUCTS;
      const feat = (yes, text, j) => h('li', { class: yes ? 'yes' : 'no', style: `--j:${j}` }, h('span', { class: 'ck' }, icon(yes ? 'check' : 'x')), h('span', null, text));
      const priceBox = h('div', { class: 'price-box' });
      const proBtn = h('button', { class: 'btn primary lg block buy' });
      const paint = () => {
        const p = P[billing];
        priceBox.replaceChildren(
          h('div', { class: 'price' }, h('span', { class: 'amt', key: billing }, ntd(p.price)), h('small', null, '／' + p.per)),
          h('div', { class: 'price-sub' }, billing === 'yearly' ? `平均每月 ${ntd(p.perMonth)}，比月繳省 ${Account.yearlySaving()}%` : '按月付款，隨時可以取消'));
        const amt = priceBox.querySelector('.amt'); amt && jelly(amt, .6, 520);
        proBtn.replaceChildren(
          sub ? h('span', null, '目前方案') : h('span', null, a ? `訂閱 ${p.label}方案` : '登入並訂閱'),
          h('span', { class: 'sso-spin' }), sub ? null : icon('chevron-right'));
        proBtn.disabled = !!sub;
      };
      proBtn.onclick = async () => {
        if (proBtn.classList.contains('busy')) return;
        if (!Account.account()) { afterSignIn = () => body.querySelector('.buy')?.click(); show('signin'); return; }
        if (!(await ensureAIConsent())) { toast('沒有同意資料傳送，維持免費版', { icon: 'gift' }); return; }
        proBtn.classList.add('busy'); proBtn.disabled = true;
        try {
          await Account.subscribe(billing);
          Store.set('plan', 'pro');
          Store.set('onboarded', true);
          buzz('success'); sfx('done');
          dlg.closeDialog();
          setTimeout(() => { bloom(); toast('歡迎加入進階版' + (Account.PREVIEW ? '（預覽模擬，沒有扣款）' : ''), { icon: 'crown', ms: 3600 }); render(); }, 260);
        } catch (e) { toast(e.message || '訂閱沒有完成', { icon: 'info' }); proBtn.classList.remove('busy'); proBtn.disabled = false; }
      };
      const bill = seg([{ v: 'monthly', label: '月繳' }, { v: 'yearly', label: `年繳 省${Account.yearlySaving()}%` }], billing,
        v => { billing = v; Store.set('billing', v); paint(); }, 'seg full billing accent');
      paint();
      return h('div', { class: 'ob-step plans-step' },
        h('div', { class: 'plans-hero' },
          h('h2', null, first ? '選一個適合你的方案' : '方案與訂閱'),
          h('p', null, '兩種方案都能錄音、看即時字幕、整理筆記。之後隨時可以升級或取消。')),
        h('div', { class: 'bill-wrap' }, bill),
        h('div', { class: 'plan-grid' },
          h('div', { class: 'plan' + (plan !== 'pro' && Store.get('onboarded', false) ? ' selected' : ''), style: '--i:0' },
            h('h3', null, icon('gift'), '免費版'),
            h('div', { class: 'price-box' }, h('div', { class: 'price' }, 'NT$0', h('small', null, '永久免費')), h('div', { class: 'price-sub' }, '不用登入，打開就能用')),
            h('ul', { class: 'feat' },
              feat(true, NATIVE ? '即時字幕（iPhone 內建語音辨識）' : '即時字幕（瀏覽器內建語音辨識）', 0),
              feat(true, '自動整理：大綱、考試重點、名詞表、心智圖、自我測驗', 1),
              feat(true, '上傳講義（PDF／PPT／Word）一起整理', 2),
              feat(true, '錄音回放、加入行事曆', 3),
              feat(false, '分辨教授和同學的聲音', 4),
              feat(false, '中英混講辨識和即時翻譯', 5),
              feat(false, 'Claude AI 改寫的中英對照筆記', 6)),
            h('button', { class: 'btn lg block' + (plan !== 'pro' ? ' soft' : ''), onclick: () => {
              if (sub) { toast('要取消訂閱，請到「設定 > 帳號 > 管理訂閱」', { icon: 'info', ms: 4000 }); return; }
              Store.set('plan', 'free'); buzz('medium'); finish(); toast('使用免費版', { icon: 'gift' }); render();
            } }, plan !== 'pro' && Store.get('onboarded', false) ? '目前方案' : '使用免費版')),
          h('div', { class: 'plan pro' + (plan === 'pro' ? ' selected' : ''), style: '--i:1' },
            h('span', { class: 'ribbon badge pro' }, icon('crown'), '推薦'),
            h('h3', null, icon('sparkles'), '進階版'),
            priceBox,
            h('ul', { class: 'feat' },
              feat(true, `每月 ${P[billing].hours} 小時中英混講即時字幕＋翻譯`, 0),
              feat(true, '自動分辨教授和同學的聲音', 1),
              feat(true, 'Claude 讀完講義和逐字稿，寫出中英對照筆記', 2),
              feat(true, '比較表格、課堂問答、考點依據更準確', 3),
              feat(true, '不用自己申請金鑰，登入就能用', 4),
              feat(true, '包含免費版的所有功能', 5)),
            proBtn)),
        h('div', { class: 'plans-foot' },
          h('p', null, `進階版為自動續訂的訂閱，${ntd(P.monthly.price)}／月或 ${ntd(P.yearly.price)}／年，從你的 Apple ID 扣款。除非在目前期間結束前至少 24 小時取消，否則會自動續訂。可隨時在 iPhone「設定 > Apple ID > 訂閱」管理或取消。`),
          h('div', { class: 'foot-links' },
            h('a', { href: '#', onclick: async e => {
              e.preventDefault();
              if (!Account.account()) { toast('請先登入，才能恢復購買', { icon: 'info' }); show('signin'); return; }
              const s = await Account.restore();
              if (s) { Store.set('plan', 'pro'); toast('已恢復進階版', { icon: 'crown' }); show('plans'); render(); } else toast('這個帳號沒有找到訂閱紀錄', { icon: 'info' });
            } }, '恢復購買'), ' · ',
            !a ? h('a', { href: '#', onclick: e => { e.preventDefault(); show('signin'); } }, '登入') : h('span', { class: 'who' }, avatar(a, 18), a.name), ' · ',
            legalLinks())));
    },
  };

  dlg = openDialog([
    !first ? h('button', { class: 'btn icon ghost plans-close', 'aria-label': '關閉', onclick: () => dlg.closeDialog() }, icon('x')) : null,
    dots, body,
  ], { cls: 'plans onboard', onClose: () => { if (!Store.get('plan', null)) { Store.set('plan', 'free'); render(); } Store.set('onboarded', true); } });
  show(cur);
  return dlg;
}

/* account sheet: from the avatar on the home page */
function confirmSheet({ icon: ic, color = '#ef4f6b', title, text, ok, danger = false }) {
  return new Promise(resolve => {
    let done = false, dlg;
    const end = v => { if (done) return; done = true; dlg.closeDialog(); resolve(v); };
    dlg = openDialog([
      h('div', { class: 'cal-head' }, h('span', { class: 'sticker', style: `--sz:46px;--r:-8deg;--a:${color};--b:${color};animation:none` }, icon(ic)),
        h('div', null, h('h3', { style: 'margin:0' }, title))),
      h('p', { class: 'muted', style: 'margin:12px 0 0;line-height:1.6' }, text),
      h('div', { class: 'cal-actions' },
        h('button', { class: 'btn lg block ' + (danger ? 'danger' : 'primary'), onclick: () => end(true) }, ok),
        h('button', { class: 'btn ghost block', onclick: () => end(false) }, '取消')),
    ], { cls: 'sheet', onClose: () => { if (!done) { done = true; resolve(false); } } });
  });
}
async function doSignOut() {
  if (!(await confirmSheet({ icon: 'log-out', color: '#6b7280', title: '要登出嗎？', text: '登出後會回到免費版。你的課堂和筆記都還在這台裝置上，重新登入就能恢復進階版。', ok: '登出' }))) return;
  Account.signOut();
  Store.set('plan', 'free');
  toast('已登出', { icon: 'log-out' });
  render();
}
async function doDeleteAccount() {
  const sub = Account.subscription();
  if (!(await confirmSheet({
    icon: 'trash-2', title: '刪除帳號？', danger: true, ok: '永久刪除帳號',
    text: '會刪除你的帳號和用量紀錄，無法復原。這台裝置上的課堂和筆記不會被刪除。' + (sub ? ' 注意：刪除帳號不會自動取消 Apple 訂閱，請另外到 iPhone「設定 > Apple ID > 訂閱」取消，以免繼續扣款。' : ''),
  }))) return;
  await Account.deleteAccount();
  Store.set('plan', 'free');
  toast('帳號已刪除', { icon: 'check' });
  render();
}
function manageSubscription() {
  if (NATIVE) { location.href = 'https://apps.apple.com/account/subscriptions'; return; }
  toast(Account.PREVIEW ? '上架後會打開 iPhone 的「訂閱」管理頁面' : '請到 iPhone「設定 > Apple ID > 訂閱」管理', { icon: 'info', ms: 3600 });
}
function accountCard() {
  const a = Account.account(), sub = Account.subscription(), u = Account.usage();
  const P = Account.PRODUCTS;
  if (!a) {
    return h('div', { class: 'acct-card guest' },
      h('div', { class: 'acct-top' }, avatar(null, 54),
        h('div', { class: 'grow' }, h('b', null, '尚未登入'), h('span', null, '目前使用免費版。登入後可以訂閱進階版。'))),
      signInButtons(() => render(), { compact: true }),
      h('button', { class: 'btn sm ghost', style: 'align-self:center', onclick: () => showPlans() }, '比較方案', icon('chevron-right')));
  }
  return h('div', { class: 'acct-card' + (sub ? ' pro' : '') },
    h('div', { class: 'acct-top' }, avatar(a, 54),
      h('div', { class: 'grow' }, h('b', null, a.name), h('span', null, a.email)),
      sub ? h('span', { class: 'badge pro' }, icon('crown'), '進階版') : h('span', { class: 'badge free' }, icon('gift'), '免費版')),
    sub ? h('div', { class: 'acct-usage' },
      h('div', { class: 'au-row' }, h('span', null, '本月即時字幕'), h('b', null, `剩 ${u.left.toFixed(1)} 小時`, h('small', null, ` ／ ${u.quota} 小時`))),
      h('div', { class: 'meter' }, h('i', { style: `width:${Math.max(2, (u.used / (u.quota || 1)) * 100)}%` })),
      h('div', { class: 'au-row muted small' }, h('span', null, `${P[sub.product].label}方案 · ${ntd(P[sub.product].price)}／${P[sub.product].per}`), h('span', null, '下次續訂 ' + new Date(sub.renews).toLocaleDateString('zh-TW')))) : null,
    h('div', { class: 'acct-actions' },
      sub ? h('button', { class: 'btn sm', onclick: manageSubscription }, icon('credit-card'), '管理訂閱')
        : h('button', { class: 'btn sm primary', onclick: () => showPlans() }, icon('crown'), '升級進階版'),
      h('button', { class: 'btn sm', onclick: async e => {
        const b = e.currentTarget; b.disabled = true;
        const s = await Account.restore(); b.disabled = false;
        if (s) { Store.set('plan', 'pro'); toast('已恢復進階版', { icon: 'crown' }); render(); } else toast('沒有找到訂閱紀錄', { icon: 'info' });
      } }, icon('refresh-cw'), '恢復購買'),
      h('button', { class: 'btn sm ghost', onclick: doSignOut }, icon('log-out'), '登出')),
    h('button', { class: 'acct-delete', onclick: doDeleteAccount }, '刪除帳號'));
}

/* ================= views ================= */
const app = () => $('#app');

async function renderHome() {
  const list = (await DB.all()).sort((a, b) => b.created - a.created);
  const cfg = settings();
  const hr = new Date().getHours();
  const greet = hr < 5 ? '夜深了' : hr < 11 ? '早安' : hr < 14 ? '午安' : hr < 18 ? '午後好' : '晚安';
  const totalMs = list.reduce((a, l) => a + (l.durationMs || 0), 0);
  const notesN = list.filter(l => l.notes).length;
  const listBox = h('div', { id: 'lecture-list' });
  const root = h('div', null,
    h('header', { class: 'topbar' },
      h('div', { class: 'brand grow' }, h('span', { class: 'logo orb-logo' }, icon('audio-lines')), '蛤說啥'),
      planBadge(),
      themeButton(),
      h('button', { class: 'btn icon ghost', 'aria-label': '設定', onclick: () => go('#/settings') }, icon('settings')),
      h('button', { class: 'btn icon ghost avatar-btn', 'aria-label': Account.account() ? '帳號' : '登入', title: Account.account() ? Account.account().name : '登入',
        onclick: () => Account.account() ? go('#/settings') : showPlans({ step: 'signin' }) }, avatar(Account.account(), 30))),
    h('main', { class: 'page' },
      cfg.plan === 'pro' && !Account.subscription() && (!cfg.sonioxKey || !cfg.anthropicKey) ? h('div', { class: 'banner' }, icon('info'),
        h('div', null, h('b', null, '進階版還差一步：'), !cfg.sonioxKey ? ' 缺 Soniox 金鑰（先用免費辨識）。' : '', !cfg.anthropicKey ? ' 缺 Anthropic 金鑰（先用免費整理）。' : '', ' ', h('a', { href: '#/settings' }, '前往設定 →'))) : null,
      h('section', { class: 'hero' },
        h('div', { class: 'hero-art', 'aria-hidden': 'true' }, sticker('notebook-pen'), sticker('mic'), sticker('sparkles')),
        h('div', { class: 'hero-top' },
          h('div', null, h('h1', null, `${greet}，準備好上課了嗎？`), h('div', { class: 'sub' }, fmtDate(Date.now())))),
        h('div', { class: 'stats' },
          h('div', { class: 'stat' }, h('b', null, String(list.length)), h('span', null, '堂課')),
          h('div', { class: 'stat' }, h('b', null, totalMs ? fmtDuration(totalMs) : '0'), h('span', null, '錄音時間')),
          h('div', { class: 'stat' }, h('b', null, String(notesN)), h('span', null, '份筆記'))),
        h('div', { class: 'hero-actions' },
          h('button', { class: 'btn primary lg', onclick: newLectureDialog }, icon('mic'), '新的一堂課'),
          list.length > 3 ? h('label', { class: 'search' }, icon('book-open'),
            h('input', { type: 'search', placeholder: '搜尋課程或標題', value: state.search, oninput: e => { state.search = e.target.value; renderList(); } })) : null)),
      listBox));
  app().replaceChildren(root);
  function renderList() {
    const q = state.search.trim().toLowerCase();
    const items = q ? list.filter(l => (l.title + ' ' + (l.course || '')).toLowerCase().includes(q)) : list;
    const groups = new Map();
    for (const l of items) { const k = l.course || '未分類'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(l); }
    let i = 0;
    listBox.replaceChildren(...(items.length ? [...groups.entries()].map(([course, its]) => h('section', { class: 'course-group' },
      h('div', { class: 'course-head', style: `--c:${courseColor(course)}` }, sticker(subjectIcon(course)), h('h2', null, course), h('span', { class: 'count' }, its.length + ' 堂')),
      h('div', { class: 'cards' }, its.map(l => h('button', { class: 'card', style: `--c:${courseColor(course)};--i:${i++}`, onclick: () => go('#/l/' + l.id) },
        icon('chevron-right', 'go'),
        h('div', { class: 'card-top' }, sticker(subjectIcon(course + ' ' + l.title)),
          h('div', { style: 'min-width:0' }, h('h3', null, l.title),
            h('div', { class: 'meta' }, icon('clock'), fmtDate(l.created), l.durationMs ? ' · ' + fmtTime(l.durationMs) : ''))),
        h('div', { class: 'chips' },
          l.notes ? h('span', { class: 'chip ok' }, icon('sparkles'), l.notes.engine === 'claude' ? 'AI 筆記' : '筆記') : h('span', { class: 'chip' }, '尚無筆記'),
          l.segments && l.segments.length ? h('span', { class: 'chip' }, icon('captions'), '逐字稿') : null,
          l.files && l.files.length ? h('span', { class: 'chip' }, icon('paperclip'), String(l.files.length)) : null,
          l.audioParts && l.audioParts.length ? h('span', { class: 'chip' }, icon('headphones'), '錄音') : null)))))) :
      [h('div', { class: 'empty' },
        h('div', { class: 'wave-art' }, h('i'), h('i'), h('i'), h('i'), h('i'), h('i'), h('i')),
        h('h3', null, q ? '找不到符合的課' : '還沒有任何一堂課'),
        h('p', null, q ? '換個關鍵字試試看。' : '按「新的一堂課」開始。上課時錄音，下課後一鍵整理成中英對照筆記。'))]));
  }
  renderList();
  afterRender();
}

function newLectureDialog() {
  DB.all().then(list => {
    const courses = [...new Set(list.map(l => l.course).filter(Boolean))];
    const d = new Date();
    let dlg;
    const create = async () => {
      const course = $('#nl-course', dlg).value.trim();
      const title = $('#nl-title', dlg).value.trim() || `新課堂 ${d.getMonth() + 1}/${d.getDate()}`;
      Store.set('lastCourse', course);
      const lec = { id: uid(), course, title, created: Date.now(), segments: [], speakers: {}, files: [], durationMs: 0 };
      await saveLecture(lec);
      dlg.closeDialog();
      go('#/l/' + lec.id);
    };
    dlg = openDialog([
      h('h3', null, '新的一堂課'),
      h('div', { class: 'form' },
        h('div', { class: 'field' }, h('label', { for: 'nl-course' }, '課程名稱'),
          h('input', { id: 'nl-course', class: 'input', list: 'nl-courses', placeholder: '例如：經濟學原理', value: Store.get('lastCourse', '') }),
          h('datalist', { id: 'nl-courses' }, courses.map(c => h('option', { value: c })))),
        h('div', { class: 'field' }, h('label', { for: 'nl-title' }, '這堂課的標題'),
          h('input', { id: 'nl-title', class: 'input', placeholder: '可以留空，整理筆記時自動命名', onkeydown: e => { if (e.key === 'Enter') create(); } }))),
      h('div', { class: 'row' },
        h('button', { class: 'btn ghost', onclick: () => dlg.closeDialog() }, '取消'),
        h('button', { class: 'btn primary', onclick: create }, icon('plus'), '建立')),
    ], { cls: 'sheet' });
  });
}

/* ---------- lecture view ---------- */
function renderLecture() {
  const top = h('header', { class: 'topbar', id: 'lecture-top' });
  const tabs = seg([
    { v: 'live', label: '逐字稿', icon: 'captions' },
    { v: 'notes', label: '筆記', icon: 'notebook-pen' },
    { v: 'files', label: '講義', icon: 'paperclip' },
    { v: 'ask', label: '助教', icon: 'message-circle-question' },
  ], state.mobileTab, v => { state.mobileTab = v; showMobilePane(); }, 'tabs even mobile-tabs');
  const left = h('section', { class: 'pane', id: 'pane-live' });
  const right = h('section', { class: 'pane', id: 'pane-right' });
  app().replaceChildren(h('div', { class: 'lecture-page' }, top, h('div', { class: 'lecture-wrap' }, tabs, h('div', { class: 'lecture' }, left, right), h('div', { id: 'player-slot' }))));
  renderLectureHead();
  showMobilePane();
  renderTranscriptPane();
  renderPlayer();
  afterRender();
}
function showMobilePane() {
  const l = $('#pane-live'), r = $('#pane-right');
  if (!l || !r) return;
  l.style.display = state.mobileTab === 'live' ? '' : 'none';
  r.style.display = state.mobileTab !== 'live' ? '' : 'none';
  renderRightPane();
  if (!matchMedia('(min-width: 900px)').matches) jellyIn(state.mobileTab === 'live' ? l : r);
}
function renderLectureHead() {
  const top = $('#lecture-top'); if (!top) return;
  const lec = state.lecture;
  top.replaceChildren(
    h('button', { class: 'btn icon ghost', 'aria-label': '返回', onclick: () => go('#/') }, icon('chevron-left')),
    h('div', { class: 'grow' },
      h('input', { class: 'title-input', value: lec.title, 'aria-label': '標題', onchange: e => { lec.title = e.target.value.trim() || lec.title; saveLecture(lec); } }),
      h('input', { class: 'title-input course-input', value: lec.course || '', placeholder: '課程名稱', 'aria-label': '課程', onchange: e => { lec.course = e.target.value.trim(); saveLecture(lec); } })),
    seg([{ v: 'zh', label: '中' }, { v: 'both', label: '中英' }, { v: 'en', label: 'EN' }], state.lang,
      v => { state.lang = v; Store.set('lang', v); rerenderTranscript(); renderNotesBody(); }),
    h('button', { class: 'btn icon ghost', 'aria-label': '更多', onclick: lectureMenu }, icon('ellipsis')));
  afterRender();
}
function renderRightPane() {
  const pane = $('#pane-right'); if (!pane) return;
  const wide = matchMedia('(min-width: 900px)').matches;
  const which = wide ? state.rightTab : (state.mobileTab === 'files' ? 'files' : state.mobileTab === 'ask' ? 'ask' : 'notes');
  const rootId = { notes: 'notes-root', files: 'files-root', ask: 'ask-root' };
  const nFiles = (state.lecture.files || []).length;
  pane.replaceChildren(...[
    wide ? h('div', { class: 'pane-head' }, seg([
      { v: 'notes', label: '筆記', icon: 'notebook-pen' },
      { v: 'files', label: '講義' + (nFiles ? ` · ${nFiles}` : ''), icon: 'paperclip' },
      { v: 'ask', label: '問助教', icon: 'message-circle-question' },
    ], which, v => { state.rightTab = v; renderRightPane(); jellyIn($('#' + rootId[v])); }, 'seg even')) : null,
    h('div', { id: rootId[which], style: 'display:flex;flex-direction:column;min-height:0;flex:1' })].filter(Boolean));
  if (which === 'notes') renderNotesPane(); else if (which === 'ask') renderAskPane(); else renderFilesPane();
  afterRender();
}

/* ---------- playback (listen again while reading) ---------- */
const parseTime = t => { if (!t) return null; const p = String(t).split(':').map(Number); if (p.some(isNaN)) return null; return (p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]) * 1000; };
const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 0.75];
const player = {
  audio: null, lec: null, part: -1, playing: false, follow: true, speed: Store.get('speed', 1), lastSeg: null, saveT: 0,
  attach(lec) {
    this.detach();
    this.lec = lec; this.part = -1;
    const a = new Audio(); a.preload = 'metadata';
    a.addEventListener('timeupdate', () => this.tick());
    a.addEventListener('play', () => { this.playing = true; this.renderBtn(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; });
    a.addEventListener('pause', () => { this.playing = false; this.renderBtn(); this.savePos(true); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; });
    a.addEventListener('ended', () => { const parts = this.parts(); if (this.part < parts.length - 1) this.seek(parts[this.part + 1].offset, true); });
    this.audio = a;
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({ title: lec.title, artist: lec.course || '蛤說啥', artwork: [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }] });
        navigator.mediaSession.setActionHandler('play', () => this.play());
        navigator.mediaSession.setActionHandler('pause', () => this.audio.pause());
        navigator.mediaSession.setActionHandler('seekbackward', () => this.skip(-15000));
        navigator.mediaSession.setActionHandler('seekforward', () => this.skip(15000));
      } catch { /* not supported */ }
    }
    const saved = Store.get('pos.' + lec.id, 0);
    this.seek(saved || 0, false);
  },
  detach() { if (this.audio) { this.savePos(true); this.audio.pause(); this.audio.src = ''; } this.audio = null; this.lec = null; this.playing = false; },
  parts() { return (this.lec && this.lec.audioParts) || []; },
  total() { const p = this.parts(); return Math.max(this.lec ? this.lec.durationMs || 0 : 0, p.length ? p[p.length - 1].offset + 1 : 0); },
  now() { const p = this.parts()[this.part]; return p && this.audio ? p.offset + this.audio.currentTime * 1000 : 0; },
  async load(i) {
    if (i === this.part) return;
    const p = this.parts()[i]; if (!p) return;
    this.part = i;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(p.blob);
    this.audio.src = this.url;
    this.audio.playbackRate = this.speed;
    await new Promise(res => { this.audio.addEventListener('loadedmetadata', res, { once: true }); this.audio.addEventListener('error', res, { once: true }); });
    // Recordings from MediaRecorder often report an unknown length; seeking to the end makes the browser work it out.
    if (this.audio.duration === Infinity || isNaN(this.audio.duration)) {
      this.audio.currentTime = 1e7;
      await new Promise(res => { const f = () => { if (this.audio.duration !== Infinity) { this.audio.removeEventListener('timeupdate', f); res(); } }; this.audio.addEventListener('timeupdate', f); setTimeout(res, 3000); });
      this.audio.currentTime = 0;
    }
  },
  async seek(ms, autoplay) {
    if (!this.audio) return;
    const parts = this.parts(); if (!parts.length) return;
    let i = 0; for (let k = 0; k < parts.length; k++) if (parts[k].offset <= ms) i = k;
    await this.load(i);
    this.audio.currentTime = Math.max(0, (ms - parts[i].offset) / 1000);
    this.tick(true);
    if (autoplay) this.play();
  },
  play() { if (!this.audio) return; this.audio.playbackRate = this.speed; this.audio.play().catch(() => toast('無法播放這段錄音', { icon: 'info' })); },
  toggle() { if (!this.audio) return; if (this.audio.paused) this.play(); else this.audio.pause(); },
  skip(d) { this.seek(Math.max(0, Math.min(this.total(), this.now() + d)), !this.audio.paused); },
  setSpeed() { const i = (SPEEDS.indexOf(this.speed) + 1) % SPEEDS.length; this.speed = SPEEDS[i]; Store.set('speed', this.speed); if (this.audio) this.audio.playbackRate = this.speed; const b = $('#pl-speed'); if (b) b.textContent = this.speed + '×'; },
  savePos(force) { if (!this.lec || !this.audio) return; const t = Date.now(); if (!force && t - this.saveT < 4000) return; this.saveT = t; Store.set('pos.' + this.lec.id, Math.round(this.now())); },
  renderBtn() { const b = $('#pl-play'); if (b) b.replaceChildren(icon(this.playing ? 'pause' : 'play')); },
  tick(force) {
    const bar = $('#player'); if (!bar || !this.lec) return;
    const now = this.now(), total = this.total() || 1;
    const r = $('#pl-range', bar);
    if (r && !r.dataset.drag) { r.value = String(Math.round(now / 1000)); r.style.setProperty('--p', (now / total * 100).toFixed(2) + '%'); }
    const tm = $('#pl-time', bar); if (tm) tm.textContent = `${fmtTime(now)} / ${fmtTime(total)}`;
    this.savePos();
    // Highlight the sentence being played.
    const segs = this.lec.segments;
    let lo = 0, hi = segs.length - 1, idx = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (segs[m].start <= now) { idx = m; lo = m + 1; } else hi = m - 1; }
    const seg = idx >= 0 ? segs[idx] : null;
    if (seg !== this.lastSeg || force) {
      this.lastSeg = seg;
      document.querySelectorAll('.tseg.playing').forEach(e => e.classList.remove('playing'));
      const cap = $('#pl-cap', bar);
      if (seg) {
        const sd = segSides(seg);
        if (cap) cap.textContent = state.lang === 'en' ? (sd.en || sd.zh) : (sd.zh || sd.en);
        const el = document.querySelector(`.tseg[data-id="${seg.id}"]`);
        if (el) {
          el.classList.add('playing');
          const pane = $('#pane-live');
          if (this.follow && !this.audio.paused && pane && pane.offsetParent) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      } else if (cap) cap.textContent = '';
    }
  },
};
function renderPlayer() {
  const slot = $('#player-slot'); if (!slot) return;
  const lec = state.lecture;
  if (!lec.audioParts || !lec.audioParts.length || state.rec) { slot.replaceChildren(); player.detach(); return; }
  if (player.lec !== lec) player.attach(lec);
  const total = player.total();
  const marks = h('div', { class: 'marks' });
  const n = lec.notes;
  if (n && total) {
    for (const sec of n.outline || []) { const t = parseTime(sec.time); if (t != null && t <= total) marks.append(h('i', { style: `left:${(t / total * 100).toFixed(2)}%`, title: sec.heading.zh || sec.heading.en })); }
    for (const e of n.exam_focus || []) { const t = parseTime(e.time); if (t != null && t <= total) marks.append(h('i', { class: 'ex', style: `left:${(t / total * 100).toFixed(2)}%`, title: '考點' })); }
  }
  const range = h('input', {
    type: 'range', class: 'range', id: 'pl-range', min: '0', max: String(Math.max(1, Math.round(total / 1000))), step: '1', value: '0', 'aria-label': '播放位置',
    oninput: e => { e.target.dataset.drag = '1'; e.target.style.setProperty('--p', (e.target.value / e.target.max * 100) + '%'); const tm = $('#pl-time'); if (tm) tm.textContent = `${fmtTime(e.target.value * 1000)} / ${fmtTime(total)}`; },
    onchange: e => { delete e.target.dataset.drag; player.seek(Number(e.target.value) * 1000, player.playing); },
  });
  const skip = (d, ic) => h('button', { class: 'skip', 'aria-label': (d < 0 ? '倒退' : '快轉') + ' 15 秒', onclick: () => player.skip(d) }, icon(ic), h('span', null, '15'));
  slot.replaceChildren(h('div', { class: 'player', id: 'player' },
    h('div', { class: 'ctrls' }, skip(-15000, 'rotate-ccw'),
      h('button', { class: 'play', id: 'pl-play', 'aria-label': '播放／暫停', onclick: () => player.toggle() }, icon(player.playing ? 'pause' : 'play')),
      skip(15000, 'rotate-cw')),
    h('div', { class: 'mid' },
      h('div', { class: 'now' }, icon('headphones'), h('span', { class: 'cap', id: 'pl-cap' }, '重聽這堂課'), h('span', { class: 'times', id: 'pl-time' }, `0:00 / ${fmtTime(total)}`)),
      h('div', { class: 'scrub' }, marks, range)),
    h('div', { class: 'right' },
      h('button', { class: 'speed', id: 'pl-speed', title: '播放速度', onclick: () => player.setSpeed() }, player.speed + '×'),
      h('button', { class: 'btn icon ghost follow' + (player.follow ? ' on' : ''), title: '逐字稿跟著播放捲動', 'aria-label': '跟隨播放', onclick: e => { player.follow = !player.follow; e.currentTarget.classList.toggle('on', player.follow); toast(player.follow ? '逐字稿會跟著播放捲動' : '已停止自動捲動', { icon: 'captions' }); } }, icon('captions')))));
  player.tick(true);
}
document.addEventListener('keydown', e => {
  if (state.view !== 'lecture' || !player.audio || e.target.closest('input, textarea, select, [contenteditable]')) return;
  if (e.code === 'Space') { e.preventDefault(); player.toggle(); }
  else if (e.key === 'ArrowLeft') player.skip(-5000);
  else if (e.key === 'ArrowRight') player.skip(5000);
});
const timeChip = (t, cls = 't') => { const ms = parseTime(t); const lec = state.lecture; const can = ms != null && lec && lec.audioParts && lec.audioParts.length && !state.rec;
  return can ? h('button', { class: cls + ' time-chip', title: '從這裡開始播放', onclick: e => { e.stopPropagation(); player.seek(ms, true); } }, icon('play'), t) : h('span', { class: cls }, t); };

/* ---------- transcript pane ---------- */
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => { renderQueued = false; updateTranscript(); }, 120);
}
function renderTranscriptPane() {
  const pane = $('#pane-live'); if (!pane) return;
  const lec = state.lecture;
  pane.replaceChildren(
    h('div', { class: 'recorder', id: 'recorder' }),
    h('div', { class: 'speakers', id: 'speakers' }),
    h('div', { class: 'pane-body', id: 'tbody' },
      h('div', { class: 'transcript', id: 'transcript' }),
      h('div', { class: 'pending', id: 'pending' })),
    h('button', { class: 'zone-fab', id: 'zone-fab', hidden: true, onclick: showCatchUp }, h('span', { class: 'zf-ico' }, icon('brain')), h('span', { class: 'zf-txt' }, '我恍神了')));
  void lec;
  renderRecorder();
  rerenderTranscript();
}
function renderRecorder(tickOnly) {
  const box = $('#recorder'); if (!box) return;
  const r = state.rec;
  const st = r ? r.status : 'idle';
  const elapsed = r ? r.elapsed() : (state.lecture.durationMs || 0);
  if (tickOnly && box.dataset.st === st) {
    const t = $('.rec-time', box); if (t) t.textContent = fmtTime(elapsed);
    const b = $('.rec-btn', box); if (b && r) b.style.setProperty('--lvl', Math.min(1, Math.sqrt(r.level) * 3.2).toFixed(3));
    drawWave();
    return;
  }
  box.dataset.st = st;
  const pro = proReady().stt;
  const engine = h('span', { class: 'engine' + (pro ? ' pro' : '') }, icon(pro ? 'sparkles' : 'gift'), pro ? '進階：Soniox' : NATIVE ? '免費：iPhone 語音辨識' : '免費：瀏覽器辨識');
  let btn;
  if (st === 'idle') btn = h('button', { class: 'rec-btn idle', 'aria-label': '開始錄音', onclick: startRecording }, icon('mic'));
  else if (st === 'recording') btn = h('button', { class: 'rec-btn live', 'aria-label': '暫停', onclick: () => r.pause() }, icon('pause'));
  else if (st === 'paused') btn = h('button', { class: 'rec-btn paused', 'aria-label': '繼續錄音', onclick: () => r.resume() }, icon('mic'));
  else btn = h('button', { class: 'rec-btn busy', disabled: true }, icon('refresh-cw'));
  const statusTxt = {
    idle: state.lecture.segments.length ? '按下紅色按鈕繼續錄音' : '按下紅色按鈕開始錄音',
    connecting: '連線中…', recording: '錄音中', paused: '已暫停', stopping: '儲存中…',
  }[st];
  box.classList.toggle('live', st === 'recording');
  const fab = $('#zone-fab');
  if (fab) {
    const on = st === 'recording' || st === 'paused';
    const was = fab.hidden;
    fab.hidden = !(on || state.lecture.segments.some(x => x.text.trim()));
    fab.classList.toggle('live', on);
    fab.querySelector('.zf-txt').textContent = on ? '我恍神了' : '剛剛講了什麼？';
    if (was && !fab.hidden) jellyIn(fab);
  }
  box.replaceChildren(...[
    btn,
    h('div', { class: 'rec-info' },
      h('div', { class: 'rec-time' }, fmtTime(elapsed)),
      h('div', { class: 'rec-status' }, st === 'recording' ? h('span', { class: 'live-dot' }) : null, statusTxt, engine),
      st === 'idle' ? h('div', { class: 'rec-hint' }, icon('battery-charging'), NATIVE ? '可錄 4 小時以上，切到別的 App 或鎖定螢幕也會繼續錄' : isIOS ? '可錄 4 小時以上。iPhone 切到別的 App 時會暫停收音，回來會自動接續' : '可錄 4 小時以上，切到別的 App 也會繼續錄；記得插電') : null,
      st !== 'idle' ? h('canvas', { class: 'wave', id: 'wave' }) : null),
    st === 'recording' || st === 'paused' ? h('div', { class: 'rec-side' },
      h('button', { class: 'btn icon', 'aria-label': '結束錄音', title: '結束錄音', onclick: () => r.stop() }, icon('square'))) : null].filter(Boolean));
  drawWave();
}
function drawWave() {
  const c = $('#wave'); const r = state.rec;
  if (!c || !r) return;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, hgt = c.clientHeight;
  if (!w) return;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(hgt * dpr); }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hgt);
  const cs = getComputedStyle(document.documentElement);
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, cs.getPropertyValue('--accent-2').trim() || '#14b8a6');
  grad.addColorStop(1, r.status === 'recording' ? (cs.getPropertyValue('--rec').trim() || '#e5484d') : (cs.getPropertyValue('--muted').trim() || '#888'));
  ctx.fillStyle = grad;
  const bw = 3, gap = 2, n = Math.floor(w / (bw + gap));
  const lv = r.levels.slice(-n);
  for (let i = 0; i < lv.length; i++) {
    const v = Math.min(1, Math.sqrt(lv[i]) * 3.2);
    const bh = Math.max(2, v * hgt);
    const x = w - (lv.length - i) * (bw + gap);
    const y = (hgt - bh) / 2;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, bw, bh, 1.5); else ctx.rect(x, y, bw, bh);
    ctx.fill();
  }
}
async function startRecording() {
  if (state.rec) return;
  player.detach();
  state.rec = new Recorder(state.lecture);
  renderPlayer();
  await state.rec.start();
  if (state.rec && state.rec.status === 'idle') state.rec = null;
  renderTranscriptPane();
  renderNotesPane();
}

function rerenderTranscript() {
  const box = $('#transcript'); if (!box) return;
  box.replaceChildren();
  const lec = state.lecture;
  if (!lec.segments.length && !state.rec) {
    box.append(h('div', { class: 'empty' },
      h('div', { class: 'wave-art' }, h('i'), h('i'), h('i'), h('i'), h('i'), h('i'), h('i')),
      h('h3', null, '教授說的話會即時出現在這裡'),
      h('p', null, '把手機或電腦放在靠近教授的位置。上課前先把講義上傳到「講義」，整理筆記會更準確。')));
  }
  let prev = null;
  for (const s of lec.segments) { box.append(segEl(s, prev)); prev = s; }
  renderSpeakers();
  updatePending();
}
function segEl(s, prev, enter) {
  const lec = state.lecture;
  const who = speakerInfo(lec, s.speaker);
  const newSpk = !prev || prev.speaker !== s.speaker;
  const sides = segSides(s);
  const hasAudio = lec.audioParts && lec.audioParts.length && !state.rec;
  const primary = s.lang === 'en' ? sides.en : sides.zh;
  const secondary = s.lang === 'en' ? sides.zh : sides.en;
  let body;
  if (state.lang === 'en') body = h('div', { class: 'tx' }, sides.en || h('span', { class: 'muted' }, sides.zh));
  else if (state.lang === 'zh') body = h('div', { class: 'tx' }, sides.zh || sides.en);
  else body = [h('div', { class: 'tx' }, primary), secondary ? h('div', { class: 'tr' }, secondary) : null];
  return h('div', {
    class: 'tseg' + (newSpk ? ' new-spk' : '') + (who.isProf || who.id === '?' ? ' prof' : ' other') + (hasAudio ? ' seekable' : '') + (enter ? ' enter' : ''),
    style: `--c:${who.color}`, 'data-id': s.id,
    onclick: hasAudio ? () => seekAudio(s.start) : null,
  },
  h('div', { class: 'av' }, newSpk ? avatarEl(who) : null),
  h('div', null, newSpk ? h('div', { class: 'who' }, who.name, h('span', { class: 't' }, fmtTime(s.start))) : null, body));
}
function seekAudio(ms) { player.seek(Math.max(0, ms - 800), true); }
function updateTranscript() {
  const box = $('#transcript'); if (!box || !state.rec) return;
  const body = $('#tbody');
  const atBottom = body && body.scrollHeight - body.scrollTop - body.clientHeight < 140;
  const lec = state.lecture;
  const dirty = state.rec.dirty;
  if (dirty.size) {
    if (box.querySelector('.empty')) box.replaceChildren();
    const idx = new Map(lec.segments.map((s, i) => [s.id, i]));
    for (const id of dirty) {
      const i = idx.get(id); if (i == null) continue;
      const s = lec.segments[i];
      const old = box.children[i];
      const isNew = !(old && old.dataset.id === id);
      const el = segEl(s, lec.segments[i - 1], isNew);
      if (!isNew) old.replaceWith(el); else box.append(el);
    }
    dirty.clear();
    if (lec.segments.length < 400 || Math.random() < .1) renderSpeakers();
  }
  updatePending();
  if (atBottom && body) body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' });
}
function updatePending() {
  const p = $('#pending'); if (!p) return;
  const nf = state.rec ? state.rec.nonFinal : { text: '', tr: '' };
  const t = nf.text ? toTW(nf.text) : '';
  p.replaceChildren();
  if (t) p.append(h('div'), h('div', { class: 'tx' }, t));
  if (t && state.lang !== 'zh' && nf.tr) p.append(h('div', { class: 'tr' }, nf.tr));
}
function renderSpeakers() {
  const box = $('#speakers'); if (!box) return;
  const lec = state.lecture;
  const ids = Object.keys(talkTimes(lec)).sort((a, b) => (speakerInfo(lec, b).isProf ? 1 : 0) - (speakerInfo(lec, a).isProf ? 1 : 0) || Number(a) - Number(b));
  const kids = ids.map(id => {
    const i = speakerInfo(lec, id);
    return h('button', { class: 'spk-chip', title: id === '?' ? '免費版無法分辨講者' : '點一下可以改名或設定為教授', onclick: () => { if (id !== '?') speakerDialog(id); } },
      avatarEl(i), i.name);
  });
  const canTranslate = proReady().notes || localTranslateSupported();
  if (ids.length && canTranslate && !state.rec && lec.segments.some(s => !s.tr)) {
    kids.push(h('button', { class: 'btn sm soft', disabled: state.translating, onclick: translateTranscript, title: '把沒有翻譯的句子補上' },
      icon('languages'), state.translating ? '翻譯中…' : '補齊翻譯'));
  }
  box.replaceChildren(...kids);
}
function speakerDialog(id) {
  const lec = state.lecture;
  const info = speakerInfo(lec, id);
  let prof = info.isProf;
  let dlg;
  dlg = openDialog([
    h('h3', null, '說話者 ', id),
    h('div', { class: 'form' },
      h('div', { class: 'field' }, h('label', { for: 'sp-name' }, '名稱'), h('input', { id: 'sp-name', class: 'input', value: info.name })),
      h('div', { class: 'row-item', style: 'padding:0;min-height:0' },
        h('div', { class: 'ri-text' }, h('b', null, '這是教授'), h('span', null, '教授說的話會成為筆記的主軸；其他人的發言整理成「課堂問答」。')),
        switchEl(prof, v => { prof = v; }, '這是教授'))),
    h('div', { class: 'row' },
      h('button', { class: 'btn ghost', onclick: () => dlg.closeDialog() }, '取消'),
      h('button', {
        class: 'btn primary', onclick: async () => {
          const name = $('#sp-name', dlg).value.trim();
          for (const v of Object.values(lec.speakers)) if (prof && v.role === 'professor') v.role = '';
          lec.speakers[id] = { name: name && name !== '教授' ? name : (prof ? '' : name), role: prof ? 'professor' : 'other' };
          await saveLecture(lec);
          dlg.closeDialog();
          rerenderTranscript();
        },
      }, '儲存')),
  ], { cls: 'sheet' });
}

/* ---------- "I zoned out" catch-up + lecture tutor ---------- */
const segText = s => (s.lang === 'en' ? s.text : toTW(s.text));
const isProfSeg = s => { const w = speakerInfo(state.lecture, s.speaker); return w.isProf || w.id === '?'; };
function lectureNowMs() {
  const lec = state.lecture, r = state.rec;
  if (r && r.status !== 'idle') return r.elapsed();
  if (player.audio && player.lec === lec && player.now() > 0) return player.now();
  const last = lec.segments[lec.segments.length - 1];
  return last ? (last.end || last.start) : 0;
}
function jumpTo(ms) {
  const lec = state.lecture;
  if (ms == null || !lec) return;
  const audio = lec.audioParts && lec.audioParts.length && !state.rec;
  if (audio) seekAudio(ms);
  const wide = matchMedia('(min-width: 900px)').matches;
  if (!wide && !audio && state.mobileTab !== 'live') {
    state.mobileTab = 'live';
    const tabs = $('.mobile-tabs'); if (tabs) selectSeg(tabs, 'live');
    showMobilePane();
  }
  let best = null;
  for (const s of lec.segments) { if (s.start <= ms + 1500) best = s; else break; }
  const el = best && $(`.tseg[data-id="${best.id}"]`);
  if (el) {
    setTimeout(() => {
      el.scrollIntoView({ block: 'center', behavior: motionOn() ? 'smooth' : 'auto' });
      el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 2200);
    }, audio ? 0 : 120);
  }
}
const jumpChip = (ms, after) => ms == null ? null : h('button', {
  class: 'time-chip t jump', title: '跳到這裡',
  onclick: e => { e.stopPropagation(); after && after(); jumpTo(ms); },
}, icon(state.lecture.audioParts && state.lecture.audioParts.length && !state.rec ? 'play' : 'captions'), fmtTime(ms));

function aiErrorText(e) {
  const st = e && e.status;
  if (st === 401 || st === 403) return '金鑰無效或沒有權限，請到「設定」檢查 Anthropic 金鑰。';
  if (st === 429) return '使用太頻繁了，請稍等一下再問。';
  if (st === 529 || st >= 500) return 'Claude 現在比較忙，請過一會兒再試。';
  if (!navigator.onLine) return '目前沒有網路連線。';
  return (e && e.message) || String(e);
}
// One tiny request, so the user knows right away whether their key works.
async function testClaude() {
  const t = toast('正在連線到 Claude…', { icon: 'sparkles', ms: 20000 });
  try {
    const client = await getClient();
    await client.messages.create({ model: 'claude-haiku-5-5', max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] });
    if (t && t.remove) t.remove();
    toast('已連上 Claude，之後的筆記、恍神補救和助教都會用它', { icon: 'check', ms: 4500 });
    return true;
  } catch (e) {
    console.error(e);
    if (t && t.remove) t.remove();
    toast('連線失敗：' + aiErrorText(e), { icon: 'info', ms: 6000 });
    return false;
  }
}
async function streamText(client, params, onText) {
  const run = async useFallback => {
    const p = useFallback ? { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : params;
    const stream = useFallback ? client.beta.messages.stream(p) : client.messages.stream(p);
    stream.on('text', (_d, snap) => onText && onText(snap));
    return stream.finalMessage();
  };
  let msg;
  try { msg = await run(true); } catch (err) {
    if (err && err.status === 400 && /fallback/i.test(err.message || '')) msg = await run(false);
    else throw err;
  }
  if (msg.stop_reason === 'refusal') throw new Error('Claude 拒絕回答這個問題');
  return msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

async function claudeCatchUp(lec, segs) {
  const client = await getClient();
  const lines = segs.map(s => `[${fmtTime(s.start)}] ${isProfSeg(s) ? '教授' : speakerInfo(lec, s.speaker).name}: ${segText(s)}`).join('\n');
  const r = await streamJSON(client, {
    model: MODEL, max_tokens: 3000, system: Tutor.CATCHUP_SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: Tutor.CATCHUP_SCHEMA } },
    messages: [{ role: 'user', content: `課程：${lec.course || '（未填）'}\n<transcript>\n${lines}\n</transcript>` }],
  });
  return {
    points: r.points.map(p => ({ text: p.text, en: p.en, ms: parseTime(p.time) })),
    terms: r.terms,
    heads_up: r.heads_up.map(x => ({ text: x.text, ms: parseTime(x.time) })),
  };
}

function showCatchUp() {
  const lec = state.lecture;
  let minutes = String(Store.get('catchMin', 5));
  const body = h('div', { class: 'cu-body' });
  const live = state.rec && state.rec.status !== 'idle';
  let token = 0, dlg;
  const close = () => dlg && dlg.closeDialog();
  const skeleton = () => h('div', { class: 'cu-skel' },
    h('div', { class: 'cu-think' }, h('span', { class: 'orb spin small' }, icon('brain')), h('span', null, proReady().notes ? 'Claude 正在幫你整理…' : '正在挑出關鍵句…')),
    h('i'), h('i'), h('i'));
  const result = (res, engine) => h('div', { class: 'cu-result' },
    res.points.length ? h('ol', { class: 'cu-points' }, res.points.map((p, j) => h('li', { style: `--j:${j}` },
      h('span', { class: 'cu-n' }, String(j + 1)),
      h('div', { class: 'cu-pt' },
        h('div', { class: 'cu-t' }, p.flag ? h('span', { class: 'cu-flag' }, icon('bell'), '提醒') : null, p.text),
        p.en && state.lang !== 'zh' && p.en !== p.text ? h('div', { class: 'cu-en' }, p.en) : null,
        jumpChip(p.ms, close))))) : h('p', { class: 'muted' }, '這段時間沒有聽到完整的句子。'),
    res.heads_up.length ? h('div', { class: 'cu-heads' }, h('span', { class: 'cu-bell' }, icon('bell')),
      h('div', null, h('b', null, '教授的提醒'), res.heads_up.map(x => h('div', { class: 'cu-hu' }, x.text, ' ', jumpChip(x.ms, close))))) : null,
    res.terms.length ? h('div', { class: 'cu-terms' }, h('div', { class: 'cu-label' }, icon('languages'), '剛剛出現的名詞'),
      h('div', { class: 'cu-chips' }, res.terms.map((t, j) => h('span', { class: 'cu-term', style: `--j:${j}` }, h('b', null, t.en), t.zh ? h('span', null, t.zh) : null)))) : null,
    h('div', { class: 'cu-foot' },
      engine === 'claude' ? h('span', { class: 'badge pro' }, icon('sparkles'), 'Claude 摘要')
        : h('button', { class: 'badge free', onclick: () => { close(); showPlans(); } }, icon('gift'), '免費版：挑出關鍵句'),
      h('button', { class: 'btn sm', onclick: () => { close(); openTutor(`最後這 ${minutes} 分鐘教授講的內容，我最需要搞懂哪裡？請解釋給我聽。`); } }, icon('message-circle-question'), '問助教')));
  const run = async () => {
    const my = ++token;
    const end = lectureNowMs();
    const segs = Tutor.windowSegments(lec.segments, end, Number(minutes));
    if (!segs.length) {
      body.replaceChildren(h('div', { class: 'cu-empty' }, h('div', { class: 'orb' }, icon('captions')), h('p', null, `最近 ${minutes} 分鐘還沒有字幕。`)));
      return;
    }
    body.replaceChildren(skeleton());
    let res = null, engine = 'free';
    if (proReady().notes && await ensureAIConsent()) {
      try { res = await claudeCatchUp(lec, segs); engine = 'claude'; } catch (e) { console.error(e); toast('Claude 暫時無法回應（' + aiErrorText(e) + '），先用裝置上的整理', { icon: 'info', ms: 5000 }); }
    }
    if (!res) {
      await wait(420);
      const f = Tutor.freeCatchUp(segs, { textOf: segText, isProf: isProfSeg });
      res = { points: f.points.map(p => ({ text: p.text, en: p.tr, ms: p.ms, flag: p.flag })), terms: f.terms, heads_up: f.heads_up };
    }
    if (my !== token) return;
    body.replaceChildren(result(res, engine));
    jellyIn(body.firstChild);
    buzz('soft');
  };
  dlg = openDialog([
    h('div', { class: 'cal-head' },
      h('span', { class: 'sticker', style: '--sz:46px;--r:-8deg;--a:#8b5cf6;--b:#ef4f6b;animation:none' }, icon('brain')),
      h('div', null, h('h3', { style: 'margin:0' }, live ? '剛剛在講什麼？' : '這段在講什麼？'),
        h('div', { class: 'muted small' }, live ? '不用倒帶，三句話幫你跟上' : player.playing ? '從目前播放的位置往前整理' : '整理這堂課最後幾分鐘的內容'))),
    h('div', { class: 'cu-range' }, seg([{ v: '2', label: '2 分鐘' }, { v: '5', label: '5 分鐘' }, { v: '10', label: '10 分鐘' }], minutes,
      v => { minutes = v; Store.set('catchMin', Number(v)); run(); }, 'seg full accent')),
    body,
  ], { cls: 'sheet catchup' });
  run();
}

/* tutor chat */
const tutorCtxCache = new WeakMap();
async function tutorContext(lec) {
  const key = lec.segments.length + '|' + (lec.files || []).length + '|' + (lec.notesAt || 0);
  const hit = tutorCtxCache.get(lec);
  if (hit && hit.key === key) return hit.blocks;
  const blocks = [];
  let bytes = 0;
  for (const f of lec.files || []) {
    if (f.kind === 'pdf' && bytes + f.size < 22 * 1024 * 1024) {
      bytes += f.size;
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: await blobToB64(f.blob) }, title: f.name });
    } else if (f.kind === 'image' && bytes + f.size < 22 * 1024 * 1024) {
      bytes += f.size;
      const mt = f.type || (f.name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg');
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mt, data: await blobToB64(f.blob) } });
    } else if (f.text) {
      blocks.push({ type: 'document', source: { type: 'text', media_type: 'text/plain', data: f.text.slice(0, 300000) }, title: f.name });
    }
  }
  const n = lec.notes;
  const notesTxt = n ? JSON.stringify({ one_line: n.one_line, outline: n.outline, key_terms: n.key_terms, exam_focus: n.exam_focus, todo: n.todo }) : '';
  blocks.push({
    type: 'text',
    text: `課程：${lec.course || '（未填）'}\n本堂標題：${lec.title}\n上課日期：${fmtDate(lec.created)}\n${lec.files && lec.files.length ? '上面附上的是教授的講義。\n' : ''}${notesTxt ? `\n已整理的筆記（JSON）：\n<notes>\n${notesTxt}\n</notes>\n` : ''}\n課堂逐字稿（時間 mm:ss）：\n<transcript>\n${lec.segments.some(s => s.text.trim()) ? transcriptForPrompt(lec) : '（沒有錄音逐字稿）'}\n</transcript>`,
    cache_control: { type: 'ephemeral' },
  });
  tutorCtxCache.set(lec, { key, blocks });
  return blocks;
}
async function claudeTutor(lec, msg, onText) {
  const client = await getClient();
  const ctx = await tutorContext(lec);
  const past = lec.chat.filter(m => m !== msg && !m.pending).slice(-12);
  const turns = [];
  for (const m of past) {
    const text = m.role === 'user' ? m.text : (m.engine === 'claude' ? m.text : '（找到了幾段相關的課堂片段）');
    if (!text) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === m.role) last.text += '\n' + text; else turns.push({ role: m.role, text });
  }
  while (turns.length && turns[0].role !== 'user') turns.shift();
  const messages = turns.map((t, i) => ({ role: t.role, content: i === 0 ? [...ctx, { type: 'text', text: t.text }] : t.text }));
  return streamText(client, {
    model: MODEL, max_tokens: 6000, system: Tutor.TUTOR_SYSTEM,
    thinking: { type: 'adaptive' }, output_config: { effort: 'medium' },
    messages,
  }, onText);
}

function richLine(line) {
  const parts = [];
  for (const piece of Tutor.splitCites(line)) {
    if (piece.time) { parts.push(jumpChip(parseTime(piece.time))); continue; }
    piece.t.split(/(\*\*[^*]+\*\*)/g).forEach(x => { if (!x) return; parts.push(/^\*\*.+\*\*$/.test(x) ? h('b', null, x.slice(2, -2)) : x); });
  }
  return parts;
}
function richText(text) {
  const out = []; let list = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/^#{1,4}\s+/, '');
    const li = line.match(/^\s*(?:[-•*]|\d+[.)、])\s+(.*)$/);
    if (li) { if (!list) { list = h('ul'); out.push(list); } list.append(h('li', null, ...richLine(li[1]))); continue; }
    list = null;
    if (line.trim()) out.push(h('p', null, ...richLine(line)));
  }
  return out;
}
function chatBubble(m) {
  if (m.role === 'user') return h('div', { class: 'msg me' }, h('div', { class: 'bubble' }, m.text));
  let content;
  if (m.pending && !m.text) content = h('div', { class: 'typing' }, h('i'), h('i'), h('i'));
  else if (m.engine === 'claude' || m.engine === 'error') content = richText(m.text);
  else if (m.empty) content = [h('p', null, '這堂課的逐字稿和筆記裡找不到相關的內容。可以換個說法試試看，或用課堂上出現的關鍵字問。')];
  else content = [h('p', null, '我在這堂課找到這些：'), ...(m.blocks || []).map(b => h('div', { class: 'ans-block' },
    h('div', { class: 'ans-title' }, b.title),
    h('ul', null, b.items.map(it => h('li', null, it.text, ' ', it.time ? jumpChip(parseTime(it.time)) : null)))))];
  return h('div', { class: 'msg bot' + (m.engine === 'error' ? ' err' : '') },
    h('span', { class: 'bot-av' }, icon('graduation-cap')),
    h('div', { class: 'bubble' }, content,
      !m.pending && m.engine === 'free' ? h('button', { class: 'upsell', onclick: () => showPlans() }, icon('sparkles'), '進階版會由 Claude 直接回答，並標出時間') : null));
}
function paintChat(scroll = true) {
  const list = $('#chat-list'); if (!list) return;
  const lec = state.lecture;
  const chat = lec.chat || [];
  if (!chat.length) {
    const ai = proReady().notes;
    list.replaceChildren(h('div', { class: 'chat-intro' },
      h('div', { class: 'ci-art' }, h('span', { class: 'ob-glow' }), h('span', { class: 'sticker', style: '--sz:64px;--r:-6deg;--a:#5b8def;--b:#8b5cf6' }, icon('graduation-cap'))),
      h('h3', null, '我是這堂課的助教'),
      h('p', { class: 'muted' }, ai ? '我讀過這堂課的逐字稿、講義和筆記，回答時會標出時間，點一下就能回去聽。' : '免費版會幫你在逐字稿和筆記裡找出相關的段落；進階版由 Claude 直接回答。'),
      h('div', { class: 'ci-sugs' }, Tutor.SUGGESTIONS.map(([ic, q], j) => h('button', { class: 'ci-sug', style: `--j:${j}`, onclick: () => askTutor(q) }, icon(ic), h('span', null, q))))));
    return;
  }
  list.replaceChildren(...chat.map(chatBubble));
  if (scroll) { const body = list.parentElement; body.scrollTop = body.scrollHeight; }
}
function updateLastBubble() {
  const list = $('#chat-list'); const chat = state.lecture.chat; if (!list || !chat) return;
  const last = list.lastElementChild; const m = chat[chat.length - 1];
  if (!last || !m) return;
  last.replaceWith(chatBubble(m));
  const body = list.parentElement;
  if (body.scrollHeight - body.scrollTop - body.clientHeight < 160) body.scrollTop = body.scrollHeight;
}
async function askTutor(q) {
  q = String(q || '').trim();
  const lec = state.lecture;
  if (!q || state.asking) return;
  if (!lec.segments.some(s => s.text.trim()) && !(lec.files || []).length && !lec.notes) { toast('先錄音或上傳講義，助教才有內容可以回答', { icon: 'info' }); return; }
  lec.chat = lec.chat || [];
  const wasEmpty = !lec.chat.length;
  lec.chat.push({ role: 'user', text: q, at: Date.now() });
  const msg = { role: 'assistant', engine: 'free', text: '', at: Date.now(), pending: true };
  lec.chat.push(msg);
  state.asking = true;
  sfx('tap');
  paintChat();
  const list = $('#chat-list');
  if (list && !wasEmpty) { const me = list.children[list.children.length - 2]; me && jellyIn(me); }
  const input = $('#chat-input'); if (input) { input.value = ''; input.style.height = ''; }
  try {
    if (proReady().notes && await ensureAIConsent()) {
      msg.engine = 'claude';
      let t = 0;
      msg.text = await claudeTutor(lec, msg, snap => { msg.text = snap; const n = Date.now(); if (n - t > 60) { t = n; updateLastBubble(); } });
    } else {
      await wait(500);
      Object.assign(msg, Tutor.freeAnswer(q, { segs: lec.segments.filter(s => s.text.trim()), textOf: segText, notes: lec.notes, fmtTime, isProf: isProfSeg, endMs: lectureNowMs() }));
    }
  } catch (e) {
    console.error(e);
    msg.engine = 'error'; msg.text = '助教暫時無法回答：' + aiErrorText(e);
  }
  delete msg.pending;
  state.asking = false;
  if (state.lecture === lec) { updateLastBubble(); const last = $('#chat-list')?.lastElementChild; if (last) { jellyIn(last); last.scrollIntoView({ block: 'nearest', behavior: motionOn() ? 'smooth' : 'auto' }); } }
  buzz('soft');
  await saveLecture(lec);
}
function renderAskPane() {
  const root = $('#ask-root'); if (!root) return;
  const lec = state.lecture;
  const input = h('textarea', {
    class: 'chat-input', id: 'chat-input', rows: '1', placeholder: '問助教這堂課的任何問題…', 'aria-label': '問題',
    oninput: e => { e.target.style.height = ''; e.target.style.height = Math.min(140, e.target.scrollHeight) + 'px'; },
    onkeydown: e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); askTutor(e.target.value); } },
  });
  root.replaceChildren(
    h('div', { class: 'chat-head' },
      h('span', { class: 'engine' + (proReady().notes ? ' pro' : '') }, icon(proReady().notes ? 'sparkles' : 'gift'), proReady().notes ? 'Claude 助教' : '免費：找出相關片段'),
      (lec.chat || []).length ? h('button', { class: 'btn sm ghost', onclick: async () => { if (state.asking) return; lec.chat = []; await saveLecture(lec); paintChat(); } }, icon('rotate-ccw'), '重新開始') : null),
    h('div', { class: 'pane-body chat-body' }, h('div', { class: 'chat-list', id: 'chat-list' })),
    h('div', { class: 'chat-bar' }, input,
      h('button', { class: 'btn icon primary chat-send', 'aria-label': '送出', onclick: () => askTutor(input.value) }, icon('arrow-up'))));
  paintChat();
  afterRender();
}
function openTutor(q) {
  if (matchMedia('(min-width: 900px)').matches) state.rightTab = 'ask';
  else { state.mobileTab = 'ask'; const tabs = $('.mobile-tabs'); if (tabs) selectSeg(tabs, 'ask'); }
  showMobilePane();
  if (q) setTimeout(() => askTutor(q), 350);
}

/* ---------- notes pane ---------- */
const NOTE_TABS = [
  { v: 'overview', label: '總覽', icon: 'book-open' },
  { v: 'outline', label: '大綱', icon: 'list-tree' },
  { v: 'mindmap', label: '心智圖', icon: 'network' },
  { v: 'tables', label: '名詞表', icon: 'table' },
  { v: 'exam', label: '考點', icon: 'target' },
  { v: 'qa', label: '問答', icon: 'message-circle-question' },
  { v: 'quiz', label: '測驗', icon: 'brain' },
];
function renderNotesPane() {
  const root = $('#notes-root'); if (!root) return;
  const lec = state.lecture;
  const n = lec.notes;
  if (state.gen) {
    const g = state.gen;
    root.replaceChildren(h('div', { class: 'pane-body' }, h('div', { class: 'gen-box' },
      h('div', { class: 'orb spin' }, icon('sparkles')),
      h('h3', null, g.engine === 'claude' ? 'Claude 正在整理筆記' : '正在自動整理筆記'),
      h('p', null, g.engine === 'claude' ? '一堂課通常需要 1–3 分鐘，請不要關閉這個頁面。' : '在你的裝置上分析，幾秒鐘就好。'),
      h('ul', { class: 'steps', id: 'gen-steps' }, g.steps.map((s, k) => h('li', { class: k < g.cur ? 'done' : k === g.cur ? 'now' : '' }, h('span', { class: 's' }, k < g.cur ? icon('check') : ''), s))),
      h('div', { class: 'muted small', id: 'gen-progress', style: 'margin-top:10px;min-height:1.4em' }, g.detail))));
    return;
  }
  if (!n) {
    const pr = proReady();
    const has = lec.segments.length || (lec.files && lec.files.length);
    const recording = state.rec && state.rec.status !== 'idle';
    root.replaceChildren(h('div', { class: 'pane-body' }, h('div', { class: 'gen-box' },
      h('div', { class: 'orb' }, icon('notebook-pen')),
      h('h3', null, '還沒有筆記'),
      h('p', null, lec.segments.length ? '錄完音後按下面的按鈕，就會結合逐字稿和講義整理出筆記。' :
        (lec.files && lec.files.length ? '只有講義也能先產生「預習筆記」，上完課再重新整理一次。' : '先錄音或上傳講義，就可以整理筆記。')),
      h('div', { style: 'display:flex;justify-content:center;gap:8px;flex-wrap:wrap;margin-bottom:16px' },
        pr.notes ? h('span', { class: 'badge pro' }, icon('sparkles'), 'Claude AI 整理') : h('button', { class: 'badge free', onclick: () => showPlans() }, icon('gift'), '免費版：在裝置上自動整理')),
      h('button', { class: 'btn primary lg', disabled: !has || recording, onclick: generateNotes }, icon('sparkles'), '整理筆記'),
      recording ? h('p', { class: 'small muted', style: 'margin:12px auto 0' }, '錄音結束後才能整理') : null,
      !pr.notes && !recording ? h('p', { class: 'small', style: 'margin:14px auto 0' }, '想要更聰明的筆記？', h('a', { href: '#', onclick: e => { e.preventDefault(); showPlans(); } }, '看看進階版')) : null)));
    return;
  }
  const tabs = seg(NOTE_TABS, state.noteTab, v => { state.noteTab = v; renderNotesBody(); jellyIn($('#notes-body')); }, 'tabs');
  root.replaceChildren(h('div', { class: 'notes-head' }, tabs), h('div', { class: 'pane-body', id: 'notes-body' }));
  renderNotesBody();
  afterRender();
}
function renderNotesBody() {
  const body = $('#notes-body'); const lec = state.lecture;
  if (!body || !lec || !lec.notes) return;
  body.replaceChildren(...[noteSection(state.noteTab, lec.notes)].flat(Infinity).filter(Boolean));
  body.scrollTop = 0;
}
function noteSection(tab, n) {
  const lec = state.lecture;
  let i = 0;
  const sec = (title, ic, ...content) => h('section', { class: 'note-sec', style: `--i:${i++}` }, h('h3', null, h('span', { class: 'ico' }, icon(ic)), title), ...content);
  switch (tab) {
    case 'overview': return [
      h('div', { class: 'engine-line' },
        n.engine === 'free' ? h('button', { class: 'badge free', onclick: () => showPlans(), title: '比較方案' }, icon('gift'), '免費版自動整理') : h('span', { class: 'badge pro' }, icon('sparkles'), 'Claude AI 筆記'),
        h('span', { class: 'muted small' }, lec.notesAt ? new Date(lec.notesAt).toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''),
        h('span', { style: 'flex:1' }),
        h('div', { class: 'note-actions' },
          h('button', { class: 'btn sm', onclick: generateNotes, disabled: state.rec && state.rec.status !== 'idle' }, icon('refresh-cw'), '重新整理'),
          h('button', { class: 'btn sm gn-btn', onclick: exportGoodNotes }, icon('notebook-pen'), 'GoodNotes'),
          h('button', { class: 'btn sm', onclick: shareSheet }, icon('share'), '分享'))),
      h('div', { class: 'lead' }, h('span', { class: 'q' }, '“'), bi(n.one_line)),
      sec('本堂課在講什麼', 'book-open', h('div', null, bi(n.overview))),
      n.learning_objectives.length ? sec('學習目標', 'target', h('ul', { class: 'plain' }, n.learning_objectives.map(o => h('li', null, bi(o))))) : null,
      sec('康乃爾筆記', 'notebook-pen', cornell(n)),
      n.todo.length ? sec('待辦／交代事項', 'list-checks', h('ul', { class: 'plain todo-list' }, n.todo.map(o => h('li', null,
        h('div', { class: 'todo-text' }, bi(o)),
        (lec.calAdded || {})[o.zh || o.en]
          ? h('button', { class: 'cal-btn done', onclick: () => calendarSheet(o) }, icon('check'), '已加入')
          : h('button', { class: 'cal-btn', onclick: () => calendarSheet(o) }, icon('calendar-plus'), '加入行事曆'))))) : null,
    ];
    case 'outline': return n.outline.length ? h('div', { class: 'timeline' }, n.outline.map((s, k) => h('div', { class: 'tl-item', style: `--i:${k}` },
      h('h4', null, s.time ? timeChip(s.time) : null, bi(s.heading)),
      h('ul', null, s.points.map(p => h('li', { class: p.emphasis ? 'em' : '' }, bi(p.text),
        p.emphasis ? h('span', { class: 'tag star' }, icon('star'), '重點') : null,
        p.source === 'slides' ? h('span', { class: 'tag slide' }, '講義') : null)))))) : emptyNote('沒有足夠的內容建立大綱。');
    case 'mindmap': return n.mind_map.branches.length ? mindMapPanel(n.mind_map) : emptyNote('沒有足夠的內容建立心智圖。');
    case 'tables': return [
      n.key_terms.length ? sec('專有名詞', 'languages', h('div', { class: 'tbl-wrap' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'English'), h('th', null, '中文'), h('th', null, state.lang === 'en' ? 'Definition' : '說明'))),
        h('tbody', null, n.key_terms.map(t => h('tr', null, h('td', null, h('b', null, t.term_en || '—')), h('td', null, t.term_zh || '—'), h('td', null, bi(t.definition)))))))) : null,
      n.tables.map(t => sec(bi(t.title, 'inline'), 'table', h('div', { class: 'tbl-wrap' }, h('table', null,
        h('thead', null, h('tr', null, t.columns.map(c => h('th', null, bi(c))))),
        h('tbody', null, t.rows.map(r => h('tr', null, r.cells.map(c => h('td', null, bi(c)))))))))),
      !n.key_terms.length && !n.tables.length ? emptyNote('這堂課沒有需要整理成表格的內容。') : null,
    ];
    case 'exam': return n.exam_focus.length ? n.exam_focus.map((e, k) => h('div', { class: 'exam', style: `--i:${k}` },
      h('span', { class: 'n' }, String(k + 1)),
      h('div', null,
        h('div', { style: 'font-weight:650' }, bi(e.point)),
        h('div', { class: 'why' }, icon('info'), h('span', null, e.time ? timeChip(e.time, 'tag slide') : '', ' ', bi(e.why, 'inline')))))) :
      emptyNote('沒有找到教授特別強調的考試重點。');
    case 'qa': return n.class_qa.length ? n.class_qa.map((q, k) => h('div', { class: 'qa', style: `--i:${k}` },
      h('div', { class: 'r' }, h('span', { class: 'k q' }, 'Q'), h('div', { class: 'q-text' }, bi(q.question))),
      h('div', { class: 'r' }, h('span', { class: 'k a' }, 'A'), h('div', null, bi(q.answer))),
      q.asked_by ? h('div', { class: 'muted small', style: 'margin-top:8px' }, '提問：' + q.asked_by) : null)) :
      emptyNote('這堂課沒有記錄到提問。');
    case 'quiz': {
      const grid = h('div', { class: 'flash' }, n.review_questions.map((q, k) => h('button', { class: 'fcard', style: `--i:${k}`, onclick: e => { e.currentTarget.classList.toggle('open'); sfx('flip'); } },
        h('div', { class: 'inner' },
          h('div', { class: 'face front' }, h('span', { class: 'lbl' }, `問題 ${k + 1}`), h('b', null, bi(q.question)), h('span', { class: 'hint' }, icon('refresh-cw'), '點一下翻面看答案')),
          h('div', { class: 'face back' }, h('span', { class: 'lbl' }, '答案'), h('div', null, bi(q.answer)))))));
      return n.review_questions.length ? [
        h('div', { class: 'quiz-bar' }, h('span', { class: 'muted small' }, `共 ${n.review_questions.length} 題，先自己回答再翻面。`),
          h('button', { class: 'btn sm', onclick: () => { const all = grid.querySelectorAll('.fcard'); const open = [...all].some(c => !c.classList.contains('open')); all.forEach((c, k) => setTimeout(() => c.classList.toggle('open', open), k * 60)); } }, icon('refresh-cw'), '全部翻面')),
        grid] : emptyNote('沒有測驗題。');
    }
    default: return null;
  }
}
function calendarSheet(o) {
  const lec = state.lecture;
  const text = o.zh || o.en || '';
  const base = new Date(lec.created);
  const p = parseDue(text, base);
  const d = p.date || new Date(base.getFullYear(), base.getMonth(), base.getDate() + 7);
  const iso = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  const cleanTitle = text.replace(/^(記得|請|大家|要|然後|那)+/, '').replace(/[。．.]$/, '').slice(0, 60);
  let alarm = p.time ? '1h' : '1d';
  let dlg;
  const build = () => {
    const title = $('#cal-title', dlg).value.trim() || cleanTitle;
    const dateV = $('#cal-date', dlg).value; const timeV = $('#cal-time', dlg).value;
    if (!dateV) { toast('請選一個日期', { icon: 'info' }); return null; }
    const [y, mo, da] = dateV.split('-').map(Number);
    let start, end, allDay = !timeV;
    if (allDay) { start = new Date(y, mo - 1, da); end = new Date(y, mo - 1, da + 1); }
    else { const [hh, mm] = timeV.split(':').map(Number); start = new Date(y, mo - 1, da, hh, mm); end = new Date(start.getTime() + 60 * 60000); }
    return { title, start, end, allDay, alarm, details: `${lec.course ? lec.course + '｜' : ''}${lec.title}\n${text}` };
  };
  const markAdded = async () => { lec.calAdded = lec.calAdded || {}; lec.calAdded[text] = true; await saveLecture(lec); const b = $('#notes-body'); const y = b ? b.scrollTop : 0; renderNotesBody(); if (b) b.scrollTop = y; };
  dlg = openDialog([
    h('div', { class: 'cal-head' }, h('span', { class: 'sticker', style: '--sz:46px;--r:-8deg' }, icon('calendar-plus')),
      h('div', null, h('h3', { style: 'margin:0' }, '加入行事曆'), h('div', { class: 'muted small' }, p.date ? '已從老師的話找出日期，可以再調整' : '沒找到明確日期，先幫你填一週後'))),
    h('div', { class: 'form', style: 'margin-top:16px' },
      h('div', { class: 'field' }, h('label', { for: 'cal-title' }, '事項'), h('input', { id: 'cal-title', class: 'input', value: cleanTitle })),
      h('div', { class: 'cal-row' },
        h('div', { class: 'field' }, h('label', { for: 'cal-date' }, '日期'), h('input', { id: 'cal-date', class: 'input', type: 'date', value: iso(d) })),
        h('div', { class: 'field' }, h('label', { for: 'cal-time' }, '時間（可空白＝整天）'), h('input', { id: 'cal-time', class: 'input', type: 'time', value: p.time ? `${String(p.time.h).padStart(2, '0')}:${String(p.time.m).padStart(2, '0')}` : '' }))),
      h('div', { class: 'field' }, h('label', null, '提醒'),
        seg([{ v: 'none', label: '不提醒' }, { v: '1d', label: '前一天' }, { v: '1h', label: '1 小時前' }], alarm, v => { alarm = v; }, 'seg full')),
      h('div', { class: 'muted small' }, '原句：', text)),
    h('div', { class: 'cal-actions' },
      h('button', {
        class: 'btn primary lg block', onclick: async () => {
          const ev = build(); if (!ev) return;
          if (NATIVE) {
            const saved = await native('calendar.add', { title: ev.title, start: ev.start.getTime(), end: ev.end.getTime(), allDay: ev.allDay, alarm: ev.alarm, notes: ev.details }).catch(() => false);
            if (saved) { await markAdded(); dlg.closeDialog(); sfx('on'); buzz('success'); toast('已加入行事曆', { icon: 'calendar-plus' }); }
            return;
          }
          const blob = new Blob([buildICS(ev)], { type: 'text/calendar;charset=utf-8' });
          const a = h('a', { href: URL.createObjectURL(blob), download: (ev.title.replace(/[\\/:*?"<>|]/g, '').slice(0, 30) || 'event') + '.ics' });
          document.body.append(a); a.click(); a.remove();
          await markAdded(); dlg.closeDialog(); sfx('on');
          toast('已產生行事曆事件，打開它就會加入行事曆', { icon: 'calendar-plus', ms: 4500 });
        },
      }, icon('calendar-plus'), NATIVE ? '加入 iPhone 行事曆' : '加入行事曆（iPhone／Mac／Android）'),
      h('button', {
        class: 'btn lg block', onclick: async () => {
          const ev = build(); if (!ev) return;
          window.open(googleCalendarUrl(ev), '_blank', 'noopener');
          await markAdded(); dlg.closeDialog();
        },
      }, icon('external-link'), '用 Google 日曆加入'),
      h('button', { class: 'btn ghost block', onclick: () => dlg.closeDialog() }, '取消')),
  ], { cls: 'sheet' });
}
const emptyNote = t => h('div', { class: 'empty', style: 'padding:30px 10px' }, h('p', null, t));
function cornell(n) {
  const rows = n.review_questions.slice(0, 8);
  return h('div', { class: 'cornell' },
    h('div', { class: 'head cue' }, '提示問題 Cues'), h('div', { class: 'head right' }, '筆記 Notes'),
    rows.map(r => [h('div', { class: 'cue' }, bi(r.question)), h('div', null, bi(r.answer))]),
    h('div', { class: 'summary' }, h('div', { class: 'head', style: 'padding:0 0 4px' }, '總結 Summary'), bi(n.summary)));
}
// Text for a mind-map node in the reading language: Chinese with English underneath, or one of them.
function mmText(o) {
  const zh = (o && o.zh) || '', en = (o && o.en) || '';
  if (state.lang === 'zh') return { main: zh || en, sub: '' };
  if (state.lang === 'en') return { main: en || zh, sub: '' };
  return { main: zh || en, sub: zh && en && en !== zh ? en : '' };
}
(() => { const st = document.createElement('style'); st.textContent = MM_NODE_CSS; document.head.append(st); })();
function mindMapPanel(m) {
  const view = mindMapView(m, mmText, { motion: motionOn(), onFold: el => { sfx('tap'); buzz('select'); jelly(el, 0.8, 520); } });
  const wrap = h('div', { class: 'mmx-wrap' });
  let all = false;
  const tb = (ic, label, fn) => h('button', { class: 'mmx-btn', 'aria-label': label, title: label, onclick: e => { e.stopPropagation(); fn(e); } }, icon(ic));
  const foldBtn = tb('chevrons-down-up', '全部收合', () => {
    all = !all; all ? view.mm.collapseAll() : view.mm.expandAll();
    foldBtn.replaceChildren(icon(all ? 'chevrons-up-down' : 'chevrons-down-up')); foldBtn.title = all ? '全部展開' : '全部收合';
  });
  const fullBtn = tb('maximize-2', '全螢幕', () => {
    const on = !wrap.classList.contains('full');
    // Full screen must sit above everything, so lift the map out of the notes pane while it is open.
    if (on) { wrap._home = document.createComment('mm'); wrap.replaceWith(wrap._home); document.body.append(wrap); }
    else if (wrap._home) { wrap._home.replaceWith(wrap); wrap._home = null; }
    wrap.classList.toggle('full', on);
    document.documentElement.classList.toggle('mmx-lock', on);
    fullBtn.replaceChildren(icon(on ? 'minimize-2' : 'maximize-2')); fullBtn.title = on ? '離開全螢幕' : '全螢幕';
    setTimeout(() => view.mm.fit(), 60);
    jellyIn(wrap);
  });
  wrap.append(view, h('div', { class: 'mmx-bar' },
    tb('minus', '縮小', () => view.mm.zoomOut()), tb('plus', '放大', () => view.mm.zoomIn()), tb('scan', '符合畫面', () => view.mm.fit()),
    h('i', { class: 'mmx-sep' }), foldBtn, fullBtn),
    h('div', { class: 'mmx-hint' }, icon('hand'), '拖曳移動・兩指縮放・點分支可收合'));
  return wrap;
}

/* ---------- share & export: GoodNotes PDF, notes + recording for classmates ---------- */
const safeName = s => String(s || '筆記').replace(/[\\/:*?"<>|\n\r]/g, '-').trim().slice(0, 60) || '筆記';
const audioExt = b => ((b.type || '').includes('mp4') || (b.type || '').includes('m4a') || (b.type || '').includes('aac') ? 'm4a' : (b.type || '').includes('ogg') ? 'ogg' : 'webm');
function notesDocHTML(lec) {
  const n = lec.notes;
  return notesDocument(lec, n, {
    lang: state.lang, mmCSS: MM_NODE_CSS, fmtDate, fmtTime,
    mindMapHTML: n.mind_map && n.mind_map.branches && n.mind_map.branches.length ? staticMindMapHTML(n.mind_map, mmText, 640, 900) : '',
  });
}
function audioFiles(lec) {
  const parts = lec.audioParts || [];
  const base = safeName(lec.title);
  return parts.map((p, i) => ({ name: parts.length > 1 ? `${base}-錄音${i + 1}.${audioExt(p.blob)}` : `${base}-錄音.${audioExt(p.blob)}`, blob: p.blob }));
}
function markdownText(lec) { return buildMarkdown(lec); }
// Web: print the formatted page; the system dialog can save it as PDF.
function printDocument(html) {
  const f = h('iframe', { style: 'position:fixed;right:0;bottom:0;width:0;height:0;border:0', 'aria-hidden': 'true' });
  document.body.append(f);
  f.srcdoc = html;
  f.onload = () => { setTimeout(() => { try { f.contentWindow.focus(); f.contentWindow.print(); } catch { /* blocked */ } }, 300); setTimeout(() => f.remove(), 60000); };
}
// Native: big files go over in pieces so the bridge never carries one huge message.
async function sendFileToApp(name, blob, onPart) {
  const CH = 1536 * 1024;
  let i = 0;
  for (let off = 0; off < blob.size || off === 0; off += CH) {
    const b64 = await blobToB64(blob.slice(off, off + CH));
    await native('export.write', { name, b64, append: i > 0 });
    i++; onPart && onPart(Math.min(1, (off + CH) / blob.size));
    if (blob.size === 0) break;
  }
  return name;
}
function busyToast(text) {
  const t = toast(text, { icon: 'refresh-cw', ms: 120000 });
  return { set: s => { const el = document.querySelector('.toast:last-child span'); if (el) el.textContent = s; }, done: () => { document.querySelectorAll('.toast').forEach(x => x.textContent.startsWith(text.slice(0, 4)) && x.remove()); void t; } };
}
async function exportGoodNotes() {
  const lec = state.lecture; if (!lec || !lec.notes) return;
  sfx('tap');
  if (!NATIVE) {
    printDocument(notesDocHTML(lec));
    toast('在列印視窗選「儲存為 PDF」，再用 GoodNotes 打開這個 PDF', { icon: 'notebook-pen', ms: 6000 });
    return;
  }
  const b = busyToast('正在排版成 PDF…');
  try {
    await native('export.clear');
    const file = await native('pdf.make', { html: notesDocHTML(lec), name: `${safeName(lec.notes.title.zh || lec.title)}.pdf` });
    b.done();
    toast('在分享選單選「Goodnotes」就會匯入成新筆記本', { icon: 'notebook-pen', ms: 5000 });
    await native('share', { files: [file] });
  } catch (e) { b.done(); toast('匯出失敗：' + (e.message || e), { icon: 'info' }); }
}
async function shareLecture({ notes = true, audio = true } = {}) {
  const lec = state.lecture; if (!lec) return;
  const aud = audio ? audioFiles(lec) : [];
  const withNotes = notes && lec.notes;
  if (!withNotes && !aud.length) { toast('這堂課還沒有筆記或錄音可以分享', { icon: 'info' }); return; }
  sfx('tap');
  if (NATIVE) {
    const b = busyToast('正在準備檔案…');
    try {
      await native('export.clear');
      const files = [];
      if (withNotes) files.push(await native('pdf.make', { html: notesDocHTML(lec), name: `${safeName(lec.notes.title.zh || lec.title)}.pdf` }));
      for (const [i, f] of aud.entries()) { b.set(`正在準備錄音 ${i + 1}/${aud.length}…`); files.push(await sendFileToApp(f.name, f.blob)); }
      b.done();
      await native('share', { files, text: lec.title });
    } catch (e) { b.done(); toast('分享失敗：' + (e.message || e), { icon: 'info' }); }
    return;
  }
  // Web: the browser's share sheet when it can take files, otherwise download them.
  const files = [];
  if (withNotes) files.push(new File([markdownText(lec)], `${safeName(lec.title)}-筆記.md`, { type: 'text/markdown' }));
  aud.forEach(f => files.push(new File([f.blob], f.name, { type: f.blob.type || 'audio/webm' })));
  try {
    if (navigator.canShare && navigator.canShare({ files })) { await navigator.share({ files, title: lec.title }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  files.forEach(f => { const a = h('a', { href: URL.createObjectURL(f), download: f.name }); document.body.append(a); a.click(); a.remove(); });
  toast(`已下載 ${files.length} 個檔案`, { icon: 'download' });
}
function shareSheet() {
  const lec = state.lecture;
  const hasNotes = !!lec.notes, hasAudio = !!(lec.audioParts && lec.audioParts.length);
  let dlg;
  const opt = (ic, a, b, title, desc, fn, enabled = true) => h('button', {
    class: 'share-opt', disabled: !enabled, style: `--a:${a};--b:${b}`,
    onclick: () => { dlg.closeDialog(); setTimeout(fn, 240); },
  }, h('span', { class: 'so-ico' }, icon(ic)), h('span', { class: 'so-text' }, h('b', null, title), h('span', null, desc)), icon('chevron-right'));
  dlg = openDialog([
    h('div', { class: 'cal-head' }, h('span', { class: 'sticker', style: '--sz:46px;--r:-8deg;--a:#a78bfa;--b:#ec4899;animation:none' }, icon('share')),
      h('div', null, h('h3', { style: 'margin:0' }, '分享與匯出'), h('div', { class: 'muted small' }, lec.title))),
    h('div', { class: 'share-list' },
      opt('notebook-pen', '#f59e0b', '#ef4444', '匯出到 GoodNotes', NATIVE ? '排版好的 A4 PDF，含心智圖和可手寫的測驗空白處' : '開啟列印，存成 PDF 後用 GoodNotes 打開', exportGoodNotes, hasNotes),
      opt('users', '#8b5cf6', '#ec4899', '分享筆記＋錄音給同學', !hasNotes ? '還沒有筆記，只會分享錄音檔' : hasAudio ? (NATIVE ? 'PDF 筆記和錄音檔，用 LINE、訊息、AirDrop 傳送' : 'Markdown 筆記和錄音檔') : '這堂課沒有保存錄音，只會分享筆記', () => shareLecture({ notes: true, audio: true }), hasNotes || hasAudio),
      opt('headphones', '#06b6d4', '#3b82f6', '只分享錄音', hasAudio ? `${(lec.audioParts || []).length} 個錄音檔` : '這堂課沒有保存錄音', () => shareLecture({ notes: false, audio: true }), hasAudio),
      opt('file-text', '#10b981', '#14b8a6', '匯出 Markdown', '筆記＋逐字稿，可貼到 Notion、Obsidian', exportMarkdown, hasNotes),
      opt('printer', '#64748b', '#94a3b8', '列印', '印出排版好的筆記', () => NATIVE ? exportGoodNotes() : printDocument(notesDocHTML(lec)), hasNotes)),
    !hasNotes ? h('p', { class: 'muted small', style: 'margin:10px 2px 0' }, '整理好筆記之後，就能匯出到 GoodNotes。') : null,
  ], { cls: 'sheet' });
}

/* ---------- export ---------- */
const mdBi = o => (o ? (o.zh && o.en && o.en !== o.zh ? `${o.zh}  \n*${o.en}*` : (o.zh || o.en)) : '');
const pair = o => (o ? [o.zh, o.en].filter(Boolean).join(' / ') : '');
function buildMarkdown(lec) {
  const n = lec.notes;
  const L = [];
  L.push(`# ${n.title.zh || n.title.en}`, n.title.zh && n.title.en ? `*${n.title.en}*` : '', '', `${lec.course || ''} · ${fmtDate(lec.created)}`, '', `> ${mdBi(n.one_line)}`, '');
  L.push('## 概要 Overview', mdBi(n.overview), '');
  if (n.learning_objectives.length) { L.push('## 學習目標 Objectives'); n.learning_objectives.forEach(o => L.push(`- ${pair(o)}`)); L.push(''); }
  L.push('## 大綱 Outline');
  for (const s of n.outline) {
    L.push(`### ${s.time ? '[' + s.time + '] ' : ''}${pair(s.heading)}`);
    s.points.forEach(p => L.push(`- ${p.emphasis ? '**⭐ ' : ''}${p.text.zh || p.text.en}${p.emphasis ? '**' : ''}${p.text.zh && p.text.en ? '  \n  *' + p.text.en + '*' : ''}`));
    L.push('');
  }
  if (n.key_terms.length) {
    L.push('## 專有名詞 Key terms', '| English | 中文 | 說明 |', '|---|---|---|');
    n.key_terms.forEach(t => L.push(`| ${t.term_en || '—'} | ${t.term_zh || '—'} | ${pair(t.definition)} |`)); L.push('');
  }
  for (const t of n.tables) {
    L.push(`## ${pair(t.title)}`, '| ' + t.columns.map(c => c.zh || c.en).join(' | ') + ' |', '|' + t.columns.map(() => '---').join('|') + '|');
    t.rows.forEach(r => L.push('| ' + r.cells.map(pair).join(' | ') + ' |')); L.push('');
  }
  L.push('## 心智圖 Mind map', `- **${pair(n.mind_map.center)}**`);
  n.mind_map.branches.forEach(b => { L.push(`  - ${pair(b.label)}`); b.children.forEach(c => { L.push(`    - ${pair(c.label)}`); c.leaves.forEach(l => L.push(`      - ${pair(l)}`)); }); });
  L.push('');
  if (n.exam_focus.length) { L.push('## 考試重點 Exam focus'); n.exam_focus.forEach(e => L.push(`- **${pair(e.point)}**  \n  ${pair(e.why)}`)); L.push(''); }
  if (n.class_qa.length) { L.push('## 課堂問答 Q&A'); n.class_qa.forEach(q => L.push(`**Q:** ${mdBi(q.question)}  \n**A:** ${mdBi(q.answer)}`, '')); }
  L.push('## 自我測驗 Review'); n.review_questions.forEach((q, k) => L.push(`${k + 1}. ${pair(q.question)}  \n   答：${pair(q.answer)}`)); L.push('');
  if (n.todo.length) { L.push('## 待辦 To-do'); n.todo.forEach(o => L.push(`- [ ] ${pair(o)}`)); L.push(''); }
  L.push('## 總結 Summary', mdBi(n.summary), '', '---', '## 逐字稿 Transcript');
  let prev = null;
  for (const s of lec.segments) {
    const sd = segSides(s);
    if (!prev || prev.speaker !== s.speaker) L.push('', `**${speakerInfo(lec, s.speaker).name}** [${fmtTime(s.start)}]`);
    L.push(`${sd.zh || sd.en}${sd.zh && sd.en ? '  \n*' + sd.en + '*' : ''}`);
    prev = s;
  }
  return L.join('\n');
}
function exportMarkdown() {
  const lec = state.lecture, n = lec.notes;
  const blob = new Blob([buildMarkdown(lec)], { type: 'text/markdown' });
  const a = h('a', { href: URL.createObjectURL(blob), download: (lec.course ? lec.course + '-' : '') + (n.title.zh || n.title.en || lec.title).replace(/[\\/:*?"<>|]/g, '') + '.md' });
  document.body.append(a); a.click(); a.remove();
  toast('已匯出 Markdown', { icon: 'download' });
}
function printNotes() {
  const n = state.lecture.notes;
  let area = $('#print-area');
  if (!area) { area = h('div', { id: 'print-area' }); document.body.append(area); }
  area.replaceChildren(
    h('h1', null, bi(n.title)), h('p', { class: 'muted' }, (state.lecture.course || '') + ' · ' + fmtDate(state.lecture.created)),
    NOTE_TABS.map(t => h('section', null, h('h2', { style: 'margin:22px 0 10px' }, t.label), noteSection(t.v, n))));
  area.querySelectorAll('.engine-line').forEach(e => e.remove());
  setTimeout(() => { if (NATIVE) native('print').catch(() => {}); else window.print(); }, 50);
}

/* ---------- files pane ---------- */
function renderFilesPane() {
  const root = $('#files-root'); if (!root) return;
  const lec = state.lecture;
  const input = h('input', { type: 'file', multiple: true, accept: ACCEPT, class: 'hidden', onchange: e => { addFiles([...e.target.files]); e.target.value = ''; } });
  const dz = h('div', {
    class: 'dropzone',
    ondragover: e => { e.preventDefault(); dz.classList.add('drag'); },
    ondragleave: () => dz.classList.remove('drag'),
    ondrop: e => { e.preventDefault(); dz.classList.remove('drag'); addFiles([...e.dataTransfer.files]); },
  }, input,
  h('div', { class: 'big-ico' }, icon('upload')),
  h('h3', { style: 'font-size:1.05rem' }, '上傳教授的投影片或講義'),
  h('p', { class: 'muted small', style: 'margin:6px auto 14px;max-width:360px' }, 'PDF、PowerPoint、Word、圖片、文字檔都可以，整理筆記時會一起讀，用來校正專有名詞和補充內容。'),
  h('button', { class: 'btn primary', onclick: () => input.click() }, icon('paperclip'), '選擇檔案'));
  const files = lec.files || [];
  root.replaceChildren(h('div', { class: 'pane-body' }, dz,
    files.map(f => {
      const st = FILE_STYLE[f.kind] || FILE_STYLE.text;
      return h('div', null,
        h('div', { class: 'file-row' },
          h('span', { class: 'fi', style: `--c:${st.c}` }, icon(st.icon)),
          h('div', { class: 'name' }, h('b', { title: f.name }, f.name), h('span', null, `${st.label} · ${(f.size / 1024 / 1024).toFixed(1)} MB${f.text ? ' · 已讀取文字' : ''}`)),
          h('button', { class: 'btn sm ghost', onclick: () => { state.openFile = state.openFile === f.id ? null : f.id; renderFilesPane(); } }, state.openFile === f.id ? '收起' : '預覽'),
          h('button', {
            class: 'btn sm icon ghost danger', 'aria-label': '移除', onclick: async () => {
              if (!confirm('移除「' + f.name + '」？')) return;
              lec.files = lec.files.filter(x => x.id !== f.id); await saveLecture(lec); renderRightPane();
            },
          }, icon('trash-2'))),
        state.openFile === f.id ? filePreview(f) : null);
    })));
}
function filePreview(f) {
  const url = URL.createObjectURL(f.blob);
  if (f.kind === 'pdf') return h('iframe', { class: 'file-preview', src: url, title: f.name });
  if (f.kind === 'image') return h('img', { class: 'file-preview img', src: url, alt: f.name });
  return h('pre', { class: 'file-preview', style: 'white-space:pre-wrap;height:auto;max-height:60vh;overflow:auto;font-size:.85rem;padding:14px;background:var(--surface)' }, (f.text || '（沒有可顯示的文字）').slice(0, 20000));
}

function lectureMenu() {
  const lec = state.lecture;
  let dlg;
  const item = (ic, label, fn, cls = '') => h('button', { class: 'btn ' + cls, onclick: () => { dlg.closeDialog(); fn(); } }, icon(ic), label);
  dlg = openDialog([
    h('h3', null, lec.title),
    h('div', { class: 'menu-list' },
      item('share', '分享與匯出（GoodNotes、錄音）', shareSheet),
      lec.notes ? item('download', '匯出 Markdown（筆記＋逐字稿）', exportMarkdown) : null,
      lec.notes ? item('printer', '列印／存成 PDF', () => NATIVE ? exportGoodNotes() : printDocument(notesDocHTML(lec))) : null,
      item('trash-2', '刪除這堂課', async () => {
        if (state.rec) { toast('請先結束錄音', { icon: 'info' }); return; }
        if (!confirm('確定刪除這堂課？錄音、逐字稿、講義和筆記都會一起刪除，無法復原。')) return;
        await DB.del(lec.id); go('#/');
      }, 'danger')),
    h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => dlg.closeDialog() }, '關閉')),
  ], { cls: 'sheet' });
}

/* ---------- settings ---------- */
const ACCENTS = [
  ['emerald', '#17946f', '#14b8a6', '翡翠'], ['indigo', '#5b5ce2', '#8b5cf6', '靛藍'], ['ocean', '#1b84d1', '#22c3d6', '海洋'],
  ['violet', '#9b51e0', '#e45dbf', '紫羅蘭'], ['rose', '#e0525f', '#fb8c4a', '珊瑚'], ['amber', '#d4820f', '#ef4f6b', '琥珀'],
];
async function renderSettings() {
  const cfg = settings();
  let usageTxt = '', usagePct = 0;
  try {
    const est = await navigator.storage.estimate();
    usageTxt = `已使用 ${(est.usage / 1024 / 1024).toFixed(1)} MB／可用約 ${(est.quota / 1024 / 1024 / 1024).toFixed(1)} GB`;
    usagePct = Math.max(1, Math.min(100, (est.usage / est.quota) * 100));
  } catch { /* unsupported */ }
  let gi = 0;
  const group = (title, ...rows) => [h('div', { class: 'group-title' }, title), h('div', { class: 'group', style: `--i:${gi++}` }, ...rows)];
  const row = (ic, color, title, desc, control) => h('div', { class: 'row-item' },
    h('span', { class: 'ri-ico', style: `--c:${color}` }, icon(ic)),
    h('div', { class: 'ri-text' }, h('b', null, title), desc ? h('span', null, desc) : null), control || null);
  const colRow = (ic, color, title, desc, control) => h('div', { class: 'row-item col' },
    h('div', { class: 'ri-head' }, h('span', { class: 'ri-ico', style: `--c:${color}` }, icon(ic)), h('div', { class: 'ri-text' }, h('b', null, title), desc ? h('span', null, desc) : null)),
    control);
  const keyRow = (ic, color, title, key, placeholder, help) => {
    const input = h('input', {
      class: 'input', type: 'password', autocomplete: 'off', spellcheck: 'false', value: cfg[key], placeholder,
      onchange: async e => {
        const v = e.target.value.trim();
        Store.set(key, v);
        if (key === 'anthropicKey' && v) { Store.set('plan', 'pro'); renderSettings(); testClaude(); return; }
        toast(v ? '金鑰已儲存' : '金鑰已移除', { icon: 'lock' }); renderSettings();
      },
    });
    const test = key === 'anthropicKey' && cfg[key] ? h('button', { class: 'btn soft', style: 'margin-top:10px;align-self:flex-start', onclick: testClaude }, icon('zap'), '測試連線') : null;
    const eye = h('button', { class: 'btn icon', 'aria-label': '顯示／隱藏', onclick: () => { input.type = input.type === 'password' ? 'text' : 'password'; } }, icon('lock'));
    return h('div', { class: 'row-item col' },
      h('div', { class: 'ri-head' }, h('span', { class: 'ri-ico', style: `--c:${color}` }, icon(ic)),
        h('div', { class: 'ri-text' }, h('b', null, title, cfg[key] ? h('span', { class: 'status-dot on' }, icon('check'), '已設定') : h('span', { class: 'status-dot off' }, '未設定')), h('span', null, help))),
      h('div', { class: 'key-field' }, input, eye), test);
  };
  const pro = cfg.plan === 'pro';
  app().replaceChildren(
    h('header', { class: 'topbar' },
      h('button', { class: 'btn icon ghost', 'aria-label': '返回', onclick: () => go('#/') }, icon('chevron-left')),
      h('div', { class: 'grow brand' }, '設定'),
      themeButton()),
    h('main', { class: 'page' }, h('div', { class: 'settings' },
      group('帳號', accountCard()),
      group('外觀',
        colRow('palette', '#9b51e0', '主題', '跟著系統，或固定淺色／深色',
          seg([{ v: 'system', label: '系統', icon: 'monitor' }, { v: 'light', label: '淺色', icon: 'sun' }, { v: 'dark', label: '深色', icon: 'moon' }],
            Store.get('theme', 'system'), (v, e) => setTheme(v, e), 'seg full accent')),
        colRow('sparkles', '#ef4f6b', '主題色', null,
          h('div', { class: 'swatches' }, ACCENTS.map(([k, a, b, label]) => h('button', {
            class: 'swatch' + (Store.get('accent', 'violet') === k ? ' on' : ''), style: `--a:${a};--b:${b}`, 'aria-label': label, title: label,
            onclick: e => { Store.set('accent', k); applyAppearance(); e.currentTarget.parentElement.querySelectorAll('.swatch').forEach(s => s.classList.toggle('on', s === e.currentTarget)); },
          }, icon('check'))))),
        row('zap', '#f5a524', '動態效果', '果凍彈跳、3D 視差、背景流動光影', switchEl(Store.get('motion', true), v => { Store.set('motion', v); applyAppearance(); }, '動態效果')),
        row('smartphone', '#14b8a6', '傾斜手機移動光影', '玻璃上的反光會跟著手機的角度移動', switchEl(Store.get('gyro', true), async v => {
          if (v && !(await askGyro())) { toast('沒有取得動作感測權限', { icon: 'info' }); Store.set('gyro', false); renderSettings(); return; }
          Store.set('gyro', v);
        }, '傾斜手機移動光影'))),
      group('音效',
        row('volume-2', '#22a3c4', '點擊音效', '按下按鈕、開關、分頁時發出輕柔的聲音', switchEl(Store.get('sound', true), v => Store.set('sound', v), '點擊音效')),
        colRow('waves', '#5b8def', '音色', '點一下可以試聽',
          seg(SOUND_STYLES.map(([v, label]) => ({ v, label })), Store.get('soundStyle', 'bubble'), v => { Store.set('soundStyle', v); setTimeout(() => sfx('on'), 60); }, 'seg full')),
        colRow('gauge', '#8b5cf6', '音量', null,
          h('input', {
            type: 'range', class: 'range', min: '0', max: '1', step: '0.05', value: String(Store.get('volume', 0.5)), style: `--p:${Store.get('volume', 0.5) * 100}%`, 'aria-label': '音量',
            oninput: e => { e.target.style.setProperty('--p', e.target.value * 100 + '%'); Store.set('volume', Number(e.target.value)); },
            onchange: () => sfx('tap'),
          }))),
      group('錄音與字幕',
        colRow('languages', '#1b84d1', '教授主要使用的語言', '免費版一次只能辨識一種語言；進階版可中英混講',
          seg([{ v: 'zh', label: '中文為主' }, { v: 'en', label: '英文為主' }], cfg.mainLang, v => Store.set('mainLang', v), 'seg full')),
        row('captions', '#17946f', '即時翻譯', pro ? '每句旁邊顯示另一種語言（Soniox）' : (localTranslateSupported() ? '使用瀏覽器內建翻譯（電腦版 Chrome）' : '這個瀏覽器沒有免費翻譯；進階版可用'),
          switchEl(cfg.translate, v => Store.set('translate', v), '即時翻譯')),
        row('headphones', '#e07a2e', '保存錄音檔', '可以點逐字稿回放那段錄音；一小時約 15 MB', switchEl(cfg.saveAudio, v => Store.set('saveAudio', v), '保存錄音檔')),
        NATIVE ? row('sparkles', '#8b5cf6', '辨識更準確', '有網路時交給 Apple 伺服器辨識，比手機上辨識準；關閉則完全在手機上處理',
          switchEl(Store.get('accurateSpeech', true), v => Store.set('accurateSpeech', v), '辨識更準確')) : null,
        NATIVE ? row('audio-lines', '#ec4899', '動態島即時字幕', '切到別的 App 或鎖定螢幕時，在動態島和鎖定畫面顯示教授說的話',
          switchEl(Store.get('liveCaptions', true), v => Store.set('liveCaptions', v), '動態島即時字幕')) : null,
        row('book-open', '#10b981', '用講義校正專有名詞', '上課前先上傳講義：課名、投影片上的英文術語和之前的名詞表，會先告訴辨識引擎，人名和術語更不容易聽錯')),
      group(Account.subscription() ? '自己的金鑰（選用）' : '進階版金鑰（開發測試用）',
        keyRow('audio-lines', '#5b5ce2', 'Soniox（即時字幕）', 'sonioxKey', '貼上 Soniox API key',
          ['到 ', h('a', { href: 'https://console.soniox.com', target: '_blank', rel: 'noopener' }, 'console.soniox.com'), ' 註冊並儲值後建立。']),
        keyRow('sparkles', '#d4820f', 'Anthropic（Claude 筆記）', 'anthropicKey', 'sk-ant-…',
          ['到 ', h('a', { href: 'https://console.anthropic.com', target: '_blank', rel: 'noopener' }, 'console.anthropic.com'), ' 儲值後建立，使用 Claude Opus 5.5。']),
        colRow('list-tree', '#1f9fb3', '筆記詳細程度', '只影響進階版的 Claude 筆記',
          seg([{ v: 'brief', label: '精簡' }, { v: 'standard', label: '標準' }, { v: 'detailed', label: '詳細' }], cfg.detail, v => Store.set('detail', v), 'seg full'))),
      group('隱私與儲存',
        row('shield-check', '#1f9d55', '資料只存在這台裝置', '錄音、逐字稿、講義、筆記和金鑰都不會上傳到這個網站，也不會同步到其他裝置。'),
        h('div', { class: 'row-item col' },
          h('div', { class: 'ri-head' }, h('span', { class: 'ri-ico', style: '--c:#6b7280' }, icon('cpu')), h('div', { class: 'ri-text' }, h('b', null, '儲存空間'), h('span', null, usageTxt || '無法讀取'))),
          h('div', { class: 'meter' }, h('i', { style: `width:${usagePct}%` })))),
      h('p', { class: 'muted small', style: 'text-align:center;margin:28px 0 0' }, '蛤說啥 Say What? · 圖示來自 Lucide'))));
  afterRender();
}

/* ================= router ================= */
function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
async function route() {
  const hash = location.hash || '#/';
  if (state.rec && state.rec.status !== 'idle' && !hash.startsWith('#/l/' + (state.lecture && state.lecture.id))) {
    if (!confirm('還在錄音，離開會結束錄音。要結束嗎？')) { history.replaceState(null, '', '#/l/' + state.lecture.id); return; }
    await state.rec.stop();
  }
  const m = hash.match(/^#\/l\/(.+)$/);
  if (m) {
    if (!state.lecture || state.lecture.id !== m[1]) {
      const lec = await DB.get(m[1]);
      if (!lec) { go('#/'); return; }
      lec.segments = lec.segments || []; lec.speakers = lec.speakers || {}; lec.files = lec.files || [];
      player.detach();
      if (!state.rec && (await recoverChunks(lec) || await recoverNativeParts(lec))) setTimeout(() => toast('已救回上次中斷的錄音', { icon: 'headphones', ms: 4000 }), 600);
      state.lecture = lec; state.mobileTab = 'live'; state.noteTab = 'overview'; state.openFile = null;
    }
    state.view = 'lecture';
  } else if (hash === '#/settings') { player.detach(); state.view = 'settings'; state.lecture = null; } else { player.detach(); state.view = 'home'; state.lecture = null; }
  const prevView = route.lastKey;
  const key = state.view + (state.lecture ? state.lecture.id : '');
  route.lastKey = key;
  // iPhone/iPad: WebKit ignores taps while a view transition runs, so animate the new page in place instead.
  if (prevView && prevView !== key && isIOS && motionOn()) {
    await render();
    window.scrollTo(0, 0);
    const page = app().firstElementChild;
    if (page && page.animate) {
      const back = state.view === 'home';
      page.animate([
        { opacity: 0, scale: '0.94 0.9', translate: back ? '0 -14px' : '0 22px' },
        { opacity: 1, scale: '1.03 0.97', translate: '0 0', offset: 0.35 },
        { scale: '0.985 1.02', offset: 0.55 }, { scale: '1.006 0.994', offset: 0.75 }, { scale: '1 1', translate: '0 0' },
      ], { duration: 560, easing: 'cubic-bezier(.3,.7,.4,1)' });
    }
    return;
  }
  if (prevView && prevView !== key && document.startViewTransition && motionOn()) {
    const root = document.documentElement;
    root.classList.add('vt-nav');
    root.dataset.navDir = state.view === 'home' ? 'back' : 'fwd';
    const vt = document.startViewTransition(async () => { await render(); window.scrollTo(0, 0); });
    vt.finished.finally(() => root.classList.remove('vt-nav'));
    try { await vt.updateCallbackDone; } catch { /* rendered anyway */ }
    return;
  }
  await render();
  window.scrollTo(0, 0);
}
async function render() {
  if (state.view === 'lecture') renderLecture();
  else if (state.view === 'settings') await renderSettings();
  else await renderHome();
}
window.addEventListener('hashchange', route);
let wasWide = matchMedia('(min-width: 900px)').matches;
window.addEventListener('resize', () => {
  const wide = matchMedia('(min-width: 900px)').matches;
  if (wide !== wasWide && state.view === 'lecture') { wasWide = wide; renderRightPane(); }
});

if (!NATIVE && 'serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => { /* offline cache unavailable */ });
try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch { /* ignore */ }
// Touch screens: drop :hover styles. iOS otherwise treats the first tap as a hover and delays the click.
function stripHover(list, owner) {
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    if (r.cssRules && !r.selectorText) { stripHover(r.cssRules, r); continue; }
    if (!r.selectorText || !r.selectorText.includes(':hover')) continue;
    const keep = r.selectorText.split(',').filter(x => !x.includes(':hover'));
    if (keep.length) r.selectorText = keep.join(','); else owner.deleteRule(i);
  }
}
if (matchMedia('(hover: none)').matches) for (const sh of document.styleSheets) { try { stripHover(sh.cssRules, sh); } catch { /* cross-origin sheet */ } }
applyAppearance();
renderJellyBlobs();
renderDoodles();
setupRefraction();
window.__lectureNotes = { state, Recorder, render, buildFreeNotes, player, renderPlayer, bloom, calendarSheet, notesDocHTML, shareSheet, speechVocab };
// Launch animation lives in index.html so it shows on the very first frame; take it away once it has played.
const splash = document.getElementById('splash');
const splashMs = splash && getComputedStyle(splash).display !== 'none' && motionOn() ? 2050 : 0;
if (splash) setTimeout(() => splash.classList.add('gone'), splashMs || 0);
if (splashMs) setTimeout(() => buzz('soft'), 380);
route().then(() => { if (!Store.get('plan', null) || !Store.get('onboarded', false)) setTimeout(() => showPlans({ first: true }), splashMs ? 1700 : 350); });
