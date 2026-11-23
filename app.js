// 蛤說啥 (Say What?) — record a lecture, live captions with speaker labels, bilingual notes.
// Two plans:
//   免費版 (free): browser speech recognition + on-device notes engine (+ Chrome's built-in translator when available)
//   進階版 (pro):  Soniox live captions with speaker labels and translation + Claude notes
// All data stays on this device (IndexedDB). API keys stay in this browser's localStorage
// and are only sent to Soniox (speech) and Anthropic (notes).

import { ICONS } from './icons.js';
import { buildFreeNotes, fillTranslations, buildQuiz } from './free-notes.js';
import { playSound, SOUND_STYLES } from './sounds.js';
import { parseDue, buildICS, googleCalendarUrl } from './calendar.js';
import * as Account from './account.js';
import * as Cloud from './cloud.js';
import * as Tutor from './tutor.js';
import { mindMapView, staticMindMapHTML, MM_NODE_CSS } from './mindmap.js';
import { notesDocument, outlineBlocks, OUTLINE_CSS } from './export-doc.js';
import { inkPad, inkImage, hasInk } from './ink.js';
import * as HiFi from './local-stt.js';
import { UPDATES, latestUpdate } from './updates.js';

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
// Theme colours, in the spirit of the iPhone palette: [key, label, light, light 2nd, dark, dark 2nd].
const ACCENTS = [
  ['violet', '紫羅蘭', '#9b51e0', '#e45dbf', '#c08cff', '#ff8ad8'],
  ['rose', '紅', '#e5484d', '#ff8a3d', '#ff6b6b', '#ffab70'],
  ['amber', '橙', '#e07b00', '#ef4f6b', '#ffa733', '#ff7a8f'],
  ['yellow', '黃', '#c99700', '#f08a00', '#ffd60a', '#ffa733'],
  ['emerald', '綠', '#1f9d55', '#14b8a6', '#3ddc84', '#2dd4bf'],
  ['mint', '薄荷', '#0aa89a', '#34c759', '#63e6e2', '#5fe08a'],
  ['teal', '青', '#1a93ad', '#3aa8f5', '#40c8e0', '#70d7ff'],
  ['ocean', '藍', '#0a7aff', '#22c3d6', '#4da3ff', '#5ee2f0'],
  ['indigo', '靛', '#5856d6', '#8b5cf6', '#8b8cff', '#b794ff'],
  ['pink', '粉紅', '#e8336d', '#ff8a3d', '#ff6b93', '#ffab70'],
  ['brown', '棕', '#9a7648', '#d4820f', '#c9a577', '#f0b45e'],
  ['graphite', '石墨', '#5f6368', '#8e8e93', '#a8adb5', '#c7c7cc'],
];
const hexToHsl = hex => {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return [0, 0, l * 100];
  const s = d / (1 - Math.abs(2 * l - 1));
  const hh = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [hh * 60, s * 100, l * 100];
};
const hsl = (hh, s, l) => `hsl(${Math.round((hh % 360 + 360) % 360)} ${Math.round(s)}% ${Math.round(l)}%)`;
// A pair of colours from one hue: readable on a light page, brighter on a dark one.
const fromHue = (hh, sat, dark) => (dark ? [hsl(hh, Math.min(95, sat + 18), 70), hsl(hh + 38, Math.min(95, sat + 18), 72)] : [hsl(hh, sat, 46), hsl(hh + 38, Math.min(90, sat + 8), 54)]);
// 自動: the colour follows the course you are in; on the home page it keeps the last course's colour.
function autoHue() {
  const lec = state.lecture;
  if (lec) { const hh = hashHue(lec.course || '未分類'); Store.set('autoHue', hh); return hh; }
  return Store.get('autoHue', 268);
}
function accentColors(dark) {
  const k = Store.get('accent', 'violet');
  if (k === 'auto') return fromHue(autoHue(), 62, dark);
  if (k === 'custom') {
    const [hh, s, l] = hexToHsl(Store.get('accentCustom', '#9b51e0'));
    if (s < 8) return dark ? [hsl(hh, 0, 72), hsl(hh, 0, 82)] : [hsl(hh, 0, Math.min(l, 42)), hsl(hh, 0, 58)];   // greys stay grey
    // Keep the chosen colour, only pulled into a range that stays readable.
    return dark ? [hsl(hh, Math.max(s, 60), Math.max(66, Math.min(l + 18, 76))), hsl(hh + 38, Math.max(s, 60), 72)]
      : [hsl(hh, s, Math.max(30, Math.min(l, 50))), hsl(hh + 38, s, 54)];
  }
  const a = ACCENTS.find(x => x[0] === k) || ACCENTS[0];
  return dark ? [a[4], a[5]] : [a[2], a[3]];
}
function applyAppearance() {
  const r = document.documentElement;
  r.dataset.theme = resolvedTheme();
  const [a1, a2] = accentColors(r.dataset.theme === 'dark');
  r.dataset.accent = Store.get('accent', 'violet');
  r.style.setProperty('--accent', a1); r.style.setProperty('--accent-2', a2);
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
  document.startViewTransition(() => applyAppearance()).finished.catch(() => {}).finally(() => root.classList.remove('vt-theme'));
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
// Whose lectures this device shows: with real sign-in, a lecture backed up to an account belongs to that account.
const myUid = () => Cloud.user() || (Account.account() || {}).uid || null;
const isMine = l => !Account.REAL_AUTH && !Cloud.user() ? true : !l.owner || l.owner === myUid();
async function myLectures() { return (await DB.all()).filter(isMine); }
async function saveLecture(lec) {
  lec.updated = Date.now();
  if (Cloud.user() && !lec.owner) lec.owner = Cloud.user();
  await DB.put(cleanForSave(lec));
  Cloud.queue(lec, { slow: !!(state.rec && state.rec.status !== 'idle' && state.lecture && state.lecture.id === lec.id) });
}

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
  plan: (Store.get('sonioxKey', '') || Store.get('anthropicKey', '')) ? 'pro' : 'free',
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
  // The lecturer is usually metres away. This copy of the microphone cuts the low rumble (air-con, desks),
  // lifts quiet speech and evens out the volume, so the built-in recogniser hears the front of the room better.
  boostedTrack() {
    if (this.boost) return this.boost;
    try {
      const c = this.ctx;
      const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 110; hp.Q.value = .7;
      const presence = c.createBiquadFilter(); presence.type = 'peaking'; presence.frequency.value = 2600; presence.Q.value = .9; presence.gain.value = 4;
      const comp = c.createDynamicsCompressor(); comp.threshold.value = -42; comp.knee.value = 24; comp.ratio.value = 5; comp.attack.value = .004; comp.release.value = .22;
      const gain = c.createGain(); gain.gain.value = 3.2;
      const limit = c.createDynamicsCompressor(); limit.threshold.value = -3; limit.knee.value = 0; limit.ratio.value = 20; limit.attack.value = .001; limit.release.value = .08;
      const out = c.createMediaStreamDestination();
      this.src.connect(hp); hp.connect(presence); presence.connect(comp); comp.connect(gain); gain.connect(limit); limit.connect(out);
      this.boostNodes = [hp, presence, comp, gain, limit, out];
      this.boost = out.stream.getAudioTracks()[0] || null;
    } catch { this.boost = null; }
    return this.boost;
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
    if (lec.course) (await myLectures()).filter(l => l.id !== lec.id && l.course === lec.course && l.notes).slice(0, 12).forEach(l => fromNotes(l.notes, 3));
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
// Small edit distance, for fixing a slightly mis-heard English term ("elasticty" → "elasticity").
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let low = i;
    for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); if (cur[j] < low) low = cur[j]; }
    if (low > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
class BrowserSTT {
  // vocab: course name, terms from the slides and earlier lectures. track(): the boosted microphone, when there is one.
  constructor({ lang, onFinal, onInterim, onError, vocab = [], track = null }) {
    Object.assign(this, { lang, onFinal, onInterim, onError, track });
    this.SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.vocab = vocab.filter(v => v && v.length >= 2).slice(0, 80);
    this.vocabLc = this.vocab.map(v => v.toLowerCase());
    this.words = this.vocab.filter(v => /^[A-Za-z][A-Za-z-]{5,}$/.test(v));   // single English terms worth correcting towards
    this.wordSet = new Set(this.words.map(w => w.toLowerCase()));
  }
  static supported() { return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }
  // The recogniser offers several guesses. Prefer the one that contains words we expect in this course.
  best(res) {
    let pick = res[0], top = -1;
    for (let i = 0; i < res.length; i++) {
      const t = res[i].transcript.toLowerCase();
      let hits = 0;
      for (const v of this.vocabLc) if (t.includes(v)) hits += v.length >= 4 ? 2 : 1;
      const score = hits * 1.5 + (res[i].confidence || 0) - i * .05;
      if (score > top) { top = score; pick = res[i]; }
    }
    return this.fix(pick.transcript);
  }
  fix(text) {
    if (!this.words.length) return text;
    return text.replace(/[A-Za-z][A-Za-z-]{4,}/g, w => {
      const lc = w.toLowerCase();
      if (this.wordSet.has(lc)) return w;
      for (const term of this.words) {
        const max = term.length >= 9 ? 2 : 1;
        if (lc[0] === term[0].toLowerCase() && editDistance(lc, term.toLowerCase(), max) <= max) return term;
      }
      return w;
    });
  }
  begin(r) {
    const t = this.track && !this.noTrack ? this.track() : null;
    this.usingTrack = !!(t && t.readyState === 'live');
    try { this.usingTrack ? r.start(t) : r.start(); }
    catch { this.usingTrack = false; try { r.start(); } catch { /* already started */ } }
  }
  start() {
    this.active = true;
    const r = new this.SR();
    r.lang = this.lang; r.continuous = true; r.interimResults = true;
    try { r.maxAlternatives = 5; } catch { /* older browsers */ }
    if (this.vocab.length && !this.noPhrases && 'phrases' in r && window.SpeechRecognitionPhrase) {
      try { r.phrases = this.vocab.slice(0, 60).map(v => new SpeechRecognitionPhrase(v, 4)); } catch { this.noPhrases = true; }
    }
    r.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) this.onFinal(this.best(res));
        else interim += res[0].transcript;
      }
      this.got = true;
      this.onInterim(interim);
    };
    r.onerror = e => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      // An extra this browser can't do: quietly switch it off and carry on.
      if (e.error === 'phrases-not-supported' && !this.noPhrases) { this.noPhrases = true; this.swap = true; return; }
      if (this.usingTrack && !this.got && (e.error === 'audio-capture' || e.error === 'network' || e.error === 'service-not-allowed')) { this.noTrack = true; this.swap = true; return; }
      this.onError(e.error);
    };
    r.onend = () => {
      if (!this.active) return;
      if (this.swap) { this.swap = false; this.start(); return; }
      this.begin(r);
    };
    this.r = r;
    this.begin(r);
  }
  pause() { this.active = false; try { this.r.stop(); } catch { /* ignore */ } }
  resume() { this.start(); }
  stop() { this.active = false; try { this.r.stop(); } catch { /* ignore */ } }
}

// The browser's own on-device AI (Gemini Nano in Chrome), when this device has it: free, private, no key.
const LocalAI = {
  opts: null,
  async status() {
    if (!('LanguageModel' in self)) return 'unavailable';
    for (const o of [{ expectedInputs: [{ type: 'text', languages: ['zh', 'en'] }], expectedOutputs: [{ type: 'text', languages: ['zh'] }] }, {}]) {
      try { const a = await LanguageModel.availability(o); if (a && a !== 'unavailable') { this.opts = o; return a; } } catch { /* try the next form */ }
    }
    return 'unavailable';
  },
  async ready() { return Store.get('localAI', true) && (await this.status()) === 'available'; },
  async download(onProgress) {
    await this.status();
    const s = await LanguageModel.create({ ...(this.opts || {}), monitor(m) { m.addEventListener('downloadprogress', e => onProgress && onProgress(e.loaded)); } });
    s.destroy();
  },
  async ask(system, prompt, onText) {
    const s = await LanguageModel.create({ ...(this.opts || {}), initialPrompts: [{ role: 'system', content: system }] });
    try {
      let out = '';
      for await (const chunk of s.promptStreaming(prompt)) { out = out && chunk.startsWith(out) ? chunk : out + chunk; onText && onText(out); }
      return out.trim();
    } finally { try { s.destroy(); } catch { /* ignore */ } }
  },
};
// The on-device model reads only a little at a time, so it gets the passages that match the question, not the whole lecture.
async function localTutor(lec, q, onText) {
  const qt = new Set(Tutor.tokens(q));
  const segs = lec.segments.filter(s => s.text.trim()).map(s => ({ s, text: segText(s), hit: Tutor.tokens(segText(s)).filter(t => qt.has(t)).length }));
  const top = segs.filter(x => x.hit).sort((a, b) => b.hit - a.hit).slice(0, 10);
  const use = (top.length ? top : segs.slice(-8)).sort((a, b) => a.s.start - b.s.start);
  let ctx = use.map(x => `[${fmtTime(x.s.start)}] ${x.text}`).join('\n').slice(0, 3200);
  const n = lec.notes;
  if (n) ctx += '\n\n筆記摘要：' + [(n.one_line || {}).zh, (n.summary || {}).zh].filter(Boolean).join(' ').slice(0, 500);
  return LocalAI.ask('你是這門課的助教。只根據提供的逐字稿片段回答，用繁體中文，簡短清楚（最多五句）。引用內容時在句尾附上原本的時間標記，例如 [12:48]。片段裡沒有的事不要編造，直接說這堂課沒有提到。',
    `逐字稿片段：\n${ctx}\n\n學生的問題：${q}`, onText);
}

