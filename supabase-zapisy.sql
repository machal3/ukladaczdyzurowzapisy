-- Zapisy na dyżury — konta osób. Uruchom w Supabase: SQL Editor → wklej → Run (można puścić ponownie).
-- WYMAGA: supabase.sql z Układacza (tabela public.dyzury, funkcja public.check_pin) — uruchom go najpierw,
-- w wersji z save_state, które zachowuje zmiany osób (data.stamps, patrz README).
--
-- Zasada: przeglądarka osoby nigdy nie dostaje całego stanu. Funkcje poniżej wycinają z dyzury.data tylko
-- imię, nazwy miejsc, avail[pid] i wants[pid], a z gotowych miesięcy grafik (same imiona) i gównianość dni.
-- Limity, minima, warunki, korekty administratora i dane innych osób zostają w bazie.

create extension if not exists pgcrypto with schema extensions;

-- pepper do haszy PIN-ów: losowy, tylko w bazie (bez niego wyciek tabeli konta nie zdradza PIN-ów od razu)
create table if not exists public.zapisy_sekret (id int primary key default 1 check (id = 1), pepper bytea not null);
insert into public.zapisy_sekret (pepper) values (extensions.gen_random_bytes(32)) on conflict do nothing;

-- pid = person.id z dyzury.data->'people'. PIN tylko jako HMAC: logowanie samym PIN-em szuka konta po haszu,
-- więc hasz musi być deterministyczny (bcrypt z solą by tu nie zadziałał) — unique = PIN-y się nie powtarzają.
create table if not exists public.konta (
  pid text primary key,
  pin_hash text not null unique,
  created_at timestamptz not null default now(),
  last_login timestamptz,
  last_change timestamptz
);
-- sesja: w przeglądarce token (losowe 32 bajty), w bazie tylko jego sha256
create table if not exists public.sesje (
  token_hash text primary key,
  pid text not null references public.konta on delete cascade,
  expires_at timestamptz not null
);
create index if not exists sesje_pid on public.sesje (pid);
create table if not exists public.zapisy_fails (at timestamptz not null default now(), ip text not null default '');
create index if not exists zapisy_fails_at on public.zapisy_fails (at);

alter table public.zapisy_sekret enable row level security; -- bez polityk: bezpośrednio niedostępne
alter table public.konta enable row level security;
alter table public.sesje enable row level security;
alter table public.zapisy_fails enable row level security;
revoke all on public.zapisy_sekret, public.konta, public.sesje, public.zapisy_fails from anon, authenticated;

drop function if exists public.pin_hash(text);
drop function if exists public.osoba_sesja(text);
drop function if exists public.osoba_login(text);
drop function if exists public.osoba_load(text);
drop function if exists public.osoba_save(text, jsonb, jsonb);
drop function if exists public.osoba_save(text, jsonb, jsonb, jsonb);
drop function if exists public.osoba_logout(text);
drop function if exists public.admin_konta(text);
drop function if exists public.admin_set_pin(text, text, text);
drop function if exists public.admin_usun_konto(text, text);
drop function if exists public.zapisy_od(jsonb);
drop function if exists public.zapisy_od(jsonb, date);
drop function if exists public.zapisy_grafik(jsonb);

create function public.pin_hash(p text) returns text as $fn$
  select encode(extensions.hmac(convert_to(p, 'UTF8'), (select pepper from public.zapisy_sekret where id = 1), 'sha256'), 'hex')
$fn$ language sql stable security definer set search_path = '';

-- token → pid (null = brak, wygasła albo osoba usunięta w Układaczu)
create function public.osoba_sesja(t text) returns text as $fn$
declare v_pid text;
begin
  if t is null or t !~ '^[0-9a-f]{64}$' then return null; end if;
  select s.pid into v_pid from public.sesje s
    where s.token_hash = encode(sha256(decode(t, 'hex')), 'hex') and s.expires_at > now();
  if v_pid is null then return null; end if;
  if not exists (select 1 from public.dyzury d, jsonb_array_elements(d.data->'people') e
                 where d.id = 1 and e->>'id' = v_pid and not coalesce((e->>'gone')::boolean, false)) then return null; end if;
  return v_pid;
