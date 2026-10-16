// Zapisy na dyżury: osoba (4-cyfrowy PIN) ustawia własną dostępność, prośby i komentarze do miesięcy
// oraz ogląda grafik (same imiona na miejscach). Limity, minima i dostępność innych zostają w bazie (supabase-zapisy.sql).
import { dateKey, daysInMonth, weekday, LEVELS, BAD, badOf, availOf, setLevel, nextLevel, monthSummary, WANT_ROWS, onlyAsked, parseWant, deadline, monthKey, myShifts, sortShifts } from './kalendarz.js';
import { hasSession, login, load, logout, save, busy, SessionError } from './api.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const DAY_NAMES = ['Poniedziałek', 'Wtorek', 'Środa', 'Czwartek', 'Piątek', 'Sobota', 'Niedziela'];
const DAYS = ['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So', 'Nd'];
const ORDER = [4, 3, 2, 1, 0]; // kolejność w pasku pędzla: od najważniejszego (Muszę) do Nie mogę
// ikony pędzla (lucide); na telefonie zostaje sama ikona na kolorze poziomu
const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const BRUSH_ICON = {
  '': svg('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>'), // Po kolei
  4: svg('<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>'),
  3: svg('<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>'),
  2: svg('<path d="M20 6 9 17l-5-5"/>'),
  1: svg('<path d="M5 12h14"/>'),
  0: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
};
const brushBtn = (l, title) => `<button type="button" class="brush${l === '' ? '' : ` lvl-${l}`}" data-lvl="${l}" aria-pressed="${brush === (l === '' ? null : l)}" title="${title}">${BRUSH_ICON[l]}<span class="lbl">${l === '' ? 'Po kolei' : LEVELS[l]}</span></button>`;
const COMMENT_MAX = 500;

const me = await start();
me.shifts = sortShifts(me.shifts); // jak w Układaczu, także zanim zapisze on nową kolejność
let avail = me.avail, wants = onlyAsked(me.wants), uwagi = me.uwagi ?? {};
const grafik = me.grafik ?? {}, bad = me.bad ?? {};
const now = new Date();
const ym = (d) => ({ y: d.getFullYear(), m: d.getMonth() });
const shift = ({ y, m }, n) => ym(new Date(y, m + n));
const cmp = (a, b) => a.y - b.y || a.m - b.m;
const open = { y: +me.od.slice(0, 4), m: +me.od.slice(5, 7) - 1 }; // pierwszy miesiąc, na który można się jeszcze zapisać
// każda zakładka z miesiącem ma własny: dostępność startuje na pierwszym otwartym, grafik na bieżącym
const views = { calendar: open, grafik: ym(now) };
const range = { calendar: [ym(now), shift(ym(now), 12)], grafik: [shift(ym(now), -1), shift(ym(now), 12)] };
let brush = null; // null = po kolei
let onlyMine = false;
const todayKey = dateKey(now.getFullYear(), now.getMonth(), now.getDate());
const monthName = ({ y, m }, form = 'long') => new Date(y, m).toLocaleDateString('pl-PL', { month: form, year: 'numeric' });
const shortDate = (d) => d.toLocaleDateString('pl-PL', { day: 'numeric', month: 'long' });

// Ekran PIN-u aż do udanego wczytania danych. Błąd sesji (wygasła, PIN zmieniony) wraca tutaj.
async function start() {
  const page = document.body.innerHTML;
  let msg = '';
  for (;;) {
    if (hasSession()) try {
      const data = await load();
      document.body.innerHTML = page;
      return data;
    } catch (e) {
      msg = e instanceof SessionError ? 'Sesja wygasła — wpisz PIN ponownie.' : `Błąd połączenia: ${e.message}`;
    }
    const pin = await ask(msg);
    try { await login(pin); msg = ''; } catch (e) { msg = e.message === 'Zły PIN' ? 'Zły PIN.' : e.message; }
  }
}

function ask(msg) {
  document.body.innerHTML = `<main class="login"><h1>Zapisy na dyżury</h1><form>
    <label for="pin">Twój PIN (4 cyfry)</label>
    <input id="pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}([0-9]{2})?" maxlength="6" autocomplete="current-password" required autofocus>
    <button>Wejdź</button><p role="status"></p></form></main>`;
  document.querySelector('.login [role=status]').textContent = msg;
  return new Promise((resolve) => document.querySelector('.login form').addEventListener('submit', (e) => {
    e.preventDefault();
    e.target.querySelector('button').disabled = true;
    resolve(e.target.elements.pin.value.trim());
  }));
}