/* ================= High-accuracy captions on this device (free, no key) ================= */
// The browser's built-in recogniser is made for dictation close to the microphone; across a classroom it drops most of what is said.
// This engine listens to the same microphone audio with a speech model that runs on the device.
const hifi = { ok: !NATIVE && HiFi.supported(), has: false };
HiFi.setSize(Store.get('hifiSize', null));
if (hifi.ok) HiFi.capability().then(c => { if (!c.ok) { hifi.ok = false; if (typeof renderRecorder === 'function' && state.view === 'lecture' && !state.rec) renderRecorder(); } });
const hifiOn = () => hifi.ok && hifi.has && Store.get('hifi', true);
if (hifi.ok) HiFi.downloaded().then(v => { hifi.has = v; if (v && typeof renderRecorder === 'function' && state.view === 'lecture' && !state.rec) renderRecorder(); });
// One long piece of dictation → caption rows of a readable length, with the time shared out by length.
function splitCaption(text, startMs, endMs) {
  const parts = [];
  for (const sent of text.split(/(?<=[。！？!?])\s*|(?<=[.])\s+(?=[A-Z\u4e00-\u9fff])/u)) {
    let rest = sent.trim();
    while (rest.length > 70) {
      const win = rest.slice(30, 70), m = win.search(/[，,、；; ](?!.*[，,、；; ])/u);
      const at = m >= 0 ? 30 + m + 1 : 50;
      parts.push(rest.slice(0, at).trim()); rest = rest.slice(at).trim();
    }
    if (rest) parts.push(rest);
  }
  const total = parts.reduce((a, x) => a + x.length, 0) || 1;
  let t = startMs;
  return parts.map(x => { const d = (endMs - startMs) * x.length / total; const r = { text: x, start: Math.round(t), end: Math.round(t + d) }; t += d; return r; });
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
    if (this.mode === 'free' && hifiOn()) this.mode = 'local';
    if (this.mode === 'free' && !BrowserSTT.supported()) {
      toast('這個瀏覽器沒有內建語音辨識，請改用 Chrome 或 Safari，或到設定接上 Soniox', { icon: 'info', ms: 5000 }); return;
    }
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
        onPcm: buf => { if (this.mode === 'soniox' && this.session) this.session.send(buf); else if (this.local) this.local.push(buf); },
      };
      if (this.mode === 'local') await this.startLocal(cfg);
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
      } else if (this.mode === 'local') {
        // Chrome on a computer can also show its own instant guess while the accurate text is on its way.
        if (BrowserSTT.supported() && !isIOS && /Chrome\//.test(navigator.userAgent)) {
          this.browser = new BrowserSTT({
            lang: cfg.mainLang === 'en' ? 'en-US' : 'zh-TW',
            onFinal: text => { this.pv = ((this.pv || '') + text).slice(-80); this.localNote(); },
            onInterim: text => { this.pvNow = text; this.localNote(); },
            onError: () => { /* the preview is optional */ },
          });
          this.browser.start();
        }
      } else {
        const vocab = (await speechVocab(this.lec).catch(() => null) || {}).terms || [];
        this.browser = new BrowserSTT({
          lang: cfg.mainLang === 'en' ? 'en-US' : 'zh-TW', vocab,
          track: Store.get('farField', true) ? () => this.mic && this.mic.boostedTrack() : null,
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
  async startLocal(cfg) {
    const v = (await speechVocab(this.lec).catch(() => null)) || {};
    this.localBase = this.offset0;
    this.local = new HiFi.LocalSTT({
      lang: cfg.mainLang === 'en' ? 'en' : 'zh', vocab: v.terms || [], course: this.lec.course || '',
      slides: (this.lec.files || []).map(f => f.text || '').join('\n'),
      onSegment: (text, s, e) => {
        this.pv = ''; this.pvNow = '';
        for (const c of splitCaption(text, this.localBase + s, this.localBase + e)) this.addFreeSegment(c.text, c.start, c.end);
        this.localNote();
      },
      onBacklog: sec => { this.backlog = sec; this.localNote(); },
      onError: err => console.warn('local captions', err),
    });
    // The model takes a while to start; recording begins right away and the first captions catch up.
    HiFi.load().catch(err => {
      console.warn('local captions', err);
      toast('高準確字幕這次沒能啟動。錄音照常保存，下課後可以按「重新辨識錄音」', { icon: 'info', ms: 7000 });
      this.localDead = true; this.localNote();
    });
    this.localNote();
  }
  // The line under the transcript while the accurate text is still being written.
  localNote() {
    if (!this.local) return;
    const live = ((this.pv || '') + (this.pvNow || '')).trim();
    let text = '';
    if (this.status === 'stopping') text = '';
    else if (this.localDead) text = '（高準確字幕沒有啟動，錄音照常進行）';
    else if (live) text = live + ' …';
    else if ((this.backlog || 0) > 45) text = `正在聽寫，目前落後約 ${Math.round(this.backlog)} 秒…`;
    else text = '正在聽寫，字幕大約晚半分鐘出現…';
    this.nonFinal = { text, tr: '' };
    scheduleRender();
    if (this.status === 'stopping') renderRecorder();
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
      if (this.local) this.localBase = this.offset0 - this.local.total / 16;
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
    if (this.local && !this.localDead) {
      // the recording is already safe; now write down whatever is still waiting
      renderRecorder();
      try { await this.local.finish(); } catch (err) { console.warn('local captions', err); }
      this.nonFinal = { text: '', tr: '' };
      await saveLecture(this.lec);
    }
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
  outline: arr(obj({ heading: B, time: { type: 'string' }, summary: B, points: arr(obj({ text: B, detail: B, emphasis: { type: 'boolean' }, source: { type: 'string', enum: ['lecture', 'slides', 'both'] } })) })),
  mind_map: obj({ center: B, branches: arr(obj({ label: B, children: arr(obj({ label: B, leaves: arr(B) })) })) }),
  key_terms: arr(obj({ term_en: { type: 'string' }, term_zh: { type: 'string' }, definition: B })),
  tables: arr(obj({ title: B, columns: arr(B), rows: arr(obj({ cells: arr(B) })) })),
  exam_focus: arr(obj({ point: B, why: B, time: { type: 'string' } })),
  class_qa: arr(obj({ question: B, answer: B, asked_by: { type: 'string' } })),
  review_questions: arr(obj({ question: B, answer: B })),
  quiz: arr(obj({ type: { type: 'string', enum: ['choice', 'blank'] }, question: B, options: arr(B), answer_index: { type: 'integer' }, answer: B, explanation: B })),
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
- outline 同時是「大綱」也是「筆記」，要寫到學生只看這一頁就能複習：每段的 summary 用一句話說這段在講什麼、結論是什麼；每個要點的 detail 是筆記內容——補上教授的解釋、原因、推導步驟、舉的例子或數字（1–3 句），讓要點不只是一句結論。教授沒有多做說明的要點，detail 給空字串，不要硬湊。
- emphasis = true 只用在教授明確強調的內容（例如「這很重要」「考試會考」「大家要記得」、重複講好幾次的觀念）。
- exam_focus 收錄最可能考的觀念，why 說明判斷依據（例如教授說了什麼）。
- mind_map：center 是本堂課主題，3–7 個 branches，每個 branch 2–5 個 children，leaves 是簡短關鍵詞（每個 child 0–4 個）。標籤要短（中文 12 字以內）。
- tables：只在內容真的適合比較時才做表格（例如方法比較、優缺點、分類），每個表格 2–5 欄；沒有適合的就給空陣列。
- review_questions：5–10 題康乃爾筆記式的自我測驗問題，附簡潔答案。
- quiz：8–12 題正式測驗，選擇題（type "choice"）和填充題（type "blank"）大約各半，難度是「期中考會出的題目」，不要送分題：
  · 要考理解、比較、因果、應用與推論（例如給一個新情境問結果、問兩個概念的差別、問為什麼），不要只是照抄定義或問「什麼是 X」。
  · 選擇題：options 剛好 4 個，只有一個正確；錯誤選項要像真的（學生常見的誤解、相近但不同的概念、因果顛倒），長度和語氣跟正確選項相近，不要出現「以上皆是／皆非」。answer_index 是正確選項的位置（0–3），正確答案的位置要分散。answer 填正確選項的文字。
  · 填充題：question 是一個完整的句子，把最關鍵的一個概念、名詞或數值挖空，用「＿＿＿＿」表示（中英文版本都要挖）；挖掉的必須是需要理解才填得出來的詞，不能從句子其他部分直接看出來。options 給空陣列，answer_index 填 -1，answer 是標準答案（簡短，中英文都給）。
  · explanation：一到兩句話說明為什麼是這個答案，以及最容易錯在哪裡。
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
    if (f.kind === 'pdf' && f.blob) {
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

// Fix what the speech recogniser misheard, using the course vocabulary, the handouts and the surrounding sentences.
// The original wording is kept in seg.raw, so it can be put back.
const POLISH_SCHEMA = obj({ items: arr(obj({ id: { type: 'string' }, text: { type: 'string' }, tr: { type: 'string' } })) });
async function polishTranscript() {
  const lec = state.lecture;
  if (!proReady().notes) { toast('修順逐字稿需要接上 Claude API', { icon: 'sparkles' }); showPlans(); return; }
  const todo = lec.segments.filter(s => s.text.trim() && !s.fixed);
  if (!todo.length) { toast('逐字稿已經修順過了'); return; }
  if (!(await ensureAIConsent())) return;
  state.polishing = true; renderSpeakers();
  let changed = 0;
  try {
    const client = await getClient();
    const vocab = ((await speechVocab(lec).catch(() => null)) || { terms: [] }).terms.slice(0, 150);
    const slides = (lec.files || []).map(f => f.text || '').join('\n').slice(0, 6000);
    const system = [
      '你是課堂逐字稿的校對員。逐字稿來自語音辨識，會有同音字、聽錯的專有名詞、斷句錯誤和中英夾雜時拼錯的英文術語。',
      '請逐句修正，讓它讀起來通順：',
      '1. 只修正辨識錯誤：同音或近音的錯字、聽錯的術語、明顯漏掉或多出來的字、標點。依照上下文、課程名稱、詞彙表和講義判斷講者真正說的是什麼。',
      '2. 不要改寫、不要濃縮、不要補充講者沒說的內容，保留口語和原本的語言（中文用繁體、台灣用語；英文維持英文）。',
      '3. 沒把握就保留原文，不要亂猜。',
      '4. tr 欄位放這一句的翻譯：中文句子翻成英文，英文句子翻成繁體中文。',
      '每個 id 都要回傳，順序不變。',
      lec.course || lec.title ? `課程：${[lec.course, lec.title].filter(Boolean).join('／')}` : '',
      vocab.length ? `這門課常出現的詞彙：${vocab.join('、')}` : '',
      slides ? `講義節錄：\n${slides}` : '',
    ].filter(Boolean).join('\n');
    for (let i = 0; i < todo.length; i += 50) {
      const batch = todo.slice(i, i + 50);
      toast(`修順中… ${Math.min(i + 50, todo.length)}/${todo.length}`, { icon: 'sparkles', ms: 90000 });
      const first = lec.segments.indexOf(batch[0]);
      const before = lec.segments.slice(Math.max(0, first - 6), first).map(s => (s.lang === 'en' ? s.text : toTW(s.text)));
      const res = await streamJSON(client, {
        model: MODEL, max_tokens: 32000,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: POLISH_SCHEMA } },
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: JSON.stringify({ 前文: before, 要校對的句子: batch.map(s => ({ id: String(s.id), text: s.lang === 'en' ? s.text : toTW(s.text) })) }) }],
      });
      const map = new Map(res.items.map(x => [String(x.id), x]));
      for (const s of batch) {
        const r = map.get(String(s.id));
        if (!r || !r.text || !r.text.trim()) continue;
        // A "correction" that throws away or doubles the sentence is not a correction.
        const ratio = r.text.length / Math.max(1, s.text.length);
        if (ratio < 0.5 || ratio > 2) { s.fixed = true; continue; }
        if (r.text.trim() !== (s.lang === 'en' ? s.text : toTW(s.text)).trim()) { if (s.raw == null) s.raw = s.text; s.text = r.text.trim(); changed++; }
        if (r.tr && r.tr.trim()) s.tr = r.tr.trim();
        s.fixed = true;
      }
      await saveLecture(lec); rerenderTranscript();
    }
    toast(changed ? `修順完成，修正了 ${changed} 句` : '修順完成，沒有需要修正的地方', { icon: 'sparkles', ms: 5000 });
  } catch (err) {
    toast('修順失敗：' + (err.message || err), { icon: 'info', ms: 6000 });
  } finally { state.polishing = false; renderSpeakers(); }
}
async function unpolishTranscript() {
  const lec = state.lecture;
  if (!(await confirmSheet({ icon: 'undo-2', color: '#6b7280', title: '還原成原本辨識的文字？', text: 'AI 修正過的句子會變回語音辨識當時的原文。', ok: '還原' }))) return;
  for (const s of lec.segments) { if (s.raw != null) { s.text = s.raw; delete s.raw; } delete s.fixed; }
  await saveLecture(lec); rerenderTranscript(); renderSpeakers();
  toast('已還原', { icon: 'undo-2' });
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
    } else throw new Error('這個裝置沒有免費翻譯可用，請改用電腦版 Chrome，或到設定接上 API');
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
  return h('button', { class: 'badge ' + (pro ? 'pro' : 'free'), onclick: () => showPlans(), title: pro ? '已連上 AI' : '怎麼讓它更聰明？' },
    icon('sparkles'), pro ? 'AI 加強中' : '讓它更聰明');
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
        h('div', null, h('h3', { style: 'margin:0' }, '接上 API 會用到外部 AI 服務'), h('div', { class: 'muted small' }, '開始之前，請先確認你同意以下資料傳送'))),
      h('div', { style: 'margin-top:12px' },
        item('audio-lines', '#5b5ce2', 'Soniox（語音辨識）', '錄音會即時傳給 Soniox，轉成逐字稿和翻譯。'),
        item('sparkles', '#d4820f', 'Anthropic（Claude）', '整理筆記或補翻譯時，會把逐字稿和你上傳的講義傳給 Claude。'),
        item('lock', '#1f9d55', '其他資料留在你的裝置', '課堂和筆記都存在這台裝置，只有處理當下需要的內容會傳出去；這兩家公司依各自的隱私政策處理收到的資料。')),
      h('p', { class: 'muted small', style: 'margin:10px 0 0' }, '不同意的話，可以繼續用裝置上的功能：' + (NATIVE ? '語音辨識在 iPhone 上進行，' : '') + '筆記在裝置上自動整理，不會傳給 AI 公司。'),
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
function avatar(a, size = 36) {
  return h('span', { class: 'avatar ' + (a ? a.provider : 'guest'), style: `--sz:${size}px` },
    a && a.photo ? h('img', { class: 'av-photo', src: a.photo, alt: '', referrerpolicy: 'no-referrer', onerror: e => e.target.remove() }) : null,
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
        toast(`已登入：${a.name}` + (Account.REAL_AUTH ? '' : '（預覽模擬）'), { icon: 'check' });
        onDone && onDone(a);
      } catch (e) { toast(e.message || '登入失敗', { icon: 'info' }); }
      finally { b.classList.remove('busy'); b.disabled = false; }
    } }, h('span', { class: 'sso-ico' }, brandIcon(provider)), h('span', null, label), h('span', { class: 'sso-spin' }));
    return b;
  };
  return h('div', { class: 'sso-stack' + (compact ? ' compact' : '') },
    Account.REAL_AUTH ? null : btn('apple', '用 Apple 登入'), // Apple sign-in needs a paid Apple developer account; not set up on the Firebase project
    btn('google', '用 Google 登入'));
}


