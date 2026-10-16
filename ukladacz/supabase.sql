-- Uruchom w Supabase: SQL Editor → wklej → Run (można puścić ponownie).
-- Dostęp: PIN wpisywany w aplikacji, sprawdzany tutaj (tabele są niewidoczne z zewnątrz, tylko przez funkcje poniżej).
-- Po poprawnym PIN-ie admin_login daje token sesji — przeglądarka trzyma tylko token, nie PIN.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.dyzury (
  id int primary key default 1 check (id = 1), -- jeden wspólny grafik
  data jsonb not null,
  updated_at timestamptz not null default now()
);
-- sprzątanie po wersji z logowaniem e-mailem (najpierw polityka, bo zależy od funkcji)
drop policy if exists "tylko editors" on public.dyzury;
drop function if exists public.is_editor();
drop table if exists public.editors;

create table if not exists public.access (pin text primary key);
delete from public.access where pin = '1122'; -- dawny domyślny PIN był jawny w repo
-- Brak domyślnego PIN-u: po pierwszym uruchomieniu ustaw własny (min. 4 znaki):
--   insert into public.access values ('4821');
-- Zmiana PIN-u: update public.access set pin = '4821';  (wylogowuje wszystkie sesje — trigger niżej)
alter table public.access drop constraint if exists pin_dlugi;
alter table public.access add constraint pin_dlugi check (length(pin) >= 4);

-- nieudane próby (do limitu)
create table if not exists public.pin_fails (at timestamptz not null default now());

-- sesje administratora: w przeglądarce token (losowe 32 bajty), w bazie tylko jego sha256
create table if not exists public.admin_sesje (token_hash text primary key, expires_at timestamptz not null);

alter table public.dyzury enable row level security; -- bez polityk: bezpośrednio niedostępne
alter table public.access enable row level security;
alter table public.pin_fails enable row level security;
alter table public.admin_sesje enable row level security;
revoke all on public.dyzury, public.access, public.pin_fails, public.admin_sesje from anon, authenticated;

-- każda zmiana PIN-u kończy wszystkie sesje (ktoś, kto znał stary PIN, traci dostęp)
create or replace function public.access_zmiana() returns trigger as $fn$
begin
  delete from public.admin_sesje where true;
  return null;
end $fn$ language plpgsql security definer set search_path = '';
drop trigger if exists access_zmiana on public.access;
create trigger access_zmiana after insert or update or delete on public.access for each statement execute function public.access_zmiana();
revoke execute on function public.access_zmiana() from public, anon, authenticated;

-- Błędy są zwracane jako { error }, a nie przez raise — raise cofnąłby zapis nieudanej próby.
drop function if exists public.load_state(text);
drop function if exists public.save_state(text, jsonb);
drop function if exists public.check_pin(text);
drop function if exists public.admin_login(text);
drop function if exists public.admin_logout(text);

-- p = token sesji z admin_login (64 znaki hex) albo PIN. Token nie liczy się do limitu prób (256 bitów — nie do zgadnięcia),
-- więc zalogowany administrator wczytuje i zapisuje dalej, nawet gdy ktoś wyczerpie limit złymi PIN-ami.
-- Limit: 20 nieudanych prób PIN-u na 15 minut dla wszystkich naraz; sprawdzanie po kolei (blokada), więc równoległe próby nie omijają limitu.
-- 4 cyfry przy tym limicie: zgadnięcie średnio ~2,5 doby ciągłych prób.
-- Bez pg_sleep: przerwanie zapytania (np. statement_timeout) w trakcie czekania cofnęłoby zapis nieudanej próby,
-- a poprawny PIN wracałby szybciej — limit dałoby się wtedy obejść.
-- ponytail: limit wspólny — atakujący może na 15 min zablokować logowanie (nie zalogowane sesje); limit per IP, gdyby to się zdarzało
create function public.check_pin(p text) returns text as $fn$
begin
  if p ~ '^[0-9a-f]{64}$' then
    if exists (select 1 from public.admin_sesje
               where token_hash = encode(sha256(decode(p, 'hex')), 'hex') and expires_at > now()) then return null; end if;
    return 'Sesja wygasła';
  end if;
  perform pg_advisory_xact_lock(hashtext('check_pin'));
  if (select count(*) from public.pin_fails where at > now() - interval '15 minutes') >= 20 then
    return 'Za dużo nieudanych prób. Spróbuj za 15 minut.';
  end if;
  if exists (select 1 from public.access where pin = p) then return null; end if;
  delete from public.pin_fails where at < now() - interval '1 day';
  insert into public.pin_fails default values;
  return 'Zły PIN';
