// 課堂筆記 — record a lecture, live captions with speaker labels, bilingual notes.
// All data stays on this device (IndexedDB). API keys stay in this browser's localStorage
// and are only sent to Soniox (speech) and Anthropic (notes).

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.3.0/+esm';
const OPENCC_URL = 'https://cdn.jsdelivr.net/npm/opencc-js@1.4.2/dist/esm/cn2t.js';
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
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const fmtTime = ms => {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return (hh ? hh + ':' + String(mm).padStart(2, '0') : String(mm).padStart(2, '0')) + ':' + String(ss).padStart(2, '0');
};
const fmtDate = ts => new Date(ts).toLocaleDateString('zh-TW', { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' });
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
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
      const r = indexedDB.open('lecture-notes', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('lectures', { keyPath: 'id' });
      r.onsuccess = () => { this._db = r.result; res(r.result); };
      r.onerror = () => rej(r.error);
    });
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction('lectures', mode);
      const req = fn(t.objectStore('lectures'));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  },
  all() { return this.tx('readonly', s => s.getAll()); },
  get(id) { return this.tx('readonly', s => s.get(id)); },
  put(o) { return this.tx('readwrite', s => s.put(o)); },
  del(id) { return this.tx('readwrite', s => s.delete(id)); },
};
function cleanForSave(lec) {
  return { ...lec, segments: lec.segments.map(({ _pend, ...s }) => s) };
}
async function saveLecture(lec) { lec.updated = Date.now(); await DB.put(cleanForSave(lec)); }

/* ================= app state ================= */
const state = {
  view: 'home',
  lecture: null,
  lang: Store.get('lang', 'both'),       // 'zh' | 'en' | 'both'
  mobileTab: 'live',                      // 'live' | 'notes' | 'files'
  noteTab: 'overview',
  rec: null,                              // active Recorder
  generating: false,
  genProgress: '',
  openFile: null,
};
const settings = () => ({
  sonioxKey: Store.get('sonioxKey', ''),
  anthropicKey: Store.get('anthropicKey', ''),
  translate: Store.get('translate', true),
  mainLang: Store.get('mainLang', 'zh'),
  saveAudio: Store.get('saveAudio', true),
  detail: Store.get('detail', 'standard'),
});

/* ================= speakers ================= */
const SPK_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)'];
function speakerInfo(lec, id) {
  lec.speakers = lec.speakers || {};
  const manual = lec.speakers[id];
  const prof = professorId(lec);
  const others = Object.keys(talkTimes(lec)).filter(k => k !== prof).sort((a, b) => Number(a) - Number(b));
  const isProf = id === prof;
  const idx = others.indexOf(id);
  const name = manual && manual.name ? manual.name : id === '?' ? '講者（未分辨）' : isProf ? '教授' : '同學 ' + String.fromCharCode(65 + Math.max(0, idx));
  return { id, name, isProf, color: isProf ? 'var(--prof)' : SPK_COLORS[Math.max(0, idx) % SPK_COLORS.length] };
}
function talkTimes(lec) {
  const t = {};
  for (const s of lec.segments) t[s.speaker] = (t[s.speaker] || 0) + Math.max(1, (s.end || 0) - (s.start || 0)) + s.text.length * 30;
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

/* ================= audio capture ================= */
class MicCapture {
  async start({ onPcm, onLevel, keepAudio }) {
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
      onLevel && onLevel(e.data.level);
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
        this.recorder.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
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

/* ================= Soniox real-time session ================= */
class SonioxSession {
  constructor({ key, translate, mainLang, onTokens, onError, onClose }) {
    Object.assign(this, { key, translate, mainLang, onTokens, onError, onClose });
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

/* ================= Free mode: browser speech recognition ================= */
class BrowserSTT {
  constructor({ lang, onFinal, onInterim, onError }) {
    Object.assign(this, { lang, onFinal, onInterim, onError });
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.SR = SR;
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
    this.segStart = 0;
    this.level = 0;
    this.closed = true;
    this.inTr = false;
    this.dirty = new Set();
  }
  elapsed() {
    return this.elapsedBase + (this.status === 'recording' && this.runStart ? performance.now() - this.runStart : 0);
  }
  async start() {
    const cfg = settings();
    this.mode = cfg.sonioxKey ? 'soniox' : 'free';
    if (this.mode === 'free' && !BrowserSTT.supported()) {
      toast('這個瀏覽器沒有內建語音辨識，請到設定填入 Soniox 金鑰'); return;
    }
    this.status = 'connecting'; renderRecbar();
    try {
      this.mic = new MicCapture();
      await this.mic.start({
        keepAudio: cfg.saveAudio,
        onLevel: l => { this.level = l; },
        onPcm: buf => { if (this.mode === 'soniox' && this.session) this.session.send(buf); },
      });
      if (this.mode === 'soniox') {
        this.session = new SonioxSession({
          key: cfg.sonioxKey, translate: cfg.translate, mainLang: cfg.mainLang,
          onTokens: t => this.onTokens(t),
          onError: msg => { toast('語音辨識：' + msg, 5000); },
          onClose: () => { if (this.status === 'recording' || this.status === 'paused') this.reconnect(); },
        });
        await this.session.start();
      } else {
        this.browser = new BrowserSTT({
          lang: cfg.mainLang === 'en' ? 'en-US' : 'zh-TW',
          onFinal: text => this.addFreeSegment(text),
          onInterim: text => { this.nonFinal = { text, tr: '' }; scheduleRender(); },
          onError: err => toast('語音辨識：' + err),
        });
        this.browser.start();
      }
    } catch (err) {
      this.status = 'idle';
      try { this.mic && await this.mic.stop(); } catch { /* ignore */ }
      renderRecbar();
      toast(err && err.name === 'NotAllowedError' ? '請允許使用麥克風' : '無法開始錄音：' + (err.message || err), 5000);
      return;
    }
    this.status = 'recording';
    this.runStart = performance.now();
    this.ticker = setInterval(() => { renderRecbar(true); }, 250);
    this.saver = setInterval(() => { this.lec.durationMs = this.elapsed(); saveLecture(this.lec); }, 15000);
    this.keeper = setInterval(() => { if (this.status === 'paused' && this.session) this.session.keepalive(); }, 8000);
    requestWakeLock();
    renderRecbar();
  }
  async reconnect() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    toast('連線中斷，重新連線…');
    // new session restarts its clock at 0, so shift timestamps by what has been recorded so far
    this.offset = this.elapsed();
    this.closed = true; this.inTr = false;
    try { await this.session.start(); } catch { toast('重新連線失敗，請檢查網路', 5000); }
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
      if (!this.inTr) {
        this.inTr = true;
        this.trTarget = segs.find(s => s._pend) || segs[segs.length - 1];
      }
      if (this.trTarget) { this.trTarget.tr = (this.trTarget.tr || '') + t.text; this.dirty.add(this.trTarget.id); }
      return;
    }
    if (this.inTr) {
      this.inTr = false;
      for (const s of segs) delete s._pend;
      this.closed = true;
    }
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
    // Without translation, close long sentences so the transcript stays readable.
    if (!settings().translate && cur.text.length > 80 && /[。．.!?？！]\s*$/.test(cur.text)) this.closed = true;
    this.dirty.add(cur.id);
  }
  addFreeSegment(text) {
    if (!text.trim()) return;
    const now = this.elapsed();
    const isZh = /[一-鿿]/.test(text);
    const seg = { id: uid(), speaker: '?', start: Math.max(0, now - 4000), end: now, lang: isZh ? 'zh' : 'en', text: text.trim(), tr: '' };
    this.lec.segments.push(seg);
    this.dirty.add(seg.id);
    this.nonFinal = { text: '', tr: '' };
    scheduleRender();
  }
  pause() {
    if (this.status !== 'recording') return;
    this.elapsedBase = this.elapsed();
    this.status = 'paused';
    this.mic.pause();
    if (this.browser) this.browser.pause();
    renderRecbar();
  }
  resume() {
    if (this.status !== 'paused') return;
    this.runStart = performance.now();
    this.status = 'recording';
    this.mic.resume();
    if (this.browser) this.browser.resume();
    renderRecbar();
  }
  async stop() {
    if (this.status === 'idle' || this.status === 'stopping') return;
    this.elapsedBase = this.elapsed();
    this.status = 'stopping'; renderRecbar();
    clearInterval(this.ticker); clearInterval(this.saver); clearInterval(this.keeper);
    const audioP = this.mic.stop();
    if (this.session) { await this.session.end(); this.session.close(); }
    if (this.browser) this.browser.stop();
    const audio = await audioP;
    for (const s of this.lec.segments) delete s._pend;
    this.nonFinal = { text: '', tr: '' };
    this.lec.durationMs = this.elapsedBase;
    if (audio) {
      this.lec.audioParts = this.lec.audioParts || [];
      this.lec.audioParts.push({ blob: audio, offset: this.offset0 ?? 0 });
    }
    await saveLecture(this.lec);
    this.status = 'idle';
    releaseWakeLock();
    state.rec = null;
    render();
    toast('錄音已儲存');
  }
}

let wakeLock = null;
async function requestWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* not allowed */ }
}
function releaseWakeLock() { try { wakeLock && wakeLock.release(); } catch { /* ignore */ } wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.rec && state.rec.status === 'recording') requestWakeLock();
});
window.addEventListener('beforeunload', e => {
  if (state.rec && state.rec.status !== 'idle') { e.preventDefault(); e.returnValue = ''; }
});

