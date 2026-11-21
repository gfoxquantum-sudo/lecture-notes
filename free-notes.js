// Free notes engine: builds structured notes on the device, no API key needed.
// It ranks sentences by how distinctive their words are, picks up phrases the
// professor uses to stress a point, and lays the result out in the same shape
// the Claude notes use, so the notes view renders both the same way.

const ZH_STOP = new Set(('的 了 是 我 你 他 她 它 我們 你們 他們 這 那 這個 那個 這些 那些 這樣 那樣 這邊 那邊 就是 然後 所以 一個 一些 可以 在 有 也 就 都 會 要 說 對 嗎 呢 吧 啊 喔 哦 嗯 欸 好 跟 和 與 而 但 但是 因為 如果 什麼 怎麼 為什麼 大家 同學 老師 今天 現在 一下 東西 其實 還是 還有 已經 可能 應該 比較 非常 很 再 去 來 到 把 被 讓 給 著 過 沒有 不是 不會 自己 時候 地方 問題 部分 方面 剛剛 剛才 等等 之後 之前 以後 以前 然後呢 好像 一樣 一點 有點 真的 這種 那種 一種 個 們 上 下 中 裡 裡面 出來 起來 知道 覺得 看到 看 講 想 做 用 OK ok 對不對 是不是 有沒有 等一下 好不好 所謂 第一 第二 第三 另外 也就是 也是 就會 就是說 或是 或者 以及 還要 而且 只是 只有 這裡 那裡 這麼 那麼 多少 怎麼樣 一定 每 各 該 某 之 其 於 以 及 並 或 則 即 為 由 從 向 對於 關於 我說 你看 我想 他說 等於 比較 接下來 再來 最後 回去 重點 首先 接著 意思 例如 整理 記得 大概 部分 情況 結果 東西 剛好 今天 開始 下來 來說').split(/\s+/));
const EN_STOP = new Set(('a an the and or but if then so of to in on at for from by with about as is are was were be been being it its this that these those there here we you they he she i me my our your their them us do does did done have has had not no yes ok okay so just like very really can could will would should may might must also than more most some any all each such what which who whom whose when where why how into over under again further once only own same too s t don now um uh yeah right well gonna wanna kind sort thing things lot get got go going one two three first second let lets know think mean see say said look'.split(' ')));

const EMPHASIS = [
  ['考試', '提到考試'], ['會考', '說會考'], ['期中', '提到期中考'], ['期末', '提到期末考'], ['小考', '提到小考'],
  ['重要', '說很重要'], ['重點', '說是重點'], ['記住', '要大家記住'], ['記得', '要大家記得'], ['注意', '提醒要注意'],
  ['一定要', '說一定要'], ['關鍵', '說是關鍵'], ['核心', '說是核心'], ['常考', '說常考'], ['必考', '說必考'],
  ['important', 'said "important"'], ['exam', 'mentioned the exam'], ['midterm', 'mentioned the midterm'], ['final', 'mentioned the final'],
  ['remember', 'said "remember"'], ['key point', 'called it a key point'], ['note that', 'said "note that"'], ['must', 'said "must"'], ['quiz', 'mentioned a quiz'],
];
const TODO_CUES = /作業|報告|繳交|截止|下週|下禮拜|下星期|考試範圍|上傳|deadline|homework|due|assignment|submit/i;
const FILLER_START = /^(那|然後|所以|好|OK|ok|嗯|欸|呃|就是|那我們|那麼|對|好那|接下來|那接下來)[，,、\s]*/;

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('zh-Hant', { granularity: 'word' }) : null;

function tokens(text) {
  const out = [];
  const isZh = /[一-鿿]/;
  if (segmenter) {
    for (const s of segmenter.segment(text)) {
      if (!s.isWordLike) continue;
      const w = s.segment.trim();
      if (isZh.test(w)) { if (w.length >= 2 && !ZH_STOP.has(w)) out.push(w); }
      else { const lw = w.toLowerCase(); if (lw.length >= 3 && !EN_STOP.has(lw) && !/^\d+$/.test(lw)) out.push(lw); }
    }
    return out;
  }
  // Fallback: English words plus Chinese bigrams.
  for (const m of text.matchAll(/[A-Za-z][A-Za-z-]{2,}/g)) { const lw = m[0].toLowerCase(); if (!EN_STOP.has(lw)) out.push(lw); }
  for (const run of text.match(/[一-鿿]+/g) || []) for (let i = 0; i < run.length - 1; i++) { const b = run.slice(i, i + 2); if (!ZH_STOP.has(b)) out.push(b); }
  return out;
}

