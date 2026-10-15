// Supabase przez fetch (bez biblioteki), jak cloud.js w Układaczu. W przeglądarce zostaje tylko token sesji —
// PIN idzie raz do osoba_login i nigdzie nie jest zapisywany. Wszystkie sprawdzenia są w bazie (supabase-zapisy.sql).
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const TOKEN = 'zapisy-token';
export class SessionError extends Error {}

async function rpc(fn, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const out = await r.json().catch(() => null);
  if (out?.error === 'Sesja wygasła') { forget(); throw new SessionError(out.error); }
  if (!r.ok || out?.error) throw new Error(out?.error || out?.message || r.statusText);
  return out;
}

const token = () => { try { return localStorage.getItem(TOKEN); } catch { return null; } };
function forget() { try { localStorage.removeItem(TOKEN); } catch {} }

export const hasSession = () => !!token();
export async function login(pin) {
  const { token: t } = await rpc('osoba_login', { p: pin });
  try { localStorage.setItem(TOKEN, t); } catch {}
}
// { name, shifts: [{ id, name, days }], avail, wants, od: 'YYYY-MM-DD' — pierwszy dzień do zmiany }
export const load = () => rpc('osoba_load', { t: token() });
export async function logout() {
  const t = token();
  forget();
  if (t) await rpc('osoba_logout', { t }).catch(() => {});
}

// Zapis całości (avail + wants osoby) po 400 ms ciszy — malowanie dni przeciągnięciem idzie jednym zapisem.
// onState('saving' | 'saved' | Error) — wskaźnik w nagłówku.
let timer = null, latest = null, pending = 0, queue = Promise.resolve();
export function save(avail, wants, onState) {
  latest = { a: avail, w: wants };
  if (!timer) pending++;
  clearTimeout(timer);
  onState('saving');
  timer = setTimeout(() => {
    timer = null;
    const { a, w } = latest;
    queue = queue.then(() => rpc('osoba_save', { t: token(), a, w }))
      .then(() => { if (pending === 1) onState('saved'); }, onState).finally(() => pending--);
  }, 400);
}
addEventListener('beforeunload', (e) => { if (pending) e.preventDefault(); }); // niewysłane zmiany → przeglądarka pyta