/* ================= file handling ================= */
const ACCEPT = '.pdf,.pptx,.docx,.txt,.md,.png,.jpg,.jpeg,.webp,.gif,application/pdf,image/*';
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
  const { default: JSZip } = await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm');
  const zip = await JSZip.loadAsync(blob);
  const decode = xml => xml.replace(/<a:br\/>|<w:br\/>/g, '\n').replace(/<\/a:p>|<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
  if (kind === 'docx') {
    const f = zip.file('word/document.xml');
    return f ? decode(await f.async('string')) : '';
  }
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
async function addFiles(fileList) {
  const lec = state.lecture; if (!lec) return;
  lec.files = lec.files || [];
  for (const f of fileList) {
    const kind = fileKind(f);
    if (kind === 'other') { toast('不支援的檔案：' + f.name + '（可用 PDF、PPTX、DOCX、圖片、文字檔）', 4000); continue; }
    const entry = { id: uid(), name: f.name, type: f.type, kind, size: f.size, blob: f, added: Date.now() };
    if (kind === 'pptx' || kind === 'docx') {
      try { entry.text = await extractOfficeText(f, kind); } catch { toast('讀不到 ' + f.name + ' 的文字'); }
    } else if (kind === 'text') entry.text = await f.text();
    lec.files.push(entry);
  }
  await saveLecture(lec);
  render();
}

/* ================= Claude: notes generation ================= */
const B = { type: 'object', properties: { zh: { type: 'string' }, en: { type: 'string' } }, required: ['zh', 'en'], additionalProperties: false };
const obj = (props) => ({ type: 'object', properties: props, required: Object.keys(props), additionalProperties: false });
const arr = items => ({ type: 'array', items });
const NOTES_SCHEMA = obj({
  title: B,
  one_line: B,
  overview: B,
  professor_speaker: { type: 'string' },
  learning_objectives: arr(B),
  outline: arr(obj({
    heading: B,
    time: { type: 'string' },
    points: arr(obj({ text: B, emphasis: { type: 'boolean' }, source: { type: 'string', enum: ['lecture', 'slides', 'both'] } })),
  })),
  mind_map: obj({
    center: B,
    branches: arr(obj({ label: B, children: arr(obj({ label: B, leaves: arr(B) })) })),
  }),
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
- outline 依照上課的時間順序分段，time 用逐字稿的時間標記 (mm:ss)，沒有就給空字串。每段 3–8 個要點，要點寫成完整、可獨立理解的句子，不要只寫關鍵字。
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
    const p = useFallback
      ? { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
      : params;
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
  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(text);
}

async function generateNotes() {
  const lec = state.lecture;
  if (state.generating) return;
  const hasTranscript = lec.segments.some(s => s.text.trim());
  const files = lec.files || [];
  if (!hasTranscript && !files.length) { toast('還沒有逐字稿或講義可以整理'); return; }
  state.generating = true; state.genProgress = '準備資料…'; renderNotesPane();
  try {
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
    state.genProgress = 'Claude 正在閱讀並整理…'; renderNotesPane();
    const notes = await streamJSON(client, {
      model: MODEL,
      max_tokens: 64000,
      system: SYSTEM_PROMPT,
      output_config: { effort: 'high', format: { type: 'json_schema', schema: NOTES_SCHEMA } },
      messages: [{ role: 'user', content }],
    }, n => { state.genProgress = `正在寫筆記…（${n.toLocaleString()} 字元）`; const el = $('#gen-progress'); if (el) el.textContent = state.genProgress; });
    lec.notes = notes;
    lec.notesAt = Date.now();
    if (lec.title.startsWith('新課堂') || /^\d{1,2}\/\d{1,2}/.test(lec.title)) lec.title = notes.title.zh || lec.title;
    await saveLecture(lec);
    state.noteTab = 'overview';
    toast('筆記完成');
  } catch (err) {
    console.error(err);
    toast('產生筆記失敗：' + (err.message || err), 7000);
  } finally {
    state.generating = false;
    if (state.lecture === lec) render();
  }
}

async function translateTranscript() {
  const lec = state.lecture;
  const todo = lec.segments.filter(s => s.text.trim() && !(s.tr && s.tr.trim()));
  if (!todo.length) { toast('逐字稿都已經有翻譯了'); return; }
  try {
    const client = await getClient();
    state.translating = true; renderTranscriptPane();
    for (let i = 0; i < todo.length; i += 60) {
      const batch = todo.slice(i, i + 60);
      toast(`翻譯中… ${Math.min(i + 60, todo.length)}/${todo.length}`, 60000);
      const res = await streamJSON(client, {
        model: MODEL,
        max_tokens: 32000,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: obj({ items: arr(obj({ id: { type: 'string' }, tr: { type: 'string' } })) }) } },
        system: '你是課堂口譯員。把每一句翻譯成另一種語言：中文句子翻成英文，英文句子翻成繁體中文（台灣用語）。保持口語但通順，修正明顯的語音辨識錯字。每個 id 都要回傳。',
        messages: [{ role: 'user', content: JSON.stringify(batch.map(s => ({ id: s.id, text: s.lang === 'zh' ? toTW(s.text) : s.text }))) }],
      });
      const map = new Map(res.items.map(x => [x.id, x.tr]));
      for (const s of batch) if (map.has(s.id)) s.tr = map.get(s.id);
      await saveLecture(lec);
      rerenderTranscript();
    }
    toast('翻譯完成');
  } catch (err) {
    toast('翻譯失敗：' + (err.message || err), 6000);
  } finally { state.translating = false; renderTranscriptPane(); }
}

/* ================= bilingual rendering ================= */
function bi(o, cls = '') {
  if (!o) return '';
  const zh = o.zh || '', en = o.en || '';
  if (state.lang === 'zh') return h('span', { class: 'bi ' + cls }, zh || en);
  if (state.lang === 'en') return h('span', { class: 'bi ' + cls }, en || zh);
  return h('span', { class: 'bi ' + cls }, zh, en && en !== zh ? h('span', { class: 'en' }, en) : null);
}
function segSides(s) {
  const orig = s.lang === 'zh' ? toTW(s.text) : s.text;
  const tr = s.tr ? (s.lang === 'zh' ? s.tr : toTW(s.tr)) : '';
  return s.lang === 'zh' ? { zh: orig, en: tr } : s.lang === 'en' ? { zh: tr, en: orig } : { zh: orig, en: tr };
}

/* ================= views ================= */
const app = () => $('#app');
function langToggle() {
  return h('div', { class: 'seg', role: 'group', 'aria-label': '語言' },
    [['zh', '中'], ['both', '中英'], ['en', 'EN']].map(([k, label]) => h('button', {
      class: state.lang === k ? 'on' : '', onclick: () => { state.lang = k; Store.set('lang', k); render(); },
    }, label)));
}

async function renderHome() {
  const list = (await DB.all()).sort((a, b) => b.created - a.created);
  const cfg = settings();
  const groups = new Map();
  for (const l of list) { const k = l.course || '未分類'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(l); }
  const root = h('div', null,
    h('header', { class: 'topbar' },
      h('div', { class: 'brand grow' }, h('img', { src: 'icon.svg', alt: '' }), '課堂筆記'),
      h('button', { class: 'btn ghost', onclick: () => go('#/settings') }, '⚙︎ 設定')),
    h('main', { class: 'page' },
      (!cfg.anthropicKey || !cfg.sonioxKey) ? h('div', { class: 'banner' },
        h('b', null, '還沒設定完成：'),
        !cfg.sonioxKey ? ' 沒有 Soniox 金鑰時會用瀏覽器內建的免費辨識（不能分辨講者、沒有即時翻譯）。' : '',
        !cfg.anthropicKey ? ' 需要 Anthropic 金鑰才能整理筆記。' : '',
        ' ', h('a', { href: '#/settings' }, '前往設定 →')) : null,
      h('div', { class: 'hero' },
        h('div', null, h('h1', null, '我的課堂'), h('div', { class: 'muted small' }, list.length ? `共 ${list.length} 堂課` : '')),
        h('button', { class: 'btn primary', onclick: newLectureDialog }, '＋ 新的一堂課')),
      list.length ? [...groups.entries()].map(([course, items]) => h('section', { class: 'course-group' },
        h('h2', null, course),
        h('div', { class: 'cards' }, items.map(l => h('button', { class: 'card', onclick: () => go('#/l/' + l.id) },
          h('h3', null, l.title),
          h('div', { class: 'muted small' }, fmtDate(l.created), l.durationMs ? ' · ' + fmtTime(l.durationMs) : ''),
          h('div', { class: 'chips' },
            l.notes ? h('span', { class: 'chip ok' }, '✓ 筆記') : h('span', { class: 'chip' }, '尚無筆記'),
            l.segments && l.segments.length ? h('span', { class: 'chip' }, '逐字稿') : null,
            l.files && l.files.length ? h('span', { class: 'chip' }, `講義 ${l.files.length}`) : null,
            l.audioParts && l.audioParts.length ? h('span', { class: 'chip' }, '錄音') : null)))))) :
        h('div', { class: 'empty' }, h('div', { class: 'big' }, '🎙️'),
          h('p', null, '按「新的一堂課」開始。上課時錄音，下課後一鍵整理成中英對照筆記。'))));
  app().replaceChildren(root);
}

function newLectureDialog() {
  DB.all().then(list => {
    const courses = [...new Set(list.map(l => l.course).filter(Boolean))];
    const d = new Date();
    const dlg = h('dialog', null,
      h('h3', null, '新的一堂課'),
      h('div', { class: 'form' },
        h('div', { class: 'field' }, h('label', { for: 'nl-course' }, '課程名稱'),
          h('input', { id: 'nl-course', class: 'input', list: 'nl-courses', placeholder: '例如：經濟學原理', value: Store.get('lastCourse', '') }),
          h('datalist', { id: 'nl-courses' }, courses.map(c => h('option', { value: c })))),
        h('div', { class: 'field' }, h('label', { for: 'nl-title' }, '這堂課的標題'),
          h('input', { id: 'nl-title', class: 'input', placeholder: '可以留空，整理筆記時自動命名' }))),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => dlg.close() }, '取消'),
        h('button', {
          class: 'btn primary', onclick: async () => {
            const course = $('#nl-course', dlg).value.trim();
            const title = $('#nl-title', dlg).value.trim() || `新課堂 ${d.getMonth() + 1}/${d.getDate()}`;
            Store.set('lastCourse', course);
            const lec = { id: uid(), course, title, created: Date.now(), segments: [], speakers: {}, files: [], durationMs: 0 };
            await saveLecture(lec);
            dlg.close();
            go('#/l/' + lec.id);
          },
        }, '建立')));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  });
}