const tab = () => document.body.dataset.tab;
const editable = (key) => key >= me.od; // klucze YYYY-MM-DD porównują się jak daty

// Nawigacja miesięcy dla aktywnej zakładki (Prośby i Instrukcja jej nie mają)
function renderMonth() {
  const v = views[tab()];
  if (!v) return;
  $('#month-label').textContent = monthName(v);
  $('#prev').disabled = cmp(v, range[tab()][0]) <= 0;
  $('#next').disabled = cmp(v, range[tab()][1]) >= 0;
}

function renderAvail() {
  const v = views.calendar, { y, m } = v, isOpen = cmp(v, open) >= 0;
  let html = DAY_NAMES.map((d) => `<div class="dow">${d}</div>`).join('');
  html += '<div class="cell empty"></div>'.repeat(weekday(y, m, 1));
  for (let d = 1; d <= daysInMonth(y, m); d++) {
    const key = dateKey(y, m, d), lvl = availOf(avail, key), wd = weekday(y, m, d), ok = editable(key), b = badOf(bad, y, m, d);
    html += `<div class="cell burden-${b} ${key === todayKey ? 'today' : ''} ${ok ? '' : 'past'}" title="${BAD[b]} dzień">
      <div class="day-heading"><div class="num" aria-hidden="true">${d}</div><span class="day-name">${DAY_NAMES[wd]}</span>${key === todayKey ? '<span class="today-label">Dzisiaj</span>' : ''}</div>
      <div class="day-slots"><button class="avail lvl-${lvl}" data-avail="${key}" ${ok ? '' : 'disabled'} aria-label="${DAY_NAMES[wd]}, ${d} ${monthName(v)}: ${LEVELS[lvl]}${ok ? '' : ' (zapisy zamknięte)'}">${LEVELS[lvl]}</button></div></div>`;
  }
  html += '<div class="cell empty"></div>'.repeat((7 - (weekday(y, m, 1) + daysInMonth(y, m)) % 7) % 7);
  $('#calendar').innerHTML = html;

  const sum = monthSummary(avail, y, m);
  const counts = ORDER.filter((l) => sum[l]).map((l) => `<span class="pill lvl-${l}">${LEVELS[l]}: ${sum[l]}</span>`).join('');
  const due = shortDate(deadline(y, m)), dueShort = deadline(y, m).toLocaleDateString('pl-PL', { day: 'numeric', month: '2-digit' });
  $('#status').classList.toggle('closed', !isOpen);
  $('#status').innerHTML = isOpen
    ? `<span class="cycle" role="group" aria-label="Dostępność — wybierz poziom i klikaj albo przeciągaj po dniach">` +
      ORDER.map((l) => brushBtn(l, `${LEVELS[l]} — klik i przeciąganie po dniach wpisuje ten poziom`)).join('') +
      brushBtn('', 'Po kolei — każdy klik w dzień: następny poziom') + '</span>' +
      `<span class="deadline" title="Zapisy na ten miesiąc do ${due}"><span class="long">zapisy do ${due}</span><span class="short" aria-hidden="true">do ${dueShort}</span></span>`
    : `<span class="who"><b>Zapisy zamknięte</b><span class="closed-msg">Na ${monthName(v)} można było się zapisać do ${due}. Dostępność jest tylko do podglądu.</span></span>` +
      `<span class="summary">${counts}</span><button type="button" class="ghost outline" data-go="grafik">Zobacz grafik →</button>`;

  // komentarz do oglądanego miesiąca; nie przebudowujemy pola w trakcie pisania (fokus, kursor)
  const key = monthKey(y, m), field = $('#comment-text');
  $('#comment-title').textContent = `Komentarz do moich dyżurów — ${monthName(v)}`;
  if (field.dataset.month !== key) { field.dataset.month = key; field.value = uwagi[key] ?? ''; }
  field.disabled = !isOpen; // po terminie komentarz tylko do podglądu (baza i tak go nie zmieni)
  $('#comment-count').textContent = `${field.value.length}/${COMMENT_MAX}`;
}