// "How do I make it smarter?" — there are no plans to buy: pasting your own API key is what upgrades it.
// Plain advice on getting better captions and on what happens when you leave the page while recording.
function showTips() {
  const cfg = settings();
  let dlg;
  const li = (ic, title, text, tag) => h('li', null, h('span', { class: 'fa-ico' }, icon(ic)), h('div', null, h('b', null, title, tag || null), h('span', null, text)));
  const away = (ic, title, text, cls, verdict) => h('li', null, h('span', { class: 'aw-ico' }, icon(ic)), h('div', null, h('b', null, title), h('span', { class: 'aw-text' }, text)), h('span', { class: 'aw-verdict ' + cls }, verdict));
  const need = (k, name) => (cfg[k] ? h('span', { class: 'status-dot on' }, icon('check'), '已接上') : h('span', { class: 'status-dot key' }, icon('zap'), `需要 ${name} 金鑰`));
  dlg = openDialog([
    h('button', { class: 'btn icon ghost plans-close', 'aria-label': '關閉', onclick: () => dlg.closeDialog() }, icon('x')),
    h('div', { class: 'cal-head' }, h('span', { class: 'sticker', style: '--sz:46px;--r:-8deg;--a:#f59e0b;--b:#ef4444;animation:none' }, icon('lightbulb')),
      h('div', null, h('h3', { style: 'margin:0' }, '讓字幕更準的方法'), h('div', { class: 'muted small' }, '內建辨識遇到離得遠、中英夾雜、專有名詞多的課，本來就容易聽錯。'))),
    h('div', { class: 'fa-box free' },
      h('div', { class: 'fa-title' }, icon('gift'), '上課前，不用花錢'),
      h('ul', { class: 'fa-list' },
        !NATIVE && hifi.ok ? li('cpu', '開啟「高準確字幕」', hifiOn() ? '已經開啟：教授離得遠、有風扇聲、講得快或含糊也聽得出來，字幕大約晚半分鐘出現。' : '差別最大的一步。瀏覽器內建辨識隔著教室會漏掉大部分內容；到設定的「錄音與字幕」下載辨識模型（一次，約 ' + HiFi.SIZE_MB[HiFi.pickSize()] + ' MB），之後就在這台裝置上聽寫，不用金鑰。',
          hifiOn() ? h('span', { class: 'status-dot on' }, icon('check'), '已開啟') : h('button', { class: 'btn sm primary', style: 'margin-left:8px', onclick: () => { dlg.closeDialog(); go('#/settings'); setTimeout(() => document.querySelector('.hifi-ctl')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 400); } }, '去下載')) : null,
        li('book-open', '填課程名稱、先上傳講義', '講義裡的術語會交給辨識器當提示，專有名詞比較不會聽錯'),
        li('mic', '靠近講者、麥克風朝前', '「加強收音」保持開啟（在設定的「錄音與字幕」）；坐前面一點差很多'),
        li('monitor', '用 Chrome 或 Edge', '內建辨識在這兩個瀏覽器比 Safari 準'),
        li('languages', '選對主要語言', '內建辨識一次只聽一種語言，在設定選「中文為主」或「英文為主」'))),
    h('div', { class: 'fa-box api' },
      h('div', { class: 'fa-title' }, icon('zap'), '接上金鑰才有'),
      h('ul', { class: 'fa-list' },
        li('sparkles', '下課後「修順逐字稿」', '錄完後按逐字稿上方的按鈕，AI 會依課名、講義和前後文修正聽錯的字和術語，並補上翻譯。只修錯字不改寫，按「還原」可以變回原文。修順後再整理筆記會更準', need('anthropicKey', 'Claude')),
        li('captions', '上課當下就準', '專門處理中英夾雜的辨識，還能分辨教授和同學。這是差別最大的一步', need('sonioxKey', 'Soniox')))),
    h('div', { class: 'fa-box' },
      h('div', { class: 'fa-title' }, icon('smartphone'), '錄音時可以切到別的地方嗎？'),
      h('ul', { class: 'away-list' },
        away('monitor', '電腦', '切到別的分頁或視窗都會繼續錄。不要關掉這個分頁，也不要讓電腦睡眠', 'yes', '會繼續錄'),
        away('notebook-pen', 'iPad 分割畫面', '把瀏覽器和 GoodNotes 並排（分割顯示或側拉），兩邊都在畫面上就會繼續錄', 'maybe', '先試錄一次'),
        away('smartphone', 'iPhone／iPad 切到別的 App', '離開的那段不會錄到；回來後會自動接續', 'no', '會暫停'),
        away('lock', '鎖定螢幕', '手機和平板鎖螢幕後網頁會被暫停。錄音時 App 會讓螢幕保持亮著', 'no', '會暫停')),
      h('p', { class: 'away-note' }, '這是手機和平板對網頁的限制，不是設定可以改的。錄音時讓這個畫面留在前面、接上電源最保險。')),
    h('div', { class: 'cal-actions' },
      !(cfg.anthropicKey && cfg.sonioxKey) ? h('button', { class: 'btn primary lg block', onclick: () => { dlg.closeDialog(); go('#/settings'); setTimeout(() => document.querySelector('.key-field')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 500); } }, icon('zap'), '去貼上金鑰') : null,
      h('button', { class: 'btn ghost block', onclick: () => dlg.closeDialog() }, '知道了')),
  ], { cls: 'sheet smart-sheet' });
  return dlg;
}
function showPlans() {
  const cfg = settings();
  let dlg;
  const li = (ic, title, text, tag) => h('li', null, h('span', { class: 'fa-ico' }, icon(ic)), h('div', null, h('b', null, title, tag || null), h('span', null, text)));
  const on = k => (cfg[k] ? h('span', { class: 'status-dot on' }, icon('check'), '已接上') : null);
  const localTag = h('span', { class: 'status-dot off' }, '檢查中…');
  LocalAI.status().then(st => { localTag.className = 'status-dot ' + (st === 'available' ? 'on' : 'off'); localTag.textContent = st === 'available' ? '裝置 AI 可用' : st === 'unavailable' ? '這個瀏覽器沒有裝置 AI' : '裝置 AI 下載後可用'; });
  dlg = openDialog([
    h('button', { class: 'btn icon ghost plans-close', 'aria-label': '關閉', onclick: () => dlg.closeDialog() }, icon('x')),
    h('div', { class: 'cal-head' }, h('span', { class: 'sticker', style: '--sz:46px;--r:-8deg;animation:none' }, icon('sparkles')),
      h('div', null, h('h3', { style: 'margin:0' }, '哪些免費，哪些要接 API'), h('div', { class: 'muted small' }, '沒有訂閱。能在裝置上做的都免費，只有真的做不到的才交給 API。'))),
    h('div', { class: 'fa-box free' },
      h('div', { class: 'fa-title' }, icon('gift'), '免費，打開就能用'),
      h('ul', { class: 'fa-list' },
        li('mic', '錄音與重聽', '長時間錄音、點逐字稿跳回那一段、錄到一半當掉也救得回來'),
        li('captions', '即時字幕', '瀏覽器內建辨識，加上收音加強和講義詞彙校正；一次一種主要語言'),
        li('languages', '中英翻譯', '用瀏覽器內建翻譯（電腦版 Chrome）'),
        li('list-tree', '筆記、心智圖、名詞表', '從逐字稿挑出重點句、考點和名詞自動整理'),
        li('brain', '選擇題＋填充題測驗', '用名詞定義和教授強調的句子出題'),
        li('sparkles', '「我恍神了」', '挑出最近幾分鐘的關鍵句和教授的提醒'),
        li('message-circle', '助教問答', '裝置上的 AI 直接回答；沒有的話幫你找出相關片段', localTag),
        li('share', '匯出與分享', 'GoodNotes／PDF、Markdown、行事曆、分享錄音'))),
    h('div', { class: 'fa-box api' },
      h('div', { class: 'fa-title' }, icon('zap'), '接上 API 才做得到'),
      h('ul', { class: 'fa-list' },
        li('users', '分辨教授和同學', '需要 Soniox：知道每一句是誰說的', on('sonioxKey')),
        li('captions', '中英混講也聽得懂', '需要 Soniox：同一句裡中英文夾雜、口音和專有名詞更準', on('sonioxKey')),
        li('languages', '每句同步翻譯（所有瀏覽器）', '需要 Soniox：手機和 Safari 也有逐句翻譯', on('sonioxKey')),
        li('list-tree', '真正讀懂整堂課的筆記', '需要 Claude：重新組織內容、補上因果和比較表格，不是只挑句子', on('anthropicKey')),
        li('sparkles', '修順逐字稿', '需要 Claude：下課後修正聽錯的字和術語，並補上翻譯；修順後整理的筆記也更準', on('anthropicKey')),
        li('brain', '期中考等級的測驗', '需要 Claude：考應用和推論，錯誤選項像真的誤解', on('anthropicKey')),
        li('message-circle', '讀過整堂課和講義的助教', '需要 Claude：能跨段落整理、解釋沒聽懂的觀念', on('anthropicKey')))),
    h('p', { class: 'muted small', style: 'margin:12px 0 0' }, icon('lock'), ' 金鑰只存在這台裝置。API 的費用由 Anthropic／Soniox 依用量直接向你收取。'),
    h('div', { class: 'cal-actions' },
      h('button', { class: 'btn primary lg block', onclick: () => { dlg.closeDialog(); go('#/settings'); setTimeout(() => document.querySelector('.key-field')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 500); } }, icon('zap'), cfg.anthropicKey && cfg.sonioxKey ? '管理金鑰' : '去貼上金鑰'),
      h('button', { class: 'btn ghost block', onclick: () => dlg.closeDialog() }, '先用免費的就好')),
  ], { cls: 'sheet smart-sheet' });
  return dlg;
}