function renderLecture() {
  const lec = state.lecture;
  const top = h('header', { class: 'topbar' },
    h('button', { class: 'btn icon ghost', 'aria-label': '返回', onclick: () => go('#/') }, '‹'),
    h('div', { class: 'grow' },
      h('input', {
        class: 'title-input', value: lec.title, 'aria-label': '標題',
        onchange: e => { lec.title = e.target.value.trim() || lec.title; saveLecture(lec); },
      }),
      h('input', {
        class: 'title-input course-input', value: lec.course || '', placeholder: '課程名稱', 'aria-label': '課程',
        onchange: e => { lec.course = e.target.value.trim(); saveLecture(lec); },
      })),
    langToggle(),
    h('button', { class: 'btn icon ghost', 'aria-label': '更多', onclick: lectureMenu }, '⋯'));
  const tabs = h('nav', { class: 'mobile-tabs' },
    [['live', '逐字稿'], ['notes', '筆記'], ['files', '講義']].map(([k, label]) =>
      h('button', { class: state.mobileTab === k ? 'on' : '', onclick: () => { state.mobileTab = k; render(); } }, label)));
  const left = h('section', { class: 'pane', id: 'pane-live', style: state.mobileTab === 'live' ? '' : 'display:none' });
  const right = h('section', { class: 'pane', id: 'pane-right', style: state.mobileTab !== 'live' ? '' : 'display:none' });
  app().replaceChildren(h('div', { class: 'lecture-page' }, top, h('div', { class: 'lecture-wrap' }, tabs, h('div', { class: 'lecture' }, left, right))));
  renderTranscriptPane();
  renderRightPane();
}

