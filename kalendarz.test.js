import test from 'node:test';
import assert from 'node:assert/strict';
import { dateKey, badOf, setLevel, nextLevel, monthSummary, WANT_ROWS, onlyAsked, parseWant, LEVELS, deadline, monthKey, myShifts, sortShifts } from './kalendarz.js';

test('gównianość jak w Układaczu: Pt gówniany, So/Nd słabe, ręczna ocena wygrywa', () => {
  assert.deepEqual([2, 3, 4, 5, 6, 7, 8].map((d) => badOf({}, 2026, 10, d)), [0, 0, 0, 0, 2, 1, 1]); // 2.11.2026 = pon
  assert.equal(badOf({ '2026-11-04': 3, '2026-11-06': 0 }, 2026, 10, 4), 3);
  assert.equal(badOf({ '2026-11-06': 0 }, 2026, 10, 6), 0);
});

test('poziomy jak w Układaczu: „Mogę” nie jest zapisywane, klik idzie po kolei', () => {
  assert.deepEqual(LEVELS, ['Nie mogę', 'W ostateczności', 'Mogę', 'Chcę', 'Muszę']);
  const a = setLevel({}, '2026-11-02', 0);
  assert.deepEqual(a, { '2026-11-02': 0 });
  assert.deepEqual(setLevel(a, '2026-11-02', 2), {});
  assert.deepEqual([2, 3, 4, 0, 1].map(nextLevel), [3, 4, 0, 1, 2]);
  assert.equal(dateKey(2026, 0, 0), '2025-12-31');
});

test('podsumowanie miesiąca liczy tylko dni tego miesiąca', () => {
  assert.deepEqual(monthSummary({ '2026-11-01': 0, '2026-11-02': 0, '2026-11-30': 3, '2026-12-01': 4 }, 2026, 10), { 0: 2, 3: 1 });
});

test('prośby: klucze zgodne ze state.wants, bez limitów; walidacja pola', () => {
  assert.deepEqual(WANT_ROWS.map((r) => r.key), ['*', 'd56']);
  assert.deepEqual(onlyAsked({ '*': 5, d56: 2, we: 3, oitn: 1 }), { '*': 5, d56: 2 }, 'dawne prośby odpadają');
  assert.deepEqual(onlyAsked(undefined), {});
  assert.equal(parseWant(''), undefined);
  assert.equal(parseWant(' 3 '), 3);
  assert.equal(parseWant('0'), 0);
  for (const bad of ['32', '-1', '1.5', 'abc', '1e1']) assert.equal(parseWant(bad), null, bad);
});

test('kolejność miejsc: OITN, PN2, PN1, inne za nimi', () => {
  const s = sortShifts([{ name: 'PN1' }, { name: 'Inne' }, { name: 'PN2' }, { name: 'oitn' }]);
  assert.deepEqual(s.map((x) => x.name), ['oitn', 'PN2', 'PN1', 'Inne']);
});

test('termin zapisów i moje dyżury z grafiku', () => {
  assert.equal(dateKey(...((d) => [d.getFullYear(), d.getMonth(), d.getDate()])(deadline(2027, 0))), '2026-12-20');
  assert.equal(monthKey(2026, 10), '2026-11');
  const g = { '2026-11-02': { a: 'Anna', b: 'Jan' }, '2026-11-05': { b: 'Anna', x: 'Anna' }, '2026-12-01': { a: 'Anna' } };
  assert.deepEqual(myShifts(g, [{ id: 'a', name: 'OITN' }, { id: 'b', name: 'PN1' }], 'Anna', 2026, 10),
    [{ d: 2, wd: 0, shift: 'OITN' }, { d: 5, wd: 3, shift: 'PN1' }]);
});