/* ================= first-open tour: scroll down and each feature plays like a short film ================= */
function showIntro({ fresh = false } = {}) {
  if (document.getElementById('intro')) return;
  const typed = (cls, text) => h('span', { class: 'ty ' + cls, style: `--n:${[...text].length}` }, text);
  const scene = {
    hero: () => h('div', { class: 'in-demo in-hero' },
      h('span', { class: 'in-orb' }, icon('audio-lines')),
      sticker('mic', '--sz:54px;--r:12deg;--a:#f5a524;--b:#ef4f6b;--dl:-1.2s'),
      sticker('languages', '--sz:48px;--r:-14deg;--a:#5b8def;--b:#8b5cf6;--dl:-2.4s'),
      sticker('notebook-pen', '--sz:50px;--r:8deg;--a:#14b8a6;--b:#22a3c4;--dl:-3.6s')),
    captions: () => h('div', { class: 'in-demo in-card' },
      h('div', { class: 'in-bar' }, h('i', { class: 'in-rec' }), h('b', null, '錄音中'), h('span', { class: 'in-wave' }, Array.from({ length: 14 }, (_, i) => h('i', { style: `--i:${i}` }))), h('span', { class: 'in-time' }, '12:48')),
      h('div', { class: 'in-cap', style: '--d:.3s' }, h('em', { class: 'prof' }, '教授'), typed('zh', '今天要講的是供給與需求的均衡'), h('small', null, 'Today we cover supply and demand equilibrium')),
      h('div', { class: 'in-cap', style: '--d:1.9s' }, h('em', { class: 'prof' }, '教授'), typed('zh', '價格上升時，需求量會下降'), h('small', null, 'When price rises, quantity demanded falls')),
      h('div', { class: 'in-cap', style: '--d:3.5s' }, h('em', null, '同學'), typed('zh', '老師，這個期中會考嗎？'), h('small', null, 'Will this be on the midterm?'))),
    zoned: () => h('div', { class: 'in-demo in-card' },
      h('div', { class: 'in-zone-btn' }, icon('sparkles'), '我恍神了'),
      h('div', { class: 'in-pop' },
        h('b', null, '最近 5 分鐘的重點'),
        [['均衡價格是供給線和需求線的交點', '.9s'], ['教授提醒：圖一定要會畫', '1.5s'], ['新名詞：price elasticity 價格彈性', '2.1s']].map(([t, d]) => h('p', { style: `--d:${d}` }, h('i'), t)))),
    notes: () => {
      // A small working copy of the notes screen: the tabs switch, the mind map answers taps, the quiz can be answered.
      const NODE = {
        '供需均衡': '供給線和需求線的交點，市場在這個價格和數量停下來。',
        '需求': '價格越高，想買的量越少——需求線往右下斜。',
        '供給': '價格越高，願意賣的量越多——供給線往右上斜。',
        '彈性': '價格變 1%，數量跟著變幾 %。大於 1 就是「有彈性」。',
        '考點': '教授說：均衡的圖一定要會畫，彈性的計算必考。',
      };
      const tip = h('p', { class: 'in-tip' }, icon('sparkles'), h('span', null, '點一下任何一個圓圈看看'));
      const svg = (() => { const t = document.createElement('template'); t.innerHTML = `<svg viewBox="0 0 320 170" class="in-mm" role="group" aria-label="心智圖範例">
        <path d="M160 85 C120 85 110 40 74 40" /><path d="M160 85 C120 85 110 130 74 130" /><path d="M160 85 C200 85 210 40 246 40" /><path d="M160 85 C200 85 210 130 246 130" />
        <g class="c" tabindex="0" role="button" data-k="供需均衡"><rect x="112" y="67" width="96" height="36" rx="18"/><text x="160" y="90">供需均衡</text></g>
        <g class="n" tabindex="0" role="button" data-k="需求" style="--d:.9s;--c:#f5a524"><rect x="14" y="24" width="64" height="32" rx="16"/><text x="46" y="45">需求</text></g>
        <g class="n" tabindex="0" role="button" data-k="供給" style="--d:1.2s;--c:#14b8a6"><rect x="14" y="114" width="64" height="32" rx="16"/><text x="46" y="135">供給</text></g>
        <g class="n" tabindex="0" role="button" data-k="彈性" style="--d:1.5s;--c:#5b8def"><rect x="242" y="24" width="64" height="32" rx="16"/><text x="274" y="45">彈性</text></g>
        <g class="n" tabindex="0" role="button" data-k="考點" style="--d:1.8s;--c:#ef4f6b"><rect x="242" y="114" width="64" height="32" rx="16"/><text x="274" y="135">考點</text></g></svg>`; return t.content.firstChild; })();
      const pickNode = g => {
        svg.querySelectorAll('g').forEach(x => x.classList.toggle('sel', x === g));
        tip.classList.add('live'); tip.lastChild.textContent = NODE[g.dataset.k];
        jelly(tip, .7, 500); sfx('tap'); buzz();
      };
      svg.addEventListener('click', e => { const g = e.target.closest('g'); if (g) pickNode(g); });
      svg.addEventListener('keydown', e => { const g = e.target.closest('g'); if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pickNode(g); } });

      const fold = (title, body) => { const d = h('button', { class: 'in-fold', onclick: () => { d.classList.toggle('open'); sfx('tap'); } }, h('b', null, icon('chevron-right'), title), h('span', null, body)); return d; };
      const quiz = () => {
        const res = h('p', { class: 'in-qres' });
        const opts = h('div', { class: 'in-qopts' }, [['需求量增加，均衡價格下跌', false], ['出現超額需求，價格被往上推', true], ['供給線往右移動', false]].map(([t, ok]) =>
          h('button', { onclick: e => {
            if (opts.classList.contains('done')) return;
            opts.classList.add('done'); e.currentTarget.classList.add(ok ? 'right' : 'wrong');
            if (!ok) [...opts.children][1].classList.add('right');
            res.textContent = ok ? '答對了！價格低於均衡時，想買的人比賣的多。' : '差一點。價格太低時買的人比賣的多，價格會被推高。';
            jelly(e.currentTarget, ok ? 1 : .6); sfx(ok ? 'on' : 'off');
          } }, t)));
        const again = h('button', { class: 'in-again', onclick: () => { opts.classList.remove('done'); [...opts.children].forEach(c => c.classList.remove('right', 'wrong')); res.textContent = ''; } }, '再試一次');
        return h('div', { class: 'in-quiz' }, h('span', { class: 'qz-kind' }, '選擇題'), h('b', null, '政府把價格壓在均衡價格以下，市場會怎樣？'), opts, res, again);
      };
      const PANES = {
        '大綱筆記': () => h('div', { class: 'in-pane' }, h('p', { class: 'in-tip live' }, icon('sparkles'), h('span', null, '點標題可以展開')),
          fold('12:48　供給與需求', '兩條線各自代表買方和賣方，在不同價格下願意交易的數量。'),
          fold('24:10　市場均衡', '兩條線的交點。價格高於它會剩貨，低於它會缺貨。'),
          fold('31:05　價格彈性', '衡量數量對價格有多敏感，決定漲價後收入是增是減。')),
        '考點': () => h('div', { class: 'in-pane' },
          h('div', { class: 'in-exam' }, h('i', null, '1'), h('div', null, h('b', null, '均衡價格的圖要會畫'), h('span', null, '教授講了三次「這個一定考」'))),
          h('div', { class: 'in-exam' }, h('i', null, '2'), h('div', null, h('b', null, '價格彈性的計算'), h('span', null, '黑板上示範了兩題')))),
        '心智圖': () => h('div', { class: 'in-pane' }, svg, tip),
        '測驗': () => h('div', { class: 'in-pane' }, quiz()),
      };
      const pane = h('div', { class: 'in-pane-box' }, PANES['心智圖']());
      const tabs = h('div', { class: 'in-tabs', role: 'tablist' }, Object.keys(PANES).map(t => h('button', { role: 'tab', class: t === '心智圖' ? 'on' : '', onclick: e => {
        tabs.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === e.currentTarget));
        pane.replaceChildren(PANES[t]()); jellyIn(pane.firstChild, 'below'); sfx('tap'); buzz();
      } }, t)));
      return h('div', { class: 'in-demo in-card in-notes' }, tabs, pane,
        h('div', { class: 'in-chips' }, h('span', { style: '--d:2.3s' }, icon('share'), '匯出 GoodNotes'), h('span', { style: '--d:2.6s' }, icon('languages'), '中英對照')));
    },
    tutor: () => h('div', { class: 'in-demo in-card in-chat' },
      h('p', { class: 'me', style: '--d:.3s' }, '期中會考哪些？'),
      h('p', { class: 'ai', style: '--d:1.3s' }, '教授提到兩個必考：均衡價格的圖', h('em', null, '12:48'), '和價格彈性的計算', h('em', null, '31:05'), '。'),
      h('p', { class: 'me', style: '--d:2.6s' }, '彈性可以再講一次嗎？'),
      h('p', { class: 'ai dots', style: '--d:3.4s' }, h('i'), h('i'), h('i'))),
    smart: () => h('div', { class: 'in-demo in-smart' },
      h('div', { class: 'in-col' }, h('b', null, '打開就能用'), h('span', null, '錄音、字幕、筆記、心智圖'), h('span', null, '全部免費，資料留在裝置')),
      h('div', { class: 'in-plus' }, icon('plus')),
      h('div', { class: 'in-col hot' }, h('b', null, icon('sparkles'), '接上 API 更聰明'), h('span', null, 'Claude 讀懂整堂課'), h('span', null, '中英混講、分辨講者'))),
  };
  const STEPS = [
    ['hero', '蛤說啥', '上課，只要專心聽', '錄音、即時字幕、中英對照筆記，一次幫你整理好。往下滑，30 秒看完怎麼用。'],
    ['captions', '第 1 步', '按下錄音，字幕馬上出現', '教授說的每一句話即時變成文字，旁邊附上另一種語言，還會分出是誰在講。'],
    ['zoned', '上課中', '恍神了？按一下就跟上', '「我恍神了」會整理剛剛幾分鐘的重點、教授的提醒和新出現的名詞。'],
    ['notes', '下課後', '自動變成一份完整筆記', '大綱筆記、考試重點、心智圖和測驗都有，還能匯出到 GoodNotes。下面這個可以直接點點看。'],
    ['tutor', '複習時', '不懂的直接問助教', '助教讀過整堂課，回答會標出時間，點一下就能跳回去重聽那一段。'],
    ['smart', '不用訂閱', '想更聰明，就接上 API', '所有功能都免費。之後在設定貼上自己的金鑰，筆記和字幕會變得更準。'],
  ];
  const firstTime = fresh || !Store.get('onboarded', false);   // first visit, or arriving from the introduction page
  const close = () => {
    Store.set('onboarded', true);
    root.classList.add('leaving');
    setTimeout(() => {
      root.remove(); document.documentElement.classList.remove('intro-open');
      // First visit only: once the tour is over, offer sign-in so the lectures follow the account.
      if (firstTime && Account.REAL_AUTH && !Account.account()) askSignIn();
    }, motionOn() ? 420 : 0);
  };
  const scroller = h('div', { class: 'in-scroll', tabindex: '0' }, STEPS.map(([k, eyebrow, title, text], i) =>
    h('section', { class: 'in-step in-' + k + '-step', 'data-i': String(i) },
      h('div', { class: 'in-text' }, h('span', { class: 'in-eyebrow' }, eyebrow), h(i ? 'h2' : 'h1', null, title), h('p', null, text),
        i === 0 ? h('button', { class: 'in-hint', onclick: () => scroller.children[1].scrollIntoView({ behavior: 'smooth' }) }, '往下滑', icon('chevron-down'))
          : i === STEPS.length - 1 ? h('div', { class: 'in-cta' },
            h('button', { class: 'btn primary lg', onclick: close }, '開始使用', icon('chevron-right')),
            h('button', { class: 'btn lg', onclick: () => { close(); go('#/settings'); } }, icon('zap'), '現在就貼金鑰')) : null),
      scene[k]())));
  const bar = h('i');
  const dots = h('div', { class: 'in-dots' }, STEPS.map((st, i) => h('button', { 'aria-label': `第 ${i + 1} 段`, onclick: () => scroller.children[i].scrollIntoView({ behavior: 'smooth' }) })));
  const root = h('div', { id: 'intro', role: 'dialog', 'aria-label': '使用教學' },
    h('div', { class: 'in-top' }, h('div', { class: 'brand' }, h('span', { class: 'logo orb-logo' }, icon('audio-lines')), '蛤說啥'),
      h('button', { class: 'btn sm in-skip', onclick: close }, '跳過', icon('chevron-right'))),
    h('div', { class: 'in-progress' }, bar), scroller, dots);
  document.body.append(root);
  document.documentElement.classList.add('intro-open');
  const io = new IntersectionObserver(es => es.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add('on'); dots.querySelectorAll('button').forEach((d, i) => d.classList.toggle('on', i === Number(e.target.dataset.i))); }
    else if (e.intersectionRatio === 0) e.target.classList.remove('on');   // replays when you scroll back
  }), { root: scroller, threshold: [0, .5] });
  [...scroller.children].forEach(c => io.observe(c));
  scroller.addEventListener('scroll', () => {
    const max = scroller.scrollHeight - scroller.clientHeight;
    bar.style.transform = `scaleX(${max ? scroller.scrollTop / max : 1})`;
  }, { passive: true });
  root.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  scroller.focus({ preventScroll: true });
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
  if (!(await confirmSheet({ icon: 'log-out', color: '#6b7280', title: '要登出嗎？', text: '已備份到帳號的課堂會從這台裝置的列表收起來，下次用同一個帳號登入就會回來。', ok: '登出' }))) return;
  Cloud.flush();
  await Account.signOut();
  Cloud.setUser(null);
  toast('已登出', { icon: 'log-out' });
  render();
}
async function doDeleteAccount() {
  if (!(await confirmSheet({
    icon: 'trash-2', title: '刪除帳號？', danger: true, ok: '永久刪除帳號',
    text: '會刪除你的帳號，以及備份在雲端的所有課堂和筆記，無法復原。',
  }))) return;
  try { await Account.deleteAccount(() => Cloud.wipe()); Cloud.setUser(null); } catch (e) { toast(e.message || '刪除失敗', { icon: 'info', ms: 5000 }); return; }
  toast('帳號已刪除', { icon: 'check' });
  render();
}
const syncText = st => st.state === 'syncing' ? '同步中…' : st.state === 'ok' ? '已備份到你的帳號 · ' + new Date(st.at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })
  : st.state === 'offline' ? '離線中，連上網路後會自動同步' : st.state === 'error' ? st.error : '';
function syncLine(cls = '') {
  const st = Cloud.status();
  return h('span', { class: 'sync-line ' + cls, 'data-sync': st.state }, h('i'), h('span', null, syncText(st)));
}
Cloud.onStatus(st => document.querySelectorAll('.sync-line').forEach(el => { el.dataset.sync = st.state; el.lastElementChild.textContent = syncText(st); }));
// Shown once, right after the first-run tour. Signing in is optional.
function askSignIn() {
  let dlg;
  dlg = openDialog([
    h('div', { class: 'cal-head' }, h('span', { class: 'sticker', style: '--sz:46px;--r:-8deg;--a:#8b5cf6;--b:#8b5cf6;animation:none' }, icon('cloud')),
      h('div', null, h('h3', { style: 'margin:0' }, '要登入嗎？'))),
    h('p', { class: 'muted', style: 'margin:12px 0 4px;line-height:1.6' }, '登入後，每堂課的逐字稿、筆記和手寫會備份到你的帳號。下週回來複習或換一台裝置，登入同一個帳號就看得到。'),
    h('ul', { class: 'ask-points' },
      h('li', null, icon('shield-check'), '只有你自己讀得到自己的課堂'),
      h('li', null, icon('headphones'), '錄音檔不會上傳，只留在這台裝置'),
      h('li', null, icon('check'), '不登入也能用，資料就只存在這台裝置')),
    signInButtons(() => { dlg.closeDialog(); render(); }, { compact: true }),
    h('button', { class: 'btn ghost block', style: 'margin-top:8px', onclick: () => dlg.closeDialog() }, '先不用'),
    h('p', { class: 'muted small', style: 'text-align:center;margin:10px 0 0' }, '之後隨時可以到「設定」登入。'),
  ], { cls: 'sheet' });
}
function accountCard() {
  const a = Account.account();
  if (!a) {
    return h('div', { class: 'acct-card guest' },
      h('div', { class: 'acct-top' }, avatar(null, 54),
        h('div', { class: 'grow' }, h('b', null, '尚未登入'), h('span', null, '登入後，每堂課的逐字稿、筆記和手寫都會備份到你的帳號。換裝置或下週回來複習，登入同一個帳號就看得到。'))),
      signInButtons(() => render(), { compact: true }));
  }
  return h('div', { class: 'acct-card' },
    h('div', { class: 'acct-top' }, avatar(a, 54),
      h('div', { class: 'grow' }, h('b', null, a.name), h('span', null, a.email))),
    h('div', { class: 'acct-sync' }, syncLine(),
      h('button', { class: 'btn sm', onclick: async e => { const b = e.currentTarget; b.disabled = true; await Cloud.sync(); b.disabled = false; } }, icon('refresh-cw'), '立即同步')),
    h('p', { class: 'acct-note' }, '會備份：逐字稿、筆記、測驗、手寫、講義文字。錄音檔和講義原始檔太大，只留在錄音的那台裝置。'),
    h('div', { class: 'acct-actions' },
      h('button', { class: 'btn sm ghost', onclick: doSignOut }, icon('log-out'), '登出')),
    h('button', { class: 'acct-delete', onclick: doDeleteAccount }, '刪除帳號'));
}

/* ================= views ================= */
const app = () => $('#app');

// The home greeting, in a handwritten face, written out one character at a time the first time it shows.
// The handwritten face is used for the greeting and for titles. Google Fonts serves it in small slices, so only the characters on screen are downloaded.
document.head.append(Object.assign(document.createElement('link'), { id: 'hand-font', rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=LXGW+WenKai+TC:wght@700&display=swap' }));
let greetShown = false;
function handGreeting(text) {
  const write = !greetShown && motionOn();
  greetShown = true;
  // Wait for the opening splash to clear, so the writing is actually seen.
  const base = document.querySelector('#splash') ? 1700 : 350;
  const tilt = [-2.2, 1.4, -0.8, 2, -1.6, 0.9, -1.2, 1.8, -0.6, 1.1, -1.9, 0.7], lift = [0, -1.5, 1, -0.5, 1.5, 0, -1, 0.5, 1, -1.5, 0.5, 0];
  let i = 0;
  return h('h1', { class: 'hand-greet' + (write ? ' write' : ''), 'aria-label': text },
    [...text].map((ch, k) => h('span', { 'aria-hidden': 'true',
      style: `--d:${base + (/[，？]/.test(ch) ? i += 2 : i++) * 90}ms;--r:${tilt[k % tilt.length]}deg;--y:${lift[k % lift.length]}px` }, ch)));
}
/* ---------- update notices ---------- */
const unseenUpdates = () => UPDATES.filter(u => u.id > Store.get('seenUpdate', 0)).length;
function updatesButton() {
  const n = unseenUpdates();
  const b = h('button', { class: 'btn icon ghost upd-btn' + (n ? ' has' : ''), 'aria-label': n ? `更新通知，有 ${n} 則新的` : '更新通知', title: '更新通知',
    onclick: () => { showUpdates(); b.classList.remove('has'); b.setAttribute('aria-label', '更新通知'); } }, icon('bell'), h('span', { class: 'upd-dot', 'aria-hidden': 'true' }));
  return b;
}
function showUpdates() {
  const seen = Store.get('seenUpdate', 0);
  let dlg;
  const day = d => { const [y, m, dd] = d.split('-').map(Number); return `${y} 年 ${m} 月 ${dd} 日`; };
  dlg = openDialog([
    h('button', { class: 'btn icon ghost plans-close', 'aria-label': '關閉', onclick: () => dlg.closeDialog() }, icon('x')),
    h('div', { class: 'cal-head' }, h('span', { class: 'sticker', style: '--sz:46px;--r:-8deg;--a:#8b5cf6;--b:#ec4899;animation:none' }, icon('bell')),
      h('div', null, h('h3', { style: 'margin:0' }, '更新通知'), h('div', { class: 'muted small' }, '每次更新了什麼，都寫在這裡。'))),
    h('div', { class: 'upd-list' }, UPDATES.map(u => h('article', { class: 'upd' + (u.id > seen ? ' new' : '') },
      h('div', { class: 'upd-meta' }, h('span', { class: 'upd-ver' }, '第 ' + u.id + ' 版'), day(u.date), u.id > seen ? h('span', { class: 'upd-new' }, '新') : null),
      h('h4', null, u.title),
      h('ul', null, u.items.map(t => h('li', null, t)))))),
  ]);
  Store.set('seenUpdate', latestUpdate());
}

async function renderHome() {
  const list = (await myLectures()).sort((a, b) => b.created - a.created);
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
      updatesButton(),
      h('button', { class: 'btn icon ghost', 'aria-label': '設定', onclick: () => go('#/settings') }, icon('settings')),
      Account.REAL_AUTH ? h('button', { class: 'btn icon ghost avatar-btn', 'aria-label': Account.account() ? '帳號' : '登入', title: Account.account() ? Account.account().name : '登入',
        onclick: () => go('#/settings') }, avatar(Account.account(), 30)) : null),
    h('main', { class: 'page' },
      h('section', { class: 'hero' },
        h('div', { class: 'hero-art', 'aria-hidden': 'true' }, sticker('notebook-pen'), sticker('mic'), sticker('sparkles')),
        h('div', { class: 'hero-top' },
          h('div', null, handGreeting(`${greet}，準備好上課了嗎？`), h('div', { class: 'sub' }, fmtDate(Date.now())),
            Account.REAL_AUTH && Account.account() ? syncLine('on-hero') : null)),
        h('div', { class: 'stats' },
          h('div', { class: 'stat' }, h('b', null, String(list.length)), h('span', null, '堂課')),
          h('div', { class: 'stat' }, h('b', null, totalMs ? fmtDuration(totalMs) : '0'), h('span', null, '錄音時間')),
          h('div', { class: 'stat' }, h('b', null, String(notesN)), h('span', null, '份筆記'))),
        h('div', { class: 'hero-actions' },
          h('button', { class: 'btn primary lg', onclick: newLectureDialog }, icon('mic'), '新的一堂課'),
          list.length > 3 ? h('label', { class: 'search' }, icon('book-open'),
            h('input', { type: 'search', placeholder: '搜尋課程或標題', value: state.search, oninput: e => { state.search = e.target.value; renderList(); } })) : null)),
      Account.REAL_AUTH && !Account.account() ? h('button', { class: 'signin-banner', onclick: () => go('#/settings') },
        h('span', { class: 'sb-ico' }, icon('cloud')),
        h('span', { class: 'grow' }, h('b', null, '登入，課堂紀錄就不會不見'), h('span', null, '用 Google 登入後，筆記會跟著你的帳號，下次登入就看得到。')),
        icon('chevron-right')) : null,
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
          l.audioParts && l.audioParts.length ? h('span', { class: 'chip' }, icon('headphones'), '錄音') : l.hasAudio ? h('span', { class: 'chip', title: '錄音檔留在錄音的那台裝置' }, icon('headphones'), '錄音在另一台裝置') : null)))))) :
      [h('div', { class: 'empty' },
        h('div', { class: 'wave-art' }, h('i'), h('i'), h('i'), h('i'), h('i'), h('i'), h('i')),
        h('h3', null, q ? '找不到符合的課' : '還沒有任何一堂課'),
        h('p', null, q ? '換個關鍵字試試看。' : '按「新的一堂課」開始。上課時錄音，下課後一鍵整理成中英對照筆記。'))]));
  }
  renderList();
  afterRender();
}