function renderRightPane() {
  const pane = $('#pane-right'); if (!pane) return;
  const wide = matchMedia('(min-width: 900px)').matches;
  const which = wide ? (state.rightTab || 'notes') : (state.mobileTab === 'files' ? 'files' : 'notes');
  pane.replaceChildren();
  if (wide) {
    pane.append(h('div', { class: 'pane-head' },
      h('div', { class: 'seg' },
        h('button', { class: which === 'notes' ? 'on' : '', onclick: () => { state.rightTab = 'notes'; renderRightPane(); } }, '筆記'),
        h('button', { class: which === 'files' ? 'on' : '', onclick: () => { state.rightTab = 'files'; renderRightPane(); } }, `講義檔案${state.lecture.files && state.lecture.files.length ? ' (' + state.lecture.files.length + ')' : ''}`))));
  }
  const body = h('div', { id: which === 'notes' ? 'notes-root' : 'files-root', style: 'display:flex;flex-direction:column;min-height:0;flex:1' });
  pane.append(body);
  if (which === 'notes') renderNotesPane(); else renderFilesPane();
}

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
  const hasAudio = lec.audioParts && lec.audioParts.length;
  pane.replaceChildren(
    h('div', { class: 'recbar', id: 'recbar' }),
    h('div', { class: 'speakers', id: 'speakers' }),
    h('div', { class: 'pane-body', id: 'tbody' },
      hasAudio && !state.rec ? h('div', null, lec.audioParts.map((p, i) => h('audio', {
        class: 'audio-player', controls: true, preload: 'metadata', id: 'audio-' + i, src: URL.createObjectURL(p.blob),
      })), h('div', { class: 'muted small', style: 'margin:-6px 0 12px' }, '點逐字稿的句子可以跳到那段錄音')) : null,
      h('div', { class: 'transcript', id: 'transcript' }),
      h('div', { class: 'pending', id: 'pending' })));
  renderRecbar();
  rerenderTranscript();
}
function renderRecbar(tickOnly) {
  const bar = $('#recbar'); if (!bar) return;
  const r = state.rec;
  const st = r ? r.status : 'idle';
  const elapsed = r ? r.elapsed() : (state.lecture.durationMs || 0);
  if (tickOnly && bar.dataset.st === st) {
    const t = $('.time', bar); if (t) t.textContent = fmtTime(elapsed);
    const m = $('.meter i', bar); if (m && r) m.style.width = Math.min(100, Math.round(Math.sqrt(r.level) * 260)) + '%';
    return;
  }
  bar.dataset.st = st;
  const cfg = settings();
  const modeTxt = cfg.sonioxKey ? (cfg.translate ? 'Soniox · 講者辨識 · 即時翻譯' : 'Soniox · 講者辨識') : '免費模式（瀏覽器辨識）';
  const kids = [];
  if (st === 'idle') {
    kids.push(h('button', { class: 'btn rec', onclick: startRecording }, '● ', state.lecture.segments.length ? '繼續錄音' : '開始錄音'));
    kids.push(h('span', { class: 'time' }, fmtTime(elapsed)));
    kids.push(h('span', { class: 'status' }, modeTxt));
  } else {
    if (st === 'recording') kids.push(h('button', { class: 'btn', onclick: () => r.pause() }, '❚❚ 暫停'));
    if (st === 'paused') kids.push(h('button', { class: 'btn rec', onclick: () => r.resume() }, '● 繼續'));
    kids.push(h('button', { class: 'btn', disabled: st === 'stopping' || st === 'connecting', onclick: () => r.stop() }, '■ 結束'));
    kids.push(h('span', { class: 'time' }, fmtTime(elapsed)));
    kids.push(h('span', { class: 'meter' }, h('i')));
    kids.push(h('span', { class: 'status' },
      st === 'recording' ? [h('span', { class: 'dot' }), '錄音中 · ' + modeTxt] :
        st === 'paused' ? '已暫停' : st === 'connecting' ? '連線中…' : '儲存中…'));
  }
  bar.replaceChildren(...kids);
}
async function startRecording() {
  if (state.rec) return;
  state.rec = new Recorder(state.lecture);
  state.rec.offset0 = state.lecture.durationMs || 0;
  await state.rec.start();
  if (state.rec && state.rec.status === 'idle') state.rec = null;
  renderTranscriptPane();
}

