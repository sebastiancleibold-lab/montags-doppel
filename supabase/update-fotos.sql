-- Update 24.11.2026: Fotos zu Spielergebnissen.
-- In Supabase: SQL Editor -> + New -> alles einfügen -> Run. Kann gefahrlos mehrfach ausgeführt werden.
--
-- Bilder liegen im Storage-Bucket "fotos" (öffentlich lesbar, wie die Ergebnisse).
-- Hochladen und Löschen geht nur mit Gruppen-PIN: Die App holt sich mit der PIN
-- einen einmaligen, nicht erratbaren Dateipfad, nur dorthin darf sie schreiben.

-- 1) Tabelle für die Fotos (pro Ergebnis beliebig viele, max. 12)
create table if not exists public.match_photos (
  id uuid primary key,
  match_id uuid not null references public.matches(id) on delete cascade,
  path text not null,
  thumb text not null,
  w int, h int,
  created_at timestamptz not null default now()
);
create index if not exists match_photos_match on public.match_photos(match_id);
alter table public.match_photos enable row level security;
drop policy if exists "alle lesen" on public.match_photos;
create policy "alle lesen" on public.match_photos for select to anon, authenticated using (true);
grant select on public.match_photos to anon, authenticated;

-- 2) Freigegebene Upload-/Lösch-Pfade (nur intern)
create table if not exists public.foto_slots (
  path text primary key,
  created_at timestamptz not null default now()
);
alter table public.foto_slots enable row level security;
revoke all on public.foto_slots from anon, authenticated;

create or replace function public.foto_slot_ok(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from foto_slots where path = p_name and created_at > now() - interval '30 minutes');
$$;

-- 3) Funktionen, die die App aufruft (alle mit PIN)
create or replace function public.foto_start(p_pin text, p_match_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid := gen_random_uuid();
begin
  perform require_pin(p_pin);
  if not exists (select 1 from matches where id = p_match_id) then raise exception 'Ergebnis nicht gefunden'; end if;
  if (select count(*) from match_photos where match_id = p_match_id) >= 12 then raise exception 'Maximal 12 Fotos pro Ergebnis'; end if;
  delete from foto_slots where created_at < now() - interval '1 day';
  insert into foto_slots (path) values
    (p_match_id || '/' || v_id || '.jpg'),
    (p_match_id || '/' || v_id || '_t.jpg');
  return v_id;
end $$;

create or replace function public.foto_save(p_pin text, p_id uuid, p_match_id uuid, p_w int, p_h int) returns void
language plpgsql security definer set search_path = public as $$
declare v_path text := p_match_id || '/' || p_id || '.jpg';
begin
  perform require_pin(p_pin);
  if not exists (select 1 from foto_slots where path = v_path) then raise exception 'Upload nicht freigegeben'; end if;
  insert into match_photos (id, match_id, path, thumb, w, h)
  values (p_id, p_match_id, v_path, p_match_id || '/' || p_id || '_t.jpg', p_w, p_h)
  on conflict (id) do nothing;
end $$;

create or replace function public.foto_delete(p_pin text, p_id uuid) returns text[]
language plpgsql security definer set search_path = public as $$
declare v_path text; v_thumb text;
begin
  perform require_pin(p_pin);
  delete from match_photos where id = p_id returning path, thumb into v_path, v_thumb;
  if v_path is null then return '{}'; end if;
  insert into foto_slots (path) values (v_path), (v_thumb)
  on conflict (path) do update set created_at = now();
  return array[v_path, v_thumb];
end $$;

revoke execute on function public.foto_slot_ok(text) from public;
grant execute on function public.foto_slot_ok(text) to anon, authenticated;
grant execute on function public.foto_start(text, uuid) to anon, authenticated;
grant execute on function public.foto_save(text, uuid, uuid, int, int) to anon, authenticated;
grant execute on function public.foto_delete(text, uuid) to anon, authenticated;

-- 4) Storage-Bucket "fotos": öffentlich lesbar, nur JPEG, max. 6 MB pro Datei
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fotos', 'fotos', true, 6291456, array['image/jpeg'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "fotos lesen" on storage.objects;
create policy "fotos lesen" on storage.objects for select to anon, authenticated
  using (bucket_id = 'fotos');
drop policy if exists "fotos hochladen" on storage.objects;
create policy "fotos hochladen" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'fotos' and public.foto_slot_ok(name));
drop policy if exists "fotos loeschen" on storage.objects;
create policy "fotos loeschen" on storage.objects for delete to anon, authenticated
  using (bucket_id = 'fotos' and public.foto_slot_ok(name));

notify pgrst, 'reload schema';

select 'Fotos eingerichtet' as status, (select count(*) from storage.buckets where id = 'fotos') as bucket;
