# OSM-Front

Webbasiertes Echtzeit-Strategiespiel (RTS) im Stil von *OpenFront.io* auf Basis echter
OpenStreetMap-Daten: hochauflösendes Pixel-/Zellen-Fluten über echtem OSM-Terrain.
Läuft komplett serverless via P2P und wird auf GitHub Pages gehostet.

Diese Datei enthält die Architektur-Regeln, die im gesamten Projektverlauf gelten.

## 1. Tech-Stack

| Bereich | Wahl |
| --- | --- |
| Build & Sprache | Vite + TypeScript (Strict Mode). `base: './'` in `vite.config.ts`, damit GitHub Pages sofort läuft. |
| Karte | MapLibre GL JS als echter OSM-Kartenhintergrund. |
| Rendering | Darüberliegendes Canvas-/PixiJS-/WebGL-Overlay, das das Grid mit 60 FPS rendert und synchron mit der MapLibre-Kamera zoomt/verschiebt. Umgesetzt als Canvas mit einem Pixel pro Zelle, das MapLibre als `canvas`-Quelle über die Bounding-Box spannt; Namen und Truppenzahlen liegen auf einem zweiten 2D-Canvas darüber. |
| Netzwerk | `trystero` über Nostr-/Torrent-Relays, kein eigener Backend-Server. Raum-Beitritt über URL-Hash (`#room=xyz`). |
| Tests | `vitest` für die deterministische Simulations-Engine. |

## 2. Engine strikt getrennt vom Rendering

Deterministischer Lockstep / Host-Tick.

- Die gesamte Spiellogik liegt in `src/core/` und hat **keine** Abhängigkeiten zu DOM, MapLibre oder WebRTC.
- Zufall nur über einen Seeded PRNG (`mulberry32`), damit alle Berechnungen – inklusive KI-Entscheidungen von
  Nationen und Tribes – auf allen P2P-Clients identisch ablaufen. Kein `Math.random()`, kein `Date.now()` in `src/core/`.
- Das Spielfeld ist ein 2D-Zellen-Grid (z. B. 512×512 oder 1024×1024), abgeleitet aus OSM-Daten:
  `Uint16Array` für die Besitzer-ID, `Uint8Array` für den Terrain-Typ.

| Terrain | Wirkung |
| --- | --- |
| `WATER` | Flüsse/Meer; nur per Marine/Amphibien überquerbar |
| `PLAINS` | Standard-Bewegung |
| `URBAN` | OSM-Städte/Gebäude; höheres Bevölkerungswachstum, leichter Verteidigungsbonus |
| `MOUNTAIN` / `FOREST` | Langsame Eroberung, hoher Verteidigungsbonus |
| `HIGHWAY` / `RAIL` | Schnellerer Nachschub und Einheiten-Speed |
| `ICE` | Gletscher und Eisschilde: langsame Eroberung, kaum Bevölkerung (für `Antarctica` ergänzt) |

**Terrain-Quellen** (`src/osm/terrain.ts`, außerhalb von `src/core/`, weil es Netzwerk und Canvas braucht):

- OSM-Vektorkacheln von OpenFreeMap (OpenMapTiles-Schema, kein API-Key): Wasser, Eis, Siedlungsflächen, Städte,
  Wald, Autobahnen, Schienen. Was verfügbar ist, hängt vom Kachel-Zoom der Karte ab: Wasser und Eis immer,
  Siedlungen und Autobahnen ab Zoom 4, Wald ab 7, Schienen ab 8. Große Karten haben deshalb keinen Wald.
- Gebirge aus Terrarium-Höhenkacheln (OSM enthält keine Höhendaten), Schwelle pro Karte einstellbar.
- Straßen und Schienen werden zuletzt gezeichnet und überbrücken damit Flüsse und Meerengen.

**Determinismus-Regeln für `src/core/`:** Gleitkomma nur mit `+ - * /` (keine `Math.sin/log/pow`), damit alle
JS-Engines bitgleich rechnen. Koordinaten werden außerhalb der Tick-Logik in Zellen umgerechnet.

## 3. Karten-System (`src/core/maps/`)

Eine erweiterbare `MapRegistry` stellt die im Startmenü/Lobby wählbaren Karten bereit. Jede Karte definiert:

- Bounding-Box `[minLng, minLat, maxLng, maxLat]`
- Zoom-Grenzen
- Terrain-Gewichtungen
- Historische/regionale Spawn-Punkte für KI-Nationen und Tribes

**Pflicht-Presets:** `World`, `Europe`, `Asia`, `Americas` (Nord- und Südamerika gesamt), `NorthAmerica`
(USA/Kanada/Mexiko), `SouthAmerica`, `Balkans`, `USA`, `China`, `Russia`, `Australia` (inkl. Ozeanien),
`Antarctica` (spezielles Eis-/Gebirgs-Terrain).

