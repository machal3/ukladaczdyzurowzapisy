// Funkcje bazy na prawdziwym Postgresie w pamięci (PGlite + pgcrypto) — bez połączenia z Supabase.
// Kolejność jak na produkcji: ukladacz/supabase.sql (Układacz) → supabase-zapisy.sql.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const sql = (name) => readFile(new URL(name, import.meta.url), 'utf8');
const ADMIN = '4821';
const day = (n) => { const d = new Date(Date.now() + n * 864e5); return d.toISOString().slice(0, 10); };

async function setup() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role anon; create role authenticated; create schema extensions;`);
  await db.exec(await sql('./ukladacz/supabase.sql'));
  await db.exec(await sql('./supabase-zapisy.sql'));
  await db.exec(await sql('./supabase-zapisy.sql')); // można puścić ponownie (pepper zostaje)
  await db.exec(`insert into public.access values ('${ADMIN}');`);
  const data = {
    people: [{ id: 'ania', name: 'Anna Kowalska' }, { id: 'jan', name: 'Jan Nowak' }, { id: 'old', name: 'Ex Osoba', gone: true }],
    shifts: [{ id: 'oitn', name: 'OITN', days: [0, 1, 2, 3, 4, 5, 6] }],
    avail: { ania: { [day(-3)]: 0 }, jan: { [day(5)]: 3 } },
    limits: { ania: { '*': 6 } }, mins: { ania: { '*': 2 } }, wants: {}, rules: [{ id: 'r', who: 'ania', with: 'jan', places: ['oitn'] }],
    schedule: { [day(-3)]: { oitn: 'jan' } },
  };
  await db.query('select public.save_state($1, $2)', [ADMIN, data]);
  const call = async (fn, ...args) => (await db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args)).rows[0].r;
  const ip = (addr) => db.query(`select set_config('request.headers', $1, false)`, [JSON.stringify({ 'x-forwarded-for': `${addr}, 10.0.0.1` })]);
  const state = async () => (await db.query('select data from public.dyzury where id = 1')).rows[0].data;
  return { db, call, ip, state };
}

test('logowanie PIN-em, sesja i dane tylko tej osoby', async () => {
  const { call, ip } = await setup();
  await ip('1.1.1.1');
  assert.deepEqual(await call('admin_set_pin', ADMIN, 'ania', '404373'), {});
  assert.match((await call('admin_set_pin', ADMIN, 'jan', '404373')).error, /zajęty/);
  assert.match((await call('admin_set_pin', ADMIN, 'jan', '12345')).error, /6 cyfr/);
  assert.match((await call('admin_set_pin', '0000', 'jan', '333190')).error, /Zły PIN/);
  const { token, name } = await call('osoba_login', '404373');
  assert.equal(name, 'Anna Kowalska');
  assert.match(token, /^[0-9a-f]{64}$/);
  const me = await call('osoba_load', token);
  assert.deepEqual(Object.keys(me).sort(), ['avail', 'name', 'od', 'shifts', 'wants']);
  assert.deepEqual(me.shifts, [{ id: 'oitn', name: 'OITN', days: [0, 1, 2, 3, 4, 5, 6] }]);
  assert.deepEqual(me.avail, { [day(-3)]: 0 });
  const text = JSON.stringify(me);
  for (const secret of ['Jan', 'jan', 'limits', 'mins', 'rules', 'schedule', '"6"', 'Ex Osoba']) assert.ok(!text.includes(secret), secret);
  assert.match((await call('osoba_load', 'f'.repeat(64))).error, /Sesja/);
  assert.match((await call('osoba_load', "' or 1=1 --")).error, /Sesja/);
  await call('osoba_logout', token);
  assert.match((await call('osoba_load', token)).error, /Sesja/);
});

test('zapis: walidacja, przeszłość nietykalna, inne pola stanu bez zmian', async () => {
  const { call, ip, state } = await setup();
  await ip('1.1.1.2');
  await call('admin_set_pin', ADMIN, 'ania', '404373');
  const { token } = await call('osoba_login', '404373');
  const before = await state();
  assert.deepEqual(await call('osoba_save', token, { [day(-3)]: 3, [day(-1)]: 4, [day(2)]: 0, [day(3)]: 2, [day(4)]: 4 }, { oitn: 3, '*': 5, we: null }), {});
  const after = await state();
  assert.deepEqual(after.avail.ania, { [day(-3)]: 0, [day(2)]: 0, [day(4)]: 4 }); // przeszłość z bazy, „Mogę” bez wpisu
  assert.deepEqual(after.wants.ania, { oitn: 3, '*': 5 });
  assert.ok(after.stamps.ania);
  for (const k of ['people', 'shifts', 'limits', 'mins', 'rules', 'schedule']) assert.deepEqual(after[k], before[k], k);
  assert.deepEqual(after.avail.jan, before.avail.jan);
  for (const [a, w, why] of [
    [{ [day(1)]: 5 }, {}, /poziom/], [{ [day(1)]: '3' }, {}, /poziom/], [{ '2026-02-30': 1 }, {}, /data/], [{ [day(500)]: 1 }, {}, /data/],
    [{ 'x': 1 }, {}, /data/], [{}, { limits: 1 }, /Nieznana/], [{}, { oitn: 40 }, /0–31/], [{}, { oitn: -1 }, /0–31/], [{}, { oitn: 1.5 }, /0–31/],
    [[], {}, /Nieprawidłowe/],
  ]) assert.match((await call('osoba_save', token, a, w)).error, why, JSON.stringify([a, w]));
  assert.deepEqual((await state()).avail.ania, after.avail.ania);
});

test('save_state Układacza nie nadpisuje zmian osoby zrobionych po wczytaniu', async () => {
  const { call, ip, state, db } = await setup();
  await ip('1.1.1.3');
  await call('admin_set_pin', ADMIN, 'ania', '404373');
  const loaded = (await call('load_state', ADMIN)).data; // Układacz wczytał dane
  const { token } = await call('osoba_login', '404373');
  await call('osoba_save', token, { [day(7)]: 3 }, { oitn: 2 }); // osoba zmienia
  loaded.avail.jan = { [day(8)]: 0 }; // Układacz zmienia kogoś innego i zapisuje stary stan Ani
  loaded.limits.ania = { '*': 4 };
  await db.query('select public.save_state($1, $2)', [ADMIN, loaded]);
  let s = await state();
  assert.deepEqual(s.avail.ania, { [day(-3)]: 0, [day(7)]: 3 });
  assert.deepEqual(s.wants.ania, { oitn: 2 });
  assert.deepEqual(s.avail.jan, { [day(8)]: 0 });
  assert.deepEqual(s.limits.ania, { '*': 4 });
  // po odświeżeniu Układacz ma aktualny stamp — wtedy jego zmiana wygrywa
  const fresh = (await call('load_state', ADMIN)).data;
  fresh.avail.ania = {};
  await db.query('select public.save_state($1, $2)', [ADMIN, fresh]);
  s = await state();
  assert.deepEqual(s.avail.ania, {});
});

test('limity prób: 5 złych z jednego adresu, osoba usunięta nie wejdzie', async () => {
  const { call, ip, db } = await setup();
  await call('admin_set_pin', ADMIN, 'ania', '404373');
  await call('admin_set_pin', ADMIN, 'old', '333190');
  await ip('9.9.9.9');
  assert.match((await call('osoba_login', '333190')).error, /nieaktywne/);
  assert.match((await call('osoba_login', 'abc')).error, /Zły PIN/);
  // przyspieszenie: pozostałe złe próby wpisane wprost (każda prawdziwa trwa 1 s)
  await db.query(`insert into public.zapisy_fails (ip) select '9.9.9.9' from generate_series(1, 4)`);
  assert.match((await call('osoba_login', '404373')).error, /Za dużo/);
  await ip('8.8.8.8');
  assert.ok((await call('osoba_login', '404373')).token);
  await db.query(`insert into public.zapisy_fails (ip) select 'x' || g from generate_series(1, 100) g`);
  assert.match((await call('osoba_login', '404373')).error, /wstrzymane/);
  assert.equal((await call('admin_konta', ADMIN)).fails24h, 105);
});

test('zmiana PIN-u i usunięcie konta unieważniają sesje; tabele zamknięte dla anon', async () => {
  const { call, ip, db } = await setup();
  await ip('1.1.1.4');
  await call('admin_set_pin', ADMIN, 'ania', '404373');
  const { token } = await call('osoba_login', '404373');
  await call('admin_set_pin', ADMIN, 'ania', '424977');
  assert.match((await call('osoba_load', token)).error, /Sesja/);
  const t2 = (await call('osoba_login', '424977')).token;
  await call('admin_usun_konto', ADMIN, 'ania');
  assert.match((await call('osoba_load', t2)).error, /Sesja/);
  const konta = (await call('admin_konta', ADMIN)).konta;
  assert.deepEqual(konta, []);
  await db.exec('set role anon');
  for (const t of ['konta', 'sesje', 'zapisy_sekret', 'zapisy_fails', 'dyzury'])
    await assert.rejects(db.query(`select * from public.${t}`), /permission denied/, t);
  await assert.rejects(db.query(`select public.pin_hash('1')`), /permission denied/);
  await assert.rejects(db.query(`select public.osoba_sesja('1')`), /permission denied/);
  assert.match((await call('osoba_login', '000000')).error, /Zły PIN/); // anon może tylko przez funkcje
});
