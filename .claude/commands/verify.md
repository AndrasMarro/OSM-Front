---
description: Tests, Build und Browser-Prüfung des aktuellen Features, danach CLAUDE.md aktualisieren und committen
argument-hint: "[Feature oder Bereich, der geprüft werden soll]"
---

Verifiziere den aktuellen Stand von OSM-Front. Zu prüfen: **$ARGUMENTS** (ohne Angabe: alles, was seit dem
letzten Commit geändert wurde – siehe `git status` und `git diff`).

Brich bei einem Fehler nicht ab und beschönige nichts: Ursache beheben, dann den fehlgeschlagenen Schritt
und alle folgenden wiederholen.

## 1. Tests und Build

1. `npm run test` – alle Vitest-Tests müssen grün sein. Neue Logik in `src/core/` ohne Test bekommt jetzt einen.
2. `npm run build` – Typprüfung (`tsc`, Strict Mode) und Produktions-Build ohne Fehler.

## 2. Browser-Prüfung mit Playwright MCP

1. Dev-Server im Hintergrund starten: `npm run dev -- --port 5173 --strictPort` und warten, bis er antwortet.
2. `http://localhost:5173/` öffnen, eine zum Feature passende Karte laden (`button[data-map="<id>"]`).
3. Das Feature wirklich bedienen, nicht nur ansehen. Spielzustand über `window.osmFront.session()` lesen
   (`game`, `me`, `proj`); Karten-Klicks über `page.mouse.click` an `map.project(proj.lngLat(x, y))`.
4. Prüfen und im Bericht festhalten:
   - **Funktion:** Das Feature tut, was es soll (Zustand vorher/nachher vergleichen).
   - **Rendering:** Screenshot ansehen – Territorien, Icons, Flugbahnen und HUD sind sichtbar und lesbar.
   - **Konsole:** 0 Fehler (`browser_console_messages` mit Level `error`).
5. Mehrspieler: zwei Tabs im selben Browser-Kontext mit `?net=local` (BroadcastChannel statt Relays). Im ersten
   Tab „Raum erstellen“, den Einladungslink im zweiten öffnen, als Host eine Karte starten. Beide Seiten müssen
   beim selben Tick denselben `session().game.hash()` liefern und `session().lockstep.desynced` muss `false` sein.
6. Dev-Server wieder beenden. Screenshots nicht committen (`.playwright-mcp/` ist ignoriert).

Skripte für `browser_run_code_unsafe` kurz halten (Timeout 60 s); längere Abläufe in mehrere Aufrufe teilen.

## 3. Dokumentation

`CLAUDE.md` auf den aktuellen Stand bringen: Checkboxen der Phase, neue Module in der Strukturtabelle,
geänderte Regeln oder Balancing-Entscheidungen, bekannte Grenzen. Nichts als erledigt markieren, was nicht
in Schritt 1 und 2 nachgewiesen wurde.

## 4. Commit und Push

1. Nur zusammengehörige Änderungen stagen; ein logischer Schritt pro Commit.
2. Semantische, englische Commit-Message (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `ci:` …).
3. Commit **ausschließlich** unter `andrasmarro <72513821+AndrasMarro@users.noreply.github.com>`.
   **Niemals** `Co-Authored-By`, `Claude-Session` oder andere Trailer, keine KI-/Modell-Nennung.
   Vor dem Push prüfen: `git log -1 --format='%an <%ae>%n%B'`.
4. `git push origin main` – gearbeitet wird nur auf `main`. Danach den Pages-Workflow-Lauf kontrollieren.

## Bericht

Am Ende kurz melden: Testanzahl, Build-Status, was im Browser geprüft wurde (mit Messwerten), Konsolenfehler,
Commit-Hash – und ausdrücklich, was **nicht** geprüft werden konnte.