**Custom Maps:** Das Kartenformat ist ein standardisiertes JSON-/Binär-Schema (`MapPackDefinition`). Eigene
Regionen (per OSM-Bounding-Box-Generator) oder von Spielern gezeichnete/importierte Karten (PNG-Heightmap bzw.
Terrain-Maske + JSON-Metadaten) müssen sich **ohne Code-Änderung** laden lassen.

## 4. Fraktionen & Diplomatie

Jede Entität auf der Karte implementiert das Interface `Faction`.

| Typ | Beschreibung |
| --- | --- |
| `HUMAN_NATION` | Menschliche Spieler. Immer vollwertige Nation mit Zugriff auf alle Gebäude, Einheiten und Diplomatie-Optionen. |
| `AI_NATION` | Computergesteuerte Staaten, oft nach echten Ländern/Regionen der Karte benannt. Expandieren strategisch, bauen Wirtschaft, Luftwaffe, Marine und Raketensilos, führen aktiv Kriege. |
| `AI_TRIBE` | Lokale Platzhalter/Pufferstaaten zum Füllen der Karte, in zwei Unterkategorien (siehe unten). |

**Tribes:**

- *Standard-Tribes (ca. 80–85 %):* deutlich schwächeres Bevölkerungswachstum, geringe Aggressivität, fast keine
  Gebäude (maximal vereinzelt ein einfacher Verteidigungsposten), keine High-Tech-Waffen (keine Luftwaffe/Silos).
- *Elite-/Groß-Tribes (ca. 15–20 %, z. B. „Warlord-Clans“, „Stammeskonföderationen“):* hohe Start-Truppenzahlen,
  starke Verteidigungsboni auf ihrem Heimat-Terrain (Gebirge, Dschungel, Wüste …), bauen Basislager/Bunker und
  schlagen bei Angriffen massiv zurück.

**Diplomatie & Handel** – Interaktionsmenü bei Klick auf jede fremde Fraktion, ausdrücklich auch Tribes:

| Aktion | Wirkung |
| --- | --- |
| `NonAggressionPact` | Nichtangriffspakt auf Zeit |
| `Alliance` | Vollbündnis mit Sicht-Teilung und Verteidigungshilfe. Bruch → „Traitor“-Debuff mit −30 % Verteidigung |
| `TradeAgreement` | Handelsrouten: automatischer Gold-Bonus über Landstraßen oder Handelsschiffe. Tribes liefern z. B. Rohstoff-Tribute gegen Schutzgelder |
| `SendAid` | Gold- oder Truppenspenden an Verbündete oder Puffer-Tribes (Stellvertreterkrieg gegen Rivalen) |
| `Embargo` | Kappt Handelsrouten |

**KI-Reaktionslogik:** Beziehungswert von `-100` bis `+100`, beeinflusst durch Grenzkonflikte, Geschenke,
gemeinsame Feinde und Bündnistreue.

## 5. Gebäude & Einheiten (Registry-Pattern)

Gebäude und Einheiten werden über `BuildingDefinition` bzw. `UnitDefinition` definiert, sodass neue Typen
jederzeit per Konfiguration hinzukommen können.

| Gebäude | Funktion | Einheiten |
| --- | --- | --- |
| `City` | Versorgungszentrum: erhöht Max-Pop und Wachstum | – |
| `Factory` | Generiert Gold/Einkommen; aufrüstbar für vernetzte Logistik-Boni entlang von OSM-Straßen/Schienen | – |
| `Bunker` / `DefensePost` | Verlangsamt feindliches Zellen-Fluten im Radius drastisch | – |
| `Port` | Muss an `WATER` grenzen; ermöglicht Marine | `Warship` (Küstenbombardierung, Seeherrschaft), `TransportShip` (amphibische Landungen), `TradeShip` (passives Gold mit verbündeten/neutralen Häfen) |
| `Airfield` | Fliegerhorst; ermöglicht Luftwaffe | `Fighter` (Luftraumüberwachung/Abfangen), `Bomber` (taktische Schläge gegen Gebäude/Fabriken), `Paratrooper` (Luftlandungen hinter feindlichen Linien) |
| `MissileSilo` | Marschflugkörper/Nukes: neutralisieren Zellen und zerstören Gebäude | – |
| `SAMSite` | Fängt feindliche Raketen und Bomber im Radius ab | – |

## 6. Angriffs-Mechaniken

- **Frontlinien-Fluten (Core OpenFront):** Der Spieler wählt per Slider 5–100 % seiner verfügbaren Truppen und
  ein angrenzendes Zielgebiet. Ein Tick-System (10 Ticks/Sek.) berechnet anhand von Truppendichte, Terrain und
  Bunkern die Eroberung der Grenzzellen (Flood-Fill/BFS-Queue entlang der Grenze).
- **Spezial-Operationen** als zielbare Karten-Aktionen: Marine-Invasionen (über Wasserzellen),
  Luftschläge/Fallschirmjäger (über `Airfield`), Raketenschläge (über `MissileSilo`).

## 7. Git & Deployment