function splitSentences(text) {
  return text.split(/(?<=[。！？!?；;])\s*|(?<=\.)\s+(?=[A-Z])/).map(s => s.trim()).filter(s => s.replace(/[\s，,。.!?！？]/g, '').length >= 4);
}
const clean = s => s.replace(FILLER_START, '').replace(FILLER_START, '').trim();
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const isZhText = s => (s.match(/[一-鿿]/g) || []).length >= (s.match(/[A-Za-z]/g) || []).length / 3;

// side(text) puts the text on the right language side; the other side is left empty
// unless a translator fills it in later.
const side = text => (isZhText(text) ? { zh: text, en: '' } : { zh: '', en: text });

export function buildFreeNotes({ sentencesIn, slidesText, title, professorId, fmtTime }) {
  // ---- sentences ----
  const sents = [];
  for (const s of sentencesIn) {
    for (const part of splitSentences(s.text)) {
      const text = clean(part);
      if (text.length < 4) continue;
      sents.push({ text, t: s.start || 0, speaker: s.speaker, toks: tokens(text), idx: sents.length });
    }
  }
  const slideLines = (slidesText || '').split(/\n+/).map(l => l.trim()).filter(l => l.length >= 2 && !/^--- 投影片/.test(l));
  const slideToks = new Set(tokens(slideLines.join(' ')));

  // ---- chunks (time-based sections) ----
  const total = sents.length ? sents[sents.length - 1].t : 0;
  // About one section per 5 minutes, with at least 3 sentences per section.
  const byTime = total > 60000 ? Math.ceil(total / 300000) : Math.ceil(sents.length / 8);
  // Long lectures (3–4 hours) get up to 20 sections, roughly one per 10–12 minutes.
  const nSections = sents.length ? Math.max(1, Math.min(total > 3600000 ? 20 : 10, total > 3600000 ? Math.ceil(total / 660000) : byTime, Math.floor(sents.length / 3))) : 0;
  const chunks = Array.from({ length: nSections }, () => []);
  sents.forEach((s, i) => {
    const k = total > 60000 ? Math.min(nSections - 1, Math.floor((s.t / (total + 1)) * nSections)) : Math.min(nSections - 1, Math.floor((i / sents.length) * nSections));
    chunks[k].push(s);
  });
  const nonEmpty = chunks.filter(c => c.length);

  // ---- term statistics ----
  const tf = new Map(), df = new Map();
  for (const c of nonEmpty) {
    const seen = new Set();
    for (const s of c) for (const w of s.toks) { tf.set(w, (tf.get(w) || 0) + 1); if (!seen.has(w)) { seen.add(w); df.set(w, (df.get(w) || 0) + 1); } }
  }
  const N = Math.max(1, nonEmpty.length);
  const weight = w => (tf.get(w) || 0) * (1 + Math.log(1 + N / (df.get(w) || 1))) * (slideToks.has(w) ? 1.6 : 1) * (w.length >= 3 ? 1.15 : 1);
  const globalKw = [...tf.keys()].filter(w => (tf.get(w) || 0) >= 2 || slideToks.has(w)).sort((a, b) => weight(b) - weight(a));

  const emphasisOf = text => { const low = text.toLowerCase(); return EMPHASIS.find(([cue]) => low.includes(cue.toLowerCase())); };
  const score = s => {
    if (!s.toks.length) return 0;
    const base = s.toks.reduce((a, w) => a + Math.log(1 + weight(w)), 0) / Math.sqrt(s.toks.length + 2);
    const len = s.text.length;
    const lenAdj = len < 10 ? 0.6 : len > 140 ? 0.8 : 1;
    const prof = professorId && s.speaker === professorId ? 1.1 : 1;
    return base * lenAdj * prof * (emphasisOf(s.text) ? 1.5 : 1);
  };
  for (const s of sents) s.score = score(s);
  const byScore = [...sents].sort((a, b) => b.score - a.score);
  const topIn = (list, n) => [...list].sort((a, b) => b.score - a.score).slice(0, n).sort((a, b) => a.idx - b.idx);

  // ---- outline ----
  const usedHeads = new Set();
  const outline = nonEmpty.map(c => {
    const local = new Map();
    for (const s of c) for (const w of s.toks) local.set(w, (local.get(w) || 0) + 1);
    const kws = [...local.keys()].sort((a, b) => local.get(b) * Math.log(1 + N / (df.get(b) || 1)) * (slideToks.has(b) ? 1.4 : 1) - local.get(a) * Math.log(1 + N / (df.get(a) || 1)) * (slideToks.has(a) ? 1.4 : 1));
    const heads = kws.filter(w => !usedHeads.has(w)).slice(0, 2);
    heads.forEach(w => usedHeads.add(w));
    const pts = topIn(c, Math.min(6, Math.max(3, Math.round(c.length / 5))));
    const picked = new Set(pts.map(s => s.idx));
    const inChunk = new Map(c.map(s => [s.idx, s]));
    const follow = s => { const nx = inChunk.get(s.idx + 1); return nx && !picked.has(nx.idx) && nx.text.length >= 8 && !/[？?]$/.test(nx.text) ? side(clip(nx.text, 200)) : { zh: '', en: '' }; };
    const gist = [...c].sort((a, b) => b.score - a.score)[0];
    return {
      heading: side(heads.join('・') || clip(pts[0] ? pts[0].text : '內容', 14)),
      time: fmtTime(c[0].t),
      summary: gist && !picked.has(gist.idx) ? side(clip(gist.text, 90)) : { zh: '', en: '' },   // never repeat a point as the gist
      points: pts.map(s => ({ text: side(clip(s.text, 160)), detail: follow(s), emphasis: !!emphasisOf(s.text), source: 'lecture' })),
      _kws: kws.slice(0, 8),
      _chunk: c,
    };
  });
  if (!outline.length && slideLines.length) {
    // Slides only: use slide titles (first line of each slide) as a preview outline.
    const slides = (slidesText || '').split(/--- 投影片 \d+ ---/).map(s => s.trim()).filter(Boolean);
    const groups = slides.length ? slides : [slideLines.join('\n')];
    for (let i = 0; i < groups.length && outline.length < 10; i += Math.max(1, Math.ceil(groups.length / 8))) {
      const lines = groups[i].split(/\n+/).map(l => l.trim()).filter(Boolean);
      if (!lines.length) continue;
      outline.push({ heading: side(clip(lines[0], 30)), time: '', points: lines.slice(1, 6).map(l => ({ text: side(clip(l, 160)), emphasis: false, source: 'slides' })), _kws: tokens(lines.join(' ')).slice(0, 6) });
    }
  }

  // ---- exam focus ----
  const exam_focus = sents.filter(s => emphasisOf(s.text) && !TODO_CUES.test(s.text)).sort((a, b) => b.score - a.score).slice(0, 8).sort((a, b) => a.idx - b.idx)
    .map(s => { const e = emphasisOf(s.text); return { point: side(clip(s.text, 160)), why: /[一-鿿]/.test(e[1]) ? { zh: '教授' + e[1], en: '' } : { zh: '', en: 'The professor ' + e[1] }, time: fmtTime(s.t) }; });

  // ---- key terms ----
  const allText = sents.map(s => s.text).join('\n') + '\n' + slideLines.join('\n');
  const enTerms = new Map();
  for (const m of allText.matchAll(/(?<![A-Za-z])([A-Za-z][A-Za-z'’-]+(?:\s+[A-Za-z][A-Za-z'’-]+){0,3})(?![A-Za-z])/g)) {
    let term = m[1].trim();
    const words = term.split(/\s+/).filter(w => !EN_STOP.has(w.toLowerCase()));
    if (!words.length) continue;
    term = words.join(' ');
    if (term.length < 3 || /^(ok|okay|yes|no|so)$/i.test(term)) continue;
    // Only keep English terms that appear inside Chinese text or on slides: those are usually technical vocabulary.
    const ctx = allText.slice(Math.max(0, m.index - 6), m.index + m[0].length + 6);
    if (!/[一-鿿]/.test(ctx) && !slideToks.has(term.toLowerCase())) continue;
    const k = term.toLowerCase();
    const cur = enTerms.get(k) || { term, n: 0, at: m.index, raw: m[1].trim() };
    cur.n++; enTerms.set(k, cur);
  }
  const findSentence = w => byScore.find(s => s.text.toLowerCase().includes(w.toLowerCase()));
  // The Chinese name usually sits right before the English term: 「…是賽局理論 game theory」.
  const BOUNDARY = /^.*(?:也就是|就是|叫做|稱為|所謂|造成|我們看|來看|講|是|的|看|叫|和|跟|與|及|或|把|在|到|用|去)/;
  const zhBefore = (raw) => {
    const re = new RegExp('([\\u4e00-\\u9fff]{2,10})[，,、]?\\s*(?:也就是|就是|叫做|又稱)?\\s*[（(]?\\s*' + raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const m = allText.match(re);
    if (!m) return '';
    let zh = m[1].replace(BOUNDARY, '');
    if (zh.length < 2) return '';
    if (zh.length > 7) zh = zh.slice(-7);
    return ZH_STOP.has(zh) ? '' : zh;
  };
  const zhLecture = isZhText(sents.map(s => s.text).join('') || slideLines.join(''));
  let key_terms = [...enTerms.values()].sort((a, b) => b.n - a.n || a.at - b.at).slice(0, 12).sort((a, b) => a.at - b.at).map(t => {
    const s = findSentence(t.term);
    return { term_en: t.term, term_zh: zhBefore(t.raw), definition: side(s ? clip(s.text, 140) : ''), _at: t.at };
  });
  if (key_terms.length < 4) {
    for (const w of globalKw.filter(w => /[一-鿿]/.test(w)).slice(0, 10 - key_terms.length)) {
      const s = findSentence(w);
      key_terms.push({ term_en: '', term_zh: w, definition: side(s ? clip(s.text, 140) : '') });
    }
  }
  // Drop names that only show up in logistics ("upload to Moodle"): they are not course concepts.
  key_terms = key_terms.filter(t => {
    if (!t.term_en && !t.term_zh) return false;
    if (t.term_zh || !t.term_en) return true;
    const s = findSentence(t.term_en);
    return !(s && TODO_CUES.test(s.text));
  });

  // Name each section after the terms it introduces: 「完全競爭市場・價格接受者」 reads better than raw keywords.
  const firstIdx = t => { const w = (t.term_en || t.term_zh).toLowerCase(); const s = sents.find(x => x.text.toLowerCase().includes(w)); return s ? s.idx : -1; };
  for (const sec of outline) {
    if (!sec._chunk) continue;
    const lo = sec._chunk[0].idx, hi = sec._chunk[sec._chunk.length - 1].idx;
    sec._terms = key_terms.filter(t => { const i = firstIdx(t); return i >= lo && i <= hi; });
    const named = sec._terms.filter(t => t.term_zh || t.term_en).slice(0, 2);
    if (named.length) {
      const zh = named.map(t => t.term_zh || t.term_en).join('・');
      const en = named.every(t => t.term_en) ? named.map(t => t.term_en).join(' · ') : '';
      sec.heading = { zh: zhLecture ? zh : '', en: zhLecture ? en : (en || zh) };
    }
  }

  // ---- class Q&A ----
  const isQ = s => /[？?]$/.test(s.text) || /(嗎|呢)[。]?$/.test(s.text) || /^(請問|老師|教授)/.test(s.text);
  const class_qa = [];
  for (let i = 0; i < sents.length - 1 && class_qa.length < 6; i++) {
    const s = sents[i];
    if (!isQ(s) || s.text.length < 6) continue;
    const fromOther = s.speaker && professorId && s.speaker !== professorId && s.speaker !== '?';
    if (professorId && s.speaker !== '?' && !fromOther) continue; // rhetorical question by the professor
    const ans = sents.slice(i + 1, i + 3).map(x => x.text).join(' ');
    class_qa.push({ question: side(clip(s.text, 160)), answer: side(clip(ans, 220)), asked_by: fromOther ? '同學' : '課堂提問' });
  }

  // ---- mind map ----
  const LEAF_NOISE = /^[的是很]|[的是了]$|^(很多|一家|幾家|少數|重要|首先|一定|大家|這個|那個)$/;
  const isLeaf = x => /[\u4e00-\u9fff]/.test(x) && x.length >= 2 && !LEAF_NOISE.test(x) && !EMPHASIS.some(([cue]) => x.includes(cue));
  const branches = outline.slice(0, 12).map(sec => {
    if (sec._terms && sec._terms.length) {
      return {
        label: sec.heading,
        children: sec._terms.slice(0, 4).map(t => {
          const w = (t.term_en || t.term_zh).toLowerCase();
          const co = new Map();
          for (const s of sents) if (s.text.toLowerCase().includes(w)) for (const x of s.toks) if (isLeaf(x) && !(t.term_zh || '').includes(x)) co.set(x, (co.get(x) || 0) + 1);
          const leaves = [...co.keys()].sort((a, b) => co.get(b) - co.get(a)).slice(0, 2).map(side);
          return { label: { zh: t.term_zh || (zhLecture ? t.term_en : ''), en: t.term_en || '' }, leaves };
        }),
      };
    }
    const kws = (sec._kws || []).filter(w => !(sec.heading.zh || sec.heading.en).includes(w)).slice(0, 4);
    return {
      label: sec.heading,
      children: kws.map(w => {
        const co = new Map();
        for (const s of sents) if (s.toks.includes(w)) for (const x of s.toks) if (x !== w && !kws.includes(x)) co.set(x, (co.get(x) || 0) + 1);
        const leaves = [...co.keys()].sort((a, b) => co.get(b) - co.get(a)).slice(0, 2).map(side);
        return { label: side(w), leaves };
      }),
    };
  });

  // ---- review questions ----
  const review_questions = [];
  const usedQ = new Set();
  for (const t of key_terms) {
    if (review_questions.length >= 6) break;
    const name = t.term_zh || t.term_en;
    const def = t.definition.zh || t.definition.en;
    if (!def || usedQ.has(name)) continue;
    usedQ.add(name);
    review_questions.push({
      question: t.term_zh ? { zh: `什麼是「${t.term_zh}」${t.term_en ? '（' + t.term_en + '）' : ''}？`, en: '' }
        : zhLecture ? { zh: `什麼是「${t.term_en}」？`, en: '' } : { zh: '', en: `What is "${t.term_en}"?` },
      answer: t.definition,
    });
  }
  for (const e of exam_focus) {
    if (review_questions.length >= 9) break;
    const txt = e.point.zh || e.point.en;
    const kw = tokens(txt).sort((a, b) => weight(b) - weight(a))[0];
    if (!kw || usedQ.has(kw)) continue;
    usedQ.add(kw);
    review_questions.push({ question: isZhText(txt) ? { zh: `教授特別強調「${kw}」的哪一點？`, en: '' } : { zh: '', en: `What did the professor stress about "${kw}"?` }, answer: e.point });
  }
  for (const sec of outline) {
    if (review_questions.length >= 8) break;
    const p = sec.points[0];
    if (!p) continue;
    const head = sec.heading.zh || sec.heading.en;
    review_questions.push({ question: sec.heading.zh ? { zh: `「${head}」這段在講什麼？`, en: '' } : { zh: '', en: `What was the section on "${head}" about?` }, answer: p.text });
  }

  // ---- overview / summary / todo ----
  const top = byScore.slice(0, 5).sort((a, b) => a.idx - b.idx);
  const joinSide = list => side(list.map(s => s.text).join(isZhText(list.map(s => s.text).join('')) ? '' : ' '));
  const one = byScore[0];
  const todo = sents.filter(s => TODO_CUES.test(s.text)).slice(0, 6).map(s => side(clip(s.text, 140)));

  for (const sec of outline) delete sec._kws;
  const openingEnd = sents.length ? allText.indexOf(sents[Math.min(2, sents.length - 1)].text) + sents[Math.min(2, sents.length - 1)].text.length : 0;
  const opening = key_terms.find(t => t.term_zh && t._at <= openingEnd);
  const autoTitle = opening ? opening.term_zh : outline[0] ? (outline[0].heading.zh || outline[0].heading.en) : (globalKw[0] || '課堂筆記');
  for (const t of key_terms) delete t._at;
  const notes = {
    title: opening && !title ? { zh: opening.term_zh, en: opening.term_en } : side(title || autoTitle),
    one_line: one ? side(clip(one.text, 120)) : side('（內容太少，無法整理）'),
    overview: top.length ? joinSide(top.slice(0, 3)) : side(slideLines.slice(0, 3).join('；') || '（沒有足夠的內容）'),
    professor_speaker: professorId || '',
    learning_objectives: key_terms.length >= 2
      ? key_terms.slice(0, 5).map(t => ({ zh: t.term_zh ? `理解「${t.term_zh}」${t.term_en ? '（' + t.term_en + '）' : ''}` : (zhLecture ? `理解「${t.term_en}」` : ''), en: t.term_en ? `Understand ${t.term_en}` : '' }))
      : globalKw.slice(0, 4).map(w => (/[一-鿿]/.test(w) ? { zh: `理解「${w}」`, en: '' } : { zh: '', en: `Understand "${w}"` })),
    outline: outline.map(({ heading, time, summary, points }) => ({ heading, time, summary: summary || { zh: '', en: '' }, points })),
    mind_map: { center: opening && !title ? { zh: opening.term_zh, en: opening.term_en } : side(title || autoTitle), branches },
    key_terms,
    tables: [],
    exam_focus,
    class_qa,
    review_questions,
    todo,
    summary: top.length ? joinSide(top) : side(''),
  };
  notes.quiz = buildQuiz(notes);
  return notes;
}

