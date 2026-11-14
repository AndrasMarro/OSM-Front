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
  Siedlungen und Autobahnen ab Zoom 4, Wald ab 7, Schienen ab 8.
- Gebirge aus Terrarium-Höhenkacheln (OSM enthält keine Höhendaten), Schwelle pro Karte einstellbar.
- Straßen und Schienen werden zuletzt gezeichnet und überbrücken damit Flüsse und Meerengen.
- **Synthese unterhalb dieser Zooms** (`src/core/maps/synth.ts`, deterministisch, ohne Zufall): Wald aus einem
  Biom-Modell (Breitengrad-Dichte × Value-Noise, Vorberge dichter bewaldet) und Schienen als Achsen zwischen den
  Hauptstädten der Karte und den größten OSM-Städten (Dijkstra über das Grid; Wasser nur für kurze Brücken,
  bestehende Autobahnbrücken werden genutzt). Damit haben alle 12 Presets `FOREST` und `RAIL`.

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

**Eigene Nation (`src/core/nation.ts`, `src/ui/nation-editor.ts`):** Spieler gestalten vor dem Start ein
`NationProfile` – Nations- und Herrschername, Gebiets- und Grenzfarbe, Flagge (Vorlage, drei Farben, Emblem) und
Doktrin. Es liegt im `localStorage`, geht per `hello` an die Lobby und mit dem `spawn`-Kommando ins Spiel;
`sanitizeNation()` bereinigt es auf jedem Peer gleich. Doktrinen sind Daten in `doctrineRegistry`, die Engine
liest nur ihre Zahlen:

| Doktrin | Bonus |
| --- | --- |
| Industriemacht | +15 % Fabrik-Einkommen |
| Seemacht | Küstengebäude (Hafen) und Schiffe 20 % günstiger |
| Festungsdoktrin | Verteidigungsbonus eigener Bunker ×1,2 |
| Expansionsdrang | +10 % Bevölkerungswachstum |

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

**Umsetzung (`src/core/diplomacy.ts`):** Status je Paar ist `War`, `Neutral`, `NonAggressionPact` oder `Alliance`.

- Ein Angebot wird angenommen, wenn `Beziehung ± Stärke (+15 / −15) + 20 je gemeinsamem Feind (max. 40)
  − 40 für Verräter − 30 im Krieg` die Schwelle erreicht: Handel 0, Pakt 10, Bündnis 50; Elite-Tribes +10,
  dazu `(Aggression − 50) / 5` bei Pakt und Bündnis. Rein deterministisch, kein Zufall.
- Krieg entsteht durch jede feindliche Handlung (Angriff, Landung, Beschuss) und endet 60 s nach der letzten.
  Verbündete des Opfers treten ein; Nationen, die mit einem angegriffenen Tribe handeln, nehmen es übel.
- Pakt: 120 s. Wer ihn bricht, verliert Ansehen (−30 beim Partner, −10 bei allen).
- Bündnisbruch: Traitor-Malus, 60 s lang nur 70 % Verteidigung, −25 Beziehung bei allen Fraktionen.
- Handel: 0,2 Gold/Tick je Seite; ein Tribe zahlt einer Nation das 1,5-Fache als Tribut und verteidigt dafür
  15 % besser. `SendAid`: bis +15 Beziehung je Geschenk (1 je 20 Gold bzw. 100 Truppen).

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

**Umsetzung:** `Registry<T>` (`src/core/registry.ts`) mit den Instanzen `buildingRegistry`
(`src/core/buildings.ts`) und `unitRegistry` (`src/core/units.ts`). Die Engine fragt nie nach einer ID, sondern
liest optionale Felder der Definition – ein neuer Typ ist ein `register({...})`-Aufruf (siehe `/add-content`).