const segEls = new Map();
function rerenderTranscript() {
  const box = $('#transcript'); if (!box) return;
  segEls.clear();
  box.replaceChildren();
  const lec = state.lecture;
  if (!lec.segments.length && !state.rec) {
    box.append(h('div', { class: 'empty' }, h('div', { class: 'big' }, '🎧'),
      h('p', null, '按「開始錄音」，教授說的話會即時出現在這裡。'),
      h('p', { class: 'small' }, '建議把手機或電腦放在靠近教授的位置。上課前先把講義上傳到「講義」，整理筆記會更準確。')));
  }
  let prev = null;
  for (const s of lec.segments) { box.append(segEl(s, prev)); prev = s; }
  renderSpeakers();
  updatePending();
}
function segEl(s, prev) {
  const lec = state.lecture;
  const who = speakerInfo(lec, s.speaker);
  const newSpk = !prev || prev.speaker !== s.speaker;
  const sides = segSides(s);
  const hasAudio = lec.audioParts && lec.audioParts.length && !state.rec;
  const el = h('div', {
    class: 'tseg' + (newSpk ? ' new-spk' : '') + (who.isProf ? ' prof' : ' other') + (hasAudio ? ' seekable' : ''),
    style: who.isProf ? '' : `border-left-color:${who.color}`,
    onclick: hasAudio ? () => seekAudio(s.start) : null,
  },
  newSpk ? h('div', { class: 'who', style: `color:${who.color}` }, who.name, h('span', { class: 't' }, fmtTime(s.start))) : null,
  state.lang === 'en' ? h('div', null, sides.en || h('span', { class: 'muted' }, sides.zh)) :
    state.lang === 'zh' ? h('div', null, sides.zh || sides.en) :
      [h('div', null, s.lang === 'en' ? sides.en : sides.zh), (s.lang === 'en' ? sides.zh : sides.en) ? h('div', { class: 'tr' }, s.lang === 'en' ? sides.zh : sides.en) : null]);
  el.dataset.id = s.id;
  segEls.set(s.id, el);
  return el;
}
function seekAudio(ms) {
  const lec = state.lecture;
  const parts = lec.audioParts || [];
  let idx = 0;
  for (let i = 0; i < parts.length; i++) if ((parts[i].offset || 0) <= ms) idx = i;
  const a = $('#audio-' + idx); if (!a) return;
  a.currentTime = Math.max(0, (ms - (parts[idx].offset || 0)) / 1000 - 1);
  a.play().catch(() => { /* needs gesture */ });
}
function updateTranscript() {
  const box = $('#transcript'); if (!box || !state.rec) return;
  const body = $('#tbody');
  const atBottom = body && body.scrollHeight - body.scrollTop - body.clientHeight < 120;
  const lec = state.lecture;
  const dirty = state.rec.dirty;
  if (dirty.size) {
    if (box.querySelector('.empty')) box.replaceChildren();
    const idx = new Map(lec.segments.map((s, i) => [s.id, i]));
    for (const id of dirty) {
      const i = idx.get(id); if (i == null) continue;
      const s = lec.segments[i];
      const el = segEl(s, lec.segments[i - 1]);
      const old = box.children[i];
      if (old && old.dataset.id === id) old.replaceWith(el); else box.append(el);
    }
    dirty.clear();
    if (lec.segments.length < 400 || Math.random() < .1) renderSpeakers();
  }
  updatePending();
  if (atBottom && body) body.scrollTop = body.scrollHeight;
}
function updatePending() {
  const p = $('#pending'); if (!p) return;
  const nf = state.rec ? state.rec.nonFinal : { text: '', tr: '' };
  const t = nf.text ? toTW(nf.text) : '';
  p.textContent = [t, state.lang !== 'zh' && nf.tr ? '→ ' + nf.tr : ''].filter(Boolean).join('  ');
}
function renderSpeakers() {
  const box = $('#speakers'); if (!box) return;
  const lec = state.lecture;
  const ids = Object.keys(talkTimes(lec)).sort((a, b) => (speakerInfo(lec, b).isProf ? 1 : 0) - (speakerInfo(lec, a).isProf ? 1 : 0) || Number(a) - Number(b));
  const kids = ids.map(id => {
    const i = speakerInfo(lec, id);
    return h('button', { class: 'spk-chip', title: '點一下可以改名或設定為教授', onclick: () => speakerDialog(id) },
      h('i', { style: `background:${i.color}` }), i.name, i.isProf ? ' ★' : '');
  });
  if (ids.length && settings().anthropicKey && !state.rec) {
    kids.push(h('button', { class: 'btn sm ghost', disabled: state.translating, onclick: translateTranscript, title: '用 Claude 把沒有翻譯的句子補上' }, state.translating ? '翻譯中…' : '補齊翻譯'));
  }
  box.replaceChildren(...kids);
}
function speakerDialog(id) {
  const lec = state.lecture;
  const info = speakerInfo(lec, id);
  const dlg = h('dialog', null,
    h('h3', null, '說話者 ', id),
    h('div', { class: 'form' },
      h('div', { class: 'field' }, h('label', { for: 'sp-name' }, '名稱'), h('input', { id: 'sp-name', class: 'input', value: info.name })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'sp-prof', checked: info.isProf }),
        h('span', null, '這是教授', h('div', { class: 'muted small' }, '教授說的話會成為筆記的主軸；其他人的發言整理成「課堂問答」。')))),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => dlg.close() }, '取消'),
      h('button', {
        class: 'btn primary', onclick: async () => {
          const name = $('#sp-name', dlg).value.trim();
          const prof = $('#sp-prof', dlg).checked;
          for (const v of Object.values(lec.speakers)) if (prof && v.role === 'professor') v.role = '';
          lec.speakers[id] = { name: name && name !== '教授' ? name : (prof ? '' : name), role: prof ? 'professor' : 'other' };
          await saveLecture(lec);
          dlg.close();
          rerenderTranscript();
        },
      }, '儲存')));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
}

