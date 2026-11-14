# Montags-Doppel

Kleine Web-App (PWA) für unser Montags-Doppel, Wintersaison 2026/27: Ergebnisse eintragen, Tabelle, Spielplan mit Abmeldungen.

- Statische Seite (GitHub Pages), Daten in Supabase (`supabase/setup.sql`).
- Lesen ohne Login, Eintragen mit Gruppen-PIN.
- Wertung: Sieg 2 Punkte, Unentschieden 1, Niederlage 0 je Spieler; Tiebreaker Satz-, dann Spieldifferenz. Ein 3. Satz mit ≥10 Punkten gilt als Match-Tie-Break (zählt 1 Spiel).
- `config.js`: Supabase-URL und publishable/anon Key; leer = Demo-Modus.