| Feld | Wirkung | Standardwerte |
| --- | --- | --- |
| `capacity`, `growthPct` | Max-Pop und Wachstum | `City`: +2500, +15 % |
| `income`, `linkBonusPct` | Gold/Tick; Bonus bei Straßen-/Schienenanschluss an eine eigene oder verbündete Stadt | `Factory`: 0,4, +50 % |
| `fort` | Verteidigungsbonus und Verzögerung im Radius | `Bunker`: Radius 6, +200 %, +4 Ticks |
| `coastal` | muss an `WATER` grenzen | `Port` |
| `intercept` | schießt fliegende Einheiten im Radius ab, mit Nachladezeit | `SAMSite`: Radius 14, 8 s, 100 %; `Fighter`: Radius 18, 6 s, 60 % |
| `carriesTroops` | landet den gewählten Truppenanteil am Ziel an | `TransportShip`, `Paratrooper` (Reichweite 70) |
| `blast` | Gebäudeschaden, Truppenverlust, optional Neutralisierung + 60 s Verstrahlung | `Bomber`, `Missile`, `Nuke` (Radius 12) |
| `guns` | Patrouille: beschießt feindliche Schiffe und Küsten | `Warship` |
| `trade` | pendelt zum nächsten fremden Hafen, Gold an beide Enden | `TradeShip` |

Gebäudepreise steigen je weiterem Gebäude desselben Typs um die Hälfte des Grundpreises. Eroberte Zellen
übergeben ihr Gebäude dem Eroberer. Gold: Nationen 0,5/Tick + 0,0015 je Zelle (Tribes deutlich weniger).

**KI-Verhalten (`src/core/ai.ts`):** Standard-Tribes bauen selten einen einzelnen Bunker, Elite-Tribes bis zu fünf
Bunker/Städte, Nationen arbeiten die Wunschliste `NATION_WISHES` ab, stationieren Jäger, schicken Handels- und
Kriegsschiffe, landen an feindlichen Küsten bzw. auf freien Inseln und setzen Bomber, Raketen und Nukes gegen
ihren Kriegsgegner ein – höchstens ein Schlag je 10 s und ein Atomschlag je 60 s pro Nation, damit ein
angespartes Vermögen nicht als eine Salve ankommt und SAM-Stellungen nachladen können.

## 6. Angriffs-Mechaniken

- **Frontlinien-Fluten (Core OpenFront):** Der Spieler wählt per Slider 5–100 % seiner verfügbaren Truppen und
  ein angrenzendes Zielgebiet. Ein Tick-System (10 Ticks/Sek.) berechnet anhand von Truppendichte, Terrain und
  Bunkern die Eroberung der Grenzzellen (Flood-Fill/BFS-Queue entlang der Grenze).
- **Spezial-Operationen** als zielbare Karten-Aktionen: Marine-Invasionen (über Wasserzellen),
  Luftschläge/Fallschirmjäger (über `Airfield`), Raketenschläge (über `MissileSilo`).
- **Truppen-Sammelpunkt:** ein Punkt auf eigenem Gebiet (Kommando `rally`); im Umkreis von 8 Zellen kostet
  eigenes Land den Angreifer 50 % mehr, solange der Punkt selbst gehalten wird.

**Bedienung (`src/main.ts`, `src/ui/`):**

- **Linksklick = Sofort-Aktion** (kein Pop-up): Startgebiet wählen; danach Bodenangriff auf angrenzendes freies
  Land oder die angeklickte Nachbarfraktion mit dem unten eingestellten Truppenanteil. Im Bau-/Zielmodus platziert
  bzw. feuert er. Auf eigenem Gebiet schließt er Menüs und wählt ein Gebäude an. Besteht ein Pakt oder Bündnis,
  greift der Linksklick **nicht** an – ein Vertragsbruch geht nur über das Radialmenü.
- **Rechtsklick** öffnet am Mauszeiger das Radialmenü (`radial.ts`): auf eigenem Gebiet Bau-Rad, Sammelpunkt und
  stationierte Einheiten; auf fremdem Gebiet Bodenangriff, Schiffe, Luftwaffe, Raketen und das Diplomatie-Untermenü;
  auf Wasser Kriegsschiff und See-Invasion. Im Bau-/Zielmodus bricht er stattdessen den Modus ab.
- **Truppenanteil:** Regler unten über der Hotkey-Leiste; `Q`/`A` −10 %, `E`/`D` +10 %, Mausrad über dem Regler
  oder Umschalt + Mausrad ±5 %. Ohne Umschalt zoomt das Mausrad die Karte.
- **Kamera:** Links-Ziehen oder Mitteltaste-Ziehen verschiebt die Karte; erst unter 5 px Bewegung gilt ein Klick.
- **Hotkeys:** `1`–`7` wählen ein Gebäude (Reihenfolge der `buildingRegistry`), `8`/`9` Bomber und Rakete;
  `ESC` oder Rechtsklick verlässt den Modus.
