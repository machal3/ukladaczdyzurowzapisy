import test from 'node:test';
import assert from 'node:assert/strict';
import { dateKey, setLevel, nextLevel, monthSummary, wantRows, parseWant, LEVELS } from './kalendarz.js';

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
  const keys = wantRows([{ id: 'a1', name: 'OITN' }]).map((r) => r.key);
  assert.deepEqual(keys, ['*', 'we', 'a1', 'd56', 'd4', 'd5', 'd6']);
  assert.equal(parseWant(''), undefined);
  assert.equal(parseWant(' 3 '), 3);
  assert.equal(parseWant('0'), 0);
  for (const bad of ['32', '-1', '1.5', 'abc', '1e1']) assert.equal(parseWant(bad), null, bad);
});