function newLectureDialog() {
  myLectures().then(list => {
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
  const local = !pro && (r ? r.mode === 'local' : hifiOn());
  const engine = h('span', { class: 'engine' + (pro ? ' pro' : '') }, icon(pro ? 'sparkles' : local ? 'cpu' : 'gift'), pro ? '進階：Soniox' : NATIVE ? '免費：iPhone 語音辨識' : local ? '免費：高準確字幕' : '免費：瀏覽器辨識');
  let btn;
  if (st === 'idle') btn = h('button', { class: 'rec-btn idle', 'aria-label': '開始錄音', onclick: startRecording }, icon('mic'));
  else if (st === 'recording') btn = h('button', { class: 'rec-btn live', 'aria-label': '暫停', onclick: () => r.pause() }, icon('pause'));
  else if (st === 'paused') btn = h('button', { class: 'rec-btn paused', 'aria-label': '繼續錄音', onclick: () => r.resume() }, icon('mic'));
  else btn = h('button', { class: 'rec-btn busy', disabled: true }, icon('refresh-cw'));
  const statusTxt = {
    idle: state.lecture.segments.length ? '按下紅色按鈕繼續錄音' : '按下紅色按鈕開始錄音',
    connecting: '連線中…', recording: '錄音中', paused: '已暫停',
    stopping: r && r.local && !r.localDead && (r.backlog || 0) > 1 ? `錄音已存好，還在寫最後 ${Math.ceil(r.backlog)} 秒的字幕…` : '儲存中…',
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
      st === 'idle' ? h('div', { class: 'rec-hint' }, icon('battery-charging'), NATIVE ? '可錄 4 小時以上，切到別的 App 或鎖定螢幕也會繼續錄' : isIOS ? '可錄 4 小時以上。iPhone 切到別的 App 時會暫停收音，回來會自動接續' : '可錄 4 小時以上，切到別的 App 也會繼續錄；記得插電',
        h('button', { class: 'rec-tips', onclick: showTips }, icon('lightbulb'), !pro && hifi.ok && !hifiOn() ? '字幕不準？開高準確字幕' : '字幕不準？'),
        !NATIVE ? h('button', { class: 'rec-tips', disabled: !!state.relisten, title: '已經用別的方式錄好了？上傳錄音檔，自動變成逐字稿和筆記', onclick: pickAudioFile }, icon('upload'), state.relisten ? '辨識中…' : '上傳錄音檔') : null) : null,
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
  if (state.relisten) { toast('正在辨識錄音檔，等它完成再錄音', { icon: 'info' }); return; }
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
    return h('button', { class: 'spk-chip', title: id === '?' ? '接上 Soniox 才能分辨講者' : '點一下可以改名或設定為教授', onclick: () => { if (id !== '?') speakerDialog(id); } },
      avatarEl(i), i.name);
  });
  const canTranslate = proReady().notes || localTranslateSupported();
  if (ids.length && canTranslate && !state.rec && lec.segments.some(s => !s.tr)) {
    kids.push(h('button', { class: 'btn sm soft', disabled: state.translating, onclick: translateTranscript, title: '把沒有翻譯的句子補上' },
      icon('languages'), state.translating ? '翻譯中…' : '補齊翻譯'));
  }
  if (lec.segments.length && !state.rec) {
    if (lec.segments.some(s => s.text.trim() && !s.fixed)) {
      kids.push(h('button', { class: 'btn sm soft', disabled: !!state.polishing, onclick: polishTranscript, title: '用 AI 修正聽錯的字和術語，並補上翻譯' },
        icon('sparkles'), state.polishing ? '修順中…' : '修順逐字稿'));
    }
    if (!state.polishing && lec.segments.some(s => s.raw != null)) kids.push(h('button', { class: 'btn sm ghost', onclick: unpolishTranscript, title: '變回語音辨識當時的原文' }, icon('undo-2'), '還原'));
  }
  if (!state.rec && hifiOn() && lec.audioParts && lec.audioParts.length) {
    kids.push(h('button', { class: 'btn sm soft', disabled: !!state.relisten, onclick: relistenLecture, title: '用高準確字幕把保存的錄音重新聽寫一次，取代現在的逐字稿' },
      icon('cpu'), state.relisten ? '重新辨識中…' : '重新辨識錄音'));
    if (!state.relisten && lec.oldSegments) kids.push(h('button', { class: 'btn sm ghost', onclick: undoRelisten, title: '換回重新辨識之前的逐字稿' }, icon('undo-2'), '換回舊逐字稿'));
  }
  box.replaceChildren(...kids);
}
// Make sure the on-device engine is downloaded and running. progress(text) shows what is happening.
async function ensureHifi(progress) {
  const prog = (a, b) => progress(`${hifi.has ? '啟動' : '下載'}辨識模型 ${Math.round(a / 1e6)} / ${Math.round(b / 1e6)} MB`);
  await HiFi.load(prog);
  if (!(await HiFi.downloaded()) && HiFi.pickSize() === 'large') {      // this browser cannot keep the bigger model
    Store.set('hifiSize', 'small'); HiFi.setSize('small');
    await HiFi.load(prog);
  }
  hifi.has = await HiFi.downloaded();
  if (hifi.has && Store.get('hifi', null) == null) Store.set('hifi', true);
}
// One recording → caption rows, starting at `offset` ms in the lecture.
async function hifiTranscribe(lec, blob, offset, note) {
  const out = [];
  const v = (await speechVocab(lec).catch(() => null)) || {};
  const total = lec.durationMs || 0;
  note('讀取錄音…');
  const pcm = await HiFi.decode16k(blob);
  const stt = new HiFi.LocalSTT({
    lang: settings().mainLang === 'en' ? 'en' : 'zh', vocab: v.terms || [], course: lec.course || '', slides: (lec.files || []).map(f => f.text || '').join('\n'),
    onSegment: (text, s, e) => {
      for (const c of splitCaption(text, offset + s, offset + e)) out.push({ id: uid(), speaker: '?', start: c.start, end: c.end, lang: /[一-鿿]/.test(c.text) ? 'zh' : 'en', text: c.text, tr: '' });
      note(`辨識中 ${fmtTime(offset + e)} / ${fmtTime(Math.max(total, offset + pcm.length / 16))}，請讓這一頁開著`);
    },
  });
  for (let i = 0; i < pcm.length; i += 16000 * 30) { stt.push(pcm.subarray(i, i + 16000 * 30)); await stt.chain; }   // half a minute at a time
  await stt.finish();
  return { segments: out, ms: Math.round(pcm.length / 16) };
}
// "I already recorded the class with something else": pick an audio file, get the transcript, then the notes.
async function pickAudioFile() {
  if (state.rec || state.relisten) return;
  if (hifi.ok && !(await HiFi.capability()).ok) hifi.ok = false;
  if (!hifi.ok) { toast('上傳錄音檔需要在裝置上辨識，這個瀏覽器不支援。請用新版 Chrome 或 Edge，iPhone 和 iPad 需要 iOS 26 以上的 Safari', { icon: 'info', ms: 8000 }); return; }
  const input = h('input', { type: 'file', accept: 'audio/*,video/mp4,.m4a,.mp3,.wav,.aac,.ogg,.webm,.mp4,.flac', class: 'hidden',
    onchange: e => { const f = e.target.files[0]; input.remove(); if (f) importAudioFile(f); } });
  document.body.append(input); input.click();
}
async function importAudioFile(file) {
  const lec = state.lecture;
  if (!lec || state.rec || state.relisten) return;
  if (!hifi.has && !confirm(`要把錄音檔變成逐字稿，需要先下載辨識模型（約 ${HiFi.SIZE_MB[HiFi.pickSize()]} MB，只要一次，建議用 Wi-Fi）。現在下載嗎？`)) return;
  if (file.size > 400 * 1024 * 1024 && !confirm('這個檔案很大，手機和平板可能會因為記憶體不夠而失敗。要繼續嗎？')) return;
  state.relisten = lec.id; renderSpeakers(); renderRecorder();
  const bt = busyToast('準備辨識錄音檔（一小時的課大約要 15 到 60 分鐘，請讓這一頁開著）…');
  try {
    await ensureHifi(t => bt.set(t));
    const offset = lec.audioParts && lec.audioParts.length ? Math.max(lec.durationMs || 0, 0) : 0;
    const r = await hifiTranscribe(lec, file, offset, t => bt.set(t));
    if (!r.segments.length) { toast('這個錄音檔裡沒有聽到說話的聲音', { icon: 'info', ms: 6000 }); return; }
    lec.audioParts = lec.audioParts || [];
    lec.audioParts.push({ blob: file, offset });
    lec.segments = lec.segments.concat(r.segments);
    lec.durationMs = offset + r.ms;
    await saveLecture(lec);
    if (state.lecture === lec) { renderRecorder(); renderTranscriptPane(); renderRightPane(); renderPlayer(); }
    bt.done();
    toast('逐字稿好了，接著整理筆記', { icon: 'check', ms: 4000 });
    state.relisten = null;
    if (state.lecture === lec) generateNotes();
  } catch (err) {
    console.error(err);
    toast('錄音檔沒有處理完：' + ((err && err.message) || err), { icon: 'info', ms: 8000 });
  } finally { bt.done(); state.relisten = null; renderSpeakers(); if (state.lecture === lec) renderRecorder(); }
}
// Write the transcript again from the saved recording, with the on-device engine.
async function relistenLecture() {
  const lec = state.lecture;
  if (state.relisten || state.rec || !lec.audioParts || !lec.audioParts.length) return;
  state.relisten = lec.id; renderSpeakers();
  const bt = busyToast('準備重新辨識錄音（一小時的課大約要 15 到 60 分鐘，請讓這一頁開著）…');
  const out = [];
  try {
    await ensureHifi(t => bt.set(t));
    for (const part of [...lec.audioParts].sort((a, b) => a.offset - b.offset)) out.push(...(await hifiTranscribe(lec, part.blob, part.offset, t => bt.set(t))).segments);
    if (!out.length) { toast('錄音裡沒有聽到說話的聲音', { icon: 'info', ms: 5000 }); return; }
    lec.oldSegments = lec.segments;
    lec.segments = out;
    await saveLecture(lec);
    if (state.lecture === lec) { renderTranscriptPane(); renderRightPane(); }
    toast(lec.notes ? '逐字稿已經重新聽寫。筆記是用舊逐字稿做的，可以重新整理一次' : '逐字稿已經重新聽寫', { icon: 'check', ms: 7000 });
  } catch (err) {
    console.error(err);
    toast('重新辨識沒有完成：' + ((err && err.message) || err), { icon: 'info', ms: 7000 });
  } finally { bt.done(); state.relisten = null; renderSpeakers(); }
}
async function undoRelisten() {
  const lec = state.lecture; if (!lec.oldSegments) return;
  lec.segments = lec.oldSegments; delete lec.oldSegments;
  await saveLecture(lec); renderTranscriptPane(); renderRightPane();
  toast('已換回舊的逐字稿', { icon: 'undo-2' });
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
        : h('button', { class: 'badge free', onclick: () => { close(); showPlans(); } }, icon('gift'), '裝置整理：挑出關鍵句'),
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
    if (f.kind === 'pdf' && f.blob && bytes + f.size < 22 * 1024 * 1024) {
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
  else if (m.engine === 'claude' || m.engine === 'local' || m.engine === 'error') content = richText(m.text);
  else if (m.empty) content = [h('p', null, '這堂課的逐字稿和筆記裡找不到相關的內容。可以換個說法試試看，或用課堂上出現的關鍵字問。')];
  else content = [h('p', null, '我在這堂課找到這些：'), ...(m.blocks || []).map(b => h('div', { class: 'ans-block' },
    h('div', { class: 'ans-title' }, b.title),
    h('ul', null, b.items.map(it => h('li', null, it.text, ' ', it.time ? jumpChip(parseTime(it.time)) : null)))))];
  return h('div', { class: 'msg bot' + (m.engine === 'error' ? ' err' : '') },
    h('span', { class: 'bot-av' }, icon('graduation-cap')),
    h('div', { class: 'bubble' }, content,
      !m.pending && m.engine === 'local' ? h('span', { class: 'engine-tag' }, icon('cpu'), '裝置上的 AI 回答') : null,
      !m.pending && m.engine === 'free' ? h('button', { class: 'upsell', onclick: () => showPlans() }, icon('sparkles'), '接上 API，Claude 會直接回答並標出時間') : null));
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
      h('p', { class: 'muted' }, ai ? '我讀過這堂課的逐字稿、講義和筆記，回答時會標出時間，點一下就能回去聽。' : '我會幫你在逐字稿和筆記裡找出相關的段落；接上 API 後由 Claude 直接回答。'),
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
    } else if (await LocalAI.ready()) {
      let t = 0, ok = false;
      try {
        msg.engine = 'local';
        msg.text = await localTutor(lec, q, snap => { msg.text = snap; const n = Date.now(); if (n - t > 80) { t = n; updateLastBubble(); } });
        ok = !!msg.text;
      } catch (e) { console.warn('on-device AI failed', e); }
      if (!ok) { msg.engine = 'free'; msg.text = ''; Object.assign(msg, Tutor.freeAnswer(q, { segs: lec.segments.filter(s => s.text.trim()), textOf: segText, notes: lec.notes, fmtTime, isProf: isProfSeg, endMs: lectureNowMs() })); }
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
  { v: 'outline', label: '大綱筆記', icon: 'list-tree' },
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
        pr.notes ? h('span', { class: 'badge pro' }, icon('sparkles'), 'Claude AI 整理') : h('button', { class: 'badge free', onclick: () => showPlans() }, icon('gift'), '在裝置上自動整理')),
      h('button', { class: 'btn primary lg', disabled: !has || recording, onclick: generateNotes }, icon('sparkles'), '整理筆記'),
      recording ? h('p', { class: 'small muted', style: 'margin:12px auto 0' }, '錄音結束後才能整理') : null,
      !pr.notes && !recording ? h('p', { class: 'small', style: 'margin:14px auto 0' }, '想要更聰明的筆記？', h('a', { href: '#', onclick: e => { e.preventDefault(); showPlans(); } }, '接上 API 試試')) : null)));
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
        n.engine === 'free' ? h('button', { class: 'badge free', onclick: () => showPlans(), title: '怎麼更聰明？' }, icon('gift'), '裝置自動整理') : h('span', { class: 'badge pro' }, icon('sparkles'), 'Claude AI 筆記'),
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
    case 'outline': return n.outline.length ? outlineNotes(n) : emptyNote('沒有足夠的內容建立大綱筆記。');
    case 'mindmap': return n.mind_map.branches.length ? h('div', null,
      h('div', { class: 'mm-export' }, h('span', { class: 'muted small' }, '一頁橫式 PDF，可以在 GoodNotes 上面圈、畫、補充'),
        h('button', { class: 'btn sm gn-btn', onclick: exportMindMapGoodNotes }, icon('notebook-pen'), '匯出到 GoodNotes')),
      mindMapPanel(n.mind_map)) : emptyNote('沒有足夠的內容建立心智圖。');
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
    case 'quiz': return quizView(n);
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
// 大綱筆記: the outline written out as real notes — each section has its one-line gist, the points with the professor's
// explanation, the terms and exam points that belong to it, and room for the student's own notes.
const outlineTerms = new WeakMap();   // notes → the terms shown under each section (the export uses the same ones)
function outlineNotes(n) {
  const lec = state.lecture;
  const secTerms = []; outlineTerms.set(n, secTerms);
  let inkTimer = 0;
  const inkChanged = () => { clearTimeout(inkTimer); inkTimer = setTimeout(() => saveLecture(lec), 700); };
  const NUM = '一二三四五六七八九十';
  const num = k => (k < 10 ? NUM[k] : k < 20 ? '十' + (k === 10 ? '' : NUM[k - 10]) : String(k + 1));
  const has = o => !!(o && (o.zh || o.en));
  const starts = n.outline.map(o => parseTime(o.time));
  const inSection = (ms, k) => {
    if (ms == null || starts[k] == null) return false;
    const next = starts.slice(k + 1).find(x => x != null);
    return ms >= starts[k] && (next == null || ms < next);
  };
  const usedTerm = new Set();
  const sections = n.outline.map((sec, k) => {
    const text = [sec.heading, sec.summary, ...sec.points.flatMap(p => [p.text, p.detail])].map(o => (o ? (o.zh || '') + ' ' + (o.en || '') : '')).join(' ').toLowerCase();
    const said = new Set(sec.points.flatMap(p => [p.text.zh, p.text.en]).filter(Boolean).map(x => x.toLowerCase()));
    const terms = (n.key_terms || []).filter(t => {
      const id = (t.term_en || t.term_zh || '').toLowerCase();
      if (!id || usedTerm.has(id) || !has(t.definition)) return false;
      const def = (t.definition.zh || t.definition.en || '').toLowerCase();
      if (said.has(def)) return false;   // the definition is already written out as a point here
      const hit = [t.term_zh, t.term_en].filter(Boolean).some(w => text.includes(w.toLowerCase()));
      if (hit) usedTerm.add(id);
      return hit;
    }).slice(0, 4);
    secTerms[k] = terms;
    const dup = o => !!o && [o.zh, o.en].filter(Boolean).some(x => said.has(x.toLowerCase()));   // already written as a point
    const exams = (n.exam_focus || []).filter(e => inSection(parseTime(e.time), k) && !dup(e.point));
    const examPts = new Set((n.exam_focus || []).flatMap(e => [e.point.zh, e.point.en]).filter(Boolean).map(x => x.toLowerCase()));
    const isExam = p => [p.text.zh, p.text.en].filter(Boolean).some(x => examPts.has(x.toLowerCase()));
    const mine = h('div', { class: 'on-mine', contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': '我的筆記', 'data-ph': '寫下自己的筆記、疑問或老師畫的重點…' });
    mine.textContent = (lec.myNotes && lec.myNotes[k]) || '';
    mine.addEventListener('blur', () => {
      const v = mine.innerText.trim();
      if (v === ((lec.myNotes && lec.myNotes[k]) || '')) return;
      lec.myNotes = lec.myNotes || {};
      if (v) lec.myNotes[k] = v; else delete lec.myNotes[k];
      saveLecture(lec); toast('已儲存你的筆記', { icon: 'check', ms: 1400 });
    });
    return h('section', { class: 'on-sec', style: `--i:${k}` },
      h('header', { class: 'on-head', onclick: e => { if (e.target.closest('button,a')) return; e.currentTarget.parentElement.classList.toggle('shut'); sfx('tap'); } },
        h('span', { class: 'on-num' }, num(k)),
        h('h4', null, bi(sec.heading)),
        sec.time ? timeChip(sec.time) : null,
        h('span', { class: 'on-caret' }, icon('chevron-down'))),
      has(sec.summary) && !dup(sec.summary) ? h('p', { class: 'on-gist' }, bi(sec.summary)) : null,
      h('div', { class: 'on-body' },
        h('ul', { class: 'on-points' }, sec.points.map(p => h('li', { class: p.emphasis ? 'em' : '' },
          h('div', { class: 'on-pt' }, h('span', { class: 'on-hl' }, bi(p.text)),
            isExam(p) ? h('span', { class: 'tag star' }, icon('star'), '考點') : p.emphasis ? h('span', { class: 'tag star' }, icon('star'), '重點') : null,
            p.source === 'slides' ? h('span', { class: 'tag slide' }, '講義') : null),
          has(p.detail) ? h('div', { class: 'on-detail' }, bi(p.detail)) : null))),
        terms.length ? h('div', { class: 'on-terms' }, terms.map(t => h('div', { class: 'on-term' },
          h('b', null, t.term_zh || t.term_en, t.term_zh && t.term_en ? h('i', null, t.term_en) : null), h('span', null, bi(t.definition))))) : null,
        exams.map(e => h('div', { class: 'on-exam' }, icon('star'), h('div', null, h('b', null, '考點　'), bi(e.point), has(e.why) ? h('span', { class: 'on-why' }, bi(e.why)) : null))),
        h('div', { class: 'on-mine-box' }, h('span', { class: 'on-mine-lbl' }, icon('notebook-pen'), '我的筆記'), mine),
        inkBox(k)));
  });
  // Handwriting: a pad under each section. Opens on its own when there is already writing in it.
  function inkBox(k) {
    const box = h('div', { class: 'on-ink' });
    const open = () => {
      lec.ink = lec.ink || {};
      const data = lec.ink[k] || (lec.ink[k] = { h: 0.42, strokes: [] });
      box.replaceChildren(inkPad(data, { h, icon, onChange: inkChanged, penOnly: Store.get('penSeen', false), onPenSeen: () => Store.set('penSeen', true) }));
    };
    if (hasInk(lec.ink && lec.ink[k])) open();
    else box.append(h('button', { class: 'on-ink-open', onclick: () => { open(); sfx('tap'); } }, icon('pencil'), '手寫筆記', h('span', null, '用觸控筆或手指直接寫')));
    return box;
  }
  const doc = h('div', { class: 'on-doc' + (Store.get('outlineMode', 'notes') === 'outline' ? ' brief' : '') }, sections);
  const total = n.outline.reduce((a, o) => a + o.points.length, 0);
  return [
    h('div', { class: 'quiz-bar' },
      h('span', { class: 'muted small' }, `共 ${n.outline.length} 段・${total} 個要點`),
      h('button', { class: 'btn sm gn-btn', onclick: exportOutlineGoodNotes }, icon('notebook-pen'), '匯出到 GoodNotes'),
      seg([{ v: 'notes', label: '完整筆記' }, { v: 'outline', label: '只看大綱' }], Store.get('outlineMode', 'notes'), v => { Store.set('outlineMode', v); doc.classList.toggle('brief', v === 'outline'); doc.querySelectorAll('.shut').forEach(x => x.classList.remove('shut')); }, 'seg')),
    doc];
}
// The quiz: multiple choice and fill-in-the-blank. Notes saved before quizzes existed get one built from their terms and key points.
const quizCache = new WeakMap();
function quizOf(n) {
  if (n.quiz && n.quiz.length) return n.quiz;
  if (!quizCache.has(n)) quizCache.set(n, buildQuiz(n));
  return quizCache.get(n);
}
const normAns = t => String(t || '').toLowerCase().replace(/[\s\u3000。，、．.,;；:：!?！？'"「」『』()（）\-＿_]/g, '');
function quizView(n) {
  const qs = quizOf(n);
  if (!qs.length) return emptyNote('這堂課的內容還不夠出題。名詞和重點多一點之後，重新整理筆記就會有測驗。');
  const state_ = qs.map(() => null);          // null = not answered, true / false = result
  const score = h('b', null, '0');
  const done = h('span', null, '0');
  const bar = h('i');
  const box = h('div', { class: 'quiz-list' });
  const update = () => {
    const answered = state_.filter(x => x !== null).length, right = state_.filter(x => x === true).length;
    score.textContent = String(right); done.textContent = String(answered);
    bar.style.width = (answered / qs.length) * 100 + '%';
    if (answered === qs.length) {
      const pct = Math.round((right / qs.length) * 100);
      toast(pct === 100 ? '全對！這堂課你都懂了' : pct >= 70 ? `答對 ${right}／${qs.length}，再看一下錯的那幾題` : `答對 ${right}／${qs.length}，建議回去重聽錯的地方`, { icon: pct >= 70 ? 'check' : 'info', ms: 4200 });
      if (pct === 100) bloom();
    }
  };
  const explain = q => h('div', { class: 'qz-exp' }, icon('sparkles'), h('div', null, bi(q.explanation)));
  const card = (q, k) => {
    const el = h('div', { class: 'qz ' + q.type, style: `--i:${k}` },
      h('div', { class: 'qz-head' }, h('span', { class: 'qz-no' }, String(k + 1)), h('span', { class: 'qz-kind' }, q.type === 'choice' ? '選擇題' : '填充題')),
      h('div', { class: 'qz-q' }, bi(q.question)));
    const finish = ok => { state_[k] = ok; el.classList.add('answered', ok ? 'right' : 'wrong'); if (q.explanation && (q.explanation.zh || q.explanation.en)) el.append(explain(q)); sfx(ok ? 'on' : 'off'); buzz(ok ? 'success' : 'medium'); update(); };
    if (q.type === 'choice') {
      const order = q.options.map((_, i) => i).sort(() => Math.random() - .5);   // so the right answer isn't always in the same spot
      const opts = h('div', { class: 'qz-opts' }, order.map((oi, j) => h('button', { class: 'qz-opt', onclick: e => {
        if (state_[k] !== null) return;
        const ok = oi === q.answer_index;
        e.currentTarget.classList.add(ok ? 'right' : 'wrong');
        if (!ok) opts.children[order.indexOf(q.answer_index)]?.classList.add('right');
        jelly(e.currentTarget, ok ? 1 : .6);
        finish(ok);
      } }, h('span', { class: 'qz-key' }, 'ABCD'[j] || '•'), h('span', null, bi(q.options[oi])))));
      el.append(opts);
    } else {
      const accepted = [q.answer.zh, q.answer.en].filter(Boolean);
      const input = h('input', { class: 'input', placeholder: '填入答案', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': `第 ${k + 1} 題答案` });
      const check = reveal => {
        if (state_[k] !== null) return;
        const v = normAns(input.value);
        if (!v && !reveal) { jelly(input, .5); input.focus(); return; }
        const ok = !reveal && accepted.some(a => { const x = normAns(a); return x && (v === x || (v.length >= 2 && v.includes(x))); });
        input.disabled = true;
        el.append(h('div', { class: 'qz-ans' }, ok ? '答對了：' : '正確答案：', h('b', null, accepted.join(' / '))));
        finish(ok);
      };
      input.addEventListener('keydown', e => { if (e.key === 'Enter') check(false); });
      el.append(h('div', { class: 'qz-fill' }, input,
        h('button', { class: 'btn primary', onclick: () => check(false) }, '對答案'),
        h('button', { class: 'btn ghost', onclick: () => check(true) }, '不會，看答案')));
    }
    return el;
  };
  const paint = () => { state_.fill(null); box.replaceChildren(...qs.map(card)); update(); };
  paint();
  const nC = qs.filter(q => q.type === 'choice').length;
  return [
    h('div', { class: 'quiz-bar qz-bar' },
      h('div', { class: 'grow' }, h('div', { class: 'muted small' }, `選擇題 ${nC} 題・填充題 ${qs.length - nC} 題`), h('div', { class: 'meter' }, bar)),
      h('div', { class: 'qz-score' }, '答對 ', score, ' ／ 已答 ', done),
      h('button', { class: 'btn sm', onclick: paint }, icon('refresh-cw'), '重新作答')),
    n.engine === 'claude'
      ? h('p', { class: 'qz-source' }, icon('sparkles'), h('span', null, '這份題目由 Claude 讀完整堂課和講義後出的，考的是理解和應用。'))
      : h('p', { class: 'qz-source' }, icon('info'), h('span', null, '這份題目是從這堂課的錄音內容和上傳的講義直接挑出來的。接上 Claude 金鑰後重新整理筆記，題目會更好：考理解和應用，錯的選項也更像真的。 ',
        h('button', { class: 'linklike', onclick: showPlans }, '看要怎麼接'))),
    box];
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
    quiz: quizOf(n),
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
  toast(text, { icon: 'refresh-cw', ms: 120000 });
  const el = () => document.querySelector('#toast span');
  let last = text;
  return {
    set: t => { const e = el(); if (e && e.textContent === last) { e.textContent = t; last = t; } },
    // Only take the toast down if it is still ours (another message may have replaced it).
    done: () => { const e = el(); if (e && e.textContent === last) { clearTimeout(toast._t); $('#toast').classList.remove('show'); } },
  };
}
// ---- 大綱筆記 → a real PDF file, handed straight to GoodNotes through the share sheet ----
const loadScript = src => new Promise((res, rej) => {
  if (document.querySelector(`script[src="${src}"]`)) return res();
  const el = document.createElement('script'); el.src = src; el.onload = res; el.onerror = () => rej(new Error('無法載入 PDF 元件，請確認網路連線')); document.head.append(el);
});
async function outlinePDF(lec, onStep) {
  const n = lec.notes;
  await Promise.all([loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'), loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js')]);
  if (!outlineTerms.has(n)) outlineNotes(n);
  const ink = {};
  for (const [k, d] of Object.entries(lec.ink || {})) { const img = inkImage(d); if (img) ink[k] = img; }
  const blocks = outlineBlocks(lec, n, { lang: state.lang, fmtDate, fmtTime, ink, terms: outlineTerms.get(n) || [] });
  const root = h('div', { class: 'gnx' });
  root.innerHTML = `<style>${OUTLINE_CSS}</style><div class="g-flow"></div>`;
  document.body.append(root);
  try {
    const flow = root.querySelector('.g-flow');
    flow.innerHTML = blocks.join('');
    await Promise.all([...flow.querySelectorAll('img')].map(i => (i.decode ? i.decode().catch(() => {}) : null)));
    // Fill A4 pages block by block, so a section is never cut in half.
    const ROOM = 1123 - 54 - 60 - 8;
    const pages = []; let cur = null, used = 0;
    for (const b of [...flow.children]) {
      const cs = getComputedStyle(b);
      const hgt = b.offsetHeight + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
      const filler = b.classList.contains('g-write');
      if (!cur || (used + hgt > ROOM && !(filler && used + 40 <= ROOM))) {
        if (filler && cur) continue;                 // no ruled lines stranded at the top of a new page
        // The next section starts on a fresh page: rule the space left on this one, so it can be written on in GoodNotes.
        if (cur && ROOM - used >= 90) cur.append(h('div', { class: 'g-write' }, Array.from({ length: Math.floor((ROOM - used - 12) / 34) }, () => h('i'))));
        cur = h('div', { class: 'g-page' }); pages.push(cur); used = 0;
      }
      if (filler && used + hgt > ROOM) { [...b.children].slice(Math.max(1, Math.floor((ROOM - used) / 34))).forEach(x => x.remove()); }
      cur.append(b); used += Math.min(hgt, ROOM - used);
    }
    flow.remove();
    pages.forEach((pg, i) => { pg.append(h('div', { class: 'g-foot' }, h('span', null, `${lec.course ? lec.course + ' · ' : ''}${n.title.zh || n.title.en || lec.title}`), h('span', null, `${i + 1} / ${pages.length}`))); root.append(pg); });
    const pdf = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4', compress: true });
    for (let i = 0; i < pages.length; i++) {
      onStep && onStep(i + 1, pages.length);
      const canvas = await window.html2canvas(pages[i], { scale: 2, backgroundColor: '#ffffff', logging: false, useCORS: true, x: 0, y: 0, scrollX: 0, scrollY: 0, windowWidth: 794 });
      if (i) pdf.addPage();
      pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, 595.28, 841.89, undefined, 'FAST');
    }
    let extra = 0;
    if (n.mind_map && n.mind_map.branches && n.mind_map.branches.length) {
      try {
        onStep && onStep(pages.length + 1, pages.length + 1);
        const mm = await mindMapPage(lec);
        pdf.addPage([mm.wPt, mm.hPt], 'landscape');
        pdf.addImage(mm.canvas.toDataURL('image/jpeg', 0.93), 'JPEG', 0, 0, mm.wPt, mm.hPt, undefined, 'FAST');
        extra = 1;
      } catch (e) { console.warn('mind map page skipped', e); }
    }
    return { blob: pdf.output('blob'), pages: pages.length + extra };
  } finally { root.remove(); }
}
// The mind map as one landscape page. A big map gets a bigger page instead of tiny text; GoodNotes zooms it like any page.
const hexMix = (hex, pct) => { const n = parseInt(hex.replace('#', ''), 16); const c = [n >> 16 & 255, n >> 8 & 255, n & 255].map(v => Math.round(v * pct + 255 * (1 - pct))); return `rgb(${c.join(',')})`; };
const MM_PDF_CSS = `
.mmpdf { position: fixed; left: -30000px; top: 0; background: #fff; color: #1f1b2e; font-family: -apple-system, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif; box-sizing: border-box; display: flex; flex-direction: column; }
.mmpdf * { box-sizing: border-box; }
.mmpdf .mp-head { display: flex; align-items: baseline; gap: 14px; border-bottom: 2px solid #8b5cf6; padding-bottom: 10px; }
.mmpdf .mp-head h1 { margin: 0; font-size: 24px; font-weight: 800; }
.mmpdf .mp-head span { font-size: 13px; color: #6b6780; }
.mmpdf .mp-head em { margin-left: auto; font-style: normal; font-size: 12px; font-weight: 700; color: #8b5cf6; letter-spacing: .08em; }
.mmpdf .mp-map { flex: 1; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.mmpdf .mmx-l0 { box-shadow: none !important; background: #8b5cf6 !important; color: #fff !important; }
.mmpdf .mmx-l1 { box-shadow: none !important; background: var(--c) !important; color: #fff !important; }
.mmpdf .mmx-l2 { box-shadow: none !important; background: #fff !important; color: #1f1b2e !important; border: 1.5px solid var(--cl) !important; border-left: 4px solid var(--c) !important; }
.mmpdf .mmx-l3 { color: #3b3650 !important; }
.mmpdf .mmx-chip { background: var(--cbg) !important; color: #3b3650 !important; border: 1px solid var(--cl) !important; }
`;
async function mindMapPage(lec) {
  const n = lec.notes;
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js');
  const html = staticMindMapHTML(n.mind_map, mmText, 1e6, 0);            // natural size, no scaling
  const [, w, hh] = html.match(/width:(\d+)px;height:(\d+)px/).map(Number);
  const PADX = 44, HEAD = 64, PADY = 34;
  const fit = Math.min((1123 - PADX * 2) / w, (794 - HEAD - PADY * 2) / hh);
  const grow = Math.min(2, Math.max(1, 0.72 / fit));                      // enlarge the page rather than shrink text below ~72%
  const PW = Math.round(1123 * grow), PH = Math.round(794 * grow);
  const k = Math.min(1.5, (PW - PADX * 2) / w, (PH - HEAD - PADY * 2) / hh);
  const root = h('div', { class: 'mmpdf', style: `width:${PW}px;height:${PH}px;padding:${PADY}px ${PADX}px` });
  root.innerHTML = `<style>${MM_PDF_CSS}</style><div class="mp-head"><h1></h1><span></span><em>心智圖 MIND MAP</em></div>
<div class="mp-map"><div style="width:${(w * k).toFixed(0)}px;height:${(hh * k).toFixed(0)}px;flex:none"><div style="width:${w}px;height:${hh}px;transform:scale(${k.toFixed(4)});transform-origin:0 0">${html}</div></div></div>`;
  root.querySelector('h1').textContent = n.title.zh || n.title.en || lec.title;
  root.querySelector('.mp-head span').textContent = [lec.course, fmtDate(lec.created)].filter(Boolean).join(' · ');
  root.querySelectorAll('.mmx-n').forEach(el => { const c = el.style.getPropertyValue('--c').trim() || '#8b5cf6'; el.style.setProperty('--cl', hexMix(c, 0.45)); el.style.setProperty('--cbg', hexMix(c, 0.12)); });
  document.body.append(root);
  try {
    const canvas = await window.html2canvas(root, { scale: Math.max(1.3, 2 / grow), backgroundColor: '#ffffff', logging: false, x: 0, y: 0, scrollX: 0, scrollY: 0, windowWidth: PW, windowHeight: PH });
    return { canvas, wPt: 841.89 * grow, hPt: 595.28 * grow };
  } finally { root.remove(); }
}
async function mindMapPDF(lec) {
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
  const pg = await mindMapPage(lec);
  const pdf = new window.jspdf.jsPDF({ unit: 'pt', format: [pg.wPt, pg.hPt], orientation: 'landscape', compress: true });
  pdf.addImage(pg.canvas.toDataURL('image/jpeg', 0.93), 'JPEG', 0, 0, pg.wPt, pg.hPt, undefined, 'FAST');
  return { blob: pdf.output('blob'), pages: 1 };
}
// "PDF is ready" sheet: share straight into GoodNotes where the browser can, download otherwise.
function pdfReadySheet(out, name) {
  const file = new File([out.blob], name, { type: 'application/pdf' });
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
  const url = URL.createObjectURL(out.blob);
  let dlg;
  dlg = openDialog([
    h('div', { class: 'cal-head' }, h('span', { class: 'sticker', style: '--sz:46px;--r:-8deg;--a:#f59e0b;--b:#ef4444;animation:none' }, icon('notebook-pen')),
      h('div', null, h('h3', { style: 'margin:0' }, 'PDF 準備好了'), h('div', { class: 'muted small' }, `${name} · ${out.pages} 頁 · ${(out.blob.size / 1048576).toFixed(1)} MB`))),
    h('p', { class: 'muted', style: 'margin:12px 0 0;line-height:1.65' }, canShare
      ? '按下面的按鈕，在分享選單選「Goodnotes」，就會變成一本新的筆記本，可以直接在上面繼續寫。'
      : '這個瀏覽器不能直接分享檔案。先下載 PDF，再到 GoodNotes 按「＋」→「匯入」選這個檔案。'),
    h('div', { class: 'cal-actions' },
      canShare ? h('button', { class: 'btn primary lg block', onclick: async () => {
        try { await navigator.share({ files: [file], title: name }); dlg.closeDialog(); }
        catch (e) { if (e.name !== 'AbortError') toast('分享失敗，請改用下載', { icon: 'info' }); }
      } }, icon('share'), '傳到 GoodNotes') : null,
      h('a', { class: 'btn lg block' + (canShare ? '' : ' primary'), href: url, download: name }, icon('download'), '下載 PDF'),
      h('button', { class: 'btn ghost block', onclick: () => dlg.closeDialog() }, '關閉')),
  ], { cls: 'sheet', onClose: () => setTimeout(() => URL.revokeObjectURL(url), 60000) });
}
async function exportMindMapGoodNotes() {
  const lec = state.lecture; if (!lec || !lec.notes) return;
  sfx('tap');
  const b = busyToast('正在把心智圖做成 PDF…');
  let out;
  try { out = await mindMapPDF(lec); }
  catch (e) { console.error(e); b.done(); toast('匯出失敗：' + (e.message || e), { icon: 'info', ms: 5000 }); return; }
  b.done();
  pdfReadySheet(out, `${safeName(lec.notes.title.zh || lec.title)}-心智圖.pdf`);
}
async function exportOutlineGoodNotes() {
  const lec = state.lecture; if (!lec || !lec.notes) return;
  sfx('tap');
  const b = busyToast('正在把大綱筆記排成 PDF…');
  let out;
  try { out = await outlinePDF(lec, (i, nPages) => b.set(`正在排版第 ${i}／${nPages} 頁…`)); }
  catch (e) { console.error(e); b.done(); toast('匯出失敗：' + (e.message || e), { icon: 'info', ms: 5000 }); return; }
  b.done();
  pdfReadySheet(out, `${safeName(lec.notes.title.zh || lec.title)}-大綱筆記.pdf`);
}
async function exportGoodNotes() {
  const lec = state.lecture; if (!lec || !lec.notes) return;
  if (!NATIVE) return exportOutlineGoodNotes();   // web: a real PDF (大綱筆記 + 心智圖) through the share sheet
  sfx('tap');
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
      opt('notebook-pen', '#f59e0b', '#ef4444', '匯出到 GoodNotes', NATIVE ? '排版好的 A4 PDF，含心智圖和可手寫的測驗空白處' : '大綱筆記、手寫和心智圖做成 PDF，直接傳到 GoodNotes', exportGoodNotes, hasNotes),
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
  L.push('## 自我測驗 Review'); quizOf(n).forEach((q, k) => { L.push(`${k + 1}. ${q.type === 'choice' ? '（選擇）' : '（填充）'}${pair(q.question)}`); q.options.forEach((o, j) => L.push(`   - (${'ABCD'[j]}) ${pair(o)}`)); });
  L.push(''); L.push('### 解答'); quizOf(n).forEach((q, k) => L.push(`${k + 1}. ${q.type === 'choice' ? '(' + 'ABCD'[q.answer_index] + ') ' + pair(q.options[q.answer_index]) : pair(q.answer)}${pair(q.explanation) ? '　—　' + pair(q.explanation) : ''}`)); L.push('');
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
  if (!f.blob) return h('pre', { class: 'file-preview', style: 'white-space:pre-wrap;height:auto;max-height:60vh;overflow:auto;font-size:.85rem;padding:14px;background:var(--surface)' },
    '這份講義的原始檔留在上傳它的那台裝置，這裡只有讀出來的文字。\n\n' + (f.text || '（沒有可顯示的文字）').slice(0, 20000));
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
        await DB.del(lec.id); Cloud.remove(lec.id, lec); go('#/');
      }, 'danger')),
    h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => dlg.closeDialog() }, '關閉')),
  ], { cls: 'sheet' });
}

