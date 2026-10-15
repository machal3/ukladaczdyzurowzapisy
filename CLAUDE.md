# CLAUDE.md

Zapisy na dyżury — osobna aplikacja do Układacza dyżurów (`machal3/ukladaczdyzurow`): osoba z 4-cyfrowym PIN-em
ustawia tylko swoją dostępność i prośby. Vanilla JS, moduły ES, bez builda. UI, komentarze i commity po polsku.

- Termin: miesiąc otwarty do 20. dnia poprzedniego miesiąca włącznie (`zapisy_od` w bazie, czas polski).
- `npm test (jsdom, fetch podmieniony), `npm run test:sql` (PGlite), `npm run lint`, `npm start` (port 3001).
- Zasada nr 1: przeglądarka nie dostaje niczego poza imieniem, miejscami, `avail[pid]`, `wants[pid]`, `uwagi[pid]`
  i grafikiem w postaci { dzień: { id miejsca: imię } } (tylko miesiące `data.gotowe`, od poprzedniego, `zapisy_grafik`)
  oraz ręczne oceny gównianości dni od poprzedniego miesiąca do roku naprzód, także bez gotowego grafiku (`bad`; domyślną liczy `badOf` w `kalendarz.js`, kopia z Układacza).
  Korekty Układacza (`data.availAdm`/`data.wantsAdm`) nigdy nie idą do osoby — osoba widzi tylko swoje wpisy.
  Każde nowe pole wysyłane do osoby przechodzi przez `osoba_load` w `supabase-zapisy.sql` — z testem w `sql.test.js`,
  że nie wycieka nic więcej. Walidacja zapisu jest w bazie, nie w kliencie.
- Format danych musi zostać zgodny ze stanem Układacza (klucze `YYYY-MM-DD`, poziomy 0–4, 2 = brak wpisu,
  klucze próśb jak `WANT_LABEL` + id miejsc). `kalendarz.js` kopiuje funkcje z jego `scheduler.js`.
- `style.css`, `theme.css`, `ui.js`, `theme-init.js`, `fonts/` to kopie z Układacza; własne style w `zapisy.css`.
- Styl „ponytail” jak w Układaczu: świadome skróty oznaczone `// ponytail:`.
