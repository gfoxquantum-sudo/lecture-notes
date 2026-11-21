// Printable notes (A4) for PDF export — what goes into GoodNotes or gets shared with classmates.
// Wide margins and blank answer space so it can be written on with a pencil.

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function notesDocument(lec, n, { lang = 'both', mindMapHTML = '', mmCSS = '', quiz = [], fmtDate, fmtTime }) {
  const t = o => {
    if (!o) return '';
    const zh = o.zh || '', en = o.en || '';
    if (lang === 'zh') return esc(zh || en);
    if (lang === 'en') return esc(en || zh);
    return esc(zh || en) + (zh && en && en !== zh ? `<span class="en">${esc(en)}</span>` : '');
  };
  const plain = o => esc(o ? (lang === 'en' ? o.en || o.zh : o.zh || o.en) : '');
  const sec = (title, icon, body, cls = '') => body ? `<section class="${cls}"><h2><span class="ic">${icon}</span>${title}</h2>${body}</section>` : '';
  const time = s => (s ? `<span class="tm">${esc(s)}</span>` : '');
  const dur = lec.durationMs ? fmtTime(lec.durationMs) : '';

  const outline = (n.outline || []).map((o, i) => `<div class="ol">
    <h3>${time(o.time)}${t(o.heading)}</h3>${o.summary && (o.summary.zh || o.summary.en) ? `<p class="gist">${t(o.summary)}</p>` : ''}
    <ul>${(o.points || []).map(p => `<li class="${p.emphasis ? 'em' : ''}">${p.emphasis ? '<b class="star">★</b>' : ''}${t(p.text)}${p.source === 'slides' ? '<span class="src">講義</span>' : ''}${p.detail && (p.detail.zh || p.detail.en) ? `<div class="detail">${t(p.detail)}</div>` : ''}</li>`).join('')}</ul>${
      lec.myNotes && lec.myNotes[i] ? `<div class="mine"><b>我的筆記</b>${esc(lec.myNotes[i]).replace(/\n/g, '<br>')}</div>` : ''}</div>`).join('');

  const terms = (n.key_terms || []).length ? `<table class="terms"><thead><tr><th>名詞</th><th>English</th><th>說明</th></tr></thead><tbody>${
    n.key_terms.map(k => `<tr><td><b>${esc(k.term_zh)}</b></td><td>${esc(k.term_en)}</td><td>${t(k.definition)}</td></tr>`).join('')}</tbody></table>` : '';

  const tables = (n.tables || []).map(tb => `<h3>${t(tb.title)}</h3><table class="cmp"><thead><tr>${tb.columns.map(c => `<th>${t(c)}</th>`).join('')}</tr></thead><tbody>${
    tb.rows.map(r => `<tr>${r.cells.map(c => `<td>${t(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`).join('');

  const exam = (n.exam_focus || []).map((e, i) => `<div class="card exam"><div class="num">${i + 1}</div><div><p class="pt">${time(e.time)}${t(e.point)}</p>${e.why ? `<p class="why">${t(e.why)}</p>` : ''}</div></div>`).join('');
  const qa = (n.class_qa || []).map(q => `<div class="card"><p class="q"><b>Q</b>${t(q.question)}</p><p class="a"><b>A</b>${t(q.answer)}</p></div>`).join('');
  const qz = quiz || [];
  const quizHTML = qz.map((q, i) => `<div class="quiz"><p><b>${i + 1}.</b> <span class="kind">${q.type === 'choice' ? '選擇' : '填充'}</span> ${t(q.question)}</p>${
    q.type === 'choice' ? `<ol class="opts">${q.options.map(o => `<li>${t(o)}</li>`).join('')}</ol>` : '<div class="lines"><i></i></div>'}</div>`).join('');
  const answers = qz.map((q, i) => `<p><b>${i + 1}.</b> ${q.type === 'choice' ? `<b>(${'ABCD'[q.answer_index] || '?'})</b> ${t(q.options[q.answer_index])}` : `<b>${t(q.answer)}</b>`}${
    q.explanation && (q.explanation.zh || q.explanation.en) ? `<span class="why2">${t(q.explanation)}</span>` : ''}</p>`).join('');
  const todo = (n.todo || []).map(x => `<li><span class="box"></span>${t(x)}</li>`).join('');

  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${plain(n.title)}</title>
<style>
@page { size: A4; margin: 0; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
html, body { margin: 0; background: #fff; }
body { font-family: -apple-system, "PingFang TC", "Noto Sans TC", "Helvetica Neue", Arial, sans-serif; color: #1f1b2e; font-size: 11.5pt; line-height: 1.6; padding: 18mm 20mm 20mm; }
.brand { display: flex; align-items: center; gap: 8px; font-size: 9pt; color: #7c6bb0; letter-spacing: .08em; font-weight: 700; }
.brand i { width: 14px; height: 14px; border-radius: 50%; background: linear-gradient(140deg, #f1e8ff, #c9b6ff 45%, #9d7cf2); box-shadow: inset 0 0 0 1px rgba(255,255,255,.6); }
h1 { font-size: 24pt; line-height: 1.25; margin: 10px 0 4px; letter-spacing: -.01em; }
h1 .en { display: block; font-size: 13pt; font-weight: 600; color: #6b6487; margin-top: 4px; }
.meta { color: #6b6487; font-size: 10pt; margin-bottom: 16px; }
.lead { margin: 14px 0 6px; padding: 14px 18px; border-radius: 14px; font-size: 13pt; font-weight: 650; line-height: 1.55;
  background: linear-gradient(135deg, #f4efff, #fde9f7); border: 1px solid #e6dcff; }
.lead .en { display: block; font-size: 10.5pt; font-weight: 500; color: #6b6487; margin-top: 4px; }
section { margin-top: 20px; }
h2 { display: flex; align-items: center; gap: 8px; font-size: 14.5pt; margin: 0 0 10px; padding-bottom: 6px; border-bottom: 2px solid #ece6ff; break-after: avoid; }
h2 .ic { width: 22px; height: 22px; border-radius: 7px; display: grid; place-items: center; font-size: 11pt; color: #fff; background: linear-gradient(140deg, #b69cff, #8b5cf6); }
h3 { font-size: 12pt; margin: 12px 0 6px; break-after: avoid; }
.en { color: #6b6487; font-size: .9em; margin-left: 6px; }
li .en, td .en, .card .en, p .en { display: block; margin-left: 0; }
ul { margin: 4px 0 8px; padding-left: 1.2em; }
li { margin: 3px 0; break-inside: avoid; }
li.em { font-weight: 650; }
.gist { margin: 2px 0 6px; color: #5b4a99; font-weight: 600; }
.detail { font-weight: 400; color: #4a4560; font-size: 10.5pt; margin: 2px 0 4px; }
.mine { margin: 6px 0 2px; padding: 8px 12px; border-radius: 10px; background: #fff9e6; border: 1px dashed #e8cf7a; font-size: 10.5pt; }
.mine b { display: block; font-size: 8.5pt; color: #a07a12; }
.star { color: #f59e0b; margin-right: 4px; }
.src { font-size: 8pt; color: #8b5cf6; border: 1px solid #d9ccff; border-radius: 6px; padding: 0 5px; margin-left: 6px; }
.tm { display: inline-block; font-size: 8.5pt; font-weight: 700; color: #7c3aed; background: #f1ebff; border-radius: 6px; padding: 0 6px; margin-right: 8px; vertical-align: 1px; font-variant-numeric: tabular-nums; }
.ol { break-inside: avoid; padding-left: 10px; border-left: 3px solid #e3d8ff; margin-bottom: 10px; }
table { width: 100%; border-collapse: collapse; font-size: 10pt; margin: 6px 0 10px; break-inside: auto; }
th { text-align: left; background: #f4efff; color: #4c3a8f; font-weight: 700; }
th, td { padding: 7px 9px; border: 1px solid #e6dcff; vertical-align: top; }
tr { break-inside: avoid; }
.card { display: flex; gap: 10px; padding: 10px 14px; border-radius: 12px; border: 1px solid #ece6ff; background: #fbf9ff; margin: 8px 0; break-inside: avoid; }
.card p { margin: 0; }
.card.exam { border-color: #fde2b3; background: #fffaf0; }
.num { width: 24px; height: 24px; flex-shrink: 0; border-radius: 50%; display: grid; place-items: center; font-weight: 800; font-size: 10pt; color: #fff; background: linear-gradient(135deg, #f59e0b, #ef4444); }
.why { color: #8a6a2f; font-size: 10pt; margin-top: 3px !important; }
.card .q b, .card .a b { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 6px; font-size: 9pt; color: #fff; margin-right: 8px; background: #8b5cf6; }
.card .a { margin-top: 6px !important; }
.card .a b { background: #10b981; }
.card { flex-direction: column; }
.card.exam { flex-direction: row; }
.quiz { break-inside: avoid; margin: 10px 0 14px; }
.quiz p { margin: 0 0 4px; }
.kind { font-size: 8pt; font-weight: 700; color: #7c3aed; background: #f1ebff; border-radius: 6px; padding: 0 6px; margin-right: 4px; }
ol.opts { list-style: upper-alpha; margin: 4px 0 0 1.6em; padding: 0; }
ol.opts li { margin: 4px 0; }
.why2 { display: block; color: #6b6487; font-size: 9.5pt; margin-top: 2px; }
.lines i { display: block; height: 26px; border-bottom: 1px dashed #cfc5ea; }
ul.todo { list-style: none; padding: 0; }
ul.todo li { display: flex; gap: 10px; align-items: flex-start; }
.box { width: 14px; height: 14px; border: 1.5px solid #8b5cf6; border-radius: 4px; margin-top: 4px; flex-shrink: 0; }
.mm { break-before: page; }
.mm .mmx-print { margin: 6px auto 0; }
.mm { break-after: page; }
.mm .mmx-print.turned { margin-top: 4px; }
.answers { break-before: page; }
.answers p { margin: 6px 0; }
footer { margin-top: 28px; padding-top: 10px; border-top: 1px solid #ece6ff; color: #9a93b5; font-size: 8.5pt; text-align: center; }
${mmCSS}
.mmx-print .mmx-l2 { background: #fff; color: #1f1b2e; }
.mmx-print .mmx-n { box-shadow: none !important; }
.mmx-print .mmx-l0 { background: #8b5cf6 !important; }
.mmx-print .mmx-l1 { background: var(--c) !important; }
</style></head><body>
<div class="brand"><i></i>蛤說啥 · 課堂筆記</div>
<h1>${t(n.title)}</h1>
<div class="meta">${esc(lec.course || '')}${lec.course ? ' · ' : ''}${esc(fmtDate(lec.created))}${dur ? ' · 錄音 ' + esc(dur) : ''}</div>
${n.one_line ? `<div class="lead">${t(n.one_line)}</div>` : ''}
${sec('本堂課在講什麼', '◎', n.overview ? `<p>${t(n.overview)}</p>` : '')}
${sec('學習目標', '✓', (n.learning_objectives || []).length ? `<ul>${n.learning_objectives.map(o => `<li>${t(o)}</li>`).join('')}</ul>` : '')}
${sec('待辦與交代事項', '!', todo ? `<ul class="todo">${todo}</ul>` : '')}
${sec('考試重點', '★', exam)}
${sec('大綱筆記', '≡', outline)}
${sec('名詞表', 'A', terms)}
${sec('比較表格', '▦', tables)}
${sec('課堂問答', '?', qa)}
${sec('總結', '∑', n.summary ? `<p>${t(n.summary)}</p>` : '')}
${mindMapHTML ? `<section class="mm"><h2><span class="ic">✶</span>心智圖</h2>${mindMapHTML}</section>` : ''}
${sec('自我測驗', '✎', quizHTML)}
${answers ? `<section class="answers"><h2><span class="ic">✓</span>自我測驗解答</h2>${answers}</section>` : ''}
<footer>由「蛤說啥」整理 · ${esc(fmtDate(Date.now()))}</footer>
</body></html>`;
}

// 大綱筆記 as loose blocks (title, then one or more per section). The app measures them and fills A4 pages for GoodNotes:
// typed notes, the student's handwriting, and ruled space after each section to keep writing in GoodNotes.
export function outlineBlocks(lec, n, { lang = 'both', fmtDate, fmtTime, ink = {}, terms = [], writeSpace = true }) {
  const t = o => {
    if (!o) return '';
    const zh = o.zh || '', en = o.en || '';
    if (lang === 'zh') return esc(zh || en);
    if (lang === 'en') return esc(en || zh);
    return esc(zh || en) + (zh && en && en !== zh ? `<span class="en">${esc(en)}</span>` : '');
  };
  const has = o => !!(o && (o.zh || o.en));
  const NUM = '一二三四五六七八九十';
  const num = k => (k < 10 ? NUM[k] : String(k + 1));
  const dur = lec.durationMs ? fmtTime(lec.durationMs) : '';
  const blocks = [`<div class="g-title"><div class="g-brand"><i></i>蛤說啥 · 大綱筆記</div><h1>${t(n.title)}</h1>
    <div class="g-meta">${esc(lec.course || '')}${lec.course ? ' · ' : ''}${esc(fmtDate(lec.created))}${dur ? ' · 錄音 ' + esc(dur) : ''}</div>
    ${has(n.one_line) ? `<div class="g-lead">${t(n.one_line)}</div>` : ''}</div>`];
  (n.outline || []).forEach((o, k) => {
    const pts = (o.points || []).map(p => `<li class="${p.emphasis ? 'em' : ''}"><div class="g-pt"><span class="${p.emphasis ? 'g-hl' : ''}">${t(p.text)}</span>${p.emphasis ? '<b class="g-star">★</b>' : ''}</div>${has(p.detail) ? `<div class="g-detail">${t(p.detail)}</div>` : ''}</li>`).join('');
    const tm = (terms[k] || []).map(x => `<div class="g-term"><b>${esc(x.term_zh || x.term_en)}${x.term_zh && x.term_en ? `<i>${esc(x.term_en)}</i>` : ''}</b><span>${t(x.definition)}</span></div>`).join('');
    const mine = lec.myNotes && lec.myNotes[k] ? `<div class="g-mine"><b>我的筆記</b>${esc(lec.myNotes[k]).replace(/\n/g, '<br>')}</div>` : '';
    blocks.push(`<div class="g-sec"><div class="g-head"><span class="g-num">${num(k)}</span><h2>${t(o.heading)}</h2>${o.time ? `<span class="g-time">${esc(o.time)}</span>` : ''}</div>
      ${has(o.summary) && !(o.points || []).some(p => p.text.zh === o.summary.zh && p.text.en === o.summary.en) ? `<p class="g-gist">${t(o.summary)}</p>` : ''}<ul>${pts}</ul>${tm ? `<div class="g-terms">${tm}</div>` : ''}${mine}</div>`);
    if (ink[k]) blocks.push(`<div class="g-ink"><span>手寫筆記</span><img src="${ink[k].src}" style="aspect-ratio:${1 / ink[k].ratio}"></div>`);
    else if (writeSpace) blocks.push(`<div class="g-write">${'<i></i>'.repeat(4)}</div>`);
  });
  return blocks;
}
export const OUTLINE_CSS = `
.gnx, .gnx * { box-sizing: border-box; margin: 0; padding: 0; animation: none !important; transition: none !important; }
.gnx { position: fixed; left: -12000px; top: 0; width: 794px; font-family: -apple-system, "PingFang TC", "Noto Sans TC", "Helvetica Neue", Arial, sans-serif; color: #1f1b2e; font-size: 15px; line-height: 1.65; text-align: left; }
.gnx .g-page { position: relative; width: 794px; height: 1123px; padding: 54px 58px 60px; background: #ffffff; overflow: hidden; }
.gnx .g-flow { width: 678px; }
.gnx .g-foot { position: absolute; left: 58px; right: 58px; bottom: 26px; display: flex; justify-content: space-between; font-size: 11px; color: #9a93b5; border-top: 1px solid #ece6ff; padding-top: 8px; }
.gnx .en { display: block; color: #6b6487; font-size: .88em; font-weight: 400; }
.gnx .g-title { padding-bottom: 14px; }
.gnx .g-brand { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #7c6bb0; letter-spacing: .08em; font-weight: 700; }
.gnx .g-brand i { width: 14px; height: 14px; border-radius: 50%; background: #a78bfa; }
.gnx h1 { font-size: 30px; line-height: 1.25; margin: 10px 0 4px; }
.gnx .g-meta { color: #6b6487; font-size: 13px; }
.gnx .g-lead { margin-top: 14px; padding: 12px 16px; border-radius: 12px; font-size: 16px; font-weight: 650; background: #f4efff; border: 1px solid #e6dcff; }
.gnx .g-sec { padding: 14px 0 6px 16px; border-left: 4px solid #b69cff; margin-top: 12px; }
.gnx .g-head { display: flex; align-items: center; gap: 10px; }
.gnx .g-num { width: 30px; height: 30px; flex-shrink: 0; border-radius: 9px; background: #8b5cf6; color: #ffffff; font-weight: 800; font-size: 15px; text-align: center; line-height: 30px; }
.gnx h2 { flex: 1; font-size: 19px; line-height: 1.35; }
.gnx .g-time { font-size: 12px; font-weight: 700; color: #7c3aed; background: #f1ebff; border-radius: 6px; padding: 1px 8px; }
.gnx .g-gist { margin: 8px 0 2px; font-weight: 600; color: #5b4a99; padding-left: 10px; border-left: 2px solid #cdbcff; }
.gnx ul { list-style: none; margin-top: 8px; }
.gnx li { position: relative; padding-left: 18px; margin: 7px 0; }
.gnx li::before { content: ""; position: absolute; left: 3px; top: 10px; width: 7px; height: 7px; border-radius: 50%; background: #b69cff; }
.gnx li.em::before { background: #f59e0b; }
.gnx .g-pt { font-weight: 600; }
.gnx .g-hl { background: #fff1a8; }
.gnx .g-star { color: #f59e0b; margin-left: 6px; }
.gnx .g-detail { color: #4a4560; font-size: 14px; }
.gnx .g-terms { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.gnx .g-term { flex: 1 1 280px; padding: 8px 12px; border: 1px dashed #cfc5ea; border-radius: 10px; font-size: 13.5px; }
.gnx .g-term b { display: block; } .gnx .g-term i { font-style: normal; font-weight: 500; color: #8a84a3; margin-left: 8px; font-size: 12px; }
.gnx .g-term span { color: #4a4560; }
.gnx .g-mine { margin-top: 8px; padding: 8px 12px; border-radius: 10px; background: #fff9e6; border: 1px dashed #e8cf7a; font-size: 14px; }
.gnx .g-mine b { display: block; font-size: 11px; color: #a07a12; }
.gnx .g-ink { margin: 8px 0 0 20px; padding: 6px 10px 10px; border-radius: 10px; background: #fffdf5; border: 1px solid #efe6c6; }
.gnx .g-ink span { display: block; font-size: 11px; font-weight: 700; color: #a07a12; }
.gnx .g-ink img { display: block; width: 100%; height: auto; }
.gnx .g-write { margin: 6px 0 0 20px; }
.gnx .g-write i { display: block; height: 34px; border-bottom: 1px dashed #d9d2ee; }
`;