end $fn$ language plpgsql security definer set search_path = '';

-- PIN → token sesji na 90 dni
create function public.admin_login(p text) returns jsonb as $fn$
declare err text; t bytea;
begin
  if p ~ '^[0-9a-f]{64}$' then return jsonb_build_object('error', 'Zły PIN'); end if; -- token nie robi nowego tokenu
  err := public.check_pin(p);
  if err is not null then return jsonb_build_object('error', err); end if;
  t := extensions.gen_random_bytes(32);
  delete from public.admin_sesje where expires_at < now();
  insert into public.admin_sesje values (encode(sha256(t), 'hex'), now() + interval '90 days');
  return jsonb_build_object('token', encode(t, 'hex'));
end $fn$ language plpgsql security definer set search_path = '';

create function public.admin_logout(t text) returns jsonb as $fn$
begin
  if t ~ '^[0-9a-f]{64}$' then delete from public.admin_sesje where token_hash = encode(sha256(decode(t, 'hex')), 'hex'); end if;
  return '{}';
end $fn$ language plpgsql security definer set search_path = '';

create function public.load_state(p text) returns jsonb as $fn$
declare err text := public.check_pin(p);
begin
  if err is not null then return jsonb_build_object('error', err); end if;
  return jsonb_build_object('data', (select data from public.dyzury where id = 1));
end $fn$ language plpgsql security definer set search_path = '';

-- Zapisy na dyżury (osobna aplikacja) zmieniają avail[pid], wants[pid] i uwagi[pid] wprost w tym wierszu i stawiają
-- data.stamps[pid] = czas zmiany. Układacz odsyła stamps takie, jakie wczytał, więc nowszy stamp w bazie
-- = osoba zmieniła coś po wczytaniu — wtedy jej avail/wants/uwagi/stamp zostają z bazy, a nie z (starszego) stanu Układacza.
-- ponytail: gdy Układacz i osoba zmienią tę samą osobę naraz, wygrywa osoba — Układacz widzi to po odświeżeniu.
create function public.save_state(p text, d jsonb) returns jsonb as $fn$
declare err text := public.check_pin(p); old jsonb; k text;
begin
  if err is not null then return jsonb_build_object('error', err); end if;
  select data into old from public.dyzury where id = 1 for update;
  for k in select jsonb_object_keys(coalesce(old->'stamps', '{}')) loop
    if d->'stamps'->>k is null or (old->'stamps'->>k)::timestamptz > (d->'stamps'->>k)::timestamptz then
      d := d || jsonb_build_object(
        'avail', coalesce(d->'avail', '{}') || jsonb_build_object(k, coalesce(old->'avail'->k, '{}')),
        'wants', coalesce(d->'wants', '{}') || jsonb_build_object(k, coalesce(old->'wants'->k, '{}')),
        'uwagi', coalesce(d->'uwagi', '{}') || jsonb_build_object(k, coalesce(old->'uwagi'->k, '{}')),
        'stamps', coalesce(d->'stamps', '{}') || jsonb_build_object(k, old->'stamps'->k));
    end if;
  end loop;
  insert into public.dyzury (id, data) values (1, d)
  on conflict (id) do update set data = excluded.data, updated_at = now();
  return '{}';
end $fn$ language plpgsql security definer set search_path = '';

revoke execute on function public.check_pin(text), public.admin_login(text), public.admin_logout(text), public.load_state(text),
  public.save_state(text, jsonb) from public, anon, authenticated; -- Supabase nadaje anon execute domyślnie
grant execute on function public.admin_login(text), public.admin_logout(text), public.load_state(text), public.save_state(text, jsonb) to anon;
