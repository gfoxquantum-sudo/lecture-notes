// "I zoned out" catch-up and the lecture tutor.
// Free versions run on the device (pick the most telling sentences / find matching moments);
// Pro versions ask Claude, with the same inputs and output shapes so the screens don't care which ran.

const STOP_EN = new Set('the and for that this with you are was were have has had not but they them their there what when where which who will would can could should about into from your our out all any its it’s it\'s just like then than also some more most very really okay ok yeah um uh so well right now one two get got going gonna want know think say said see look make made let lets way thing things here because how why does did doing done been being only even much many each other such same over under again'.split(' '));
const CUE = /(重要|重點|注意|記得|一定要|會考|考試|期中|期末|小考|作業|報告|繳交|截止|下週|下禮拜|下次|important|remember|exam|midterm|final|quiz|homework|assignment|due|deadline|key point|make sure|don't forget)/i;
const DUE_CUE = /(作業|報告|繳交|截止|小考|考試|期中|期末|下週|下禮拜|下次上課|homework|assignment|due|deadline|quiz|exam|midterm|final)/i;

export function tokens(text) {
  const out = [];
  const s = String(text || '').toLowerCase();
  for (const m of s.matchAll(/[a-z][a-z0-9'-]{2,}/g)) if (!STOP_EN.has(m[0])) out.push(m[0]);
  for (const m of s.matchAll(/[一-鿿]+/g)) {
    const r = m[0];
    if (r.length === 1) continue;
    for (let i = 0; i < r.length - 1; i++) out.push(r.slice(i, i + 2));
  }
  return out;
}
const ZH_FILLER = new Set(['我們', '你們', '這個', '那個', '就是', '然後', '所以', '因為', '可以', '一個', '什麼', '沒有', '他們', '這樣', '如果', '現在', '大家', '的話', '一下', '其實', '還是', '也是', '這邊', '那邊', '時候', '好的', '對不', '不是', '知道', '覺得', '應該', '今天', '教授', '老師', '講的', '內容', '需要', '解釋', '哪裡', '哪些', '地方', '最後', '分鐘', '這堂', '堂課', '課堂', '問題', '怎麼', '為什', '什麼', '麼是', '簡單', '告訴', '幫我', '請解', '給我', '我聽', '可能', '搞懂', '最需', '要搞', '這段', '剛剛', '剛才', '說的', '一點']);
const informative = t => !ZH_FILLER.has(t);

/* ---------- catch-up ---------- */
export function windowSegments(segs, endMs, minutes) {
  const from = endMs - minutes * 60000;
  return segs.filter(s => s.text && s.text.trim() && (s.end || s.start) >= from && s.start <= endMs + 1000);
}

export function freeCatchUp(segs, { textOf, isProf }) {
  if (!segs.length) return { points: [], terms: [], heads_up: [] };
  const docs = segs.map(s => ({ s, text: textOf(s), tok: tokens(textOf(s)).filter(informative) }));
  const tf = new Map();
  for (const d of docs) for (const t of new Set(d.tok)) tf.set(t, (tf.get(t) || 0) + 1);
  const scored = docs.map((d, i) => {
    const uniq = [...new Set(d.tok)];
    let sc = uniq.reduce((a, t) => a + Math.log(1 + (tf.get(t) || 0)), 0) / Math.sqrt(Math.max(4, uniq.length));
    if (CUE.test(d.text)) sc += 1.4;
    if (isProf(d.s)) sc += 0.4;
    if (d.text.length < 12) sc *= 0.4;
    return { i, d, sc };
  });
  const n = Math.min(3, docs.length);
  const pick = scored.slice().sort((a, b) => b.sc - a.sc).slice(0, n).sort((a, b) => a.i - b.i);
  const points = pick.map(p => ({ text: trimSentence(p.d.text), tr: p.d.s.tr || '', ms: p.d.s.start }));
  // English terms said in this stretch (EMI classes: the words students most want to catch)
  const en = new Map();
  for (const d of docs) for (const m of d.text.matchAll(/\b([A-Za-z][A-Za-z-]{3,}(?:\s+[A-Za-z][A-Za-z-]{3,}){0,2})\b/g)) {
    const w = m[1].trim(); const lw = w.toLowerCase();
    if (w.split(/\s+/).every(x => STOP_EN.has(x.toLowerCase()))) continue;
    en.set(lw, { term: w, n: (en.get(lw)?.n || 0) + 1 });
  }
  const terms = [...en.values()].filter(t => t.n >= 2 || /[A-Z]/.test(t.term[0])).sort((a, b) => b.n - a.n).slice(0, 5).map(t => ({ en: t.term, zh: '' }));
  const picked = new Set(pick.map(p => p.d.s));
  const heads_up = docs.filter(d => DUE_CUE.test(d.text) && !picked.has(d.s)).slice(-2).map(d => ({ text: trimSentence(d.text), ms: d.s.start }));
  // a reminder that is already one of the points gets marked instead of repeated
  for (const p of points) if (DUE_CUE.test(p.text)) p.flag = true;
  return { points, terms, heads_up };
}
const trimSentence = t => { t = String(t).trim(); return t.length > 120 ? t.slice(0, 118) + '…' : t; };

export const CATCHUP_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['points', 'terms', 'heads_up'],
  properties: {
    points: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'en', 'time'], properties: { text: { type: 'string' }, en: { type: 'string' }, time: { type: 'string' } } } },
    terms: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['en', 'zh'], properties: { en: { type: 'string' }, zh: { type: 'string' } } } },
    heads_up: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'time'], properties: { text: { type: 'string' }, time: { type: 'string' } } } },
  },
};
export const CATCHUP_SYSTEM = `學生上課恍神了幾分鐘，你要用最短的時間幫他跟上。根據逐字稿片段回覆：
- points：2–3 點，按時間順序，用繁體中文（台灣用語）白話說明教授剛剛講了什麼，每點一句、不超過 45 字；en 是同一句的簡短英文；time 填那段開始的 mm:ss。
- terms：剛剛出現、學生最可能聽不懂的專有名詞（最多 4 個），en 原文、zh 中文。沒有就給空陣列。
- heads_up：教授交代的考試、作業、截止日或「這個很重要」之類的提醒；沒有就給空陣列。
- 逐字稿有辨識錯誤是正常的，依上下文判斷。不要編造逐字稿裡沒有的內容。`;

