-- Uruchom w Supabase: SQL Editor → wklej → Run (można puścić ponownie).
-- Dostęp: PIN wpisywany w aplikacji, sprawdzany tutaj (tabele są niewidoczne z zewnątrz, tylko przez funkcje poniżej).

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
-- Zmiana PIN-u: update public.access set pin = '4821';
alter table public.access drop constraint if exists pin_dlugi;
alter table public.access add constraint pin_dlugi check (length(pin) >= 4);

-- nieudane próby (do limitu)
create table if not exists public.pin_fails (at timestamptz not null default now());

alter table public.dyzury enable row level security; -- bez polityk: bezpośrednio niedostępne
alter table public.access enable row level security;
alter table public.pin_fails enable row level security;
revoke all on public.dyzury, public.access, public.pin_fails from anon, authenticated;

-- Błędy są zwracane jako { error }, a nie przez raise — raise cofnąłby zapis nieudanej próby.
drop function if exists public.load_state(text);
drop function if exists public.save_state(text, jsonb);
drop function if exists public.check_pin(text);

-- Limit: 20 nieudanych prób na 15 minut dla wszystkich naraz; sprawdzanie po kolei (blokada), więc równoległe próby nie omijają limitu.
-- 4 cyfry przy tym limicie: zgadnięcie średnio ~2,5 doby ciągłych prób.
-- ponytail: limit wspólny — atakujący może na 15 min zablokować też prawowitych użytkowników; limit per IP, gdyby to się zdarzało
create function public.check_pin(p text) returns text as $fn$
begin
  perform pg_advisory_xact_lock(hashtext('check_pin'));
  if (select count(*) from public.pin_fails where at > now() - interval '15 minutes') >= 20 then
    return 'Za dużo nieudanych prób. Spróbuj za 15 minut.';
  end if;
  if exists (select 1 from public.access where pin = p) then return null; end if;
  delete from public.pin_fails where at < now() - interval '1 day';
  insert into public.pin_fails default values;
  perform pg_sleep(1);
  return 'Zły PIN';
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

revoke execute on function public.check_pin(text), public.load_state(text), public.save_state(text, jsonb) from public, anon, authenticated; -- Supabase nadaje anon execute domyślnie
grant execute on function public.load_state(text), public.save_state(text, jsonb) to anon;
