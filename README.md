# Stundenplan 2026/27

Wochenansicht meines WebUntis-Stundenplans – mit Entfällen, Vertretungen, Prüfungen und Ferien.
Die Seite liest nur `timetable.json`; es gibt keinen Zugriff auf WebUntis.

## Aktualisieren

1. In WebUntis einloggen, F12 drücken → Tab **Konsole** → Inhalt von [`export.js`](export.js) einfügen → Enter.
2. Nach ca. 20 Sekunden wird `timetable.json` heruntergeladen.
3. Hier im Repo **Add file → Upload files** → die neue `timetable.json` hochladen → **Commit changes**.
   Nach ca. 1 Minute ist die Seite aktuell.

Ausgeblendete Fächer stehen oben in `export.js` (`HIDDEN_SUBJECTS`).
