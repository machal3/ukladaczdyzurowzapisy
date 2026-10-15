# Prompt do sesji w repo `ukladaczdyzurow` (Układacz)

Wklej poniższy tekst w nowej sesji Claude Code w repozytorium Układacza.

---

Dodaj integrację z osobną aplikacją „Zapisy na dyżury” (repo `machal3/ukladaczdyzurowzapisy`), w której każda
osoba swoim 4-cyfrowym PIN-em ustawia własną dostępność (`state.avail[pid]`; na miesiąc do 20. dnia poprzedniego),
prośby (`state.wants[pid]`) i komentarze do miesięcy (`state.uwagi[pid]['YYYY-MM'] = tekst`), a także ogląda
grafik (same imiona na miejscach).
Funkcje bazy (`konta`, `sesje`, `osoba_*`, `admin_*`) są w `supabase-zapisy.sql` tamtego repo. Zapisy zmieniają
`dyzury.data` po stronie serwera i ustawiają `data.stamps[pid]` (czas zmiany, ISO).

1. **`supabase.sql`** — podmień `save_state` na wersję z `ukladacz/supabase.sql` w repo Zapisów (jest tam
   przetestowana na Postgresie w `sql.test.js`): przed zapisem, z `select … for update`, dla każdego pid, gdzie
   `old.stamps[pid]` jest nowszy niż `d.stamps[pid]` (albo `d` go nie ma), przepisuje z bazy `avail[pid]`,
   `wants[pid]`, `uwagi[pid]` i `stamps[pid]`. Reszta pliku bez zmian.
2. **`app.js`** — `state.stamps ??= {}; state.uwagi ??= {};` obok pozostałych `??=` po `load()`; przy usuwaniu osoby
   `delete state.uwagi[pid]`. Klient nigdy nie zmienia `stamps`
   (odsyła je takie, jakie wczytał — to wystarcza serwerowi do wykrycia zmian osób).
3. **`cloud.js`** — `cloudReload()`: gdy nic nie czeka na wysłanie (`pending === 0`), ponownie `load_state`
   i zwróć dane; w `app.js` podmień `state` (z tymi samymi `??=`/migracjami — wydziel je do funkcji) i `render()`.
   Wywołuj na `visibilitychange` (karta znów widoczna) i z przycisku „Odśwież dane” w Ustawieniach aplikacji
   (tylko tryb chmury). Nie przeładowuj w trakcie układania (`generation`) ani przy otwartym oknie osoby.
4. **Okno osoby (⚙)**, tylko w trybie chmury — nowa karta „Konto w Zapisach”:
   - stan z `admin_konta(p)` (pobierz raz przy otwarciu okna): „ma PIN” / „bez konta”, ostatnie logowanie,
     ostatnia zmiana w Zapisach,
   - „Nadaj nowy PIN”: losuje 4 cyfry przez `crypto.getRandomValues` (odrzuć słabe: ≤ 2 różne cyfry, ciągi
     rosnące/malejące, `abcabc`), woła `admin_set_pin(p, osoba, nowy)`, przy błędzie „zajęty” losuje ponownie;
     pokazuje PIN **raz** w oknie z przyciskiem „Skopiuj” i uwagą, że stary PIN i sesje przestały działać,
   - „Usuń konto” (confirm) → `admin_usun_konto(p, osoba)`.
   Potrzebny jest PIN administratora — wyeksportuj z `cloud.js` funkcję `cloudRpc(fn, body)`, która dokłada `p: pin`.
5. **Ustawienia aplikacji** — wiersz „Zapisy na dyżury”: liczba złych prób logowania z 24 h (`fails24h`
   z `admin_konta`) i link do aplikacji Zapisów (stała `ZAPISY_URL` w `config.js`, pusta = wiersz ukryty).
6. **Usunięcie osoby** (`delPerson`) w trybie chmury woła też `admin_usun_konto`.
7. **Komentarze osób** — w oglądanym miesiącu pokaż komentarze (`state.uwagi[pid][YYYY-MM]`): w sekcji „Uwagi” nad
   kalendarzem (osobny wiersz „Komentarz” przy osobie, tekst przez `esc()`), w oknie osoby (⚙) i w Statystykach.
   Uwagi mają być widoczne także wtedy, gdy grafik jest pusty (dziś sekcja jest wtedy ukryta).
8. **Termin zapisów** — osoby zapisują się na miesiąc do 20. dnia poprzedniego (pilnuje baza). Opcjonalnie pole
   „Zamknij zapisy wcześniej, do miesiąca” (`<input type="month">`) → `state.zapisyOd = 'YYYY-MM'`.
   W nagłówku kalendarza pokaż „Zapisy osób: otwarte do 20.MM” albo „zamknięte”.
9. **Grafik widzą osoby** — Zapisy pokazują aktualny `state.schedule` (od poprzedniego miesiąca) z imionami.
   Dodaj w Instrukcji zdanie, że osoby widzą grafik na bieżąco, także w trakcie poprawiania.
10. W trybie dostępności osoby (kalendarz) pokaż obok imienia „zmienione w Zapisach: <data>”, jeśli `state.stamps[pid]`
   istnieje — żeby było wiadomo, że te dni wpisała osoba.
11. Testy: `ui.test.js` — bez chmury nowa karta i wiersz się nie pokazują; `state.stamps` przetrwa zapis/odczyt.
   README + zakładka Instrukcja: sekcja „Dane od osób (Zapisy na dyżury)” (co osoba widzi, a czego nie: limitów,
   minimów, innych osób, warunków, gównianości i grafiku nie widzi; kto wygrywa przy jednoczesnej zmianie — osoba).
   Nie zmieniaj klucza `dyzury-v1`; nowe pola przez `??=`. Zachowaj styl ponytail.

Kolejność wdrożenia: najpierw nowy `supabase.sql` w Supabase (SQL Editor), potem `supabase-zapisy.sql`
z repo Zapisów, dopiero potem rozdawanie PIN-ów.
