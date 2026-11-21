// Cloud copy of each signed-in person's lectures (Firebase Firestore), so they come back on any device after sign-in.
// What is kept in the cloud: transcript, notes, quiz, handwriting, typed notes, handout text.
// What stays on the recording device: the audio itself and the original handout files (too large for the free database).
//
// Layout:  users/{uid}/lectures/{id}            → { title, course, created, updated, parts, len, deleted? }
//          users/{uid}/lectures/{id}/parts/{i}  → { d: '…slice of the lecture JSON…' }   (a Firestore doc is capped at 1 MiB)

import { firebaseApp } from './account.js';

const FB_VER = '11.0.2';
const SLICE = 250000; // characters per part: at most ~750 KB of UTF-8

let deps = null;      // { all, get, put, del, isOpen, onChange }
let uid = null;
let backend = null;   // { list, read, write, remove, wipe }
let makeBackend = firestoreBackend;
let busy = null, again = false;
const timers = new Map();
const lastPush = new Map();
const known = new Map(); // id → number of parts the cloud holds
const listeners = new Set();
let st = { state: 'off', at: 0, error: '' }; // off | syncing | ok | offline | error

function setStatus(p) { st = { ...st, ...p }; listeners.forEach(f => { try { f(st); } catch { /* ignore */ } }); }
export const status = () => st;
export const onStatus = f => { listeners.add(f); return () => listeners.delete(f); };
export const user = () => uid;
export function init(d) { deps = d; }
// Tests swap in an in-memory backend.
export function useBackend(factory) { makeBackend = factory || firestoreBackend; backend = null; }

async function firestoreBackend(u) {
  const [app, fs] = await Promise.all([firebaseApp(), import(`https://www.gstatic.com/firebasejs/${FB_VER}/firebase-firestore-lite.js`)]);
  const db = fs.getFirestore(app);
  const lec = id => fs.doc(db, 'users', u, 'lectures', id);
  const part = (id, i) => fs.doc(db, 'users', u, 'lectures', id, 'parts', String(i));
  const dropParts = (id, from, to) => Promise.all(Array.from({ length: Math.max(0, to - from) }, (_, k) => fs.deleteDoc(part(id, from + k))));
  return {
    async meta(id) { const s = await fs.getDoc(lec(id)); return s.exists() ? s.data() : null; },
    async list() { return (await fs.getDocs(fs.collection(db, 'users', u, 'lectures'))).docs.map(d => ({ id: d.id, ...d.data() })); },
    async read(id, n) {
      const snaps = await Promise.all(Array.from({ length: n }, (_, i) => fs.getDoc(part(id, i))));
      return snaps.map(s => (s.exists() ? s.data().d : '')).join('');
    },
    async write(id, meta, slices, prevParts) {
      for (let i = 0; i < slices.length; i++) await fs.setDoc(part(id, i), { d: slices[i] });
      await fs.setDoc(lec(id), meta);
      await dropParts(id, slices.length, prevParts || 0);
    },
    async remove(id, meta, prevParts) { await fs.setDoc(lec(id), meta); await dropParts(id, 0, prevParts || 0); },
    async wipe() {
      for (const d of (await fs.getDocs(fs.collection(db, 'users', u, 'lectures'))).docs) {
        await dropParts(d.id, 0, d.data().parts || 0);
        await fs.deleteDoc(d.ref);
      }
    },
  };
}

const isBlob = v => typeof Blob !== 'undefined' && v instanceof Blob;
// The lecture as it goes to the cloud: no audio, no binary files.
export function pack(lec) {
  const { audioParts, ...rest } = lec;
  rest.hasAudio = !!(audioParts && audioParts.length) || !!lec.hasAudio;
  return JSON.stringify(rest, (k, v) => (isBlob(v) || k === '_pend' ? undefined : v));
}
// A lecture from the cloud, keeping the audio and handout files this device already has.
export function unpack(json, local, u) {
  const lec = JSON.parse(json);
  lec.owner = u;
  lec.segments = lec.segments || []; lec.speakers = lec.speakers || {}; lec.files = lec.files || [];
  if (local) {
    if (local.audioParts && local.audioParts.length) lec.audioParts = local.audioParts;
    const mine = new Map((local.files || []).map(f => [f.id, f]));
    lec.files = lec.files.map(f => (mine.has(f.id) && mine.get(f.id).blob ? { ...f, blob: mine.get(f.id).blob } : f));
  }
  return lec;
}
const slices = s => { const out = []; for (let i = 0; i < s.length; i += SLICE) out.push(s.slice(i, i + SLICE)); return out.length ? out : ['']; };
const metaOf = (lec, n, len) => ({ title: lec.title || '', course: lec.course || '', created: lec.created || 0, updated: lec.updated || 0, parts: n, len });

function explain(e) {
  const c = (e && e.code) || '';
  if (!navigator.onLine || /unavailable|network|failed to fetch/i.test(c + ' ' + (e && e.message))) return { state: 'offline', error: '' };
  if (/permission-denied/.test(c)) return { state: 'error', error: '雲端資料庫的規則還沒設定好（permission-denied）' };
  if (/not-found|failed-precondition/.test(c)) return { state: 'error', error: '雲端資料庫還沒建立（Firestore）' };
  if (/resource-exhausted/.test(c)) return { state: 'error', error: '今天的免費雲端額度用完了，明天會自動繼續同步' };
  return { state: 'error', error: '同步失敗（' + (c || (e && e.message) || e) + '）' };
}