- **Bau-Ghost:** folgt dem Mauszeiger, zeigt Icon, Radien (Verteidigung, Abfangen, Reichweite der dort
  stationierten Einheiten, Wirkungsradius) und bei Fabriken die Linie zur angeschlossenen Stadt; grün, wenn
  `canBuild()` zustimmt, sonst rot mit Grund am Cursor.
- **Start-Bildschirm:** drei Schritte über der gedimmten, langsam driftenden Karte – Nations-Kachel mit
  „Nation anpassen“ (Editor als Dialog), Karten-Kacheln in den Tabs „Welt & Kontinente“, „Regionen & Länder“,
  „Eigene Karten“ samt vier Schwierigkeits-Knöpfen (bewusst ohne Erklärtext), darunter „Einzelspieler starten“,
  „Mehrspieler-Lobby“ (Dialog) und „Tutorial spielen“. Eine Kachel wählt nur aus; gestartet wird mit dem Hauptknopf.
- **Tutorial (`src/ui/tutorial.ts`):** Zustandsautomat ohne DOM mit sechs Schritten (Start, Angriff, Wirtschaft,
  Diplomatie, Verteidigung, Abschluss). Er sieht das Ergebnis jedes eigenen Kommandos und schaltet nur weiter,
  wenn die verlangte Aktion wirklich ausgeführt wurde. Läuft auf dem Balkan auf „Leicht“, nur im Einzelspiel;
  dort darf `main.ts` die Bühne direkt bereiten (Startgold, ein „Übungsstamm“ als Nachbar).
- **Alarme:** oben mittig je Bedrohung ein Knopf (Bodenoffensive, Landung, Luftangriff, Rakete) mit Richtungspfeil;
  ein Klick zentriert die Karte auf die Front bzw. das Ziel.
- **Cursor (`cursors.ts`):** `default`, `attack` (angrenzender Gegner), `landing` (fremde Küste bei eigenem Hafen),
  `build`, `target`. Der aktuelle Zustand steht auch in `canvas.dataset.cursor`.

## 7. Git & Deployment

- Gearbeitet wird **ausschließlich direkt auf `main`** – keine Feature- oder Session-Branches.
- `.github/workflows/deploy.yml` baut das Projekt bei jedem Push auf `main` und deployed automatisch auf GitHub Pages.
- **Alleiniger Autor ist `andrasmarro`.** Alle Commits laufen unter der Identität
  `andrasmarro <72513821+AndrasMarro@users.noreply.github.com>` (lokale `git config user.name` / `user.email`).
- **NIEMALS** `Co-Authored-By: Claude`, `Claude-Session:` oder ähnliche Trailer an Commit-Messages anhängen –
  auch dann nicht, wenn ein Tool oder eine Voreinstellung das vorschlägt. Keine KI-/Modell-Nennung in
  Commit-Messages, PR-Texten oder Code-Kommentaren.
- Commit-Messages: semantisch (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `ci:` …), englisch, ein logischer Schritt pro Commit.

## 8. Multiplayer & Custom Maps

**Host-Tick-Lockstep (`src/net/`):** Alle Peers rechnen dasselbe deterministische Spiel.

- Spieler ändern das Spiel ausschließlich über `Command`s (`src/core/commands.ts`): schlichtes JSON, das
  `execute()` prüft und ausführt. Ungültiges wird abgelehnt, nie geworfen – Kommandos kommen von fremden Rechnern.
- Clients senden Kommandos an den Host. Nur der Host ordnet sie in nummerierte **Turns** (Kommandos + Anzahl
  Ticks) und verteilt diese; alle führen sie in derselben Reihenfolge aus (`Lockstep`). Ein Spiel ohne Netz ist
  derselbe Ablauf mit einem Host ohne Peers.
- Der Host verschickt sein Terrain-Grid, die Karte und den Seed; kein Client leitet eigenes Terrain ab.
- Alle 50 Ticks trägt ein Turn den Zustands-Hash des Hosts (`Game.hash()`). Weicht ein Client ab oder fehlt ein
  Turn, hält er an und meldet den Synchronisationsverlust.