/* ---------- notes pane ---------- */
const NOTE_TABS = [
  ['overview', '總覽'], ['outline', '大綱'], ['mindmap', '心智圖'], ['tables', '名詞與表格'],
  ['exam', '考試重點'], ['qa', '課堂問答'], ['quiz', '自我測驗'],
];
function renderNotesPane() {
  const root = $('#notes-root'); if (!root) return;
  const lec = state.lecture;
  const n = lec.notes;
  if (state.generating) {
    root.replaceChildren(h('div', { class: 'pane-body' }, h('div', { class: 'gen-box' },
      h('h3', null, '正在整理筆記'), h('div', { class: 'progress' }, h('i')),
      h('div', { class: 'muted small', id: 'gen-progress' }, state.genProgress),
      h('p', { class: 'muted small' }, '一堂課通常需要 1–3 分鐘，請不要關閉這個頁面。'))));
    return;
  }
  if (!n) {
    const cfg = settings();
    const canGen = cfg.anthropicKey && (lec.segments.length || (lec.files && lec.files.length));
    root.replaceChildren(h('div', { class: 'pane-body' }, h('div', { class: 'gen-box' },
      h('div', { style: 'font-size:2.2rem' }, '📝'),
      h('h3', null, '還沒有筆記'),
      h('p', { class: 'muted' }, lec.segments.length ? '錄完音後按下面的按鈕，Claude 會結合逐字稿和講義整理出筆記。' :
        (lec.files && lec.files.length ? '只有講義也可以先產生「預習筆記」，上完課再重新整理一次。' : '先錄音或上傳講義，就可以整理筆記。')),
      h('button', { class: 'btn primary', disabled: !canGen || (state.rec && state.rec.status !== 'idle'), onclick: generateNotes }, '✨ 整理筆記'),
      !cfg.anthropicKey ? h('p', { class: 'small' }, h('a', { href: '#/settings' }, '先到設定填入 Anthropic 金鑰')) : null,
      state.rec ? h('p', { class: 'small muted' }, '錄音結束後才能整理') : null)));
    return;
  }
  const tabs = h('nav', { class: 'ntabs' }, NOTE_TABS.map(([k, label]) =>
    h('button', { class: state.noteTab === k ? 'on' : '', onclick: () => { state.noteTab = k; renderNotesPane(); } }, label)));
  const body = h('div', { class: 'pane-body', id: 'notes-body' }, noteSection(state.noteTab, n));
  root.replaceChildren(tabs, body);
}
function noteSection(tab, n) {
  const lec = state.lecture;
  switch (tab) {
    case 'overview': return [
      h('div', { class: 'note-actions' },
        h('button', { class: 'btn sm', onclick: generateNotes, disabled: state.rec && state.rec.status !== 'idle' }, '↻ 重新整理'),
        h('button', { class: 'btn sm', onclick: exportMarkdown }, '⤓ Markdown'),
        h('button', { class: 'btn sm', onclick: printNotes }, '🖨 列印 / PDF'),
        h('span', { class: 'muted small', style: 'align-self:center' }, lec.notesAt ? '更新於 ' + new Date(lec.notesAt).toLocaleString('zh-TW', { hour12: false }) : '')),
      h('div', { class: 'lead' }, bi(n.one_line)),
      sec('本堂課在講什麼', h('p', { style: 'margin:0' }, bi(n.overview))),
      n.learning_objectives.length ? sec('學習目標', h('ul', { class: 'plain' }, n.learning_objectives.map(o => h('li', null, bi(o))))) : null,
      sec('康乃爾筆記', cornell(n)),
      n.todo.length ? sec('📌 待辦／交代事項', h('ul', { class: 'plain' }, n.todo.map(o => h('li', null, bi(o))))) : null,
    ];
    case 'outline': return n.outline.map(s => h('div', { class: 'outline-sec' },
      h('h4', null, s.time ? h('span', { class: 't' }, s.time) : null, bi(s.heading)),
      h('ul', null, s.points.map(p => h('li', { class: p.emphasis ? 'em' : '' }, bi(p.text),
        p.emphasis ? h('span', { class: 'tag star' }, '重點') : null,
        p.source === 'slides' ? h('span', { class: 'tag slide' }, '講義') : null)))));
    case 'mindmap': return [h('p', { class: 'muted small' }, '可以左右滑動查看整張心智圖。'), h('div', { class: 'mm-scroll' }, mindMap(n.mind_map))];
    case 'tables': return [
      n.key_terms.length ? sec('專有名詞', h('div', { class: 'tbl-wrap' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'English'), h('th', null, '中文'), h('th', null, state.lang === 'en' ? 'Definition' : '定義'))),
        h('tbody', null, n.key_terms.map(t => h('tr', null, h('td', null, h('b', null, t.term_en)), h('td', null, t.term_zh), h('td', null, bi(t.definition)))))))) : null,
      n.tables.map(t => sec(bi(t.title, 'inline'), h('div', { class: 'tbl-wrap' }, h('table', null,
        h('thead', null, h('tr', null, t.columns.map(c => h('th', null, bi(c))))),
        h('tbody', null, t.rows.map(r => h('tr', null, r.cells.map(c => h('td', null, bi(c)))))))))),
      !n.key_terms.length && !n.tables.length ? h('p', { class: 'muted' }, '這堂課沒有需要整理成表格的內容。') : null,
    ];
    case 'exam': return n.exam_focus.length ? n.exam_focus.map(e => h('div', { class: 'exam' },
      h('div', null, e.time ? h('span', { class: 'muted small' }, e.time + '  ') : null, h('b', null, bi(e.point))),
      h('div', { class: 'why' }, bi(e.why)))) : h('p', { class: 'muted' }, '沒有找到教授特別強調的考試重點。');
    case 'qa': return n.class_qa.length ? n.class_qa.map(q => h('div', { class: 'qa' },
      h('div', { class: 'q' }, bi(q.question)), h('div', { class: 'a' }, bi(q.answer)),
      q.asked_by ? h('div', { class: 'muted small', style: 'margin-top:6px' }, '提問：' + q.asked_by) : null)) :
      h('p', { class: 'muted' }, '這堂課沒有記錄到學生提問。');
    case 'quiz': return [h('p', { class: 'muted small' }, '先自己回答，再點卡片看答案。'),
      h('div', { class: 'flash' }, n.review_questions.map(q => h('button', { class: 'fcard', onclick: e => e.currentTarget.classList.toggle('open') },
        h('b', null, bi(q.question)), h('div', { class: 'ans' }, bi(q.answer)), h('span', { class: 'hint' }, '點一下看答案'))))];
    default: return null;
  }
}
function sec(title, ...body) { return h('section', { class: 'note-sec' }, h('h3', null, title), ...body); }
function cornell(n) {
  const rows = n.review_questions.slice(0, 8);
  return h('div', { class: 'cornell' },
    h('div', { class: 'head cue' }, '提示問題 Cues'), h('div', { class: 'head right' }, '筆記 Notes'),
    rows.map(r => [h('div', { class: 'cue' }, bi(r.question)), h('div', null, bi(r.answer))]),
    h('div', { class: 'summary' }, h('div', { class: 'head', style: 'padding:0 0 4px' }, '總結 Summary'), bi(n.summary)));
}
function mindMap(m) {
  const node = (label, lvl, kids) => h('div', { class: 'mm-item mm-l' + lvl },
    h('div', { class: 'mm-node' }, bi(label)),
    kids && kids.length ? h('div', { class: 'mm-kids' }, kids) : null);
  return h('div', { class: 'mm mm-root' },
    h('div', { class: 'mm-node' }, bi(m.center)),
    h('div', { class: 'mm-kids' }, m.branches.map(b => node(b.label, 1,
      b.children.map(c => node(c.label, 2, c.leaves.map(l => node(l, 3)))))))
  );
}

