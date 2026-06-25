# FEATURE REQUEST — Reaktions-Blueprints (Reactions)
# Status: GEPLANT — **NICHT in der aktuellen Bug-Fix-Runde implementieren**

> Entscheidung des Users: P-2.3 ist kein Bug, sondern ein **neues Feature**. Dieses Dokument
> hält die Anforderung fest. Die AI soll dieses Feature **erst nach expliziter Freigabe**
> umsetzen, nicht zusammen mit der Bug-Fix-Runde (`plans/BAUPLAN_FUER_DIE_AI_v2.md`).

---

## Ziel
Reaktions-Blueprints (Composite / Hybrid Polymer / Biochemical / etc.) sollen genauso
berechenbar sein wie Manufacturing-Blueprints — inklusive Materialien, Reaktionszeit,
Cost-Index (Activity „reactions") und Buy/Build-Entscheidung.

## Root Cause / aktuelle Lücke (verifiziert @ `7047cb3`)
Im SDE-Import werden Reaktionen nicht eingelesen:
- `backend/app/services/sde_pg_importer.py:19` — `invTypeReactions → reaction definitions (TODO)`.
- `backend/app/services/sde_pg_importer.py:366` — beim Blueprint-Import:
  `activity_id=1, # industryBlueprints only contains manufacturing`, `is_reaction=False`.
- Reaktionen laufen in EVE unter einer eigenen Activity (`activity_id = 11`, „reactions").
  Diese wird im Import nicht berücksichtigt → keine Reaktions-Materialien/Produkte,
  keine Reaktionszeit, kein Reactions-Cost-Index.

Folge: Reaktions-BPs können nicht kalkuliert werden, und das R-Badge (siehe Bug B im
Bug-Fix-Plan) lässt sich nicht sauber von „echtem Reaktions-Output" ableiten, weil die
Reaktions-Daten gar nicht in der DB sind.

## Umfang (wenn implementiert)
1. **SDE-Import erweitern** (`sde_pg_importer.py`):
   - Quelle für Reaktionen einbinden (Fuzzwork `industryActivityMaterials` /
     `industryActivityProducts` / `industryActivity` mit `activityID = 11`, bzw. die
     entsprechende SDE-Reaktions-Tabelle). Die genaue Tabelle/Spalte gegen die aktuell
     genutzte Fuzzwork-Quelle prüfen (CCP hat die SDE 2025 umgebaut — Schema verifizieren,
     nicht annehmen).
   - `sde_blueprint_materials` / `sde_blueprint_products` auch für `activity_id = 11` füllen.
   - `is_reaction = True` korrekt setzen (statt hart `False`).
   - Reaktionszeit (`time` der Activity 11) importieren.
2. **Cost-Index:** für Reaktionen den `reactions`-Cost-Index nutzen
   (`cost_indices.py` liefert ihn bereits im `cost_indices`-Response je System).
3. **Kostenformel:** Reaktionen haben **keine ME/TE**, nur Zeit-/Runs-Skalierung und eigene
   Facility-Boni (Refinery-Rigs). Die Job-Cost-Formel (EIV × Index + SCC + Facility-Tax,
   siehe Bug A) gilt analog mit dem Reactions-Cost-Index.
4. **Build-Tree / Buy-vs-Build:** Reaktions-Outputs als baubare Sub-Steps verfügbar machen,
   damit „selber reagieren vs. kaufen" im Shopper (Bug C) entscheidbar wird.
5. **Badges:** nach dem Import lässt sich das R-Badge sauber an „Output einer Reaktion"
   knüpfen statt an eine rohe category_id (verweist zurück auf Bug B im Bug-Fix-Plan).

## Abhängigkeiten / Reihenfolge
- Setzt voraus, dass Bug E (invMetaTypes / SDE-Import-Pipeline) und Bug A (EIV-Job-Cost-
  Formel) abgeschlossen sind, da Reaktionen dieselbe Cost-Formel (mit Reactions-Index)
  wiederverwenden sollen.

## Akzeptanzkriterien (für später)
- Eine bekannte Reaktion (z. B. ein Composite/Moon-Material) lässt sich im Tool mit
  Materialien, Reaktionszeit und Job-Cost berechnen.
- `docker exec eve-db psql -U eve -d eve_industrial -c
  "SELECT COUNT(*) FROM sde_blueprint_materials WHERE activity_id = 11;"` > 0.
- R-Badge erscheint nur bei tatsächlichen Reaktions-Outputs.

*Erstellt: 2026-06-25 — Feature-Request, nicht zur sofortigen Umsetzung.*