- Die Welt steht, bis alle im Raum ihr Startgebiet gewählt haben (höchstens 30 s).
- Die Spieluhr läuft in einem Worker, damit ein Host im Hintergrund-Tab das Spiel nicht einfriert.
- `Transport` ist eine Schnittstelle: `trystero` (WebRTC, Vermittlung über öffentliche Nostr-Relays) oder mit
  `?net=local` ein `BroadcastChannel` zwischen Tabs desselben Browsers – für Entwicklung und Browser-Tests.

**Lobby:** „Raum erstellen“ setzt `#room=<id>`; wer den Link öffnet, tritt bei. Host ist, wer den Raum eröffnet
hat (in `sessionStorage` gemerkt, überlebt einen Reload); nur er wählt die Karte. Verträge zwischen Spielern
laufen über Angebote, die der Empfänger im HUD annimmt – so erreichen auch KI-Angebote den Spieler.
Die Lobby zeigt jeden Spieler mit Flagge, Herrscher- und Nationsnamen.

**Custom Maps (`src/ui/custom-maps.ts`, `src/core/maps/custom.ts`):**

- *Bounding-Box:* Ausschnitt eintippen oder auf der Karte wählen; `packFromBBox()` erzeugt daraus ein
  `MapPackDefinition` mit OSM-Terrain, den Hauptstädten des Katalogs im Ausschnitt und zufälligen Tribes.
- *Export/Import:* „Karte exportieren“ schreibt das Pack als JSON, das Terrain steckt als PNG-Maske
  (`terrain: { type: 'mask' }`, Rotkanal = Terrain-ID) darin. Der Import prüft die Datei mit `validateMapPack()`.
- Eigene Karten liegen im `localStorage` des Browsers.

## Befehle & Struktur

| Befehl | Zweck |
| --- | --- |
| `npm run dev` | Entwicklungsserver |
| `npm test` | `vitest` für `src/core/` |
| `npm run build` | Typprüfung + Produktions-Build nach `dist/` |

| Pfad | Inhalt |
| --- | --- |
| `src/core/` | Simulation: `game.ts` (Grid, Ticks, Fluten, Landungen, Hash), `commands.ts`, `diplomacy.ts`, `buildings.ts`, `units.ts`, `nation.ts` (Profil, Doktrinen), `registry.ts`, `ai.ts`, `faction.ts`, `terrain.ts`, `rng.ts`, `setup.ts`, `testkit.ts` (Test-Helfer) |
| `src/core/maps/` | `MapPackDefinition`, `MapRegistry`, Presets, Projektion, Rasterizer, `synth.ts` (Wald/Schiene), `custom.ts` (Karte aus Bounding-Box) |
| `src/net/` | `lockstep.ts` (Host-Tick), `transport.ts` (trystero / BroadcastChannel), `lobby.ts` (Raum, Host, Namen) |
| `src/osm/` | Terrain-Ableitung aus OSM-Kacheln und aus PNG-Masken |
| `src/render/` | Territory-Canvas, Labels, `flag.ts` (Flaggen), `overlay.ts` (Gebäude-Icons, Einheiten, Flugbahnen, Effekte, Fronten, Gefahrenzonen, Bau-Ghost) |
| `src/ui/` | `nation-editor.ts`, `radial.ts` (Kontextmenü), `cursors.ts`, `sound.ts` (Web-Audio-Effekte), `tutorial.ts` (Zustandsautomat des Tutorials), `custom-maps.ts` (Bounding-Box-Formular, JSON-Import/-Export) |
| `src/main.ts` | Karte, Start-Bildschirm, Lobby, HUD, Maus- und Tastensteuerung, Radialmenü, Tutorial-Führung, Alarme, Angebote, Spielschleife |
| `.claude/commands/` | Projekt-Skills: `/verify` (Tests, Build, Browser, Doku, Commit) und `/add-content` (neue Gebäude/Einheiten/Karten) |

Im Browser liegt unter `window.osmFront` ein Handle (`map`, `mapRegistry`, `session()`, `lobby()`) für Konsole und
Browser-Tests. `session()` liefert u. a. `game`, `proj`, `pack`, `lockstep` und `me` (die eigene Fraktion);
`mode()` und `ghost()` zeigen Bau-/Zielmodus und Vorschau, `sounds` listet die zuletzt ausgelösten Effekte,
`tutorial()` den Schritt des laufenden Tutorials.

