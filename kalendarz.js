// Czyste funkcje (bez DOM i sieci). dateKey/daysInMonth/weekday/LEVELS/BAD/badOf skopiowane z scheduler.js Układacza —
// muszą zostać zgodne, bo klucze dni i poziomy trafiają wprost do jego stanu (state.avail).
const pad = (n) => String(n).padStart(2, '0');
export const dateKey = (y, m, d) => d >= 1 && d <= 28 && m >= 0 && m <= 11 ? `${y}-${pad(m + 1)}-${pad(d)}`
  : ((t) => `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`)(new Date(y, m, d));
export const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
export const weekday = (y, m, d) => (new Date(y, m, d).getDay() + 6) % 7; // 0 = pon, 6 = nd
export const LEVELS = ['Nie mogę', 'W ostateczności', 'Mogę', 'Chcę', 'Muszę'];
export const DEFAULT_LEVEL = 2; // brak wpisu = „Mogę”
export const availOf = (avail, key) => avail[key] ?? DEFAULT_LEVEL;
// Gównianość dnia jak w Układaczu (BAD/badOf z scheduler.js): bad = ręczne oceny z osoba_load, reszta wg dnia tygodnia
export const BAD = ['Zwykły', 'Słaby', 'Gówniany', 'Tragiczny'];
const BAD_DEFAULT = [0, 0, 0, 0, 2, 1, 1]; // indeks = dzień tygodnia, 0 = pon
export const badOf = (bad, y, m, d) => bad[dateKey(y, m, d)] ?? BAD_DEFAULT[weekday(y, m, d)];

// Poziom dnia; „Mogę” nie jest zapisywane (jak w Układaczu). Zwraca nowy obiekt.
export function setLevel(avail, key, lvl) {
  const out = { ...avail };
  if (lvl === DEFAULT_LEVEL) delete out[key]; else out[key] = lvl;
  return out;
}
// Klik bez pędzla: Mogę → Chcę → Muszę → Nie mogę → W ostateczności → Mogę
export const nextLevel = (lvl) => (lvl + 1) % LEVELS.length;

// Ile dni miesiąca ma każdy poziom (bez „Mogę”), np. { 0: 5, 3: 2 }
export function monthSummary(avail, y, m) {
  const out = {};
  for (let d = 1; d <= daysInMonth(y, m); d++) {
    const lvl = availOf(avail, dateKey(y, m, d));
    if (lvl !== DEFAULT_LEVEL) out[lvl] = (out[lvl] ?? 0) + 1;
  }
  return out;
}

// Prośby osoby: tylko ile dyżurów łącznie i ile z nich w soboty i niedziele. Klucze jak state.wants w Układaczu;
// ta sama lista w osoba_save (supabase-zapisy.sql) i OSOBA_WANTS w Układaczu. Resztę próśb ustawia tylko administrator.
export const WANT_ROWS = [
  { key: '*', label: 'Łącznie', hint: 'wszystkie dyżury w miesiącu' },
  { key: 'd56', label: 'Soboty i niedziele', hint: 'ile z nich w So + Nd' },
];
// dawne prośby (np. Pt/So/Nd, miejsca) nie są już pokazywane ani odsyłane — znikają przy pierwszym zapisie osoby
export const onlyAsked = (wants) => Object.fromEntries(Object.entries(wants ?? {}).filter(([k]) => WANT_ROWS.some((r) => r.key === k)));

// Wartość pola prośby: '' = brak prośby (usuwa klucz), inaczej liczba całkowita 0–31; null = niepoprawna
export function parseWant(text) {
  const t = String(text).trim();
  if (t === '') return undefined;
  return /^\d{1,2}$/.test(t) && +t <= 31 ? +t : null;
}

// Termin zapisów na miesiąc m: 20. dzień poprzedniego miesiąca (włącznie). Pilnuje go baza (zapisy_od), tu tylko do opisu.
export const deadline = (y, m) => new Date(y, m - 1, 20);
export const monthKey = (y, m) => dateKey(y, m, 1).slice(0, 7);

// Moje dyżury w miesiącu z grafiku { dzień: { id miejsca: imię } }: [{ d, wd, shift }]
export function myShifts(grafik, shifts, name, y, m) {
  const names = Object.fromEntries(shifts.map((s) => [s.id, s.name]));
  const out = [];
  for (let d = 1; d <= daysInMonth(y, m); d++)
    for (const [sid, who] of Object.entries(grafik[dateKey(y, m, d)] ?? {}))
      if (who === name && names[sid]) out.push({ d, wd: weekday(y, m, d), shift: names[sid] });
  return out;
}
