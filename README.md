# Montags-Doppel

Kleine Web-App (PWA) für unser Montags-Doppel, Wintersaison 2026/27: Ergebnisse eintragen, Tabelle, Spielplan mit Abmeldungen.

- Statische Seite (GitHub Pages), Daten in Supabase (`supabase/setup.sql`).
- Lesen ohne Login, Eintragen mit Gruppen-PIN.
- Wertung: Sieg 2 Punkte, Unentschieden 1, Niederlage 0 je Spieler; Tiebreaker Satz-, dann Spieldifferenz. Ein 3. Satz mit ≥10 Punkten gilt als Match-Tie-Break (zählt 1 Spiel).
- `config.js`: Supabase-URL und publishable/anon Key; leer = Demo-Modus.

## Weitere Apps im Repo
- `scanner/`: Dokumenten-Scanner (PWA).
- `memory/`: Luisen Memory, Bilder-Memory mit 4×5 Karten (10 Paare), jede Runde neu aus dem Bilderfundus gemischt. Fotos werden in der App hochgeladen (Supabase-Bucket `memory`, Einrichtung: `supabase/memory.sql`, eigene Memory-PIN) und automatisch auf Gesichter/Motive zugeschnitten. Elternbereich (Fundus, Statistik, Rundenzähler): Titel 2 s gedrückt halten + PIN. `?demo` = nur lokal im Browser.
