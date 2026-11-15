// Printable notes (A4) for PDF export — what goes into GoodNotes or gets shared with classmates.
// Wide margins and blank answer space so it can be written on with a pencil.

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function notesDocument(lec, n, { lang = 'both', mindMapHTML = '', mmCSS = '', fmtDate, fmtTime }) {
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

  const outline = (n.outline || []).map(o => `<div class="ol">
    <h3>${time(o.time)}${t(o.heading)}</h3>
    <ul>${(o.points || []).map(p => `<li class="${p.emphasis ? 'em' : ''}">${p.emphasis ? '<b class="star">★</b>' : ''}${t(p.text)}${p.source === 'slides' ? '<span class="src">講義</span>' : ''}</li>`).join('')}</ul></div>`).join('');

  const terms = (n.key_terms || []).length ? `<table class="terms"><thead><tr><th>名詞</th><th>English</th><th>說明</th></tr></thead><tbody>${
    n.key_terms.map(k => `<tr><td><b>${esc(k.term_zh)}</b></td><td>${esc(k.term_en)}</td><td>${t(k.definition)}</td></tr>`).join('')}</tbody></table>` : '';

  const tables = (n.tables || []).map(tb => `<h3>${t(tb.title)}</h3><table class="cmp"><thead><tr>${tb.columns.map(c => `<th>${t(c)}</th>`).join('')}</tr></thead><tbody>${
    tb.rows.map(r => `<tr>${r.cells.map(c => `<td>${t(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`).join('');

  const exam = (n.exam_focus || []).map((e, i) => `<div class="card exam"><div class="num">${i + 1}</div><div><p class="pt">${time(e.time)}${t(e.point)}</p>${e.why ? `<p class="why">${t(e.why)}</p>` : ''}</div></div>`).join('');
  const qa = (n.class_qa || []).map(q => `<div class="card"><p class="q"><b>Q</b>${t(q.question)}</p><p class="a"><b>A</b>${t(q.answer)}</p></div>`).join('');
  const quiz = (n.review_questions || []).map((q, i) => `<div class="quiz"><p><b>${i + 1}.</b> ${t(q.question)}</p><div class="lines"><i></i><i></i><i></i></div></div>`).join('');
  const answers = (n.review_questions || []).map((q, i) => `<p><b>${i + 1}.</b> ${t(q.answer)}</p>`).join('');
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
${sec('大綱', '≡', outline)}
${sec('名詞表', 'A', terms)}
${sec('比較表格', '▦', tables)}
${sec('課堂問答', '?', qa)}
${sec('總結', '∑', n.summary ? `<p>${t(n.summary)}</p>` : '')}
${mindMapHTML ? `<section class="mm"><h2><span class="ic">✶</span>心智圖</h2>${mindMapHTML}</section>` : ''}
${sec('自我測驗', '✎', quiz)}
${answers ? `<section class="answers"><h2><span class="ic">✓</span>自我測驗解答</h2>${answers}</section>` : ''}
<footer>由「蛤說啥」整理 · ${esc(fmtDate(Date.now()))}</footer>
</body></html>`;
}
