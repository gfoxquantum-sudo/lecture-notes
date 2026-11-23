// On-device speech recognition (Whisper, through transformers.js on WebGPU). Runs in a worker so the page stays smooth.
// The audio never leaves the device: only the model files are downloaded, once, and kept in the browser's cache.
import { AutoProcessor, AutoTokenizer, WhisperForConditionalGeneration } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';

const MODELS = {
  // In the classroom tests this one was as accurate as the larger model below, and it is lighter to run (410 MB).
  small: { id: 'onnx-community/whisper-small', dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' } },
  // for graphics chips without 16-bit float support: same model, stored differently (300 MB)
  lite: { id: 'onnx-community/whisper-small', dtype: { encoder_model: 'q4', decoder_model_merged: 'q4' } },
  // kept for comparison in the tests (563 MB)
  large: { id: 'onnx-community/whisper-large-v3-turbo', dtype: { encoder_model: 'q4f16', decoder_model_merged: 'q4f16' } },
};

let processor, tokenizer, model, special = null, busy = Promise.resolve();

let dbg = {};
async function load(size, opts) {
  dbg = opts || {};
  const adapter = navigator.gpu && await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('這台裝置的瀏覽器沒有可用的繪圖晶片介面（WebGPU）');
  if (!adapter.features.has('shader-f16') && size !== 'lite') size = 'lite';
  postMessage({ type: 'variant', size });
  const m = { ...(MODELS[size] || MODELS.small) };
  if (dbg.dtype) m.dtype = dbg.dtype;
  const files = new Map();
  const progress = p => {
    if (p.status !== 'progress' || !p.total) return;
    files.set(p.file, [p.loaded, p.total]);
    let a = 0, b = 0; for (const [l, t] of files.values()) { a += l; b += t; }
    postMessage({ type: 'progress', loaded: a, total: b });
  };
  [processor, tokenizer, model] = await Promise.all([
    AutoProcessor.from_pretrained(m.id),
    AutoTokenizer.from_pretrained(m.id),
    WhisperForConditionalGeneration.from_pretrained(m.id, { device: 'webgpu', dtype: m.dtype, progress_callback: progress }),
  ]);
  const id = t => tokenizer.convert_tokens_to_ids([t])[0];
  special = { prev: id('<|startofprev|>'), sot: id('<|startoftranscript|>'), zh: id('<|zh|>'), en: id('<|en|>'), task: id('<|transcribe|>'), nots: id('<|notimestamps|>') };
  // first run compiles the GPU programs: do it now, not on the first sentence of the lecture
  await run(new Float32Array(16000), { lang: 'zh', prompt: '' });
}

async function run(audio, { lang, prompt, gen }) {
  const inputs = await processor(audio);
  let init = [special.sot, lang === 'en' ? special.en : special.zh, special.task, special.nots];
  if (prompt && special.prev != null) {
    const ids = tokenizer.encode(' ' + prompt.trim(), { add_special_tokens: false }).slice(-200);
    init = [special.prev, ...ids, ...init];
  }
  // about 7 Chinese characters a second is already very fast speech; the cap stops runaway repetition
  const max_new_tokens = Math.min(440 - init.length, Math.max(24, Math.round(audio.length / 16000 * 14) + 16));
  const out = await model.generate({ ...inputs, decoder_input_ids: init, max_new_tokens, ...(dbg.gen || {}), ...(gen || {}) });
  const seq = (out.sequences || out).tolist()[0].map(Number).slice(init.length);
  run.cut = seq.length >= max_new_tokens;      // ran to the limit: it was probably going round in circles
  const text = tokenizer.decode(seq, { skip_special_tokens: true }).trim();
  if (dbg.raw && text.includes('\uFFFD')) postMessage({ type: 'debug', pieces: seq.map(t => t + ':' + tokenizer.decode([t])) });
  return text;
}

onmessage = e => {
  const m = e.data;
  busy = busy.then(async () => {
    try {
      if (m.type === 'load') { await load(m.size, m.opts); postMessage({ type: 'ready' }); }
      else if (m.type === 'run') {
        const t0 = performance.now();
        const text = await run(m.audio, m);
        postMessage({ type: 'result', id: m.id, text, cut: !!run.cut, ms: performance.now() - t0 });
      }
    } catch (err) {
      postMessage({ type: 'error', id: m.id, stage: m.type, message: String((err && err.message) || err).slice(0, 300) });
    }
  });
};