/* ---------- export ---------- */
function mdBi(o) { return o ? (o.en && o.en !== o.zh ? `${o.zh}  \n*${o.en}*` : o.zh) : ''; }
function exportMarkdown() {
  const lec = state.lecture, n = lec.notes;
  const L = [];
  L.push(`# ${n.title.zh}`, `*${n.title.en}*`, '', `${lec.course || ''} · ${fmtDate(lec.created)}`, '', `> ${mdBi(n.one_line)}`, '');
  L.push('## 概要 Overview', mdBi(n.overview), '');
  if (n.learning_objectives.length) { L.push('## 學習目標 Objectives'); n.learning_objectives.forEach(o => L.push(`- ${o.zh} / ${o.en}`)); L.push(''); }
  L.push('## 大綱 Outline');
  for (const s of n.outline) {
    L.push(`### ${s.time ? '[' + s.time + '] ' : ''}${s.heading.zh} / ${s.heading.en}`);
    s.points.forEach(p => L.push(`- ${p.emphasis ? '**⭐ ' : ''}${p.text.zh}${p.emphasis ? '**' : ''}  \n  *${p.text.en}*`));
    L.push('');
  }
  if (n.key_terms.length) {
    L.push('## 專有名詞 Key terms', '| English | 中文 | 定義 Definition |', '|---|---|---|');
    n.key_terms.forEach(t => L.push(`| ${t.term_en} | ${t.term_zh} | ${t.definition.zh} / ${t.definition.en} |`)); L.push('');
  }
  for (const t of n.tables) {
    L.push(`## ${t.title.zh} / ${t.title.en}`, '| ' + t.columns.map(c => c.zh).join(' | ') + ' |', '|' + t.columns.map(() => '---').join('|') + '|');
    t.rows.forEach(r => L.push('| ' + r.cells.map(c => `${c.zh} (${c.en})`).join(' | ') + ' |')); L.push('');
  }
  L.push('## 心智圖 Mind map', `- **${n.mind_map.center.zh} / ${n.mind_map.center.en}**`);
  n.mind_map.branches.forEach(b => { L.push(`  - ${b.label.zh} / ${b.label.en}`); b.children.forEach(c => { L.push(`    - ${c.label.zh} / ${c.label.en}`); c.leaves.forEach(l => L.push(`      - ${l.zh} / ${l.en}`)); }); });
  L.push('');
  if (n.exam_focus.length) { L.push('## 考試重點 Exam focus'); n.exam_focus.forEach(e => L.push(`- **${e.point.zh}** / ${e.point.en}  \n  ${e.why.zh}`)); L.push(''); }
  if (n.class_qa.length) { L.push('## 課堂問答 Q&A'); n.class_qa.forEach(q => L.push(`**Q:** ${mdBi(q.question)}  \n**A:** ${mdBi(q.answer)}`, '')); }
  L.push('## 自我測驗 Review'); n.review_questions.forEach((q, i) => L.push(`${i + 1}. ${q.question.zh} / ${q.question.en}  \n   答：${q.answer.zh} / ${q.answer.en}`)); L.push('');
  if (n.todo.length) { L.push('## 待辦 To-do'); n.todo.forEach(o => L.push(`- [ ] ${o.zh} / ${o.en}`)); L.push(''); }
  L.push('## 總結 Summary', mdBi(n.summary), '');
  L.push('---', '## 逐字稿 Transcript');
  let prev = null;
  for (const s of lec.segments) {
    const sd = segSides(s);
    if (!prev || prev.speaker !== s.speaker) L.push('', `**${speakerInfo(lec, s.speaker).name}** [${fmtTime(s.start)}]`);
    L.push(`${sd.zh}${sd.en ? '  \n*' + sd.en + '*' : ''}`);
    prev = s;
  }
  const blob = new Blob([L.join('\n')], { type: 'text/markdown' });
  const a = h('a', { href: URL.createObjectURL(blob), download: (lec.course ? lec.course + '-' : '') + n.title.zh.replace(/[\\/:*?"<>|]/g, '') + '.md' });
  document.body.append(a); a.click(); a.remove();
}
function printNotes() {
  const n = state.lecture.notes;
  let area = $('#print-area');
  if (!area) { area = h('div', { id: 'print-area' }); document.body.append(area); }
  area.replaceChildren(
    h('h1', null, bi(n.title)), h('p', { class: 'muted' }, (state.lecture.course || '') + ' · ' + fmtDate(state.lecture.created)),
    NOTE_TABS.map(([k, label]) => h('section', { class: 'note-sec' }, h('h2', null, label), noteSection(k, n))));
  area.querySelectorAll('.note-actions').forEach(e => e.remove());
  setTimeout(() => window.print(), 50);
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
  h('div', { style: 'font-size:1.8rem' }, '📎'),
  h('p', { style: 'margin:4px 0 10px' }, '上傳教授的投影片、講義或課本頁面'),
  h('button', { class: 'btn primary', onclick: () => input.click() }, '選擇檔案'),
  h('p', { class: 'muted small', style: 'margin:10px 0 0' }, 'PDF、PowerPoint (.pptx)、Word (.docx)、圖片、文字檔。整理筆記時會一起讀，用來校正專有名詞和補充內容。'));
  const files = lec.files || [];
  const icon = { pdf: '📕', pptx: '📊', docx: '📄', image: '🖼️', text: '📝' };
  root.replaceChildren(h('div', { class: 'pane-body' }, dz,
    files.map(f => h('div', null,
      h('div', { class: 'file-row' },
        h('span', null, icon[f.kind] || '📄'),
        h('span', { class: 'name', title: f.name }, f.name),
        h('span', { class: 'muted small' }, (f.size / 1024 / 1024).toFixed(1) + ' MB'),
        h('button', { class: 'btn sm', onclick: () => { state.openFile = state.openFile === f.id ? null : f.id; renderFilesPane(); } }, state.openFile === f.id ? '收起' : '預覽'),
        h('button', {
          class: 'btn sm danger', onclick: async () => {
            if (!confirm('移除「' + f.name + '」？')) return;
            lec.files = lec.files.filter(x => x.id !== f.id); await saveLecture(lec); renderRightPane();
          },
        }, '移除')),
      state.openFile === f.id ? filePreview(f) : null))));
}
function filePreview(f) {
  const url = URL.createObjectURL(f.blob);
  if (f.kind === 'pdf') return h('iframe', { class: 'file-preview', src: url, title: f.name });
  if (f.kind === 'image') return h('img', { class: 'file-preview img', src: url, alt: f.name });
  return h('pre', { class: 'panel', style: 'white-space:pre-wrap;max-height:60vh;overflow:auto;font-size:.85rem' }, (f.text || '（沒有可顯示的文字）').slice(0, 20000));
}

function lectureMenu() {
  const lec = state.lecture;
  const dlg = h('dialog', null, h('h3', null, lec.title),
    h('div', { class: 'form' },
      lec.notes ? h('button', { class: 'btn', onclick: () => { dlg.close(); exportMarkdown(); } }, '⤓ 匯出 Markdown（筆記＋逐字稿）') : null,
      lec.notes ? h('button', { class: 'btn', onclick: () => { dlg.close(); printNotes(); } }, '🖨 列印 / 存成 PDF') : null,
      lec.audioParts && lec.audioParts.length ? h('button', {
        class: 'btn', onclick: () => {
          lec.audioParts.forEach((p, i) => { const a = h('a', { href: URL.createObjectURL(p.blob), download: `${lec.title}-錄音${i + 1}.${(p.blob.type || '').includes('mp4') ? 'm4a' : 'webm'}` }); document.body.append(a); a.click(); a.remove(); });
          dlg.close();
        },
      }, '⤓ 下載錄音檔') : null,
      h('button', {
        class: 'btn danger', onclick: async () => {
          if (state.rec) { toast('請先結束錄音'); return; }
          if (!confirm('確定刪除這堂課？錄音、逐字稿、講義和筆記都會一起刪除，無法復原。')) return;
          await DB.del(lec.id); dlg.close(); go('#/');
        },
      }, '🗑 刪除這堂課')),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => dlg.close() }, '關閉')));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
}