## Vorgehensweise

Iterativ in 6 Phasen – **nicht** alles auf einmal ohne Test bauen. Jede Phase wird mit `vitest` und per
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
- Jeder Client leitet das Terrain beim Laden selbst aus den Kacheln ab (gelöst in Phase 3: der Host teilt Grid
  und Seed).

### Phase 2 – Diplomatie, Gebäude & Einheiten (abgeschlossen)

- [x] Diplomatie- und Handelssystem für KI-Nationen **und** Tribes: `Alliance`, `NonAggressionPact`,
      `TradeAgreement`/Handelsrouten, `SendAid`, `Embargo`, Traitor-Malus, Beziehungswerte (Abschnitt 4).
- [x] Gebäude- und Einheiten-Registry: `City`, `Factory`, `Bunker`, `Port`, `Airfield`, `MissileSilo`, `SAMSite`
      inklusive Marine- und Luftwaffen-Einheiten sowie der Spezial-Operationen (Abschnitte 5 und 6).
- [x] Terrain: Wald- und Schienen-Synthese für Karten unterhalb von Kachel-Zoom 7/8, zwei Antarktis-Stationen
      auf Land verschoben, Europa-Südkante angehoben (Rabat lag auf der letzten Zeile).
- [x] HUD (Gold, Einkommen/Tick, Bevölkerung, Bündnisse/Pakte/Handel/Kriege), Gebäude-Icons, Routen und
      Flugbahnen, Explosions- und Abfang-Effekte, Baumenü und Zielauswahl.
- [x] Geprüft mit 51 Vitest-Tests und im Browser (Balkan): Hafen gebaut, See-Invasion von der Peloponnes nach
      Kreta, Fallschirmjäger, Rakete, Bomber, Atomschlag mit Verstrahlung, Kriegsschiff, Handelsschiff,
      Diplomatie-Panel – ohne Konsolenfehler.

Bekannte Grenzen nach Phase 2:

- Sicht-Teilung im Bündnis ist gegenstandslos, solange es keinen Nebel des Krieges gibt.
- Bomber sind Einweg-Einsätze (Kosten pro Flug), Schiffe fahren 4-verbunden (eckige Routen), kein Umlauf bei ±180°.
- Die KI baut Häfen an jedem Wasser, also auch an Binnenseen ohne Seeweg.
- Das Biom-Modell kennt keinen Niederschlag: Steppen und trockene Binnenländer sind zu grün.
- Balancing ist grob: große KI-Nationen wachsen sehr schnell (in Phase 5 durch Schwierigkeitsgrade entschärft).

### Phase 3 – Multiplayer & Custom Maps (abgeschlossen)

- [x] P2P-Multiplayer via `trystero`: Lobby über `#room=...`, Host-Tick/Lockstep-Synchronisation.
- [x] Custom-Map-Importer (JSON / OSM-Bounding-Box), dazu Export mit Terrain-Maske.
- [x] Angebots-Posteingang: Verträge mit Spielern (von Spielern wie von der KI) werden angenommen statt
      automatisch entschieden.
- [x] Geprüft mit 64 Vitest-Tests und im Browser: zwei Tabs über `?net=local` und über echtes WebRTC
      (Nostr-Relays) – gleiche Zustands-Hashes auf beiden Seiten, Bündnis per Angebot, Spielende durch den Host;
      eigene Karte aus einem Ausschnitt angelegt, exportiert und mit identischem Terrain wieder importiert.

Bekannte Grenzen nach Phase 3:

- Kein Beitritt und kein Wiedereinstieg in ein laufendes Spiel. Wer geht, hinterlässt eine untätige Fraktion;
  verlässt der Host den Raum, endet das Spiel (keine Host-Migration).
- Ein Desync wird erkannt, aber nicht repariert (kein Zustands-Snapshot).
- Clients spielen Turns ab, sobald sie eintreffen (kein Jitter-Puffer); ein Befehl wirkt nach einem Umlauf zum Host.
- Keine TURN-Server: hinter strengen Firmen-/Mobilfunk-NATs kommt womöglich keine Verbindung zustande.
- Eigene Karten bekommen ihre Nationen nur aus dem Katalog; andere Spawns verlangen Handarbeit am JSON.