end $fn$ language plpgsql stable security definer set search_path = '';

-- Limity prób (sam PIN: ~30 kont na milion kombinacji, więc to główna ochrona):
--   5 złych prób / 15 min z jednego adresu, 100 złych prób / 24 h łącznie → logowanie wstrzymane dla wszystkich
--   (zalogowane sesje działają dalej). Próby po kolei (blokada) z 1 s przerwy po złej, więc równoległość nic nie daje.
-- Przy tych limitach trafienie czyjegoś PIN-u to ok. 100 × 30 / 10⁶ ≈ 0,3% na dobę ciągłego ataku.
-- ponytail: adres z nagłówków proxy (cf-connecting-ip / x-forwarded-for) da się czasem podrobić — dlatego twardą
-- granicą jest limit globalny — gdyby to nie wystarczało: logowanie nazwiskiem + PIN-em.
create function public.osoba_login(p text) returns jsonb as $fn$
declare
  h json := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json;
  v_ip text := coalesce(h->>'cf-connecting-ip', trim(split_part(h->>'x-forwarded-for', ',', 1)), '');
  v_pid text; v_name text; t bytea;
begin
  perform pg_advisory_xact_lock(hashtext('osoba_login'));
  if (select count(*) from public.zapisy_fails where at > now() - interval '24 hours') >= 100 then
    return jsonb_build_object('error', 'Logowanie jest chwilowo wstrzymane (za dużo nieudanych prób). Spróbuj później.');
  end if;
  if (select count(*) from public.zapisy_fails where ip = v_ip and at > now() - interval '15 minutes') >= 5 then
    return jsonb_build_object('error', 'Za dużo nieudanych prób. Spróbuj za 15 minut.');
  end if;
  if p ~ '^\d{6}$' then select k.pid into v_pid from public.konta k where k.pin_hash = public.pin_hash(p); end if;
  if v_pid is null then
    delete from public.zapisy_fails where at < now() - interval '2 days';
    insert into public.zapisy_fails (ip) values (v_ip);
    perform pg_sleep(1);
    return jsonb_build_object('error', 'Zły PIN');
  end if;
  select e->>'name' into v_name from public.dyzury d, jsonb_array_elements(d.data->'people') e
    where d.id = 1 and e->>'id' = v_pid and not coalesce((e->>'gone')::boolean, false);
  if v_name is null then return jsonb_build_object('error', 'To konto jest nieaktywne. Zapytaj osobę układającą grafik.'); end if;
  t := extensions.gen_random_bytes(32);
  delete from public.sesje where expires_at < now();
  insert into public.sesje values (encode(sha256(t), 'hex'), v_pid, now() + interval '90 days');
  update public.konta set last_login = now() where pid = v_pid;
  return jsonb_build_object('token', encode(t, 'hex'), 'name', v_name);
end $fn$ language plpgsql security definer set search_path = '';

-- Pierwszy dzień, który osoba może zmieniać: zapisy na miesiąc trwają do 20. dnia poprzedniego miesiąca włącznie
-- (czas polski), więc do 20. otwarty jest następny miesiąc, od 21. — dopiero ten po nim.
-- data.zapisyOd ('YYYY-MM') z Układacza może zamknąć więcej miesięcy.
-- Prośby (wants) nie są per miesiąc, więc obowiązują od najbliższego miesiąca — po jego terminie (od 21.) są zamknięte do 1.
create function public.zapisy_od(d jsonb, dzis date default (now() at time zone 'Europe/Warsaw')::date) returns date as $fn$
  select greatest(
    (date_trunc('month', dzis) + case when extract(day from dzis) <= 20 then interval '1 month' else interval '2 months' end)::date,
    case when d->>'zapisyOd' ~ '^\d{4}-(0[1-9]|1[0-2])$' then (d->>'zapisyOd' || '-01')::date else '-infinity'::date end)