/* ---------- settings ---------- */
async function renderSettings() {
  const cfg = settings();
  let usage = '';
  try {
    const est = await navigator.storage.estimate();
    usage = `已使用 ${(est.usage / 1024 / 1024).toFixed(1)} MB（可用約 ${(est.quota / 1024 / 1024 / 1024).toFixed(1)} GB）`;
  } catch { /* unsupported */ }
  const field = (id, label, input, help) => h('div', { class: 'field' }, h('label', { for: id }, label), input, help ? h('div', { class: 'help' }, help) : null);
  const save = () => {
    Store.set('sonioxKey', $('#s-soniox').value.trim());
    Store.set('anthropicKey', $('#s-anth').value.trim());
    Store.set('translate', $('#s-tr').checked);
    Store.set('saveAudio', $('#s-audio').checked);
    Store.set('mainLang', $('#s-lang').value);
    Store.set('detail', $('#s-detail').value);
    toast('已儲存');
  };
  const sel = (id, val, opts) => h('select', { id, class: 'input', onchange: save }, opts.map(([v, l]) => h('option', { value: v, selected: v === val }, l)));
  app().replaceChildren(
    h('header', { class: 'topbar' },
      h('button', { class: 'btn icon ghost', 'aria-label': '返回', onclick: () => go('#/') }, '‹'),
      h('div', { class: 'grow brand' }, '設定')),
    h('main', { class: 'page' }, h('div', { class: 'form' },
      h('div', { class: 'panel' }, h('h3', { style: 'margin-bottom:12px' }, '語音辨識（即時字幕）'),
        field('s-soniox', 'Soniox API 金鑰', h('input', { id: 's-soniox', class: 'input', type: 'password', autocomplete: 'off', value: cfg.sonioxKey, onchange: save, placeholder: '貼上金鑰' }),
          ['可以辨識中英混合、分辨教授和其他人的聲音、即時翻譯。到 ', h('a', { href: 'https://console.soniox.com', target: '_blank', rel: 'noopener' }, 'console.soniox.com'), ' 註冊後建立 API key。留空就用瀏覽器內建的免費辨識（不分講者、沒有即時翻譯，iPhone 上可能不穩定）。']),
        h('div', { style: 'height:12px' }),
        field('s-lang', '教授主要使用的語言', sel('s-lang', cfg.mainLang, [['zh', '中文（夾雜英文）'], ['en', '英文（夾雜中文）']])),
        h('div', { style: 'height:12px' }),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 's-tr', checked: cfg.translate, onchange: save }),
          h('span', null, '即時中英翻譯', h('div', { class: 'muted small' }, '每句話旁邊顯示另一種語言（需要 Soniox）'))),
        h('div', { style: 'height:12px' }),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 's-audio', checked: cfg.saveAudio, onchange: save }),
          h('span', null, '保存錄音檔', h('div', { class: 'muted small' }, '可以點逐字稿回放那段錄音；一小時約 15 MB')))),
      h('div', { class: 'panel' }, h('h3', { style: 'margin-bottom:12px' }, '筆記整理（Claude）'),
        field('s-anth', 'Anthropic API 金鑰', h('input', { id: 's-anth', class: 'input', type: 'password', autocomplete: 'off', value: cfg.anthropicKey, onchange: save, placeholder: 'sk-ant-…' }),
          ['到 ', h('a', { href: 'https://console.anthropic.com', target: '_blank', rel: 'noopener' }, 'console.anthropic.com'), ' 建立。使用 Claude Opus 5.5 整理筆記。']),
        h('div', { style: 'height:12px' }),
        field('s-detail', '筆記詳細程度', sel('s-detail', cfg.detail, [['brief', '精簡'], ['standard', '標準'], ['detailed', '詳細（保留例子與推導）']]))),
      h('div', { class: 'panel small' },
        h('p', { style: 'margin-top:0' }, '🔒 金鑰只存在這台裝置的瀏覽器裡，只會傳給 Soniox 和 Anthropic。錄音、逐字稿、講義和筆記也都只存在這台裝置，不會同步到其他裝置；要在別的裝置看，可以匯出 Markdown 或 PDF。'),
        h('p', { class: 'muted', style: 'margin-bottom:0' }, usage)),
      h('button', { class: 'btn primary', onclick: () => { save(); go('#/'); } }, '完成'))));
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
      state.lecture = lec; state.mobileTab = 'live'; state.noteTab = 'overview'; state.openFile = null;
    }
    state.view = 'lecture';
  } else if (hash === '#/settings') { state.view = 'settings'; state.lecture = null; } else { state.view = 'home'; state.lecture = null; }
  render();
}
function render() {
  if (state.view === 'lecture') renderLecture();
  else if (state.view === 'settings') renderSettings();
  else renderHome();
}
window.addEventListener('hashchange', route);
let wasWide = matchMedia('(min-width: 900px)').matches;
window.addEventListener('resize', () => {
  const wide = matchMedia('(min-width: 900px)').matches;
  if (wide !== wasWide && state.view === 'lecture') { wasWide = wide; renderRightPane(); }
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => { /* offline cache unavailable */ });
try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch { /* ignore */ }
window.__lectureNotes = { state, Recorder, render };
route();
