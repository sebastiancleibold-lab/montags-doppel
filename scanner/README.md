# Scanner

Eigener Dokumenten-Scanner als Web-App (PWA), läuft komplett auf dem Handy – keine Cloud, kein Konto.

- Foto aufnehmen oder importieren, Blatt wird automatisch erkannt und entzerrt (Ecken von Hand nachziehbar, mit Lupe).
- Filter: Verbessert, Graustufen, S/W, Original. Mehrere Seiten pro Dokument.
- Texterkennung (Tesseract, Deutsch) lokal im Browser: PDFs sind durchsuchbar, die Übersicht durchsucht auch den Text.
- Dateiname nach `YYYYMMDD_Titel_Betrag.pdf`, Datum/Titel/Betrag werden aus dem Beleg vorgeschlagen (München → `MUC`, Leipzig → `LPZ`).
- Unterschrift einmal hinterlegen (zeichnen oder von Papier fotografieren, Hintergrund wird entfernt). Die App sucht Felder wie „Unterschrift …“ und „Ort, Datum“ und setzt beides als Vorschlag, den man verschieben kann.
- Teilen über das Teilen-Menü (z. B. „In Dateien sichern“, Mail, Google Drive).

Bibliotheken liegen in `vendor/` (tesseract.js 5, tesseract.js-core, deu.traineddata, pdf-lib), damit nichts von fremden Servern geladen wird.
