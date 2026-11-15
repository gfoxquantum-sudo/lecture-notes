// Accounts and subscriptions.
// Preview build: sign-in and purchases are simulated on this device so the screens can be tried.
// Later: signIn → Firebase Auth (Sign in with Apple / Google), subscribe/restore → StoreKit 2 in the iPhone app,
// with the server checking the receipt and counting hours. Only the functions in this file need to change.

const K = 'ln.';
const get = (k, d) => { try { const v = localStorage.getItem(K + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const set = (k, v) => { try { v == null ? localStorage.removeItem(K + k) : localStorage.setItem(K + k, JSON.stringify(v)); } catch { /* ignore */ } };
const wait = ms => new Promise(r => setTimeout(r, ms));

export const PREVIEW = true; // true until the real login and payment services are connected

// Prices are placeholders; the real ones are set in App Store Connect and shown from StoreKit.
export const PRODUCTS = {
  monthly: { id: 'pro.monthly', label: '月繳', price: 190, per: '月', hours: 20 },
  yearly: { id: 'pro.yearly', label: '年繳', price: 1490, per: '年', hours: 20, perMonth: 124 },
};
export const yearlySaving = () => Math.round((1 - PRODUCTS.yearly.price / (PRODUCTS.monthly.price * 12)) * 100);

export function account() { return get('account', null); }
export function subscription() {
  const a = account(), s = get('sub', null);
  if (!a || !s || s.uid !== a.uid) return null;
  return { ...s, active: s.renews > Date.now() || s.autoRenew };
}
export function usage() {
  const s = subscription();
  const quota = s ? PRODUCTS[s.product].hours : 0;
  const used = (get('usedMs', 0) || 0) / 3600000;
  return { quota, used: Math.min(used, quota), left: Math.max(0, quota - used) };
}

export async function signIn(provider) {
  await wait(900);
  const uid = 'preview-' + provider;
  const a = provider === 'apple'
    ? { uid, provider, name: 'Apple 使用者', email: 'hidden@privaterelay.appleid.com' }
    : { uid, provider, name: 'Google 使用者', email: 'you@gmail.com' };
  set('account', { ...a, since: Date.now() });
  return account();
}
export function signOut() { set('account', null); }
export async function deleteAccount() {
  await wait(700);
  set('sub', null); set('usedMs', null); set('account', null);
}

export async function subscribe(product) {
  const a = account();
  if (!a) throw new Error('請先登入');
  await wait(1200);
  const now = Date.now();
  const len = product === 'yearly' ? 365 : 30;
  set('sub', { uid: a.uid, product, since: now, renews: now + len * 864e5, autoRenew: true });
  return subscription();
}
export async function restore() {
  await wait(900);
  return subscription();
}
export function addUsage(ms) { if (subscription()) set('usedMs', (get('usedMs', 0) || 0) + ms); }