$fn$ language sql stable set search_path = '';
revoke execute on function public.zapisy_od(jsonb, date) from public, anon, authenticated;

-- Grafik do podglądu: tylko miesiące oznaczone w Układaczu jako gotowe (data.gotowe['YYYY-MM'] = true), od 1. dnia
-- poprzedniego miesiąca, najwyżej rok naprzód. Tylko { dzień: { id miejsca: imię } } — bez dostępności, wpisów ręcznych
-- i czegokolwiek innego z grafiku.
create function public.zapisy_grafik(d jsonb) returns jsonb as $fn$
  select coalesce(jsonb_object_agg(g.key, g.day), '{}') from (
    select day.key, jsonb_object_agg(slot.key, p->>'name') as day
    from jsonb_each(coalesce(d->'schedule', '{}')) day,
      jsonb_each_text(case when jsonb_typeof(day.value) = 'object' then day.value else '{}' end) slot,
      jsonb_array_elements(coalesce(d->'people', '[]')) p,
      jsonb_array_elements(coalesce(d->'shifts', '[]')) s
    where day.key ~ '^\d{4}-\d{2}-\d{2}$' and d->'gotowe'->left(day.key, 7) = 'true'
      and day.key >= to_char(date_trunc('month', (now() at time zone 'Europe/Warsaw')::date) - interval '1 month', 'YYYY-MM-DD')
      and day.key < to_char((now() at time zone 'Europe/Warsaw')::date + 366, 'YYYY-MM-DD')
      and p->>'id' = slot.value and s->>'id' = slot.key
    group by day.key) g
$fn$ language sql stable set search_path = '';
revoke execute on function public.zapisy_grafik(jsonb) from public, anon, authenticated;

create function public.osoba_load(t text) returns jsonb as $fn$
declare v_pid text := public.osoba_sesja(t); d jsonb;
begin
  if v_pid is null then return jsonb_build_object('error', 'Sesja wygasła'); end if;
  select data into d from public.dyzury where id = 1;
  return jsonb_build_object(
    'name', (select e->>'name' from jsonb_array_elements(d->'people') e where e->>'id' = v_pid),
    'shifts', (select coalesce(jsonb_agg(jsonb_build_object('id', s->>'id', 'name', s->>'name', 'days', s->'days')), '[]')
               from jsonb_array_elements(coalesce(d->'shifts', '[]')) s),
    'avail', coalesce(d->'avail'->v_pid, '{}'),
    'wants', coalesce(d->'wants'->v_pid, '{}'),
    'uwagi', coalesce(d->'uwagi'->v_pid, '{}'),
    'od', public.zapisy_od(d),
    'prosby', public.zapisy_od(d) <= (date_trunc('month', (now() at time zone 'Europe/Warsaw')::date) + interval '1 month')::date,
    'grafik', public.zapisy_grafik(d),
    -- gównianość dni 0–3 ustawiona ręcznie w Układaczu (data.bad), tylko dni miesięcy z grafikiem do podglądu;
    -- domyślną (wg dnia tygodnia) liczy klient — badOf w kalendarz.js
    'bad', (select coalesce(jsonb_object_agg(b.key, b.value), '{}')
            from jsonb_each(case when jsonb_typeof(d->'bad') = 'object' then d->'bad' else '{}' end) b
            where b.key ~ '^\d{4}-\d{2}-\d{2}$' and d->'gotowe'->left(b.key, 7) = 'true' and b.value::text in ('0', '1', '2', '3')
              and b.key >= to_char(date_trunc('month', (now() at time zone 'Europe/Warsaw')::date) - interval '1 month', 'YYYY-MM-DD')
              and b.key < to_char((now() at time zone 'Europe/Warsaw')::date + 366, 'YYYY-MM-DD')));
end $fn$ language plpgsql stable security definer set search_path = '';

