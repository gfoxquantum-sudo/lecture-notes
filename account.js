// Accounts. Real sign-in (Google / Apple) runs on Firebase once firebase-config.js is filled in;
// until then sign-in is simulated on this device so the screens can be tried.



import { FIREBASE } from './firebase-config.js';

const K = 'ln.';
const get = (k, d) => { try { const v = localStorage.getItem(K + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const set = (k, v) => { try { v == null ? localStorage.removeItem(K + k) : localStorage.setItem(K + k, JSON.stringify(v)); } catch { /* ignore */ } };
const wait = ms => new Promise(r => setTimeout(r, ms));

export const REAL_AUTH = !!(FIREBASE && FIREBASE.apiKey); // real Google / Apple sign-in once firebase-config.js is filled in
export function account() { return get('account', null); }

// ---- real sign-in (Firebase Authentication), used when firebase-config.js is filled in ----
const FB_VER = '11.0.2';
let fb = null;
function firebase() {
  if (!fb) fb = (async () => {
    const [{ initializeApp }, auth] = await Promise.all([
      import(`https://www.gstatic.com/firebasejs/${FB_VER}/firebase-app.js`),
      import(`https://www.gstatic.com/firebasejs/${FB_VER}/firebase-auth.js`),
    ]);
    const a = auth.getAuth(initializeApp(FIREBASE));
    a.useDeviceLanguage();
    return { auth, a, app: a.app };
  })().catch(e => { fb = null; throw e; });
  return fb;
}
const fromUser = (u, provider) => {
  const p = provider || ((u.providerData[0] || {}).providerId === 'apple.com' ? 'apple' : 'google');
  const prev = get('account', null);
  return { uid: u.uid, provider: p, name: u.displayName || (u.email || '').split('@')[0] || '使用者', email: u.email || '', photo: u.photoURL || '',
    since: prev && prev.uid === u.uid ? prev.since : Date.now() };
};
const authError = e => {
  const c = (e && e.code) || '';
  if (c === 'auth/popup-closed-by-user' || c === 'auth/cancelled-popup-request' || c === 'auth/user-cancelled') return '已取消登入';
  if (c === 'auth/popup-blocked') return '瀏覽器擋住了登入視窗，請允許彈出視窗後再試一次';
  if (c === 'auth/operation-not-allowed') return '這種登入方式還沒有開通';
  if (c === 'auth/unauthorized-domain') return '這個網址還沒有加入 Firebase 的授權網域';
  if (c === 'auth/network-request-failed' || !navigator.onLine) return '沒有網路連線，無法登入';
  return '登入失敗（' + (c || (e && e.message) || e) + '）';
};
// Keep the saved account in step with Firebase (signed out elsewhere, name changed…). Calls back when it changes.
export async function firebaseApp() { return (await firebase()).app; }
export async function watchAccount(onChange, onUser) {
  if (!REAL_AUTH) return;
  try {
    const { auth, a } = await firebase();
    auth.onAuthStateChanged(a, u => {
      const before = JSON.stringify(get('account', null));
      set('account', u ? fromUser(u) : null);
      if (onUser) onUser(u ? u.uid : null);
      if (JSON.stringify(get('account', null)) !== before && onChange) onChange();
    });
  } catch (e) { console.warn('sign-in service unavailable', e); }
}

export async function signIn(provider) {
  if (REAL_AUTH) {
    try {
      const { auth, a } = await firebase();
      const p = provider === 'apple' ? new auth.OAuthProvider('apple.com') : new auth.GoogleAuthProvider();
      if (provider === 'apple') { p.addScope('email'); p.addScope('name'); } else p.setCustomParameters({ prompt: 'select_account' });
      const res = await auth.signInWithPopup(a, p);
      set('account', fromUser(res.user, provider));
      return account();
    } catch (e) { console.error(e); throw new Error(authError(e)); }
  }
  await wait(900);
  const uid = 'preview-' + provider;
  const a = provider === 'apple'
    ? { uid, provider, name: 'Apple 使用者', email: 'hidden@privaterelay.appleid.com' }
    : { uid, provider, name: 'Google 使用者', email: 'you@gmail.com' };
  set('account', { ...a, since: Date.now() });
  return account();
}
export async function signOut() {
  if (REAL_AUTH) { try { const { auth, a } = await firebase(); await auth.signOut(a); } catch (e) { console.warn(e); } }
  set('account', null);
}
export async function deleteAccount(beforeDelete) {
  if (REAL_AUTH) {
    if (beforeDelete) await beforeDelete();
    const { auth, a } = await firebase();
    const u = a.currentUser;
    if (u) {
      try { await auth.deleteUser(u); }
      catch (e) {
        if (e.code !== 'auth/requires-recent-login') throw new Error(authError(e));
        // Deleting needs a fresh sign-in: ask once more, then delete.
        const prov = (get('account', null) || {}).provider === 'apple' ? new auth.OAuthProvider('apple.com') : new auth.GoogleAuthProvider();
        try { await auth.reauthenticateWithPopup(u, prov); await auth.deleteUser(u); } catch (e2) { throw new Error(authError(e2)); }
      }
    }
  } else await wait(700);
  set('account', null);
}
