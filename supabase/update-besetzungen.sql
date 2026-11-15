-- Update 15.11.2026: Spielart (Doppel/Einzel) und tatsächliche Besetzungen 28.09.–09.11.
-- In Supabase: SQL Editor -> + New -> alles einfügen -> Run.

alter table public.schedule add column if not exists typ text not null default 'doppel';
grant select on public.schedule to anon, authenticated;

-- Matthias heißt in der App ab jetzt überall "Nussi" (Spielplan und bereits eingetragene Ergebnisse)
update public.schedule set spieler = array_replace(spieler, 'Matthias', 'Nussi'), abgemeldet = array_replace(abgemeldet, 'Matthias', 'Nussi');
update public.matches set a1 = 'Nussi' where a1 = 'Matthias';
update public.matches set a2 = 'Nussi' where a2 = 'Matthias';
update public.matches set b1 = 'Nussi' where b1 = 'Matthias';
update public.matches set b2 = 'Nussi' where b2 = 'Matthias';

-- "abgemeldet" = laut Einteilung vorgesehen, aber nicht gespielt ("Nussi" = Matthias)
update public.schedule set typ = 'einzel', spieler = '{Frank,Alex}',                       abgemeldet = '{Norbert,Nussi,Sebastian}' where datum = '2026-09-28';
update public.schedule set typ = 'doppel', spieler = '{Nussi,Sebastian,Alex,Flo}',      abgemeldet = '{Frank}'                     where datum = '2026-10-05';
update public.schedule set typ = 'einzel', spieler = '{Sebastian,Alex}',                   abgemeldet = '{Norbert,Frank}'             where datum = '2026-10-12';
update public.schedule set typ = 'doppel', spieler = '{Norbert,Nussi,Alex,Sebastian}',  abgemeldet = '{Phil}'                      where datum = '2026-10-19';
update public.schedule set typ = 'doppel', spieler = '{Sebastian,Frank,Norbert,Alex}',     abgemeldet = '{Phil,Nussi}'             where datum = '2026-10-26';
update public.schedule set typ = 'doppel', spieler = '{Sebastian,Frank,Alex,Nussi}',    abgemeldet = '{Norbert}'                   where datum = '2026-11-02';
update public.schedule set typ = 'doppel', spieler = '{Phil,Nussi,Sebastian,Norbert}',  abgemeldet = '{}'                          where datum = '2026-11-09';

notify pgrst, 'reload schema';

select datum, typ, spieler, abgemeldet from public.schedule where datum <= '2026-11-09' order by datum;
