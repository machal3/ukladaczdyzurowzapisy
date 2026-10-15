import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SourceTextModule } from 'node:vm';
import { JSDOM } from 'jsdom';

// Prawdziwe moduły i DOM; zamiast Supabase — fetch w pamięci, który zachowuje się jak funkcje z supabase-zapisy.sql.
async function setup(t, { token = null } = {}) {
  const dom = new JSDOM(await readFile(new URL('./index.html', import.meta.url), 'utf8'), {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.scrollTo = () => {};
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLFormElement.prototype.reportValidity = () => false;
  if (token) w.localStorage.setItem('zapisy-token', token);
  const db = { avail: { '2020-01-01': 0 }, wants: { '*': 4 }, uwagi: {}, calls: [], loggedOut: false };
  const now = new Date(), key = (y, m, d) => { const t = new Date(y, m, d); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
  const od = key(now.getFullYear(), now.getMonth() + (now.getDate() <= 20 ? 1 : 2), 1); // jak zapisy_od w bazie
  const cur = (d) => key(now.getFullYear(), now.getMonth(), d);
  db.grafik = { [cur(3)]: { s1: 'Anna Kowalska', s2: 'Jan Nowak' }, [cur(4)]: { s1: 'Jan Nowak' } };
  w.fetch = async (url, init) => {
    const fn = url.split('/').pop(), body = JSON.parse(init.body);
    db.calls.push({ fn, body });
    const ok = (data) => ({ ok: true, json: async () => data });
    if (fn === 'osoba_login') return ok(body.p === '404373' ? { token: 'a'.repeat(64), name: 'Anna Kowalska' } : { error: 'Zły PIN' });
    if (body.t !== 'a'.repeat(64)) return ok({ error: 'Sesja wygasła' });
    if (fn === 'osoba_load') return ok({ name: 'Anna Kowalska', shifts: [{ id: 's1', name: 'OITN', days: [0, 1, 2, 3, 4, 5, 6] }, { id: 's2', name: 'PN1', days: [0, 1, 2, 3, 4, 5, 6] }], avail: db.avail, wants: db.wants, uwagi: db.uwagi, od, grafik: db.grafik });
    if (fn === 'osoba_save') { db.avail = body.a; db.wants = body.w; db.uwagi = body.c; return ok({}); }
    if (fn === 'osoba_logout') { db.loggedOut = true; return ok({}); }
    throw new Error(`Nieoczekiwane RPC ${fn}`);
  };
  const context = dom.getInternalVMContext();
  const mods = {};
  const source = async (name) => mods[name] ??= new SourceTextModule(await readFile(new URL(name, import.meta.url), 'utf8'), {
    context, identifier: name, initializeImportMeta: (meta) => { meta.url = new URL(name, import.meta.url).href; },
  });
  const ui = await source('./ui.js');
  await ui.link(() => {});
  await ui.evaluate();
  const app = await source('./app.js');
  await app.link(source);
  const $ = (s) => w.document.querySelector(s);
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const done = app.evaluate();
  return { w, $, tick, db, done, od, cur, wait: (ms) => new Promise((r) => setTimeout(r, ms)) };
}

const typePin = async ({ w, $, tick }, pin) => {
  for (let i = 0; i < 50 && !$('.login form'); i++) await tick();
  $('#pin').value = pin;
  $('.login form').dispatchEvent(new w.Event('submit', { cancelable: true }));
  await tick(); await tick();
};

test('PIN: zły → komunikat, dobry → kalendarz; w przeglądarce tylko token', async (t) => {
  const s = await setup(t);
  await typePin(s, '111111');
  for (let i = 0; i < 20 && !s.$('.login [role=status]')?.textContent; i++) await s.tick();
  assert.equal(s.$('.login [role=status]').textContent, 'Zły PIN.');
  await typePin(s, '404373');
  await s.done;
  assert.equal(s.$('#me').textContent, 'Anna Kowalska');
  assert.equal(s.w.localStorage.getItem('zapisy-token'), 'a'.repeat(64));
  assert.ok(![...Array(s.w.localStorage.length)].some((_, i) => s.w.localStorage.getItem(s.w.localStorage.key(i)).includes('404373')));
  assert.ok(s.$('#calendar [data-avail]'));
});

test('kalendarz: klik zmienia poziom i zapisuje; brak limitów i innych osób w DOM', async (t) => {
  const s = await setup(t, { token: 'a'.repeat(64) });
  await s.done;
  const html = s.w.document.body.innerHTML;
  for (const word of ['Limit', 'Min.', 'najmniej', 'najwyżej', 'Rezydent']) assert.ok(!html.includes(word), word);
  const btn = s.$('#calendar [data-avail]:enabled');
  const key = btn.dataset.avail;
  btn.click(); // Mogę → Chcę
  assert.equal(s.$(`[data-avail="${key}"]`).textContent, 'Chcę');
  s.$('#status [data-lvl="0"]').click(); // pędzel „Nie mogę”
  s.$(`[data-avail="${key}"]`).click();
  assert.equal(s.$(`[data-avail="${key}"]`).textContent, 'Nie mogę');
  assert.equal(s.$('#save-state').textContent, 'Zapisuję…');
  await s.wait(450);
  await s.tick();
  assert.equal(s.db.calls.filter((c) => c.fn === 'osoba_save').length, 1, 'seria zmian = jeden zapis');
  assert.equal(s.db.avail[key], 0);
  assert.equal(s.db.avail['2020-01-01'], 0, 'przeszłość odsyłana bez zmian');
  assert.equal(s.$('#save-state').textContent, 'Zapisano');
});

test('termin 20.: start na pierwszym otwartym miesiącu, wcześniejsze tylko do podglądu', async (t) => {
  const s = await setup(t, { token: 'a'.repeat(64) });
  await s.done;
  assert.equal(s.$('#calendar [data-avail]').dataset.avail.slice(0, 7), s.od.slice(0, 7));
  assert.match(s.$('#status').textContent, /zapisy do 20 /);
  for (let i = 0; i < 3 && !s.$('#prev').disabled; i++) s.$('#prev').click();
  assert.equal(s.$('#prev').disabled, true);
  assert.match(s.$('#status').textContent, /Zapisy zamknięte/);
  assert.ok(!s.$('#status [data-lvl]'), 'bez pędzla w zamkniętym miesiącu');
  for (const b of s.w.document.querySelectorAll('#calendar [data-avail]')) assert.equal(b.disabled, true, b.dataset.avail);
  s.$('#status [data-go]').click();
  assert.equal(s.w.document.body.dataset.tab, 'grafik');
});

test('grafik: wszystkie dyżury, moje podświetlone, „Tylko moje”', async (t) => {
  const s = await setup(t, { token: 'a'.repeat(64) });
  await s.done;
  s.$('button[data-tab="grafik"]').click();
  assert.equal(s.$('#grafik-empty').hidden, true);
  const mine = [...s.w.document.querySelectorAll('#grafik .slot.mine')];
  assert.equal(mine.length, 1);
  assert.match(mine[0].textContent, /OITN.*Anna Kowalska/);
  assert.match(s.$('#grafik').textContent, /Jan Nowak/);
  assert.equal(s.$('#grafik-list .count').textContent, '1');
  s.$('#only-mine').click();
  assert.equal(s.$('#only-mine').getAttribute('aria-pressed'), 'true');
  assert.ok(s.$('#grafik').classList.contains('only-mine'));
  s.$('#next').click(); s.$('#next').click();
  assert.equal(s.$('#grafik-empty').hidden, false);
});

test('komentarz do miesiąca zapisuje się razem z resztą', async (t) => {
  const s = await setup(t, { token: 'a'.repeat(64) });
  await s.done;
  const f = s.$('#comment-text');
  f.value = 'Wolę OITN, 12. mogę się zamienić';
  f.dispatchEvent(new s.w.Event('input', { bubbles: true }));
  assert.equal(s.$('#comment-count').textContent, '32/500');
  await s.wait(450); await s.tick();
  assert.deepEqual(s.db.uwagi, { [s.od.slice(0, 7)]: 'Wolę OITN, 12. mogę się zamienić' });
  f.value = '  ';
  f.dispatchEvent(new s.w.Event('input', { bubbles: true }));
  await s.wait(450); await s.tick();
  assert.deepEqual(s.db.uwagi, {});
});

test('prośby: wpis, czyszczenie i odrzucenie złej wartości', async (t) => {
  const s = await setup(t, { token: 'a'.repeat(64) });
  await s.done;
  s.$('button[data-tab="settings"]').click();
  assert.equal(s.w.document.body.dataset.tab, 'settings');
  assert.equal(s.$('[data-want="*"]').value, '4');
  const set = (k, v) => { const i = s.$(`[data-want="${k}"]`); i.value = v; i.dispatchEvent(new s.w.Event('input', { bubbles: true })); };
  set('s1', '3');
  set('*', '');
  set('we', '99');
  await s.wait(450);
  await s.tick();
  assert.deepEqual(s.db.wants, { s1: 3 });
  assert.equal(s.w.document.querySelectorAll('#wants input').length, 8); // Łącznie, Pt/So/Nd, 2 miejsca, So+Nd, Pt, So, Nd
});

test('wygasła sesja → ekran PIN-u; wylogowanie kasuje sesję w bazie', async (t) => {
  const s = await setup(t, { token: 'b'.repeat(64) });
  for (let i = 0; i < 50 && !s.$('.login [role=status]')?.textContent; i++) await s.tick();
  assert.match(s.$('.login [role=status]').textContent, /Sesja wygasła/);
  assert.equal(s.w.localStorage.getItem('zapisy-token'), null);
  await typePin(s, '404373');
  await s.done;
  s.$('#logout').click();
  await s.tick(); await s.tick();
  assert.equal(s.db.loggedOut, true);
  assert.equal(s.w.localStorage.getItem('zapisy-token'), null);
});
