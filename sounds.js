// Soft UI sounds, synthesized with Web Audio so nothing is downloaded.
// Each style has: tap (any button), on/off (switches), nav (tabs), start/stop (recording), done (notes ready).

let ctx = null;
let master = null;
function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function env(g, t, a, peak, d) {
  g.gain.cancelScheduledValues(t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
}
function tone({ type = 'sine', f0, f1, dur = 0.08, peak = 0.3, attack = 0.004, delay = 0, filter }) {
  const c = ac(); if (!c) return;
  const t = c.currentTime + delay;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  let node = o;
  if (filter) { const bq = c.createBiquadFilter(); bq.type = filter.type; bq.frequency.value = filter.f; bq.Q.value = filter.q || 1; o.connect(bq); node = bq; }
  node.connect(g); g.connect(master);
  env(g, t, attack, peak, dur);
  o.start(t); o.stop(t + attack + dur + 0.05);
}
function noise({ dur = 0.03, peak = 0.2, f = 2000, q = 4, delay = 0 }) {
  const c = ac(); if (!c) return;
  const t = c.currentTime + delay;
  const len = Math.max(1, Math.floor(c.sampleRate * (dur + 0.02)));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const s = c.createBufferSource(); s.buffer = buf;
  const bq = c.createBiquadFilter(); bq.type = 'bandpass'; bq.frequency.value = f; bq.Q.value = q;
  const g = c.createGain();
  s.connect(bq); bq.connect(g); g.connect(master);
  env(g, t, 0.002, peak, dur);
  s.start(t); s.stop(t + dur + 0.05);
}

const STYLES = {
  bubble: {
    tap: () => tone({ f0: 620, f1: 300, dur: 0.07, peak: 0.28 }),
    on: () => tone({ f0: 420, f1: 880, dur: 0.09, peak: 0.25 }),
    off: () => tone({ f0: 760, f1: 360, dur: 0.09, peak: 0.22 }),
    nav: () => tone({ f0: 900, f1: 520, dur: 0.05, peak: 0.16 }),
  },
  droplet: {
    tap: () => tone({ f0: 520, f1: 1500, dur: 0.06, peak: 0.22, attack: 0.002 }),
    on: () => { tone({ f0: 600, f1: 1600, dur: 0.06, peak: 0.2 }); tone({ f0: 900, f1: 2000, dur: 0.05, peak: 0.12, delay: 0.06 }); },
    off: () => tone({ f0: 1400, f1: 500, dur: 0.08, peak: 0.18 }),
    nav: () => tone({ f0: 800, f1: 1700, dur: 0.04, peak: 0.13 }),
  },
  wood: {
    tap: () => { tone({ type: 'triangle', f0: 880, f1: 760, dur: 0.035, peak: 0.3, attack: 0.001 }); noise({ dur: 0.02, peak: 0.08, f: 2500 }); },
    on: () => { tone({ type: 'triangle', f0: 700, dur: 0.035, peak: 0.26, attack: 0.001 }); tone({ type: 'triangle', f0: 1050, dur: 0.035, peak: 0.22, attack: 0.001, delay: 0.07 }); },
    off: () => { tone({ type: 'triangle', f0: 1050, dur: 0.035, peak: 0.22, attack: 0.001 }); tone({ type: 'triangle', f0: 700, dur: 0.035, peak: 0.22, attack: 0.001, delay: 0.07 }); },
    nav: () => tone({ type: 'triangle', f0: 1200, f1: 1100, dur: 0.025, peak: 0.18, attack: 0.001 }),
  },
  soft: {
    tap: () => tone({ f0: 2100, f1: 1900, dur: 0.018, peak: 0.12, attack: 0.001 }),
    on: () => tone({ f0: 1800, f1: 2400, dur: 0.03, peak: 0.12, attack: 0.001 }),
    off: () => tone({ f0: 2400, f1: 1700, dur: 0.03, peak: 0.1, attack: 0.001 }),
    nav: () => tone({ f0: 2600, dur: 0.015, peak: 0.08, attack: 0.001 }),
  },
};
const SHARED = {
  // Recording start: gentle rising two-note chime. Stop: falling.
  start: () => { tone({ f0: 523.25, dur: 0.18, peak: 0.22, attack: 0.01 }); tone({ f0: 783.99, dur: 0.28, peak: 0.2, attack: 0.01, delay: 0.12 }); },
  stop: () => { tone({ f0: 783.99, dur: 0.16, peak: 0.2, attack: 0.01 }); tone({ f0: 523.25, dur: 0.3, peak: 0.2, attack: 0.01, delay: 0.12 }); },
  // Notes ready: soft major arpeggio with a little sparkle.
  done: () => { [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone({ f0: f, dur: 0.35, peak: 0.16, attack: 0.01, delay: i * 0.09 })); tone({ f0: 2093, dur: 0.4, peak: 0.05, delay: 0.38 }); },
  flip: () => noise({ dur: 0.08, peak: 0.12, f: 1200, q: 1.2 }),
};

export const SOUND_STYLES = [['bubble', '泡泡'], ['droplet', '水滴'], ['wood', '木頭'], ['soft', '輕觸']];

export function playSound(kind, { style = 'bubble', volume = 0.6 } = {}) {
  try {
    if (!ac()) return;
    master.gain.value = Math.max(0, Math.min(1, volume));
    const fn = SHARED[kind] || (STYLES[style] || STYLES.bubble)[kind] || STYLES.bubble.tap;
    fn();
  } catch { /* audio unavailable */ }
}