/* ---------- settings ---------- */
function accentPicker() {
  const cur = () => Store.get('accent', 'violet');
  const box = h('div', { class: 'swatches' });
  const note = h('div', { class: 'swatch-note muted small' });
  const say = () => { const k = cur(); note.textContent = k === 'auto' ? '自動：顏色會跟著你正在看的課程變化，每門課有自己的顏色。' : k === 'custom' ? '自訂：點最後一格可以再換顏色。' : (ACCENTS.find(a => a[0] === k) || ACCENTS[0])[1]; };
  const pick = (k, el) => { Store.set('accent', k); applyAppearance(); box.querySelectorAll('.swatch').forEach(s => s.classList.toggle('on', s === el)); custom.replaceChildren(input, icon(k === 'custom' ? 'check' : 'plus')); say(); sfx('tap'); };
  const auto = h('button', { class: 'swatch auto' + (cur() === 'auto' ? ' on' : ''), 'aria-label': '自動', title: '自動（跟著課程變色）', onclick: e => pick('auto', e.currentTarget) }, icon('check'));
  const input = h('input', { type: 'color', value: Store.get('accentCustom', '#9b51e0'), 'aria-label': '自訂顏色', tabindex: '-1' });
  const custom = h('label', { class: 'swatch custom' + (Store.get('accentCustom', null) ? ' has' : '') + (cur() === 'custom' ? ' on' : ''), title: '自訂顏色', style: `--a:${Store.get('accentCustom', '#9b51e0')};--b:${Store.get('accentCustom', '#9b51e0')}` }, input, icon(cur() === 'custom' ? 'check' : 'plus'));
  const setCustom = () => { Store.set('accentCustom', input.value); custom.style.setProperty('--a', input.value); custom.style.setProperty('--b', input.value); custom.classList.add('has'); pick('custom', custom); };
  input.addEventListener('input', setCustom);
  input.addEventListener('click', () => { if (Store.get('accentCustom', null)) setCustom(); });
  const dark = document.documentElement.dataset.theme === 'dark';
  box.append(auto, ...ACCENTS.map(([k, label, a, b, da, db]) => h('button', {
    class: 'swatch' + (cur() === k ? ' on' : ''), style: `--a:${dark ? da : a};--b:${dark ? db : b}`, 'aria-label': label, title: label, onclick: e => pick(k, e.currentTarget) }, icon('check'))), custom);
  say();
  return h('div', null, box, note);
}
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
        if (key === 'anthropicKey' && v) { renderSettings(); testClaude(); return; }
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
      Account.REAL_AUTH ? group('帳號', accountCard()) : null,
      group('外觀',
        colRow('palette', '#9b51e0', '主題', '跟著系統，或固定淺色／深色',
          seg([{ v: 'system', label: '系統', icon: 'monitor' }, { v: 'light', label: '淺色', icon: 'sun' }, { v: 'dark', label: '深色', icon: 'moon' }],
            Store.get('theme', 'system'), (v, e) => setTheme(v, e), 'seg full accent')),
        colRow('sparkles', '#ef4f6b', '主題色', null,
          accentPicker()),
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
        colRow('languages', '#1b84d1', '教授主要使用的語言', '內建辨識一次只能一種語言；接上 Soniox 可中英混講',
          seg([{ v: 'zh', label: '中文為主' }, { v: 'en', label: '英文為主' }], cfg.mainLang, v => Store.set('mainLang', v), 'seg full')),
        row('captions', '#17946f', '即時翻譯', pro ? '每句旁邊顯示另一種語言（Soniox）' : (localTranslateSupported() ? '使用瀏覽器內建翻譯（電腦版 Chrome）' : '這個瀏覽器沒有內建翻譯；接上 Soniox 可用'),
          switchEl(cfg.translate, v => Store.set('translate', v), '即時翻譯')),
        row('lightbulb', '#f59e0b', '讓字幕更準的方法', '上課前的準備、下課後用 AI 修順逐字稿、錄音時能不能切到別的 App', h('button', { class: 'btn sm', onclick: () => showTips() }, '看提醒')),
        row('headphones', '#e07a2e', '保存錄音檔', '可以點逐字稿回放那段錄音；一小時約 15 MB', switchEl(cfg.saveAudio, v => Store.set('saveAudio', v), '保存錄音檔')),
        !NATIVE ? hifiRow() : null,
        !NATIVE ? row('mic', '#ec4899', '加強收音（坐後排也聽得到）', '把遠處講者的聲音放大、濾掉冷氣和桌椅的低頻噪音，再交給內建辨識。只影響辨識，不影響保存的錄音',
          switchEl(Store.get('farField', true), v => Store.set('farField', v), '加強收音')) : null,
        NATIVE ? row('sparkles', '#8b5cf6', '辨識更準確', '有網路時交給 Apple 伺服器辨識，比手機上辨識準；關閉則完全在手機上處理',
          switchEl(Store.get('accurateSpeech', true), v => Store.set('accurateSpeech', v), '辨識更準確')) : null,
        NATIVE ? row('audio-lines', '#ec4899', '動態島即時字幕', '切到別的 App 或鎖定螢幕時，在動態島和鎖定畫面顯示教授說的話',
          switchEl(Store.get('liveCaptions', true), v => Store.set('liveCaptions', v), '動態島即時字幕')) : null,
        row('book-open', '#10b981', '用講義校正專有名詞', '上課前先上傳講義：課名、投影片上的英文術語和之前的名詞表，會先告訴辨識引擎，人名和術語更不容易聽錯')),
      group('裝置上的 AI（免費）', localAIRow(),
        h('button', { class: 'row-item', style: 'width:100%;text-align:left;font:inherit;color:inherit;background:none;border:0;cursor:pointer', onclick: () => showPlans() },
          h('span', { class: 'ri-ico', style: '--c:#9b51e0' }, icon('list-tree')), h('div', { class: 'ri-text' }, h('b', null, '哪些免費，哪些要接 API'), h('span', null, '看完整對照表')), icon('chevron-right'))),
      group('接上 API，會更聰明',
        keyRow('audio-lines', '#5b5ce2', 'Soniox（即時字幕）', 'sonioxKey', '貼上 Soniox API key',
          ['到 ', h('a', { href: 'https://console.soniox.com', target: '_blank', rel: 'noopener' }, 'console.soniox.com'), ' 註冊並儲值後建立。']),
        keyRow('sparkles', '#d4820f', 'Anthropic（Claude 筆記）', 'anthropicKey', 'sk-ant-…',
          ['到 ', h('a', { href: 'https://console.anthropic.com', target: '_blank', rel: 'noopener' }, 'console.anthropic.com'), ' 儲值後建立，使用 Claude Opus 5.5。']),
        colRow('list-tree', '#1f9fb3', '筆記詳細程度', '只影響 Claude 整理的筆記',
          seg([{ v: 'brief', label: '精簡' }, { v: 'standard', label: '標準' }, { v: 'detailed', label: '詳細' }], cfg.detail, v => Store.set('detail', v), 'seg full'))),
      group('教學',
        row('book-open', '#8b5cf6', '重看使用教學', '第一次打開時看到的滑動教學', h('button', { class: 'btn sm', onclick: () => showIntro() }, '播放'))),
      group('隱私與儲存',
        Account.REAL_AUTH ? row('shield-check', '#1f9d55', '資料存在哪裡', '沒登入時，所有資料只存在這台裝置。登入後，逐字稿、筆記和手寫會備份到你的帳號（Google Firebase），只有你自己讀得到。錄音檔和 API 金鑰永遠只留在這台裝置。')
          : row('shield-check', '#1f9d55', '資料只存在這台裝置', '錄音、逐字稿、講義、筆記和金鑰都不會上傳到這個網站，也不會同步到其他裝置。'),
        h('div', { class: 'row-item col' },
          h('div', { class: 'ri-head' }, h('span', { class: 'ri-ico', style: '--c:#6b7280' }, icon('cpu')), h('div', { class: 'ri-text' }, h('b', null, '儲存空間'), h('span', null, usageTxt || '無法讀取'))),
          h('div', { class: 'meter' }, h('i', { style: `width:${usagePct}%` })))),
      h('p', { class: 'muted small', style: 'text-align:center;margin:28px 0 0' }, '蛤說啥 Say What? · 圖示來自 Lucide'))));
  afterRender();
}