/* ---------- tutor ---------- */
export const TUTOR_SYSTEM = `你是這門課的助教，學生正在複習這一堂課。只根據下面提供的逐字稿、講義和筆記回答。
- 用學生提問的語言回答；中文一律用繁體中文（台灣用語），專有名詞附英文原文。
- 先直接回答，再補充必要的解釋或例子。簡潔，通常 3–8 句；需要時可以用條列。
- 每個重點後面用 [mm:ss] 標出逐字稿裡的時間，讓學生可以點回去聽，例如：教授說這題期中會考 [42:10]。只用逐字稿裡真的有的時間。
- 如果課堂內容沒有提到，就直接說「這堂課沒有提到」，可以補一句一般知識，但要清楚標示「課堂外補充」。
- 逐字稿有辨識錯誤是正常的，依上下文和講義判斷正確的詞。`;

export const SUGGESTIONS = [
  ['target', '這堂課哪些地方可能會考？'],
  ['lightbulb', '用簡單的話解釋最難的概念'],
  ['list-checks', '教授交代了哪些作業或期限？'],
  ['book-open', '用三句話總結這堂課'],
];

export function splitCites(text) {
  // "…會考 [42:10]" → [{t:'…會考 '}, {time:'42:10'}]
  const out = []; let last = 0;
  for (const m of text.matchAll(/[［\[]((?:\d{1,2}:)?\d{1,2}:\d{2})[］\]]/g)) {
    if (m.index > last) out.push({ t: text.slice(last, m.index) });
    out.push({ time: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: text.slice(last) });
  return out;
}

export function freeAnswer(q, { segs, textOf, notes, fmtTime, isProf, endMs }) {
  const ql = q.toLowerCase();
  const blocks = [];
  const recent = q.match(/最後(?:這)?\s*(\d+)\s*分鐘|剛剛|剛才/);
  if (recent && segs.length) {
    const mins = Number(recent[1]) || 5;
    const end = endMs != null ? endMs : (segs[segs.length - 1].end || segs[segs.length - 1].start);
    const c = freeCatchUp(windowSegments(segs, end, mins), { textOf, isProf: isProf || (() => true) });
    if (c.points.length) blocks.push({ title: `最後 ${mins} 分鐘的重點`, items: c.points.map(p => ({ text: p.text, time: fmtTime(p.ms) })) });
    if (c.heads_up.length) blocks.push({ title: '教授的提醒', items: c.heads_up.map(p => ({ text: p.text, time: fmtTime(p.ms) })) });
    if (blocks.length) return { blocks, empty: false };
  }
  const n = notes || null;
  const zh = o => (o && (o.zh || o.en)) || '';
  if (n && /考|exam|test|quiz|期中|期末|重點/.test(ql) && n.exam_focus && n.exam_focus.length) {
    blocks.push({ title: '筆記裡標記的考點', items: n.exam_focus.slice(0, 6).map(e => ({ text: zh(e.point), time: e.time })) });
  }
  if (n && /作業|報告|期限|截止|交|homework|assignment|due|deadline|準備|todo/.test(ql) && n.todo && n.todo.length) {
    blocks.push({ title: '教授交代的事項', items: n.todo.map(t => ({ text: zh(t) })) });
  }
  if (n && /總結|摘要|summary|講了什麼|在講什麼|大綱|三句/.test(ql)) {
    blocks.push({ title: '這堂課的重點', items: [n.one_line && { text: zh(n.one_line) }, ...(n.outline || []).slice(0, 6).map(o => ({ text: zh(o.heading), time: o.time }))].filter(Boolean) });
  }
  if (n && n.key_terms) {
    const hit = n.key_terms.filter(k => (k.term_en && ql.includes(k.term_en.toLowerCase())) || (k.term_zh && q.includes(k.term_zh))).slice(0, 3);
    if (hit.length) blocks.push({ title: '名詞解釋', items: hit.map(k => ({ text: `${k.term_zh || ''}${k.term_en ? `（${k.term_en}）` : ''}：${zh(k.definition)}` })) });
  }
  // find the moments in the lecture that match the question best
  const qt = [...new Set(tokens(q).filter(informative))];
  if (qt.length && segs.length) {
    const df = new Map();
    const docs = segs.map(s => { const tok = new Set(tokens(textOf(s))); for (const t of tok) df.set(t, (df.get(t) || 0) + 1); return { s, tok }; });
    const N = docs.length;
    const scored = docs.map((d, i) => ({ i, d, sc: qt.reduce((a, t) => a + (d.tok.has(t) ? Math.log(1 + N / (df.get(t) || 1)) : 0), 0) }))
      .filter(x => x.sc > 0).sort((a, b) => b.sc - a.sc);
    const picked = []; const used = new Set();
    for (const x of scored) {
      if (picked.length >= 4) break;
      if (used.has(x.i) || used.has(x.i - 1) || used.has(x.i + 1)) continue;
      used.add(x.i);
      const nxt = segs[x.i + 1];
      const text = textOf(x.d.s) + (nxt && nxt.speaker === x.d.s.speaker && textOf(x.d.s).length < 60 ? ' ' + textOf(nxt) : '');
      picked.push({ text: text.length > 160 ? text.slice(0, 158) + '…' : text, time: fmtTime(x.d.s.start), i: x.i });
    }
    const seen = blocks.flatMap(b => b.items.map(it => String(it.text).slice(0, 18)));
    const fresh = picked.filter(p => !seen.some(k => k && p.text.includes(k))).slice(0, blocks.length ? 2 : 4);
    fresh.sort((a, b) => a.i - b.i);
    if (fresh.length) blocks.push({ title: blocks.length ? '課堂上也提到' : '課堂上相關的片段', items: fresh });
  }
  return { blocks, empty: !blocks.length };
}
