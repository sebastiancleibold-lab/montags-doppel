-- Update 14.11.2026: Notizfeld "Besondere Vorkommnisse" speichern.
-- In Supabase: SQL Editor -> New query -> einfügen -> Run.
drop function if exists public.save_match(text, uuid, date, text, text, text, text, jsonb);

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

grant execute on function public.save_match(text, uuid, date, text, text, text, text, jsonb, text) to anon, authenticated;
notify pgrst, 'reload schema';