// Settings row for the browser's own AI model: shows whether this device has it, and downloads it when it can.
function hifiRow() {
  const desc = h('span', null, '');
  const ctl = h('div', { class: 'hifi-ctl' });
  const size = h('div', { class: 'hifi-size' });
  const el = h('div', { class: 'row-item hifi-row' }, h('span', { class: 'ri-ico', style: '--c:#0ea5e9' }, icon('cpu')),
    h('div', { class: 'ri-text' }, h('b', null, '高準確字幕（免費，在這台裝置上辨識）'), desc, size), ctl);
  const pick = async v => { Store.set('hifiSize', v); HiFi.setSize(v); hifi.has = await HiFi.downloaded(); paint(); };
  const paint = () => {
    const mb = HiFi.SIZE_MB[HiFi.pickSize()];
    if (!hifi.ok) {
      desc.textContent = '這台裝置的瀏覽器不支援（需要能使用繪圖晶片的新版 Chrome 或 Edge；iPhone 和 iPad 需要 iOS 26 以上的 Safari，較舊的機型可能無法使用）。';
      ctl.replaceChildren(); size.hidden = true; return;
    }
    size.hidden = false;
    size.replaceChildren(
      seg([{ v: 'large', label: `最準 ${HiFi.SIZE_MB.large} MB` }, { v: 'small', label: `輕量 ${HiFi.SIZE_MB.small} MB` }], HiFi.pickSize(), pick),
      h('span', { class: 'muted small' }, HiFi.pickSize() === 'large' ? '講很快又有噪音時最準；手機和記憶體較少的平板請選輕量' : '比較省記憶體，適合手機和平板；講很快又有噪音時會比「最準」多一些錯字'));
    afterRender();
    if (proReady().stt) { desc.textContent = '你已經接上 Soniox，上課會用 Soniox 辨識。'; ctl.replaceChildren(); size.hidden = true; return; }
    if (hifi.has) {
      desc.textContent = '教授離得遠、有風扇聲、講得快或含糊時，比瀏覽器內建辨識準很多。字幕大約晚半分鐘出現，聲音不會離開這台裝置。';
      ctl.replaceChildren(
        switchEl(Store.get('hifi', true), v => { Store.set('hifi', v); }, '高準確字幕'),
        h('button', { class: 'btn sm ghost', title: '刪除下載的辨識模型，釋放空間', onclick: async () => { await HiFi.forget(); hifi.has = false; paint(); toast('已移除辨識模型', { icon: 'trash-2' }); } }, '移除'));
      return;
    }
    desc.textContent = `瀏覽器內建辨識是為近距離口述設計的，隔著教室會漏掉大部分內容。下載辨識模型（約 ${mb} MB，只需要一次，建議用 Wi-Fi）之後，就能在這台裝置上聽寫。`;
    const b = h('button', { class: 'btn sm primary', onclick: async () => {
      b.disabled = true; b.textContent = '準備中…';
      try {
        const prog = (a, t) => { b.textContent = `下載中 ${Math.round(a / 1e6)} / ${Math.round(t / 1e6)} MB`; };
        await HiFi.load(prog);
        // Some browsers cannot keep the bigger model: it would have to be downloaded again before every class. Use the one that stays.
        if (!(await HiFi.downloaded()) && HiFi.pickSize() === 'large') {
          Store.set('hifiSize', 'small'); HiFi.setSize('small');
          toast('這個瀏覽器存不下「最準」的模型，改下載「輕量」版', { icon: 'info', ms: 6000 });
          await HiFi.load(prog);
        }
        hifi.has = await HiFi.downloaded();
        if (!hifi.has) throw new Error('瀏覽器沒有把模型存下來（可能是空間不足或無痕模式）');
        Store.set('hifi', true);
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});   // ask the browser not to clear it when space runs low
        toast('高準確字幕已經準備好，下次錄音就會使用', { icon: 'check', ms: 5000 });
      } catch (e) { console.error(e); toast('下載沒有完成：' + ((e && e.message) || e), { icon: 'info', ms: 7000 }); }
      paint();
    } }, '下載');
    ctl.replaceChildren(b);
  };
  paint();
  HiFi.capability().then(c => { if (!c.ok && hifi.ok) { hifi.ok = false; } paint(); });
  return el;
}
function localAIRow() {
  const desc = h('span', null, '檢查中…');
  const ctl = h('div', null);
  const el = h('div', { class: 'row-item' }, h('span', { class: 'ri-ico', style: '--c:#14b8a6' }, icon('cpu')),
    h('div', { class: 'ri-text' }, h('b', null, '用裝置上的 AI 回答助教問題'), desc), ctl);
  const paint = async () => {
    const st = await LocalAI.status();
    if (st === 'available') {
      desc.textContent = '這台裝置已經有 Chrome 內建的 AI 模型。不用金鑰、不用網路，內容不會離開裝置。';
      ctl.replaceChildren(switchEl(Store.get('localAI', true), v => Store.set('localAI', v), '裝置上的 AI'));
    } else if (st === 'downloadable' || st === 'downloading') {
      desc.textContent = '這個瀏覽器支援內建 AI，但模型還沒下載（約 2–4 GB，只需要一次，建議用 Wi-Fi）。';
      const b = h('button', { class: 'btn sm', onclick: async () => {
        b.disabled = true;
        try { await LocalAI.download(p => { b.textContent = `下載中 ${Math.round(p * 100)}%`; }); toast('裝置上的 AI 已經準備好', { icon: 'check' }); }
        catch (e) { console.error(e); toast('下載失敗，稍後再試一次', { icon: 'info' }); }
        b.disabled = false; paint();
      } }, st === 'downloading' ? '下載中…' : '下載');
      ctl.replaceChildren(b);
    } else {
      desc.textContent = '這個瀏覽器沒有內建 AI（目前只有較新的電腦版 Chrome 有）。助教會改用搜尋，幫你找出相關片段。';
      ctl.replaceChildren();
    }
  };
  paint();
  return el;
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
    vt.finished.catch(() => {}).finally(() => root.classList.remove('vt-nav'));   // aborted when the tab is hidden: nothing to do
    vt.ready.catch(() => {});
    try { await vt.updateCallbackDone; } catch { /* rendered anyway */ }
    return;
  }
  await render();
  window.scrollTo(0, 0);
}
async function render() {
  if (Store.get('accent', 'violet') === 'auto') applyAppearance();
  if (state.view === 'lecture') renderLecture();
  else if (state.view === 'settings') await renderSettings();
  else await renderHome();
}
window.addEventListener('hashchange', route);
const refreshAfterSync = () => { if (state.view !== 'lecture' && !document.querySelector('dialog[open]') && !document.querySelector('#intro')) render(); };
Cloud.init({ all: () => DB.all(), get: id => DB.get(id), put: o => DB.put(o), del: id => DB.del(id),
  isOpen: id => !!(state.lecture && state.lecture.id === id), onChange: refreshAfterSync });