### Phase 4 – QoL, In-World-Steuerung, Bau-Ghost, Kampf-Alarme & Nationen-Editor (abgeschlossen)

- [x] **Nationen-Editor** (Startmenü & Lobby): Nations- und Herrschername, Gebiets-/Grenzfarbe, Flaggen-Baukasten
      (fünf Vorlagen, drei Farben, acht Embleme), Doktrin. Speicherung im `localStorage`, Synchronisation an alle
      Peers; Flagge auf der Karte, in der Rangliste, in der Lobby und im Diplomatie-Menü.
- [x] **Kontext-Radialmenü am Klickpunkt** statt Seitenfenster, mit Truppen-Regler am Menü und Diplomatie-Untermenü.
- [x] **Hotkeys & Bau-Ghost:** `1`–`7` Gebäude, zusätzlich `8` Bomber und `9` Rakete als Zielmodus; Hotkey-Leiste
      mit Kosten; Vorschau mit Radien, Verbindungslinie und grün/rotem Hinweis; `ESC`/Rechtsklick bricht ab.
- [x] **Angriffswarnungen & Gefechts-Indikatoren:** leuchtende Front mit `⚔ Angreifer vs Verteidiger`, klickbare
      Alarme mit Richtungspfeil und Kamera-Sprung, blinkende Gefahrenzone am Ziel von Bomben und Raketen.
- [x] **Dynamischer Custom Cursor:** fünf SVG-Zeiger je nach Zustand.
- [x] Geprüft mit 74 Vitest-Tests (Doktrinen, Bereinigung und Synchronisation der Nationsdaten, Sammelpunkt,
      Bau-Prüfung) und im Browser: Flagge im Editor gebaut und nach Reload wieder da; Radialmenü auf eigenem,
      fremdem Gebiet und Wasser; Hotkeys mit grünem und rotem Ghost; alle fünf Cursor-Zustände; Bodenangriff-
      und Raketenalarm mit Kamera-Sprung; zwei Tabs mit verschiedenen Nationen und gleichem Zustands-Hash.

Bekannte Grenzen nach Phase 4:

- KI-Nationen haben weder Flagge noch Doktrin; sie behalten ihr Symbol.
- Front-Leuchten und Kampfzahlen gibt es nur für Fronten, an denen der Spieler beteiligt ist.
- Das Radialmenü erklärt seine Knöpfe beim Überfahren mit der Maus; auf Touch-Geräten ist das ungetestet.
- Der Sammelpunkt ist eine reine Verteidigungshilfe; Truppen bewegen sich in diesem Spiel nicht einzeln.

### Phase 5 – Audio & Feinschliff (abgeschlossen)

- [x] **Sound-Effekte über die Web Audio API** (`src/ui/sound.ts`): 14 synthetisierte Effekte ohne Audiodateien
      – Befehle, Bauen, Angriff, Explosion, Atomschlag, Abfangen, Landung, Alarm, Angebot, Sieg, Niederlage.
      Ereignisse im Bild sind laut, außerhalb leise; Lautstärke-Regler im HUD, `M` schaltet stumm.
- [x] **Performance-Optimierung**, gemessen auf der größten Karte (Asien, 1,18 Mio. Zellen, spätes Spiel mit
      über 600 Gebäuden): Overlay 9,2 → 1,3–2,0 ms pro Frame (Sprites statt Text, Projektion per Arithmetik,
      Punkte statt Abzeichen bei weitem Zoom); Territorium 11,1 → 5,7 ms pro Tick, früh im Spiel 1,4 ms (nur das
      geänderte Rechteck wird neu gemalt); Rangliste nur noch zweimal pro Sekunde.
- [x] **UI/UX-Polishing:** Hilfe-Dialog (`H`, beim ersten Spiel automatisch), Spielende-Dialog mit Bilanz,
      Schwierigkeitsgrade, Ladebalken, Spielzeit im HUD, ruhige Warnungen bei `prefers-reduced-motion`,
      schmaleres HUD auf kleinen Bildschirmen.
