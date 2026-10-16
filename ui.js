// @ts-check
// Wyłącznie prezentacja. Nie odczytuje ani nie zmienia stanu grafiku.
const root = document.documentElement;
try {
  const saved = localStorage.getItem('dyzury-theme');
  if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;
} catch { /* Motyw systemowy, jeśli pamięć przeglądarki jest niedostępna. */ }

function updateColorThemeButtons() {
  const current = root.dataset.colorTheme || 'zielony';
  document.querySelectorAll('[data-color-theme-pick]').forEach((button) => button.setAttribute('aria-pressed', String(/** @type {HTMLElement} */ (button).dataset.colorThemePick === current)));
}
document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target.closest('[data-color-theme-pick]') : null;
  if (!(target instanceof HTMLElement)) return;
  const button = target;
  event.stopPropagation();
  const name = button.dataset.colorThemePick ?? 'zielony';
  if (name === 'zielony') delete root.dataset.colorTheme; else root.dataset.colorTheme = name;
  try { if (name === 'zielony') localStorage.removeItem('dyzury-color-theme'); else localStorage.setItem('dyzury-color-theme', name); } catch { /* Motyw działa bez zapisu. */ }
  updateColorThemeButtons();
}, true);

const systemTheme = matchMedia('(prefers-color-scheme: dark)');
function updateThemeButton() {
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : systemTheme.matches;
  const button = document.querySelector('#theme-toggle');
  button?.setAttribute('aria-label', dark ? 'Włącz jasny motyw' : 'Włącz ciemny motyw');
  button?.setAttribute('aria-pressed', String(dark));
}
systemTheme.addEventListener('change', updateThemeButton);
document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element) || !event.target.closest('#theme-toggle')) return;
  event.stopPropagation();
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : systemTheme.matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('dyzury-theme', root.dataset.theme); } catch { /* Motyw działa bez zapisu. */ }
  updateThemeButton();
}, true);

// Delegacja działa także po odtworzeniu DOM przez logowanie i render().
document.addEventListener('pointerdown', (event) => {
  if (!(event.target instanceof Element) || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  const bounds = button.getBoundingClientRect();
  button.style.setProperty('--ripple-x', `${event.clientX - bounds.left}px`);
  button.style.setProperty('--ripple-y', `${event.clientY - bounds.top}px`);
  button.classList.remove('rippling');
  void button.offsetWidth;
  button.classList.add('rippling');
});
// animationcancel: np. window.print() przerywa animację i animationend nie przychodzi
for (const type of ['animationend', 'animationcancel']) document.addEventListener(type, (event) => {
  if (event.target instanceof Element && 'animationName' in event && event.animationName === 'ripple') event.target.classList.remove('rippling');
});
// Dolny pasek na telefonie jak w większości aplikacji: chowa się przy przewijaniu w dół, wraca przy przewijaniu w górę,
// na samej górze i na końcu strony. Próg 8 px pomija drgania palca i „gumkę” iOS.
let lastY = scrollY, fromTab = false;
const onScroll = () => {
  const y = scrollY, dy = y - lastY;
  root.classList.toggle('scrolled', y > 16);
  if (fromTab) { fromTab = false; lastY = y; return; } // skok do zapamiętanego miejsca karty nie chowa paska, który właśnie kliknięto
  if (y < 56 || innerHeight + y >= document.documentElement.scrollHeight - 2) root.classList.remove('nav-hidden');
  else if (Math.abs(dy) > 8) root.classList.toggle('nav-hidden', dy > 0);
  else return;
  lastY = y;
};
addEventListener('scroll', onScroll, { passive: true });
document.addEventListener('click', (event) => {
  if (event.target instanceof Element && event.target.closest('.tabs, #help-open')) { fromTab = true; root.classList.remove('nav-hidden'); }
}, true);
onScroll();

// Pływające etykiety bez zmiany kontrolek i powiązanych z nimi zdarzeń.
function decorate() {
  updateThemeButton();
  updateColorThemeButtons();
  document.querySelectorAll('input[data-pn1sandwich]').forEach((input) => input.setAttribute('role', 'switch'));
  document.querySelectorAll('.field:has(select), .rule-form > label:has(select)').forEach((label) => label.classList.add('filled-select'));
}
// Obserwujemy tylko wymianę elementów i zakładkę, nie atrybuty dekorowane wyżej.
new MutationObserver(decorate).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-tab'] });
decorate();