Account.watchAccount(() => { if (!document.querySelector('dialog[open]')) render(); }, uid => Cloud.setUser(uid));
let lastCloudCheck = Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) Cloud.flush();
  else if (Cloud.user() && Date.now() - lastCloudCheck > 120000) { lastCloudCheck = Date.now(); Cloud.sync(); }
});
window.addEventListener('online', () => { if (Cloud.user()) Cloud.sync(); });
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
window.__lectureNotes = { importAudioFile, HiFi, hifi, splitCaption, relistenLecture, mindMapPDF, mindMapPage, polishTranscript, Cloud, Account, DB, state, Recorder, outlinePDF, BrowserSTT, MicCapture, LocalAI, render, buildFreeNotes, player, renderPlayer, bloom, calendarSheet, notesDocHTML, shareSheet, speechVocab };
// Launch animation lives in index.html so it shows on the very first frame; take it away once it has played.
const splash = document.getElementById('splash');
const splashMs = splash && getComputedStyle(splash).display !== 'none' && motionOn() ? 2050 : 0;
if (splash) setTimeout(() => splash.classList.add('gone'), splashMs || 0);
if (splashMs) setTimeout(() => buzz('soft'), 380);
// Arriving from the introduction page (welcome.html → ./?from=welcome) counts as a fresh start: the tour and the
// sign-in offer are shown even if this browser has seen them before. The marker is dropped so a reload does not repeat it.
const fromWelcome = new URLSearchParams(location.search).get('from') === 'welcome';
if (fromWelcome) history.replaceState(null, '', location.pathname + location.hash);
route().then(() => { if (fromWelcome || !Store.get('onboarded', false)) setTimeout(() => showIntro({ fresh: fromWelcome }), splashMs ? 1500 : 200); });
