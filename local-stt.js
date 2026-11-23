// High-accuracy captions without a key: cuts the microphone audio into sentences and has the on-device model (stt-worker.js) write them down.
// Slower than the browser's built-in recogniser (text arrives 10-30 s later) but it hears a lecturer across the room, over fan noise.

const RATE = 16000, FRAME = 480;                    // 30 ms
const MIN_LEN = 14 * RATE, MAX_LEN = 27 * RATE;     // a piece is cut at a pause after 14 s, or at the quietest spot before 27 s
const PAUSE = 14, PAD = 8;                          // frames: 0.4 s of quiet ends a piece; keep 0.25 s around speech

// What the model tends to write when it is given noise with nobody speaking.
const GHOST = /字幕|訂閱|订阅|點贊|点赞|按讚|謝謝觀看|谢谢观看|感謝收看|感谢收看|下期再見|Amara|明鏡|歡迎收看|請不吝|subtitles? by|thanks? for watching/i;

let worker = null, ready = null, loadedSize = null, seq = 0;
export let variant = null;   // what the worker actually loaded (it switches to 'lite' on chips without 16-bit floats)
const waiting = new Map();
const progressFns = new Set();

export const supported = () => typeof Worker !== 'undefined' && !!navigator.gpu;
// navigator.gpu can exist with no usable graphics adapter behind it, so the real answer needs asking.
let cap = null;
export function capability() {
  if (!cap) cap = (async () => {
    try { const a = supported() && await navigator.gpu.requestAdapter(); return a ? { ok: true, f16: a.features.has('shader-f16') } : { ok: false, f16: false }; }
    catch { return { ok: false, f16: false }; }
  })();
  return cap;
}
// 'large' hears fast speech over noise better; 'small' is lighter, for phones and tablets with little memory.
let chosen = null;
export const setSize = v => { chosen = v === 'small' || v === 'large' ? v : null; };
export const defaultSize = () => (/iPhone|iPad|Android/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'small' : 'large');
export const pickSize = () => chosen || defaultSize();
export const SIZE_MB = { small: 410, large: 565 };
const MARK = { large: 'whisper-large-v3-turbo', small: 'whisper-small' };
export async function downloaded(size = pickSize()) {
  try {
    const c = await caches.open('transformers-cache');
    const keys = (await c.keys()).map(r => r.url).filter(u => u.includes(MARK[size]) && /\.onnx/.test(u));
    return keys.some(u => /encoder_model/.test(u)) && keys.some(u => /decoder_model/.test(u));
  } catch { return false; }
}
export async function forget() {
  if (worker) { worker.terminate(); worker = null; ready = null; loadedSize = null; }
  try { await caches.delete('transformers-cache'); } catch { /* nothing to remove */ }
}
// Downloads (first time) and starts the model. Safe to call again: the same load is reused.
export const debug = {};
export function load(onProgress, size = pickSize()) {
  if (onProgress) progressFns.add(onProgress);
  if (ready && loadedSize === size) return ready;
  if (worker) worker.terminate();
  loadedSize = size;
  worker = new Worker(new URL('./stt-worker.js', import.meta.url), { type: 'module' });
  ready = new Promise((res, rej) => {
    worker.onmessage = e => {
      const m = e.data;
      if (m.type === 'progress') progressFns.forEach(f => { try { f(m.loaded, m.total); } catch { /* ignore */ } });
      else if (m.type === 'ready') { progressFns.clear(); res(); }
      else if (m.type === 'debug') console.log('stt', JSON.stringify(m.pieces));
      else if (m.type === 'variant') variant = m.size;
      else if (m.type === 'result') { const w = waiting.get(m.id); waiting.delete(m.id); w && w.res(m); }
      else if (m.type === 'error') {
        if (m.stage === 'load') { progressFns.clear(); ready = null; loadedSize = null; rej(new Error(m.message)); }
        else { const w = waiting.get(m.id); waiting.delete(m.id); w && w.rej(new Error(m.message)); }
      }
    };
    worker.onerror = e => { ready = null; loadedSize = null; rej(new Error(e.message || '辨識引擎無法啟動')); };
    worker.postMessage({ type: 'load', size, opts: debug.worker });
  });
  return ready;
}
function transcribe(audio, lang, prompt, gen) {
  return new Promise((res, rej) => {
    const id = ++seq; waiting.set(id, { res, rej });
    const copy = audio.slice();
    worker.postMessage({ type: 'run', id, audio: copy, lang, prompt, gen }, [copy.buffer]);
  });
}

/* ---------- Simplified → Traditional (the model writes whichever it likes) ---------- */
let s2t = null;
async function converter() {
  if (s2t) return s2t;
  try {
    const m = await import('https://cdn.jsdelivr.net/npm/opencc-js@1.0.5/dist/esm/cn2t.js');
    s2t = m.Converter({ from: 'cn', to: 'tw' });
  } catch { s2t = x => x; }
  return s2t;
}

