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
  Stämme und einzelne starke Elite-Stämme. Vier Schwierigkeitsgrade von „Leicht“ bis „Unmöglich“.
- **Sieben Gebäude, acht Einheiten:** Stadt, Fabrik, Bunker, Hafen, Fliegerhorst, Raketensilo, SAM-Stellung;
  Transporter, Kriegs- und Handelsschiffe, Jäger, Bomber, Fallschirmjäger, Raketen, Atomraketen.
- **Diplomatie:** Nichtangriffspakt, Bündnis, Handel, Hilfslieferungen, Embargo – auch mit Stämmen.
- **Gebäude-Stufen:** Ausbau bis Stufe 4, Fabriken versorgen ihr Umland, Silos mit Magazin, SAM mit Anlaufzeit.
- **Seehandel:** Häfen schicken Handelsschiffe von selbst; Kriegsschiffe kapern sie und steigen im Gefecht auf.
- **Echte Grenzen und Städte:** Länderkarten enden an den echten Staatsgrenzen; eine Stadt auf einer echten
  Metropole übernimmt deren Namen und Bonus.
- **Flaggen-Bibliothek:** über hundert heutige Staaten und historische Reiche als Vorlage für die eigene Nation.
- **Tutorial:** ein geführtes erstes Spiel in sechs Schritten, direkt vom Startbildschirm.
- **Mehrspieler:** „Raum erstellen“, Link verschicken, losspielen – über einen kleinen Relay-Server (Cloudflare
  Worker), wenn einer eingerichtet ist, sonst Peer-to-Peer über WebRTC.

## Steuerung

| Eingabe | Wirkung |
| --- | --- |
| Linksklick | Startgebiet wählen; danach Sofort-Angriff auf angrenzendes freies Land oder eine Nachbarfraktion |
| Rechtsklick | Radialmenü am Mauszeiger: bauen, Schiffe, Luftwaffe, Raketen, Diplomatie |
| Regler unten, `Q`/`E`, Umschalt + Mausrad | Truppenanteil für Angriffe |
| `W` `A` `S` `D`, Pfeiltasten | Kamera verschieben |
| Leertaste, `+`/`-` | Pause, Spieltempo 0.5x bis 4x (im Mehrspieler der Host) |
| Ziehen (links oder Mitteltaste) | Karte verschieben |
| `1`–`7` | Gebäude wählen – die Vorschau zeigt Reichweite und ob der Platz taugt; Linksklick baut, auf ein eigenes Gebäude derselben Art baut er es aus |
| `8`, `9` | Bomber und Rakete zielen; Linksklick feuert |
| `Esc`, Rechtsklick | Bau- oder Zielmodus verlassen, Menü schließen |
| `M`, `H` | Ton aus/an, Hilfe |

Gewonnen hat, wer 80 % der Landfläche hält oder als Letzter übrig ist.

## Mehrspieler-Server einrichten (einmalig)

Ohne Server finden sich Spieler über öffentliche Nostr-Relays und verbinden sich direkt per WebRTC. Das scheitert
manchmal an Routern oder an Relays, die gerade ausfallen. Zuverlässiger ist der Relay-Server in `relay/`, ein
Cloudflare Worker, der im Gratis-Tarif läuft und nur Nachrichten weiterreicht:

1. Im Cloudflare-Dashboard unter *My Profile → API Tokens* ein Token mit der Vorlage **„Edit Cloudflare Workers“**
   erstellen.
2. Im GitHub-Repository unter *Settings → Secrets and variables → Actions* das Secret `CLOUDFLARE_API_TOKEN`
   anlegen (bei mehreren Cloudflare-Konten zusätzlich `CLOUDFLARE_ACCOUNT_ID`).
3. Den Workflow **„Deploy relay to Cloudflare“** unter *Actions* starten. Er nennt am Ende die Adresse,
   `https://osm-front-relay.<dein-subdomain>.workers.dev`.
4. Diese Adresse als Repository-Variable `RELAY_URL` (Tab *Variables*) eintragen und **„Deploy to GitHub Pages“**
   neu starten. Ab dann verbinden sich alle über den Server; ist er nicht erreichbar, fällt das Spiel auf
   Peer-to-Peer zurück. Mit `?net=p2p` in der Adresse lässt sich P2P erzwingen, mit `?relay=<adresse>` ein anderer
   Server testen.

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

Den Relay-Server lokal starten (für `?relay=http://localhost:8787`):

```bash
cd relay && npx wrangler dev --port 8787
```

Vite, TypeScript (strict), MapLibre GL JS, `trystero` für WebRTC, `vitest` für die Simulation. Die Spiellogik
in `src/core/` ist deterministisch und frei von DOM und Netzwerk; Architektur, Regeln und der Stand jeder
Phase stehen in [`CLAUDE.md`](CLAUDE.md). Jeder Push auf `main` wird getestet, gebaut und auf GitHub Pages
veröffentlicht.

## Daten und Dank

- Kartendaten © [OpenStreetMap](https://www.openstreetmap.org/copyright)-Mitwirkende (ODbL),
  Kacheln und Basiskarte von [OpenFreeMap](https://openfreemap.org/) im OpenMapTiles-Schema.
- Höhendaten: Terrarium-Kacheln (Mapzen / AWS Open Data).
- Historische Flaggen: [Wikimedia Commons](https://commons.wikimedia.org/wiki/Historical_flags) (gemeinfrei bzw. CC BY-SA,
  siehe die jeweilige Dateiseite); heutige Flaggen: flag-icons.
- Ländergrenzen: [Natural Earth](https://www.naturalearthdata.com/) über `world-atlas`; Städte: [GeoNames](https://www.geonames.org/) (CC BY 4.0);
  Flaggen: [flag-icons](https://github.com/lipis/flag-icons) (MIT).
- [MapLibre GL JS](https://maplibre.org/), [Trystero](https://github.com/dmotz/trystero).
