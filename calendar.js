// Turn a to-do sentence ("下週三交第一章習題", "12/3 下午2點小考") into a calendar event.

const DOW = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
const EN_DOW = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const mondayOf = d => addDays(startOfDay(d), -((d.getDay() + 6) % 7));
const zhNum = s => {
  if (/^\d+$/.test(s)) return Number(s);
  const map = { 零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (s.length === 1) return map[s];
  if (s[0] === '十') return 10 + (map[s[1]] || 0);
  if (s[1] === '十') return map[s[0]] * 10 + (map[s[2]] || 0);
  return NaN;
};

// Returns { date: Date|null, time: {h, m}|null, guessed: bool }
export function parseDue(text, base = new Date()) {
  const t = String(text || '');
  const b = startOfDay(base);
  let date = null;
  let m;
  if ((m = t.match(/(\d{4})\s*[/\-.年]\s*(\d{1,2})\s*[/\-.月]\s*(\d{1,2})/))) {
    date = new Date(+m[1], +m[2] - 1, +m[3]);
  } else if ((m = t.match(/(?<![\d/])(\d{1,2})\s*(?:\/|月)\s*(\d{1,2})\s*(?:日|號)?(?![\d/])/))) {
    const mo = +m[1], d = +m[2];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      date = new Date(b.getFullYear(), mo - 1, d);
      if (date < addDays(b, -30)) date = new Date(b.getFullYear() + 1, mo - 1, d);
    }
  } else if ((m = t.match(/(下下|下|這|本|上)?\s*個?\s*(?:週|周|禮拜|星期)\s*([一二三四五六日天])/))) {
    const weeks = { 下下: 2, 下: 1, 這: 0, 本: 0, 上: -1 }[m[1]] ?? 0;
    const dow = DOW[m[2]];
    date = addDays(mondayOf(b), weeks * 7 + (dow === 0 ? 6 : dow - 1));
    if (!m[1] && date <= b) date = addDays(date, 7);
  } else if ((m = t.match(/大後天|後天|明天|今天|今晚/))) {
    date = addDays(b, { 今天: 0, 今晚: 0, 明天: 1, 後天: 2, 大後天: 3 }[m[0]]);
  } else if ((m = t.match(/([0-9一二兩三四五六七八九十]+)\s*天(?:後|之後|內)/))) {
    const n = zhNum(m[1]);
    if (!isNaN(n)) date = addDays(b, n);
  } else if ((m = t.match(/\b(next|this)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i))) {
    const dow = EN_DOW[m[2].toLowerCase()];
    date = addDays(mondayOf(b), (m[1] && m[1].toLowerCase() === 'next' ? 7 : 0) + (dow === 0 ? 6 : dow - 1));
    if (!m[1] && date < b) date = addDays(date, 7);
  } else if (/\btomorrow\b/i.test(t)) {
    date = addDays(b, 1);
  } else if ((m = t.match(/下(?:個)?(?:週|周|禮拜|星期)|next week/i))) {
    date = addDays(b, 7);
  }
  let time = null;
  if ((m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i))) {
    let hr = +m[1];
    if (/pm/i.test(m[3]) && hr < 12) hr += 12;
    if (/am/i.test(m[3]) && hr === 12) hr = 0;
    time = { h: hr, m: m[2] ? +m[2] : 0 };
  } else if ((m = t.match(/(上午|早上|中午|下午|晚上|傍晚)?\s*([0-9一二兩三四五六七八九十]{1,3})\s*(?:[:：]\s*(\d{2})|點\s*(半|[0-9]{1,2}\s*分?)?)/))) {
    let hr = zhNum(m[2]);
    const min = m[3] ? +m[3] : m[4] === '半' ? 30 : m[4] ? parseInt(m[4], 10) : 0;
    if (!isNaN(hr) && hr <= 24 && min < 60) {
      if (/下午|晚上|傍晚/.test(m[1] || '') && hr < 12) hr += 12;
      if (m[1] === '中午' && hr < 6) hr += 12;
      time = { h: hr % 24, m: min };
    }
  } else if ((m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i))) {
    let hr = +m[1];
    if (/pm/i.test(m[3]) && hr < 12) hr += 12;
    if (/am/i.test(m[3]) && hr === 12) hr = 0;
    time = { h: hr, m: m[2] ? +m[2] : 0 };
  }
  return { date, time, guessed: !date };
}

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const ymdhms = d => `${ymd(d)}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
const esc = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function fold(line) {
  // iCalendar lines should stay short; continuation lines start with a space.
  const out = [];
  let s = line;
  while (s.length > 60) { out.push(s.slice(0, 60)); s = ' ' + s.slice(60); }
  out.push(s);
  return out.join('\r\n');
}

// event: { title, start: Date, end: Date, allDay: bool, details, alarm: 'none'|'1d'|'1h' }
export function buildICS(ev) {
  const now = new Date();
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//lecture-notes//zh-Hant', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}@lecture-notes`,
    `DTSTAMP:${stamp}`,
    ev.allDay ? `DTSTART;VALUE=DATE:${ymd(ev.start)}` : `DTSTART:${ymdhms(ev.start)}`,
    ev.allDay ? `DTEND;VALUE=DATE:${ymd(ev.end)}` : `DTEND:${ymdhms(ev.end)}`,
    `SUMMARY:${esc(ev.title)}`,
    ev.details ? `DESCRIPTION:${esc(ev.details)}` : null,
  ].filter(Boolean);
  if (ev.alarm && ev.alarm !== 'none') {
    lines.push('BEGIN:VALARM', `TRIGGER:${ev.alarm === '1h' ? '-PT1H' : '-P1D'}`, 'ACTION:DISPLAY', `DESCRIPTION:${esc(ev.title)}`, 'END:VALARM');
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

export function googleCalendarUrl(ev) {
  const dates = ev.allDay ? `${ymd(ev.start)}/${ymd(ev.end)}` : `${ymdhms(ev.start)}/${ymdhms(ev.end)}`;
  const p = new URLSearchParams({ action: 'TEMPLATE', text: ev.title, dates, details: ev.details || '' });
  try { p.set('ctz', Intl.DateTimeFormat().resolvedOptions().timeZone); } catch { /* ignore */ }
  return 'https://calendar.google.com/calendar/render?' + p.toString();
}
