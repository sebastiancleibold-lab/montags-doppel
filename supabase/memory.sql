-- Luises Memory: Bilderfundus in Supabase (Stand 25.11.2026).
-- In Supabase: SQL Editor -> + New -> alles einfügen -> Run. Kann gefahrlos mehrfach ausgeführt werden.
--
-- Bilder liegen im Storage-Bucket "memory" (öffentlich lesbar über nicht erratbare Links).
-- Hochladen, Zuschnitt ändern und Löschen geht nur mit der Memory-PIN (eigene PIN, nicht die Tennis-PIN).
-- PIN ändern: unten bei 'luise' eintragen und erneut ausführen, oder später:
--   update public.memory_secret set pin = 'neue-pin' where id = 1;

-- 1) PIN
create table if not exists public.memory_secret (
  id int primary key default 1 check (id = 1),
  pin text not null
);
alter table public.memory_secret enable row level security;
revoke all on public.memory_secret from anon, authenticated;
insert into public.memory_secret (id, pin) values (1, 'luise') on conflict (id) do nothing;

create or replace function public.mem_pin_ok(p_pin text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from memory_secret where lower(pin) = lower(trim(coalesce(p_pin, ''))));
$$;
create or replace function public.mem_require_pin(p_pin text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not mem_pin_ok(p_pin) then raise exception 'Falsche PIN'; end if;
end $$;

-- 2) Bilder. cx/cy = Mitte des Ausschnitts (0..1), sz = Kantenlänge des quadratischen Ausschnitts
--    als Anteil der kürzeren Bildseite (0..1). So kann der Zuschnitt jederzeit geändert werden.
create table if not exists public.memory_bilder (
  id uuid primary key,
  path text not null,
  thumb text not null,
  w int not null, h int not null,
  cx real not null default 0.5, cy real not null default 0.5, sz real not null default 1,
  created_at timestamptz not null default now()
);
alter table public.memory_bilder enable row level security;
drop policy if exists "alle lesen" on public.memory_bilder;
create policy "alle lesen" on public.memory_bilder for select to anon, authenticated using (true);
grant select on public.memory_bilder to anon, authenticated;

-- 3) Freigegebene Upload-/Lösch-Pfade (nur intern)
create table if not exists public.memory_slots (
  path text primary key,
  created_at timestamptz not null default now()
);
alter table public.memory_slots enable row level security;
revoke all on public.memory_slots from anon, authenticated;

create or replace function public.mem_slot_ok(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from memory_slots where path = p_name and created_at > now() - interval '30 minutes');
$$;

-- 4) Funktionen, die die App aufruft
create or replace function public.mem_check(p_pin text) returns boolean
language sql stable security definer set search_path = public as $$ select mem_pin_ok(p_pin); $$;

create or replace function public.mem_start(p_pin text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid := gen_random_uuid();
begin
  perform mem_require_pin(p_pin);
  if (select count(*) from memory_bilder) >= 300 then raise exception 'Maximal 300 Bilder im Fundus'; end if;
  delete from memory_slots where created_at < now() - interval '1 day';
  insert into memory_slots (path) values (v_id || '.jpg'), (v_id || '_t.jpg');
  return v_id;
end $$;

create or replace function public.mem_save(p_pin text, p_id uuid, p_w int, p_h int, p_cx real, p_cy real, p_sz real) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform mem_require_pin(p_pin);
  if not exists (select 1 from memory_slots where path = p_id || '.jpg') then raise exception 'Upload nicht freigegeben'; end if;
  insert into memory_bilder (id, path, thumb, w, h, cx, cy, sz)
  values (p_id, p_id || '.jpg', p_id || '_t.jpg', p_w, p_h, p_cx, p_cy, p_sz)
  on conflict (id) do nothing;
end $$;

create or replace function public.mem_focus(p_pin text, p_id uuid, p_cx real, p_cy real, p_sz real) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform mem_require_pin(p_pin);
  update memory_bilder set cx = p_cx, cy = p_cy, sz = p_sz where id = p_id;
end $$;

create or replace function public.mem_delete(p_pin text, p_id uuid) returns text[]
language plpgsql security definer set search_path = public as $$
declare v_path text; v_thumb text;
begin
  perform mem_require_pin(p_pin);
  delete from memory_bilder where id = p_id returning path, thumb into v_path, v_thumb;
  if v_path is null then return '{}'; end if;
  insert into memory_slots (path) values (v_path), (v_thumb)
  on conflict (path) do update set created_at = now();
  return array[v_path, v_thumb];
end $$;

revoke execute on function public.mem_pin_ok(text) from public;
revoke execute on function public.mem_require_pin(text) from public;
revoke execute on function public.mem_slot_ok(text) from public;
grant execute on function public.mem_slot_ok(text) to anon, authenticated;
grant execute on function public.mem_check(text) to anon, authenticated;
grant execute on function public.mem_start(text) to anon, authenticated;
grant execute on function public.mem_save(text, uuid, int, int, real, real, real) to anon, authenticated;
grant execute on function public.mem_focus(text, uuid, real, real, real) to anon, authenticated;
grant execute on function public.mem_delete(text, uuid) to anon, authenticated;

-- 5) Storage-Bucket "memory": öffentlich lesbar, nur JPEG, max. 4 MB pro Datei
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('memory', 'memory', true, 4194304, array['image/jpeg'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "memory lesen" on storage.objects;
create policy "memory lesen" on storage.objects for select to anon, authenticated
  using (bucket_id = 'memory');
drop policy if exists "memory hochladen" on storage.objects;
create policy "memory hochladen" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'memory' and public.mem_slot_ok(name));
drop policy if exists "memory loeschen" on storage.objects;
create policy "memory loeschen" on storage.objects for delete to anon, authenticated
  using (bucket_id = 'memory' and public.mem_slot_ok(name));

notify pgrst, 'reload schema';

select 'Memory eingerichtet' as status, (select count(*) from storage.buckets where id = 'memory') as bucket;