// "的的的的的…" and other loops: keep one copy.
const unloop = t => t.replace(/(.{1,15}?)\1{3,}/gu, '$1');
function clean(text, prompt) {
  let t = unloop(String(text || '').replace(/\uFFFD+/g, '，').replace(/\s+/g, ' ').trim());
  if (!t) return '';
  if (GHOST.test(t) && t.length < 40) return '';
  if (prompt && t.length > 6 && prompt.includes(t)) return '';        // it read the hint back instead of the audio
  if (/^[\p{P}\p{S}\s]*$/u.test(t)) return '';
  return t;
}

/* ---------- one recording (or one re-transcription) ---------- */
export class LocalSTT {
  // vocab: course terms; onSegment(text, startMs, endMs); onBacklog(seconds of audio still waiting)
  constructor({ lang = 'zh', vocab = [], course = '', slides = '', onSegment, onBacklog, onError }) {
    Object.assign(this, { lang, onSegment, onBacklog, onError });
    const terms = vocab.filter(v => v && v.length >= 2 && v.length <= 30).slice(0, 45);
    this.hint = lang === 'en'
      ? `A university lecture${course ? ' on ' + course : ''}.${terms.length ? ' Terms: ' + terms.join(', ') + '.' : ''}`
      : `以下是大學${course ? '「' + course + '」' : ''}課堂的逐字稿，使用繁體中文。${terms.length ? '課堂用語：' + terms.join('、') + '。' : ''}`;
    // the start of the handout: its title and key words are what the lecturer will be saying
    const lead = String(slides || '').replace(/---[^-]*---/g, ' ').replace(/[\s◼•⚫\d.()（）]+/g, ' ').trim().slice(0, 110);
    if (lead) this.hint += (lang === 'en' ? ' Handout: ' : '講義：') + lead + (lang === 'en' ? '. ' : '。');
    this.tail = '';
    this.buf = new Float32Array(MAX_LEN + RATE); this.n = 0;       // the piece being collected
    this.start = 0;                                                  // sample index (whole recording) where it begins
    this.total = 0;
    this.eng = []; this.voiced = [];                                 // per frame of the current piece
    this.fAcc = 0; this.fN = 0; this.prevX = 0; this.h1 = 0; this.h2 = 0;
    this.floor = null; this.quiet = 0;
    this.pending = 0; this.chain = Promise.resolve();
  }
  // Microphone audio as 16-bit PCM (what the worklet posts) or as floats.
  push(pcm) {
    const x = pcm instanceof Float32Array ? pcm : (() => { const i = new Int16Array(pcm), f = new Float32Array(i.length); for (let k = 0; k < i.length; k++) f[k] = i[k] / 32768; return f; })();
    for (let i = 0; i < x.length; i++) {
      const s = x[i];
      this.buf[this.n++] = s; this.total++;
      // judge "is someone talking" on the part of the sound where speech is and fan rumble is not
      const h1 = s - this.prevX + .9 * this.h1; this.prevX = s; const h2 = h1 - this.h1 + .9 * this.h2; this.h1 = h1; this.h2 = h2;
      this.fAcc += h2 * h2;
      if (++this.fN === FRAME) { this.frame(10 * Math.log10(this.fAcc / FRAME + 1e-12)); this.fAcc = 0; this.fN = 0; }
    }
  }
  frame(db) {
    // background level: follows drops at once, creeps up slowly
    this.floor = this.floor == null || db < this.floor ? db : Math.min(db, this.floor + .03);
    const v = db > this.floor + 5.5;
    this.eng.push(db); this.voiced.push(v);
    this.quiet = v ? 0 : this.quiet + 1;
    const spoken = this.voiced.reduce((a, b) => a + (b ? 1 : 0), 0);
    if (!spoken && this.eng.length > 40) { this.drop(this.eng.length - PAD); return; }           // nothing but room noise so far
    if (this.n >= MIN_LEN && this.quiet >= PAUSE) { this.cut(this.eng.length - Math.floor(this.quiet / 2)); return; }
    if (this.n >= MAX_LEN) {
      let best = this.eng.length - 1, low = Infinity;
      for (let i = Math.floor(this.eng.length * .6); i < this.eng.length - 3; i++) {
        const e = (this.eng[i - 1] + this.eng[i] + this.eng[i + 1]) / 3;
        if (e < low) { low = e; best = i; }
      }
      this.cut(best);
    }
  }
  drop(frames) {
    const k = frames * FRAME;
    this.buf.copyWithin(0, k, this.n); this.n -= k; this.start += k;
    this.eng.splice(0, frames); this.voiced.splice(0, frames);
  }
  cut(frames) {
    const k = Math.min(this.n, frames * FRAME);
    const spoken = this.voiced.slice(0, frames).reduce((a, b) => a + (b ? 1 : 0), 0);
    if (spoken >= 8) this.send(this.buf.slice(0, k), this.start);
    this.drop(Math.min(frames, this.eng.length));
  }
  send(audio, at) {
    if (!debug.noHp) { let a = 0, b = 0; for (let i = 0; i < audio.length; i++) { const x = audio[i]; b = x - a + .95 * b; a = x; audio[i] = b; } }   // take out the rumble below ~130 Hz
    // even out the volume: a far-away lecturer arrives very quiet
    let sq = 0; for (let i = 0; i < audio.length; i++) sq += audio[i] * audio[i];
    const g = Math.min(60, .07 / Math.sqrt(sq / audio.length + 1e-12));
    for (let i = 0; i < audio.length; i++) { const v = audio[i] * g; audio[i] = v > 1 ? 1 : v < -1 ? -1 : v; }
    const startMs = at / RATE * 1000, endMs = (at + audio.length) / RATE * 1000;
    this.pending += audio.length;
    this.onBacklog && this.onBacklog(this.pending / RATE);
    this.chain = this.chain.then(async () => {
      const prompt = debug.noPrompt ? '' : this.hint + (debug.noTail ? '' : this.tail);
      try {
        await load();
        let text = await this.recog(audio, prompt, 0);
        if (text && this.lang !== 'en') text = (await converter())(text);
        if (text) { this.tail = text.slice(-60); this.onSegment(text, startMs, endMs); } else this.tail = '';
      } catch (err) { this.onError && this.onError(err); }
      this.pending -= (endMs - startMs) / 1000 * RATE;
      this.onBacklog && this.onBacklog(Math.max(0, this.pending / RATE));
    });
  }
  // Sometimes the model gets stuck repeating one word and loses the rest of the piece. When that happens,
  // try once more with repetition discouraged, then cut the piece in two so the stuck spot only costs a few seconds.
  async recog(audio, prompt, depth) {
    const r = await transcribe(audio, this.lang, prompt, depth ? { repetition_penalty: 1.15 } : null);
    const stuck = x => x.cut || x.text.length - unloop(x.text).length >= 10;
    if (!stuck(r) || debug.noRetry) {
      const text = clean(r.text, prompt);
      // Far too little text for this much talking: over heavy noise the model sometimes echoes the hint and stops.
      // Listen once more without the hint and keep whichever heard more.
      if (depth === 0 && prompt && !debug.noRetry && audio.length >= 5 * RATE && text.length < audio.length / RATE * (this.lang === 'en' ? 4 : 1.6)) {
        const bare = await transcribe(audio, this.lang, '', null);
        const t2 = stuck(bare) ? '' : clean(bare.text, '');
        if (t2.length > text.length * 1.3) return t2;
      }
      return text;
    }
    if (depth === 0) {
      const again = await transcribe(audio, this.lang, prompt, { repetition_penalty: 1.15 });
      if (!stuck(again)) return clean(again.text, prompt);
    }
    if (audio.length < 6 * RATE || depth >= 3) return clean(r.text, prompt);
    // quietest spot in the middle third
    let at = audio.length >> 1, low = Infinity;
    const win = 1600;
    for (let i = Math.floor(audio.length * .35); i + win < audio.length * .65; i += 400) {
      let e = 0; for (let k = i; k < i + win; k++) e += audio[k] * audio[k];
      if (e < low) { low = e; at = i + (win >> 1); }
    }
    const a = await this.recog(audio.subarray(0, at), prompt, depth + 1);
    const b = await this.recog(audio.subarray(at), this.hint + a.slice(-60), depth + 1);
    return a + (a && b ? ' ' : '') + b;
  }
  // End of the recording: write down what is left and wait for everything still in line.
  async finish() {
    if (this.n > RATE / 2 && this.voiced.some(Boolean)) this.send(this.buf.slice(0, this.n), this.start);
    this.n = 0; this.eng = []; this.voiced = [];
    await this.chain;
  }
}

// Saved recordings → 16 kHz mono samples.
export async function decode16k(blob) {
  const ab = await blob.arrayBuffer();
  let buf;
  try {
    // decoding straight to 16 kHz keeps a long lecture small in memory
    buf = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(ab.slice(0));
  } catch {
    const AC = window.AudioContext || window.webkitAudioContext;
    const probe = new AC();
    try { buf = await probe.decodeAudioData(ab); } finally { probe.close().catch(() => {}); }
  }
  if (buf.sampleRate === RATE) {
    if (buf.numberOfChannels === 1) return buf.getChannelData(0);
    const out = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) out[i] += d[i] / buf.numberOfChannels; }
    return out;
  }
  const off = new OfflineAudioContext(1, Math.ceil(buf.duration * RATE), RATE);
  const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start();
  return (await off.startRendering()).getChannelData(0);
}