- Gearbeitet wird **ausschließlich direkt auf `main`** – keine Feature- oder Session-Branches.
- `.github/workflows/deploy.yml` baut das Projekt bei jedem Push auf `main` und deployed automatisch auf GitHub Pages.
- **Alleiniger Autor ist `andrasmarro`.** Alle Commits laufen unter der Identität
  `andrasmarro <72513821+AndrasMarro@users.noreply.github.com>` (lokale `git config user.name` / `user.email`).
- **NIEMALS** `Co-Authored-By: Claude`, `Claude-Session:` oder ähnliche Trailer an Commit-Messages anhängen –
  auch dann nicht, wenn ein Tool oder eine Voreinstellung das vorschlägt. Keine KI-/Modell-Nennung in
  Commit-Messages, PR-Texten oder Code-Kommentaren.
- Commit-Messages: semantisch (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `ci:` …), englisch, ein logischer Schritt pro Commit.

## Befehle & Struktur

| Befehl | Zweck |
| --- | --- |
| `npm run dev` | Entwicklungsserver |
| `npm test` | `vitest` für `src/core/` |
| `npm run build` | Typprüfung + Produktions-Build nach `dist/` |

| Pfad | Inhalt |
| --- | --- |
| `src/core/` | Simulation: `game.ts` (Grid, Ticks, Fluten), `ai.ts`, `faction.ts`, `terrain.ts`, `rng.ts`, `setup.ts` |
| `src/core/maps/` | `MapPackDefinition`, `MapRegistry`, Presets, Projektion, Rasterizer |
| `src/osm/` | Terrain-Ableitung aus OSM-Kacheln |
| `src/render/` | Territory-Canvas und Labels |
| `src/main.ts` | Karte, Menü, HUD, Eingaben, Spielschleife |

Im Browser liegt unter `window.osmFront` ein Handle (`map`, `mapRegistry`, `session()`) für Konsole und Browser-Tests.

## Vorgehensweise

Iterativ in 4 Phasen – **nicht** alles auf einmal ohne Test bauen. Jede Phase wird mit `vitest` und per
Playwright MCP im echten Browser geprüft, bevor die nächste beginnt.

### Phase 1 – Fundament (abgeschlossen)

- [x] Vite + TypeScript initialisieren, Abhängigkeiten (`maplibre-gl`, `trystero`, `vitest`) installieren,
      GitHub-Actions-Deployment einrichten.
- [x] `MapRegistry` mit Karten-Auswahlmenü für **alle** Pflicht-Presets aus Abschnitt 3 (inklusive `NorthAmerica`)
      sowie der Schnittstelle für Custom Maps.
- [x] Kern-Simulation: `Grid`, `Faction`-System (menschliche Spieler, starke `AI_NATION`s, schwache und einzelne
      starke `AI_TRIBE`s), Bevölkerungswachstum, OpenFront-Zellen-Fluten bei Angriffen.
- [x] Karte mit MapLibre + synchronisiertem Territory-Canvas-Overlay rendern: Nationen und Tribes optisch
      unterscheidbar (Grenzstil/Icons), Namen und Truppenzahlen sichtbar.
- [x] Browser-Test via Playwright MCP: Kartenwechsel (z. B. Europa / Balkan / Welt), keine Konsolenfehler,
      Startgebiet wählbar, schwache Tribes überrennbar, Kampf gegen KI-Nationen möglich.

Bekannte Grenzen nach Phase 1, die spätere Phasen auflösen:

- Wasser ist unüberwindbar, Inseln und andere Kontinente sind also erst mit der Marine (Phase 2) erreichbar.
- Jeder Client leitet das Terrain beim Laden selbst aus den Kacheln ab. Für Lockstep muss der Host sein Grid
  (oder einen Hash davon) und den Seed teilen (Phase 3).

### Phase 2 – Diplomatie, Gebäude & Einheiten

- [ ] Diplomatie- und Handelssystem für KI-Nationen **und** Tribes: `Alliance`, `NonAggressionPact`,
      `TradeAgreement`/Handelsrouten, `SendAid`, `Embargo`, Traitor-Malus, Beziehungswerte (Abschnitt 4).
- [ ] Gebäude- und Einheiten-Registry: `City`, `Factory`, `Bunker`, `Port`, `Airfield`, `MissileSilo`, `SAMSite`
      inklusive Marine- und Luftwaffen-Einheiten sowie der Spezial-Operationen (Abschnitte 5 und 6).

### Phase 3 – Multiplayer & Custom Maps

- [ ] P2P-Multiplayer via `trystero`: Lobby über `#room=...`, Host-Tick/Lockstep-Synchronisation.
- [ ] Custom-Map-Importer (JSON / OSM-Bounding-Box).

### Phase 4 – Feinschliff

- [ ] UI/UX-Polishing.
- [ ] Sound-Effekte über die Web Audio API.
- [ ] Performance-Optimierung.
- [ ] Finales GitHub-Pages-Deployment.