function renderGrafik() {
  const v = views.grafik, { y, m } = v;
  const mine = myShifts(grafik, me.shifts, me.name, y, m);
  $('#grafik-title').textContent = `Moje dyżury — ${monthName(v)}`;
  $('#grafik-list').innerHTML = mine.length
    ? `<span class="count">${mine.length}</span>` + mine.map((s) => `<span class="pill mine-pill">${s.d} ${DAYS[s.wd]} · ${esc(s.shift)}</span>`).join('')
    : '<span class="hint">Brak Twoich dyżurów w tym miesiącu.</span>';
  const any = Object.keys(grafik).some((k) => k.startsWith(monthKey(y, m)));
  $('#grafik-empty').hidden = any;
  $('#grafik').hidden = !any;
  $('#only-mine').setAttribute('aria-pressed', onlyMine);
  $('#grafik').classList.toggle('only-mine', onlyMine);
  if (!any) return;
  let html = DAY_NAMES.map((d) => `<div class="dow">${d}</div>`).join('');
  html += '<div class="cell empty"></div>'.repeat(weekday(y, m, 1));
  for (let d = 1; d <= daysInMonth(y, m); d++) {
    const key = dateKey(y, m, d), wd = weekday(y, m, d), day = grafik[key] ?? {}, b = badOf(bad, y, m, d);
    const slots = me.shifts.filter((s) => s.days?.includes(wd) || day[s.id]).map((s) => {
      const who = day[s.id], my = who === me.name;
      return `<div class="slot ${who ? '' : 'unfilled'} ${my ? 'mine' : ''}"><span class="slot-label">${esc(s.name)}</span>` +
        `<span class="slot-name">${who ? esc(who) : '—'}${my ? '<span class="you">Ty</span>' : ''}</span></div>`;
    }).join('');
    html += `<div class="cell burden-${b} ${key === todayKey ? 'today' : ''} ${slots.includes(' mine') ? 'has-mine' : ''}" aria-label="${DAY_NAMES[wd]}, ${d} ${monthName(v)} — ${BAD[b]}" title="${BAD[b]} dzień">
      <div class="day-heading"><div class="num" aria-hidden="true">${d}</div><span class="day-name">${DAY_NAMES[wd]}</span>${key === todayKey ? '<span class="today-label">Dzisiaj</span>' : ''}</div>
      <div class="day-slots">${slots}</div></div>`;
  }
  html += '<div class="cell empty"></div>'.repeat((7 - (weekday(y, m, 1) + daysInMonth(y, m)) % 7) % 7);
  $('#grafik').innerHTML = html;
}

function render() { renderMonth(); renderAvail(); renderGrafik(); }

// Prośby nie są per miesiąc — po terminie najbliższego miesiąca (od 11.) zamknięte do 1. (pilnuje baza: me.prosby)
const wantsOpen = me.prosby !== false;
function renderWants() {
  const row = (r) => `<tr><th scope="row">${esc(r.label)}${r.hint ? `<small>${r.hint}</small>` : ''}</th>` +
    `<td><input type="number" min="0" max="31" step="1" inputmode="numeric" placeholder="—" data-want="${esc(r.key)}" value="${wants[r.key] ?? ''}" ${wantsOpen ? '' : 'disabled'} aria-label="Prośba: ${esc(r.label)}"></td></tr>`;
  const head = '<thead><tr><td></td><th scope="col">Prośba<small>ile dyżurów</small></th></tr></thead>';
  $('#wants').innerHTML = (wantsOpen ? '' : `<p class="closed-msg">Termin zapisów na ${monthName(shift(ym(now), 1))} minął — prośby są tylko do podglądu, zmienisz je od 1. dnia następnego miesiąca.</p>`) +
    `<table class="counts">${head}<tbody>${WANT_ROWS.map(row).join('')}</tbody></table>`;
}

function showSave(st) {
  const el = $('#save-state');
  if (st instanceof SessionError) { location.reload(); return; } // ekran PIN-u; niezapisana zmiana przepada, komunikat pokaże logowanie
  el.className = st instanceof Error ? 'error' : st;
  // zapis i sukces widać jako kropkę / ✓ (zapisy.css), tekst tylko dla czytnika; błąd zostaje widoczny
  el.innerHTML = st instanceof Error ? esc(`Nie zapisano: ${st.message}`)
    : `<span class="sr-only">${st === 'saving' ? 'Zapisuję…' : 'Zapisano'}</span>`;
}
const persist = () => save(avail, wants, uwagi, showSave);

