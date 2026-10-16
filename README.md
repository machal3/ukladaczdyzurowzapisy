# Zapisy na dyżury

Osobna aplikacja dla osób dyżurujących, do [Układacza dyżurów](https://github.com/machal3/ukladaczdyzurow).
Każda osoba loguje się **własnym 4-cyfrowym PIN-em** i może:

- zaznaczyć w kalendarzu, kiedy może / chce / musi / nie może dyżurować (te same poziomy co w Układaczu) —
  **na dany miesiąc do 10. dnia poprzedniego miesiąca**, później miesiąc jest tylko do podglądu,
- zostawić **komentarz** do swoich dyżurów w danym miesiącu (do 500 znaków, w tym samym terminie co dostępność),
- ustawić swoje **prośby**: ile dyżurów chce łącznie i ile z nich w soboty i niedziele — obowiązują od
  najbliższego miesiąca, więc od 11. do końca miesiąca są zamknięte,
- obejrzeć **grafik** miesięcy oznaczonych w Układaczu jako „Gotowe” (od poprzedniego miesiąca) — swoje dyżury podświetlone, filtr „Tylko moje”, dni w kolorach gównianości jak w Układaczu.

Nie widzi swoich limitów ani minimów, korekt administratora, dostępności i próśb innych ani warunków — te dane w ogóle
nie wychodzą z bazy. Z grafiku dostaje tylko imiona na miejscach i gównianość dni. Wpisy trafiają wprost do stanu Układacza
(`state.avail[pid]`, `state.wants[pid]`, `state.uwagi[pid]['YYYY-MM']`).

## Bezpieczeństwo

| Co | Jak |
|---|---|
| Dostęp do danych | tylko funkcje `security definer` w Postgresie (`supabase-zapisy.sql`); tabele zamknięte (RLS bez polityk, `revoke all`). `osoba_load` zwraca imię, nazwy miejsc, `avail`, `wants` i `uwagi` tej osoby oraz grafik jako { dzień: { miejsce: imię } } i ręczne oceny gównianości dni z tych samych miesięcy (`bad`). |
| Uprawnienia | Supabase domyślnie daje rolom `anon`/`authenticated` `execute` na nowe funkcje — SQL odbiera je wprost (nie tylko `public`); `sql.test.js` odtwarza te domyślne uprawnienia. Klucz w `config.js` to klucz publishable (publiczny z założenia); klucza `secret`/`service_role` nie ma w repo. |
| PIN | w bazie tylko HMAC-SHA256 z losowym pepperem (`zapisy_sekret`); unikalny. Do przeglądarki nie wraca i nie jest w niej zapisywany. |
| Sesja | po zalogowaniu losowy token (32 bajty) w `localStorage`, w bazie jego sha256; ważny 90 dni. Wyloguj / nowy PIN / usunięcie konta lub osoby = koniec sesji. |
| Zgadywanie PIN-u | 5 złych prób / 15 min z jednego adresu, 100 złych prób / 24 h łącznie → logowanie wstrzymane (zalogowani pracują dalej), 1 s przerwy po złej próbie, próby po kolei. Szansa trafienia czyjegoś PIN-u przy ciągłym ataku ≈ 30% na dobę (4 cyfry, ~30 kont) — PIN chroni przed przypadkiem, nie przed uporem. |
| Zapis | serwer sprawdza każdą datę (format, miesiąc otwarty — termin 10. dnia poprzedniego miesiąca, opcjonalnie `zapisyOd` — ≤ 400 dni naprzód), komentarze (miesiąc otwarty, ≤ 500 znaków), prośby (zamknięte od 11. do końca miesiąca), poziom 0–4, klucze próśb (tylko `*` i `d56`), wartości 0–31. Przeszłe dni zostają takie, jakie były. |
| Przeglądarka | CSP w `vercel.json` (skrypty tylko własne, połączenia tylko do Supabase), `no-referrer`, `nosniff`; tekst z bazy zawsze przez `esc()`/`textContent`. |
| Korekty administratora | Układacz nie zmienia wpisów osoby: swoje zmiany dostępności i próśb trzyma obok, w `data.availAdm`/`data.wantsAdm`. Mają pierwszeństwo przy układaniu, ale `osoba_load` ich nie wysyła — osoba widzi tylko to, co sama wpisała (`sql.test.js`). |
| Konflikty z Układaczem | Zapisy ustawiają `data.stamps[pid]`; zmieniony `save_state` Układacza nie nadpisuje zmian osoby, których jeszcze nie wczytał (`ukladacz/supabase.sql`). |

## Wdrożenie

1. W repo Układacza wykonaj prompt z [`ukladacz/PROMPT.md`](ukladacz/PROMPT.md) (nowy `save_state` + zarządzanie kontami).
2. Supabase → SQL Editor: nowy `supabase.sql` Układacza, potem `supabase-zapisy.sql` z tego repo (oba można puszczać ponownie).
3. PIN-y: jednorazowy skrypt `seed-piny.sql` (nie jest w repo — `.gitignore`) nadaje PIN-y aktywnym osobom
   i wypisuje tabelę osoba → PIN. Później: Układacz → ⚙ osoby → „Nadaj nowy PIN”.
4. Vercel: nowy projekt z tego repo, bez budowania (jak Układacz). `config.js` ma ten sam adres i publiczny klucz Supabase.

## Dla programistów

Vanilla JS (moduły ES), bez zależności uruchomieniowych i bez kroku budowania. Node ≥ 22.

```sh
npm ci
npm start         # http://127.0.0.1:3001 (Układacz lokalnie: 3000)
npm test          # kalendarz.test.js + ui.test.js (jsdom, Supabase podmienione)
npm run test:sql  # supabase-zapisy.sql + save_state na prawdziwym Postgresie (PGlite)
npm run lint
```

| Plik | Rola |
|---|---|
| `app.js` | ekran PIN-u, kalendarz dostępności (pędzel, przeciąganie), prośby |
| `api.js` | RPC do Supabase, token sesji, zapis z opóźnieniem 400 ms |
| `kalendarz.js` | czyste funkcje; `dateKey`/`daysInMonth`/`weekday`/`LEVELS` skopiowane z `scheduler.js` Układacza — muszą zostać zgodne |
| `supabase-zapisy.sql` | tabele kont i sesji, funkcje `osoba_*` i `admin_*` |
| `ukladacz/` | zmiany dla Układacza: `supabase.sql` z nowym `save_state` i `PROMPT.md` |
| `style.css`, `theme.css`, `theme-init.js`, `ui.js`, `fonts/` | **kopie z Układacza** — przy zmianie wyglądu tam skopiuj je ponownie; dodatki tylko w `zapisy.css`. `icon.svg` i logo w `index.html` są własne (kalendarz z ptaszkiem), nie kopiuj ich z Układacza |
