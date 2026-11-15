-- Update 15.11.2026: Spielart (Doppel/Einzel) und tatsächliche Besetzungen 28.09.–09.11.
-- In Supabase: SQL Editor -> + New -> alles einfügen -> Run.

alter table public.schedule add column if not exists typ text not null default 'doppel';
grant select on public.schedule to anon, authenticated;

-- "abgemeldet" = laut Einteilung vorgesehen, aber nicht gespielt ("Nussi" = Matthias)
update public.schedule set typ = 'einzel', spieler = '{Frank,Alex}',                       abgemeldet = '{Norbert,Matthias,Sebastian}' where datum = '2026-09-28';
update public.schedule set typ = 'doppel', spieler = '{Matthias,Sebastian,Alex,Flo}',      abgemeldet = '{Frank}'                     where datum = '2026-10-05';
update public.schedule set typ = 'einzel', spieler = '{Sebastian,Alex}',                   abgemeldet = '{Norbert,Frank}'             where datum = '2026-10-12';
update public.schedule set typ = 'doppel', spieler = '{Norbert,Matthias,Alex,Sebastian}',  abgemeldet = '{Phil}'                      where datum = '2026-10-19';
update public.schedule set typ = 'doppel', spieler = '{Sebastian,Frank,Norbert,Alex}',     abgemeldet = '{Phil,Matthias}'             where datum = '2026-10-26';
update public.schedule set typ = 'doppel', spieler = '{Sebastian,Frank,Alex,Matthias}',    abgemeldet = '{Norbert}'                   where datum = '2026-11-02';
update public.schedule set typ = 'doppel', spieler = '{Phil,Matthias,Sebastian,Norbert}',  abgemeldet = '{}'                          where datum = '2026-11-09';

notify pgrst, 'reload schema';

select datum, typ, spieler, abgemeldet from public.schedule where datum <= '2026-11-09' order by datum;
