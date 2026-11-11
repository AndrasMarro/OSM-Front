---
description: Neues Gebäude, neue Einheit oder neue Karte modular über die Registries hinzufügen (inkl. Vitest-Test)
argument-hint: "<building|unit|map> <Name> [Beschreibung der gewünschten Wirkung]"
---

Füge neuen Inhalt hinzu: **$ARGUMENTS**

Inhalt ist in OSM-Front **Daten, kein Code**. Ein neuer Typ ist ein Eintrag in einer Registry; die Engine
liest nur die Felder der Definition. Erst wenn eine Wirkung mit den vorhandenen Feldern nicht ausdrückbar
ist, wird die Definition um ein *optionales* Feld erweitert und genau eine Stelle der Engine wertet es aus.
Niemals `if (def.id === 'MeinTyp')` in der Engine.

## Regeln, die immer gelten

- Alles unter `src/core/` bleibt frei von DOM, MapLibre und Netzwerk.
- Zufall ausschließlich über den Seeded PRNG des Spiels (`game.rng`, erzeugt mit `mulberry32`).
  Kein `Math.random()`, kein `Date.now()`, keine Iteration über ungeordnete Strukturen mit Seiteneffekten.
- Gleitkomma in der Tick-Logik nur mit `+ - * /`.
- UI-Texte deutsch, Code/Kommentare/Commit-Messages englisch.
- Jeder neue Inhalt bekommt einen Vitest-Test, der fehlschlägt, wenn die Wirkung ausbleibt.

## Gebäude – `src/core/buildings.ts`

```ts
buildingRegistry.register({
  id: 'Radar',            // eindeutiger Schlüssel, auch im Baumenü-Datensatz
  name: 'Radarstation',   // Anzeigename (deutsch)
  icon: '◉',              // ein Zeichen für Karte und Baumenü
  cost: 300,              // Gold; steigt automatisch mit jedem weiteren Gebäude desselben Typs
  hp: 2,                  // Treffer bis zur Zerstörung
  // optionale Wirkungen – nur setzen, was der Typ braucht:
  // coastal: true,                               muss an WATER grenzen
  // capacity: 2500, growthPct: 15,               Max-Pop und Wachstum (City)
  // income: 0.4, linkBonusPct: 50,               Gold/Tick, Bonus bei Straßen-/Schienenanschluss (Factory)
  // fort: { radius: 6, defensePct: 200, slow: 4 }  Verteidigung und Bremse im Radius (Bunker)
  // intercept: { radius: 14, cooldown: 80, chancePct: 100, domains: ['air', 'missile'] }  (SAMSite)
});
```

Das Baumenü, die Icons auf der Karte und `build()` übernehmen den Eintrag ohne weitere Änderung.
Soll die KI den Typ bauen, kommt eine Zeile in die Wunschliste `NATION_WISHES` in `src/core/ai.ts`.

## Einheit – `src/core/units.ts`

```ts
unitRegistry.register({
  id: 'CruiseMissile',
  name: 'Marschflugkörper',
  cost: 500,
  base: 'MissileSilo',    // Gebäude-ID, von der aus die Einheit startet
  domain: 'missile',      // 'sea' | 'air' | 'missile' – bestimmt Bewegung und wer sie abfangen kann
  speed: 3,               // Zellen pro Tick
  range: 400,             // Reichweite in Zellen ab Basis
  hp: 1,
  // genau eine Rolle:
  blast: { radius: 5, buildingDamage: 3, troopsPct: 10 },   // Einschlag (optional neutralize: true)
  // carriesTroops: true,                                   landet Truppen an (Transporter, Fallschirmjäger)
  // guns: { radius: 7, cooldown: 15, troops: 40 },         Patrouille mit Beschuss (Warship)
  // trade: { gold: 20, perCell: 0.5 },                     pendelt zu fremden Häfen (TradeShip)
  // intercept: { radius: 18, cooldown: 60, chancePct: 60, domains: ['air'] }  bleibt an der Basis (Fighter)
});
```

Das Aktionsmenü listet die Einheit automatisch: Einheiten mit `intercept` oder `trade` beim Klick auf
eigenes Gebiet, alle anderen bei der Zielauswahl.

## Karte – `src/core/maps/presets.ts`

```ts
preset('Iberia', 'Iberische Halbinsel', [-10, 35.5, 4.5, 44], [4, 9], 640,
  [...nations(['Spanien', -3.7, 40.42], ['Portugal', -9.14, 38.72]), ...elites(['Pyrenäen-Clans', 0.5, 42.6])],
  25, // zufällige Tribes
  // optional: { terrain: { type: 'osm', zoom: 7, mountainElevation: 1200 }, terrainWeights: { MOUNTAIN: 1.3 } }
),
```

- Bounding-Box `[minLng, minLat, maxLng, maxLat]`, Zoom-Grenzen `[min, max]`, Grid-Breite in Zellen.
- Spawn-Punkte müssen auf Land liegen; im Browser prüfen, dass jede Nation wirklich spawnt.
- Custom Maps brauchen keinen Code: `mapRegistry.register(json)` mit einem `MapPackDefinition`-Objekt.

## Test-Vorlage

`src/core/testkit.ts` liefert die Helfer: `world(w, h, terrainAt?, seed?)`, `human(g, x, y)` (Spieler mit vollem
Goldkonto, handelt nie von selbst), `at(g, x, y)` und `run(g, ticks)`.

```ts
import { describe, expect, it } from 'vitest';
import { build } from './buildings';
import { at, human, run, world } from './testkit';

describe('Radar', () => {
  it('does what its definition promises', () => {
    const g = world(40, 40);
    const me = human(g, 20, 20);
    expect(build(g, me.id, 'Radar', at(g, 20, 20))).toBe('ok');
    run(g, 100);
    // assert the effect here, and that a second game with the same seed ends in the same state
  });
});
```

Vorbilder: `buildings.test.ts` (Konfigurations-Typ `Palisade`), `units.test.ts` (Landung, SAM-Abfang),
`maps/maps.test.ts` (Presets und Custom Maps).

## Abschluss

`/verify <neuer Inhalt>` ausführen: Tests, Build, Browser-Prüfung, `CLAUDE.md`, Commit unter
`andrasmarro` ohne Trailer.
