-- Montags-Doppel: Datenbank einrichten
-- In Supabase: SQL Editor -> New query -> alles einfügen -> Run.
-- Vorher unten die PIN ('aufschlag') auf eure Gruppen-PIN ändern.

create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  datum date not null,
  a1 text not null, a2 text not null,
  b1 text not null, b2 text not null,
  sets jsonb not null,
  notiz text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.schedule (
  datum date primary key,
  spieler text[] not null default '{}',
  abgemeldet text[] not null default '{}',
  typ text not null default 'doppel'
);

create table if not exists public.app_secret (
  id int primary key default 1 check (id = 1),
  pin text not null
);

alter table public.matches enable row level security;
alter table public.schedule enable row level security;
alter table public.app_secret enable row level security;

-- Lesen darf jeder mit dem Link, schreiben nur über die Funktionen unten (mit PIN).
drop policy if exists "alle lesen" on public.matches;
create policy "alle lesen" on public.matches for select to anon, authenticated using (true);
drop policy if exists "alle lesen" on public.schedule;
create policy "alle lesen" on public.schedule for select to anon, authenticated using (true);
grant select on public.matches, public.schedule to anon, authenticated;
revoke all on public.app_secret from anon, authenticated;

create or replace function public.pin_ok(p_pin text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_secret where lower(pin) = lower(trim(coalesce(p_pin, ''))));
$$;

create or replace function public.require_pin(p_pin text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not pin_ok(p_pin) then raise exception 'Falsche PIN'; end if;
end $$;

create or replace function public.save_match(
  p_pin text, p_id uuid, p_datum date,
  p_a1 text, p_a2 text, p_b1 text, p_b2 text, p_sets jsonb,
  p_notiz text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform require_pin(p_pin);
  if p_id is null then
    insert into matches (datum, a1, a2, b1, b2, sets, notiz)
    values (p_datum, p_a1, p_a2, p_b1, p_b2, p_sets, nullif(trim(p_notiz), '')) returning id into v_id;
  else
    update matches set datum = p_datum, a1 = p_a1, a2 = p_a2, b1 = p_b1, b2 = p_b2,
      sets = p_sets, notiz = nullif(trim(p_notiz), ''), updated_at = now() where id = p_id returning id into v_id;
  end if;
  return v_id;
end $$;

create or replace function public.delete_match(p_pin text, p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_pin(p_pin);
  delete from matches where id = p_id;
end $$;

create or replace function public.save_day(p_pin text, p_datum date, p_spieler text[], p_abgemeldet text[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_pin(p_pin);
  insert into schedule (datum, spieler, abgemeldet) values (p_datum, p_spieler, p_abgemeldet)
  on conflict (datum) do update set spieler = excluded.spieler, abgemeldet = excluded.abgemeldet;
end $$;

revoke execute on function public.require_pin(text) from public, anon, authenticated;
grant execute on function public.pin_ok(text) to anon, authenticated;
grant execute on function public.save_match(text, uuid, date, text, text, text, text, jsonb, text) to anon, authenticated;
grant execute on function public.delete_match(text, uuid) to anon, authenticated;
grant execute on function public.save_day(text, date, text[], text[]) to anon, authenticated;

-- >>> Gruppen-PIN hier festlegen <<<
insert into public.app_secret (id, pin) values (1, 'aufschlag')
on conflict (id) do update set pin = excluded.pin;

-- Spielplan Wintersaison 2026/27 (aus der Excel-Einteilung)
insert into public.schedule (datum, spieler) values
('2026-09-28','{Norbert,Nussi,Sebastian,Frank}'),
('2026-10-05','{Nussi,Sebastian,Frank,Alex}'),
('2026-10-12','{Norbert,Sebastian,Frank,Alex}'),
('2026-10-19','{Norbert,Phil,Nussi,Alex}'),
('2026-10-26','{Phil,Nussi,Sebastian,Frank}'),
('2026-11-02','{Norbert,Sebastian,Frank,Alex}'),
('2026-11-09','{Norbert,Phil,Nussi,Sebastian}'),
('2026-11-16','{Phil,Nussi,Frank,Alex}'),
('2026-11-23','{Norbert,Phil,Sebastian,Alex}'),
('2026-11-30','{Norbert,Nussi,Sebastian,Frank}'),
('2026-12-07','{Phil,Nussi,Frank,Alex}'),
('2026-12-14','{Norbert,Phil,Sebastian,Alex}'),
('2026-12-21','{Norbert,Nussi,Frank,Alex}'),
('2026-12-28','{Norbert,Phil,Sebastian,Frank}'),
('2027-01-04','{Phil,Nussi,Sebastian,Alex}'),
('2027-01-11','{Norbert,Nussi,Sebastian,Frank}'),
('2027-01-18','{Phil,Nussi,Sebastian,Alex}'),
('2027-01-25','{Norbert,Phil,Nussi,Frank}'),
('2027-02-01','{Norbert,Sebastian,Frank,Alex}'),
('2027-02-08','{Norbert,Phil,Nussi,Sebastian}'),
('2027-02-15','{Phil,Nussi,Frank,Alex}'),
('2027-02-22','{Norbert,Sebastian,Frank,Alex}'),
('2027-03-01','{Phil,Nussi,Sebastian,Frank}'),
('2027-03-08','{Norbert,Phil,Nussi,Alex}'),
('2027-03-15','{Norbert,Nussi,Sebastian,Frank}'),
('2027-03-22','{Phil,Sebastian,Frank,Alex}'),
('2027-03-29','{Norbert,Nussi,Sebastian,Alex}'),
('2027-04-05','{Norbert,Phil,Frank,Alex}'),
('2027-04-12','{Nussi,Sebastian,Frank,Alex}'),
('2027-04-19','{Norbert,Phil,Nussi,Sebastian}')
on conflict (datum) do nothing;