-- Zapis całej dostępności i próśb osoby. Dni przed zapisy_od zostają takie, jak były (przysłane są pomijane).
-- avail: { 'YYYY-MM-DD': 0|1|3|4 } (2 = „Mogę” = brak wpisu), najwyżej 400 dni naprzód.
-- wants: { id miejsca | '*' | we | d56 | d4 | d5 | d6: 0–31 }.
-- Prośby po terminie najbliższego miesiąca zostają takie, jak były (patrz zapisy_od).
-- c (komentarze): { 'YYYY-MM': tekst do 500 znaków } — od miesiąca zapisy_od do roku naprzód, wcześniejsze zostają.
create function public.osoba_save(t text, a jsonb, w jsonb, c jsonb) returns jsonb as $fn$
declare
  v_pid text := public.osoba_sesja(t); d jsonb; od date; k text; v jsonb; dt date;
  na jsonb := '{}'; nw jsonb := '{}'; nc jsonb := '{}'; allowed text[];
  m0 text; -- pierwszy miesiąc, którego komentarz można zmienić (jak dostępność)
  m1 text := to_char((now() at time zone 'Europe/Warsaw')::date + 366, 'YYYY-MM');
begin
  if v_pid is null then return jsonb_build_object('error', 'Sesja wygasła'); end if;
  if jsonb_typeof(a) is distinct from 'object' or jsonb_typeof(w) is distinct from 'object' or jsonb_typeof(c) is distinct from 'object' then
    return jsonb_build_object('error', 'Nieprawidłowe dane');
  end if;
  select data into d from public.dyzury where id = 1 for update; -- po kolei z zapisami Układacza
  od := public.zapisy_od(d);
  m0 := to_char(od, 'YYYY-MM');
  -- stare wpisy sprzed od zostają
  for k, v in select * from jsonb_each(coalesce(d->'avail'->v_pid, '{}')) loop
    if k < to_char(od, 'YYYY-MM-DD') then na := na || jsonb_build_object(k, v); end if;
  end loop;
  for k, v in select * from jsonb_each(a) loop
    if k !~ '^\d{4}-\d{2}-\d{2}$' then return jsonb_build_object('error', 'Nieprawidłowa data'); end if;
    begin dt := k::date; exception when others then return jsonb_build_object('error', 'Nieprawidłowa data'); end;
    if to_char(dt, 'YYYY-MM-DD') <> k or dt > od + 400 then return jsonb_build_object('error', 'Nieprawidłowa data'); end if;
    if jsonb_typeof(v) <> 'number' or v::text not in ('0', '1', '2', '3', '4') then
      return jsonb_build_object('error', 'Nieprawidłowy poziom dostępności');
    end if;
    if dt >= od and v::text <> '2' then na := na || jsonb_build_object(k, v); end if;
  end loop;
  allowed := array['*', 'we', 'd56', 'd4', 'd5', 'd6'] ||
    array(select s->>'id' from jsonb_array_elements(coalesce(d->'shifts', '[]')) s);
  if od > (date_trunc('month', (now() at time zone 'Europe/Warsaw')::date) + interval '1 month')::date then
    nw := coalesce(d->'wants'->v_pid, '{}'); -- prośby zamknięte
  else for k, v in select * from jsonb_each(w) loop
    if not k = any(allowed) then return jsonb_build_object('error', 'Nieznana prośba'); end if;
    if jsonb_typeof(v) = 'null' then continue; end if;
    if jsonb_typeof(v) <> 'number' or v::text !~ '^\d{1,2}$' or v::text::int > 31 then
      return jsonb_build_object('error', 'Prośba musi być liczbą 0–31');
    end if;
    nw := nw || jsonb_build_object(k, v);
  end loop; end if;
  for k, v in select * from jsonb_each(coalesce(d->'uwagi'->v_pid, '{}')) loop
    if k < m0 then nc := nc || jsonb_build_object(k, v); end if;
  end loop;
  for k, v in select * from jsonb_each(c) loop
    if k !~ '^\d{4}-(0[1-9]|1[0-2])$' or k > m1 then return jsonb_build_object('error', 'Nieprawidłowy miesiąc komentarza'); end if;
    if jsonb_typeof(v) <> 'string' or length(v #>> '{}') > 500 then
      return jsonb_build_object('error', 'Komentarz może mieć najwyżej 500 znaków');
    end if;
    if k >= m0 and btrim(v #>> '{}') <> '' then nc := nc || jsonb_build_object(k, v); end if;
  end loop;
  update public.dyzury set data = data
    || jsonb_build_object('avail', coalesce(data->'avail', '{}') || jsonb_build_object(v_pid, na))
    || jsonb_build_object('wants', coalesce(data->'wants', '{}') || jsonb_build_object(v_pid, nw))
    || jsonb_build_object('uwagi', coalesce(data->'uwagi', '{}') || jsonb_build_object(v_pid, nc))
    || jsonb_build_object('stamps', coalesce(data->'stamps', '{}') || jsonb_build_object(v_pid, now())),
    updated_at = now()
  where id = 1;
  update public.konta set last_change = now() where pid = v_pid;
  return '{}';
end $fn$ language plpgsql security definer set search_path = '';

create function public.osoba_logout(t text) returns jsonb as $fn$
begin
  if t ~ '^[0-9a-f]{64}$' then delete from public.sesje where token_hash = encode(sha256(decode(t, 'hex')), 'hex'); end if;
  return '{}';
end $fn$ language plpgsql security definer set search_path = '';

-- Dla Układacza (PIN administratora, ten sam limit prób co load_state/save_state)
create function public.admin_konta(p text) returns jsonb as $fn$
declare err text := public.check_pin(p);
begin
  if err is not null then return jsonb_build_object('error', err); end if;
  return jsonb_build_object(
    'konta', (select coalesce(jsonb_agg(jsonb_build_object('pid', pid, 'created_at', created_at, 'last_login', last_login, 'last_change', last_change)), '[]') from public.konta),
    'fails24h', (select count(*) from public.zapisy_fails where at > now() - interval '24 hours'));
end $fn$ language plpgsql security definer set search_path = '';

-- Nadaje (albo zmienia) PIN osoby — stare sesje tej osoby przestają działać
create function public.admin_set_pin(p text, osoba text, nowy text) returns jsonb as $fn$
declare err text := public.check_pin(p);
begin
  if err is not null then return jsonb_build_object('error', err); end if;
  if nowy !~ '^\d{6}$' then return jsonb_build_object('error', 'PIN musi mieć 6 cyfr'); end if;
  if not exists (select 1 from public.dyzury d, jsonb_array_elements(d.data->'people') e where d.id = 1 and e->>'id' = osoba) then
    return jsonb_build_object('error', 'Nie ma takiej osoby');
  end if;
  if exists (select 1 from public.konta where pin_hash = public.pin_hash(nowy) and pid <> osoba) then
    return jsonb_build_object('error', 'Ten PIN jest już zajęty — wylosuj inny');
  end if;
  insert into public.konta (pid, pin_hash) values (osoba, public.pin_hash(nowy))
    on conflict (pid) do update set pin_hash = excluded.pin_hash;
  delete from public.sesje where pid = osoba;
  return '{}';
end $fn$ language plpgsql security definer set search_path = '';

create function public.admin_usun_konto(p text, osoba text) returns jsonb as $fn$
declare err text := public.check_pin(p);
begin
  if err is not null then return jsonb_build_object('error', err); end if;
  delete from public.konta where pid = osoba; -- sesje znikają kaskadowo
  return '{}';
end $fn$ language plpgsql security definer set search_path = '';

revoke execute on function public.pin_hash(text), public.osoba_sesja(text), public.osoba_login(text), public.osoba_load(text),
  public.osoba_save(text, jsonb, jsonb, jsonb), public.osoba_logout(text), public.admin_konta(text), public.admin_set_pin(text, text, text),
  public.admin_usun_konto(text, text) from public, anon, authenticated; -- Supabase nadaje anon/authenticated execute domyślnie
grant execute on function public.osoba_login(text), public.osoba_load(text), public.osoba_save(text, jsonb, jsonb, jsonb), public.osoba_logout(text),
  public.admin_konta(text), public.admin_set_pin(text, text, text), public.admin_usun_konto(text, text) to anon;