// Walks every {zh, en} pair in the notes and fills the empty side with translate().
// Multiple-choice and fill-in-the-blank questions made from finished notes (also used for notes saved before quizzes existed).
// Kept from being trivial: choices are told apart by their descriptions, and blanks are cut out of the professor's own key sentences.
export function buildQuiz(n) {
  const terms = (n.key_terms || []).map(t => ({ name: t.term_zh || t.term_en, alt: t.term_zh && t.term_en ? t.term_en : '', def: t.definition || {}, t }))
    .filter(x => x.name && (x.def.zh || x.def.en));
  const defText = x => x.def.zh || x.def.en;
  const CUE = /(會考|必考|很重要|要記得|記得|一定要|注意|important|exam|remember)/i;
  // The description on its own: no term names (they would give the answer away) and no "this will be on the exam" asides.
  const bare = (text, x) => {
    let t = text;
    for (const y of terms) for (const w of [y.t.term_zh, y.t.term_en].filter(Boolean)) if (y === x || t.startsWith(w)) t = t.split(w).join(y === x ? '' : w);
    t = t.replace(/[（(]\s*[）)]/g, '').replace(/^[\s，,、:：]*(是指|指的是|就是|是|means|is|refers to)\s*/i, '');
    const parts = t.split(/(?<=[，,；;])/);
    while (parts.length > 1 && CUE.test(parts[parts.length - 1])) parts.pop();
    return parts.join('').replace(/[，,；;。.\s]+$/, '');
  };
  const sideOf = (d, x) => ({ zh: d.zh ? bare(d.zh, x) : '', en: d.en ? bare(d.en, x) : '' });
  const pick = (list, k, seed) => { const a = list.slice(); const out = []; let r = seed * 7 + 3; while (a.length && out.length < k) { r = (r * 31 + 17) % 997; out.push(a.splice(r % a.length, 1)[0]); } return out; };
  const place = (right, wrong, seed) => { const opts = wrong.slice(); const at = (seed * 5 + 1) % (wrong.length + 1); opts.splice(at, 0, right); return { opts, at }; };
  const choice = [], blank = [];

  // Only sentences that really define something make fair options ("X 是指…"), not ones that merely mention the term.
  const defining = x => /(是指|指的是|就是|定義|means|refers to|is defined)/i.test(defText(x));
  terms.filter(defining).forEach((x, i) => {
    const others = terms.filter(y => y !== x && defining(y) && defText(y) !== defText(x));
    if (others.length < 2 || choice.length >= 6) return;
    const wrong = pick(others, 3, i);
    const zh = !!(x.def.zh || x.t.term_zh);
    if (i % 2 === 0) {     // which statement is true of X?
      const { opts, at } = place(sideOf(x.def, x), wrong.map(y => sideOf(y.def, y)), i);
      choice.push({ type: 'choice', question: zh ? { zh: `關於「${x.name}」${x.alt ? '（' + x.alt + '）' : ''}，下列哪一個敘述正確？`, en: '' } : { zh: '', en: `Which statement about "${x.name}" is correct?` },
        options: opts, answer_index: at,
        answer: { zh: '', en: '' }, explanation: x.def });
    } else {               // which term does this describe?
      const { opts, at } = place(x, wrong, i);
      const d = bare(defText(x), x);
      choice.push({ type: 'choice', question: zh ? { zh: `教授的這段說明是在講哪一個概念？「${d}」`, en: '' } : { zh: '', en: `Which concept is being described? "${d}"` },
        options: opts.map(y => ({ zh: y.t.term_zh || '', en: y.t.term_en || '' })), answer_index: at,
        answer: { zh: '', en: '' }, explanation: x.def });
    }
  });

  const sentences = [...(n.exam_focus || []).map(e => e.point), ...(n.outline || []).flatMap(o => (o.points || []).filter(p => p.emphasis).map(p => p.text)),
    ...(n.outline || []).flatMap(o => (o.points || []).slice(0, 2).map(p => p.text))];
  const used = new Set();
  for (const sen of sentences) {
    if (blank.length >= 6) break;
    const txt = (sen && (sen.zh || sen.en)) || '';
    if (txt.length < 10 || used.has(txt)) continue;
    const hit = terms.map(x => [x, [x.t.term_zh, x.t.term_en].filter(Boolean).find(w => txt.includes(w))]).find(([x, w]) => w && !used.has(x.name));
    if (!hit) continue;
    const [x, w] = hit;
    used.add(txt); used.add(x.name);
    const cut = txt.replace(w, '＿＿＿＿').replace(/＿＿＿＿\s*[（(][^）)]*[）)]/, '＿＿＿＿');
    if (cut.replace(/[＿\s，。,.]/g, '').length < 8) continue;
    blank.push({ type: 'blank', question: sen.zh ? { zh: cut, en: '' } : { zh: '', en: cut }, options: [], answer_index: -1,
      answer: { zh: x.t.term_zh || '', en: x.t.term_en || '' }, explanation: x.def });
  }
  const out = [];
  for (let i = 0; i < Math.max(choice.length, blank.length); i++) { if (choice[i]) out.push(choice[i]); if (blank[i]) out.push(blank[i]); }
  return out.slice(0, 10);
}

export async function fillTranslations(notes, translate, onProgress) {
  const pairs = [];
  const walk = o => {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (o && typeof o === 'object') {
      if ('zh' in o && 'en' in o && Object.keys(o).length === 2) { if ((o.zh && !o.en) || (!o.zh && o.en)) pairs.push(o); return; }
      Object.values(o).forEach(walk);
    }
  };
  walk(notes);
  let i = 0, fails = 0;
  for (const p of pairs) {
    try {
      if (p.zh && !p.en) p.en = await translate(p.zh, 'zh', 'en');
      else if (p.en && !p.zh) p.zh = await translate(p.en, 'en', 'zh');
      fails = 0;
    } catch {
      if (++fails >= 2) break; // translator is not working; keep the rest in one language
    }
    onProgress && onProgress(++i, pairs.length);
  }
}
