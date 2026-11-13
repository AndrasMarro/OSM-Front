# OSM-Front

Echtzeit-Strategie auf echten OpenStreetMap-Daten: Du gründest eine Nation, flutest Zelle für Zelle über echtes
Gelände, baust Städte, Häfen und Raketensilos, schließt Bündnisse – allein gegen die KI oder mit Freunden
direkt von Browser zu Browser, ohne Server.

**Spielen:** <https://andrasmarro.github.io/OSM-Front/>

## Was drin ist

- **Zwölf Karten** von der Welt bis zum Balkan, dazu eigene Karten für jeden Ausschnitt der Erde.
  Gelände kommt aus OSM: Wasser, Städte, Wälder, Gebirge, Autobahnen, Schienen, Eis.
- **Eigene Nation:** Name, Herrscher, Farben, Flagge aus dem Baukasten und eine Doktrin mit kleinem Bonus.
- **Gegner:** KI-Nationen, die Wirtschaft, Marine, Luftwaffe und Raketen einsetzen und verhandeln; dazu
  Stämme und einzelne starke Elite-Stämme. Drei Schwierigkeitsgrade.
- **Sieben Gebäude, acht Einheiten:** Stadt, Fabrik, Bunker, Hafen, Fliegerhorst, Raketensilo, SAM-Stellung;
  Transporter, Kriegs- und Handelsschiffe, Jäger, Bomber, Fallschirmjäger, Raketen, Atomraketen.
- **Diplomatie:** Nichtangriffspakt, Bündnis, Handel, Hilfslieferungen, Embargo – auch mit Stämmen.
- **Mehrspieler:** „Raum erstellen“, Link verschicken, losspielen. Peer-to-Peer über WebRTC.

## Steuerung

| Eingabe | Wirkung |
| --- | --- |
| Klick auf freies Land | Startgebiet wählen, danach ausbreiten |
| Linksklick | Menü am Klickpunkt: bauen, angreifen, Schiffe, Luftwaffe, Raketen, Diplomatie |
| `1`–`7` | Gebäude wählen – die Vorschau zeigt Reichweite und ob der Platz taugt |
| `8`, `9` | Bomber und Rakete zielen |
| `Esc`, Rechtsklick | Menü schließen, Modus verlassen |
| `M`, `H` | Ton aus/an, Hilfe |

Gewonnen hat, wer 80 % der Landfläche hält oder als Letzter übrig ist.

## Entwickeln

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run build
```

Vite, TypeScript (strict), MapLibre GL JS, `trystero` für WebRTC, `vitest` für die Simulation. Die Spiellogik
in `src/core/` ist deterministisch und frei von DOM und Netzwerk; Architektur, Regeln und der Stand jeder
Phase stehen in [`CLAUDE.md`](CLAUDE.md). Jeder Push auf `main` wird getestet, gebaut und auf GitHub Pages
veröffentlicht.

## Daten und Dank

- Kartendaten © [OpenStreetMap](https://www.openstreetmap.org/copyright)-Mitwirkende (ODbL),
  Kacheln und Basiskarte von [OpenFreeMap](https://openfreemap.org/) im OpenMapTiles-Schema.
- Höhendaten: Terrarium-Kacheln (Mapzen / AWS Open Data).
- [MapLibre GL JS](https://maplibre.org/), [Trystero](https://github.com/dmotz/trystero).