// Malowanie dni: klik = następny poziom albo poziom pędzla; przeciągnięcie myszą wpisuje poziom pierwszego dnia
// we wszystkie mijane dni (jak w Układaczu). ponytail: palcem przeciąganie przewija stronę — dotyk = stuknięcia.
const dayButton = (t) => t.closest?.('[data-avail]:enabled');
const levelFor = (el) => brush ?? nextLevel(availOf(avail, el.dataset.avail));
function paintDay(el, lvl) {
  if (availOf(avail, el.dataset.avail) === lvl) return;
  avail = setLevel(avail, el.dataset.avail, lvl);
  persist();
  renderAvail();
}
let paint = null, skipClick = false;
$('#calendar').onclick = (e) => { const el = dayButton(e.target); if (el && !skipClick) paintDay(el, levelFor(el)); };
$('#calendar').addEventListener('pointerdown', (e) => {
  const el = dayButton(e.target);
  if (!el || e.pointerType === 'touch' || e.button !== 0) return;
  paint = { lvl: levelFor(el), last: el.dataset.avail };
  skipClick = true;
  paintDay(el, paint.lvl);
});
$('#calendar').addEventListener('pointerover', (e) => {
  const el = paint && dayButton(e.target);
  if (!el || el.dataset.avail === paint.last) return;
  paint.last = el.dataset.avail;
  paintDay(el, paint.lvl);
});
for (const type of ['pointerup', 'pointercancel']) addEventListener(type, () => { paint = null; setTimeout(() => { skipClick = false; }); });

$('#status').onclick = (e) => {
  const b = e.target.closest('[data-lvl]');
  if (b) { brush = b.dataset.lvl === '' ? null : +b.dataset.lvl; renderAvail(); }
  if (e.target.closest('[data-go]')) showTab('grafik');
};

$('#comment-text').addEventListener('input', (e) => {
  const key = e.target.dataset.month, text = e.target.value;
  $('#comment-count').textContent = `${text.length}/${COMMENT_MAX}`;
  uwagi = { ...uwagi };
  if (text.trim()) uwagi[key] = text; else delete uwagi[key];
  persist();
});

$('#wants').addEventListener('input', (e) => {
  const key = e.target.dataset.want;
  if (!key) return;
  const v = parseWant(e.target.value);
  e.target.setCustomValidity(v === null ? 'Wpisz liczbę od 0 do 31 albo zostaw puste.' : '');
  if (v === null) return e.target.reportValidity();
  if (v === wants[key]) return;
  wants = { ...wants };
  if (v === undefined) delete wants[key]; else wants[key] = v;
  persist();
});

$('#only-mine').onclick = () => { onlyMine = !onlyMine; renderGrafik(); };

const step = (n) => { const t = tab(); if (!views[t]) return; views[t] = shift(views[t], n); render(); };
$('#prev').onclick = () => step(-1);
$('#next').onclick = () => step(1);

const scrolls = {};
function showTab(next) {
  const cur = tab();
  scrolls[cur] = next === cur ? 0 : scrollY;
  document.body.dataset.tab = next;
  for (const b of document.querySelectorAll('button[data-tab]')) b.setAttribute('aria-pressed', b.dataset.tab === next);
  renderMonth();
  scrollTo({ top: scrolls[next] ?? 0, behavior: 'instant' });
}
$('.tabs').onclick = (e) => { const t = e.target.closest('[data-tab]'); if (t) showTab(t.dataset.tab); };
$('#app-settings-open').onclick = () => $('#app-settings').showModal();
$('#logout').onclick = async () => { await logout(); location.reload(); };

// Powrót na kartę: świeże wpisy z bazy — administrator mógł zmienić je w Układaczu jawnie (przełącznik „Wpis osoby”),
// a zapis ze starego stanu nadpisałby jego zmianę. Nie w trakcie zapisu ani malowania; pól w trakcie pisania nie przebudowujemy.
// ponytail: grafik i termin zostają z pierwszego wczytania — po zmianie widać je po przeładowaniu strony
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || busy() || paint) return;
  let d;
  try { d = await load(); } catch (e) { if (e instanceof SessionError) location.reload(); return; }
  if (busy()) return; // osoba zdążyła coś zmienić — jej zmiana jest nowsza
  avail = d.avail;
  wants = onlyAsked(d.wants);
  uwagi = d.uwagi ?? {};
  if (!$('#wants').contains(document.activeElement)) renderWants();
  if (document.activeElement !== $('#comment-text')) delete $('#comment-text').dataset.month;
  render();
});

$('#me').textContent = me.name;
renderWants();
render();