// Called on every sign-in state change. null = signed out.
export function setUser(u) {
  if (u === uid) return;
  uid = u || null; backend = null;
  timers.forEach(clearTimeout); timers.clear(); lastPush.clear(); known.clear();
  if (!uid) { setStatus({ state: 'off', error: '' }); return; }
  sync();
}
async function be() { if (!backend) backend = await makeBackend(uid); return backend; }

async function partsOf(b, id) {
  if (!known.has(id)) { const m = await b.meta(id); known.set(id, (m && m.parts) || 0); }
  return known.get(id);
}
async function pushOne(b, lec) {
  const json = pack({ ...lec, owner: uid });
  const sl = slices(json);
  await b.write(lec.id, metaOf(lec, sl.length, json.length), sl, await partsOf(b, lec.id));
  known.set(lec.id, sl.length);
  lastPush.set(lec.id, Date.now());
  if (lec.owner !== uid) { const cur = await deps.get(lec.id); if (cur && cur.owner !== uid) await deps.put({ ...cur, owner: uid }); }
}

// Two-way sync: newer side wins per lecture; deletions travel as tombstones.
export function sync() {
  if (!uid || !deps) return Promise.resolve(false);
  if (busy) { again = true; return busy; }
  const me = uid;
  busy = (async () => {
    setStatus({ state: 'syncing', error: '' });
    let changed = false;
    try {
      const b = await be();
      const remote = await b.list();
      if (me !== uid) return false;
      const local = await deps.all();
      const byId = new Map(local.map(l => [l.id, l]));
      const rById = new Map(remote.map(r => [r.id, r]));
      remote.forEach(r => known.set(r.id, r.parts || 0));
      for (const r of remote) {
        const l = byId.get(r.id);
        if (l && l.owner && l.owner !== me) continue;
        if (r.deleted) {
          if (l && (l.updated || 0) <= (r.updated || 0) && !deps.isOpen(r.id)) { await deps.del(r.id); byId.delete(r.id); changed = true; }
          continue;
        }
        if (l && (l.updated || 0) >= (r.updated || 0)) continue;
        if (deps.isOpen(r.id)) continue; // being edited here: this device's copy goes up when it is saved
        try {
          const json = await b.read(r.id, r.parts || 0);
          if (r.len != null && json.length !== r.len) continue; // another device is in the middle of writing it
          const lec = unpack(json, l, me);
          lec.id = r.id; lec.updated = r.updated;
          await deps.put(lec); byId.set(r.id, lec); changed = true;
        } catch (e) { console.warn('cloud: could not read', r.id, e); }
      }
      for (const l of byId.values()) {
        if (me !== uid) break;
        if (l.owner && l.owner !== me) continue;
        const r = rById.get(l.id);
        if (!r || (l.updated || 0) > (r.updated || 0)) await pushOne(b, l);
        else if (l.owner !== me) await deps.put({ ...l, owner: me });
      }
      setStatus({ state: 'ok', at: Date.now(), error: '' });
    } catch (e) { console.warn('cloud sync', e); setStatus(explain(e)); }
    return changed;
  })().then(changed => {
    busy = null;
    if (changed && deps.onChange) deps.onChange();
    if (again) { again = false; return sync(); }
    return changed;
  });
  return busy;
}

// Called after every local save. While recording, saves come every few seconds, so uploads are spaced out.
export function queue(lec, { slow = false } = {}) {
  if (!uid || !lec || (lec.owner && lec.owner !== uid)) return;
  const id = lec.id, gap = slow ? 60000 : 4000;
  const wait = Math.max(gap - (Date.now() - (lastPush.get(id) || 0)), slow ? 0 : gap);
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(async () => {
    timers.delete(id);
    if (!uid) return;
    try {
      const cur = await deps.get(id);
      if (!cur || (cur.owner && cur.owner !== uid)) return;
      const b = await be();
      setStatus({ state: 'syncing', error: '' });
      await pushOne(b, cur);
      setStatus({ state: 'ok', at: Date.now(), error: '' });
    } catch (e) { console.warn('cloud push', e); setStatus(explain(e)); }
  }, Math.min(wait, 60000)));
}
// Upload anything still waiting (page is being hidden or closed).
export function flush() { for (const [id, t] of timers) { clearTimeout(t); timers.delete(id); deps.get(id).then(l => l && uid && be().then(b => pushOne(b, l))).catch(() => {}); } }

export async function remove(id, lec) {
  if (!uid || (lec && lec.owner && lec.owner !== uid)) return;
  clearTimeout(timers.get(id)); timers.delete(id);
  try { const b = await be(); const n = await partsOf(b, id); await b.remove(id, { title: (lec && lec.title) || '', deleted: true, updated: Date.now(), parts: 0, len: 0 }, n); known.set(id, 0); }
  catch (e) { console.warn('cloud delete', e); setStatus(explain(e)); }
}
// Delete everything this account has in the cloud (used when the account itself is deleted).
export async function wipe() { if (!uid) return; const b = await be(); await b.wipe(); }