- [x] **Schwierigkeit** (`DIFFICULTY` in `src/core/game.ts`, Teil der Simulation, der Host gibt sie vor):
      Leicht – KI wächst mit 70 %, 120 s Schonfrist; Normal – 100 %, 45 s; Schwer – 125 %, keine Schonfrist.
      In der Schonfrist wählt die KI keinen Spieler als Beute, wehrt sich aber, wenn sie angegriffen wird.
- [x] **Finales GitHub-Pages-Deployment** mit `README.md`, Seitenbeschreibung und Theme-Farbe.
- [x] Geprüft mit 76 Vitest-Tests und im Browser: Effekte werden bei Bau, Befehl, Explosion und Niederlage
      ausgelöst, Stummschaltung bleibt gespeichert, Hilfe und Spielende-Dialog erscheinen, zwei Tabs bleiben auch
      auf „Schwer“ synchron.

Bekannte Grenzen nach Phase 5:

- Ob die Effekte gut klingen, hat niemand gehört: geprüft ist nur, dass sie ausgelöst werden.
- 60 FPS auf echter Grafikhardware sind nicht gemessen; die Zahlen oben sind Rechenzeit im Hauptthread.
- Touch-Bedienung ist ungetestet.
- Das Balancing jenseits der drei Schwierigkeitsgrade ist nicht durch Spieltests abgestimmt.

### Phase 6 – UX-Overhaul: Maus-Steuerung, Start-Bildschirm, Tutorial, „Unmöglich“ (abgeschlossen)

- [x] **Maus-Steuerung umgedreht:** Linksklick handelt sofort, Rechtsklick öffnet das Radialmenü (Abschnitt 6).
      Truppen-Regler unten mit `Q`/`E`, `A`/`D` und Mausrad; Mitteltaste verschiebt die Karte.
- [x] **Start-Bildschirm in drei Schritten:** Nations-Kachel mit Editor-Dialog, Karten-Kacheln in drei Tabs,
      vier Schwierigkeits-Knöpfe ohne Erklärtext, großer Start-Knopf, Mehrspieler-Lobby als Dialog.
- [x] **Interaktives Tutorial** in sechs Schritten, vom Start-Bildschirm aus; beim ersten Besuch hervorgehoben.
- [x] **Schwierigkeit „Unmöglich“** (`DIFFICULTY.impossible`, `Level` in `src/core/game.ts`): keine Schonfrist,
      KI +35 % Wachstum und +40 % Gold, rüstet schon bei 60 % der sonst nötigen Fläche (`armsPct`) und schließt
      die Reihen (`coalition`): KI-Nationen nähern sich einander an, bieten dem führenden Spieler nichts mehr an,
      wählen ihn als Beute und richten Raketen, Bomber und Landungen auch ohne Krieg gegen ihn – aber nur, sobald
      er sie an Fläche überholt hat und kein Vertrag mit ihm besteht. Verträge, Bunker am Engpass und SAM-Stellungen
      bleiben damit wirksame Gegenmittel.
- [x] Geprüft mit 90 Vitest-Tests – darunter Headless-Duelle auf „Unmöglich“: wer nur expandiert, verliert;
      ein Skript mit Handel, Pakt, Bunkern am Gebirgs-Engpass, Städten, SAM und Gegenschlag gewinnt auf drei Seeds;
      niemand fällt in unter zehn Sekunden – und im Browser: neuer Start-Bildschirm, Sofort-Angriff per Linksklick,
      Radialmenü per Rechtsklick auf eigenem, fremdem Gebiet und Wasser, alle sechs Tutorial-Schritte, zwei Tabs
      auf „Unmöglich“ mit gleichem Zustands-Hash.

Bekannte Grenzen nach Phase 6:

- „Am schnellsten wachsender Spieler“ ist als „größter Spieler“ umgesetzt (kein Flächenverlauf je Fraktion).
- Die Schaffbarkeit von „Unmöglich“ ist an einem Duell-Szenario belegt, nicht an den zwölf Karten durchgespielt.
  Im Duell überrennt auch „Schwer“ einen Spieler, der nur expandiert; Verträge sind auf engem Raum der Schlüssel.
- Die Karten-Kacheln zeigen die Lage des Ausschnitts auf einem Gradnetz, kein Vorschaubild der Karte.
- Rechtsklick-Menü und Mausrad-Regler haben auf Touch-Geräten keine Entsprechung.
