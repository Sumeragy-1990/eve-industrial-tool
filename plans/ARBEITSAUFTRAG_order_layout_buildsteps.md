# ARBEITSAUFTRAG FÜR DIE AI — Order-Ansicht: Layout + Inline-Build-Steps + Preise
# EVE Industrial Tool — Code-Analyse @ Commit `fc5633f` (NACH deinem A–I-Fix)

Dein A–I-Fix ist drin, aber die Order-/Shopper-Material-Ansicht sieht im Browser weiter
kaputt aus (Name verschoben/mittig, Spalten verrutscht). **Ursache gefunden — siehe Bug 1.**
Außerdem 6 weitere Punkte aus dem User-Feedback.

Docker-Rebuild + Hard-Reload (Strg+Shift+R) + Verifizierung nach JEDER Änderung
(siehe `plans/BAUPLAN_FUER_DIE_AI.md`). Zeilennummern @ `fc5633f` — vor dem Edit frisch
per `grep -n` prüfen.

---

## BUG 1 — Grid-Layout weiterhin kaputt (DAS ist der Blocker, höchste Prio)

### Warum dein Fix nicht gegriffen hat (verifiziert)
`blueprints.html` lädt CSS in dieser Reihenfolge:
```
Zeile 9:  style.css
Zeile 10: themes.css     ← lädt NACH style.css
```
Du hast das Grid in **`style.css:2058/2073`** korrekt auf 8 Spalten gesetzt:
```css
.bp-order-mat-header, .bp-order-mat-row {
    grid-template-columns: 24px 1fr 70px 85px 85px 75px 85px 55px;  /* RICHTIG: badge 24px, name 1fr */
}
```
Aber **`themes.css:372` und `themes.css:387`** enthalten noch die ALTE Definition:
```css
.bp-order-mat-header { grid-template-columns: 1fr 80px 90px 90px 50px 80px; }  /* STALE */
.bp-order-mat-row   { grid-template-columns: 1fr 80px 90px 90px 50px 80px; }  /* STALE */
```
Gleiche Spezifität (eine Klasse), aber themes.css kommt später → **themes.css gewinnt**.
Ergebnis: nur 6 Tracks für 8 DOM-Spalten, und das flexible `1fr` liegt auf der **Badge**-
Spalte (1. DOM-Kind) statt auf dem Namen. Deshalb: Badge frisst den ganzen Platz, Name wird
in 80px gequetscht (Ellipsis, wirkt „mittig"), Sell/Buy/Total/Action verrutschen in
implizite Auto-Tracks. **Exakt das im Screenshot.**

### Fix
1. In **`themes.css`** aus den Blöcken `.bp-order-mat-header` (~Z.372) und
   `.bp-order-mat-row` (~Z.387) die Layout-Eigenschaften **entfernen**: `display: grid`,
   `grid-template-columns`, `gap`, `padding`. themes.css soll NUR Farben/Theme tragen
   (`--t-*`), nicht das Grid. Layout gehört allein in style.css.
   - Falls du in themes.css eine Padding-/Hintergrund-Anpassung brauchst, ok — aber **kein**
     `grid-template-columns` mehr.
2. In **`blueprints.html` `<style>`** (~Z.218-221) die fixen Breiten entfernen bzw. auf die
   Daten-Rows neutralisieren:
   ```css
   .bp-mat-col-badge { width: 32px; ... }   /* width raus */
   .bp-mat-col-sell  { width: 65px; ... }   /* width raus */
   .bp-mat-col-buy   { width: 65px; ... }   /* width raus */
   ```
   In einem Grid bestimmt `grid-template-columns` die Spaltenbreite — feste `width` auf den
   Grid-Kindern verursacht nur Versatz zwischen Header und Rows. `text-align`, `color`,
   `font` dürfen bleiben, nur `width`/`flex-shrink` raus. (Du hattest die `width:auto`-
   Overrides nur für `.bp-order-mat-header` gesetzt, nicht für die Rows — daher der Versatz.)
3. Sicherstellen, dass Header (`bp-order-mat-header`) und Row (`bp-order-mat-row`) **dieselbe**
   `grid-template-columns` haben (beide 8 Tracks in style.css). Aggregated-Tabelle
   (`style.css:2168/2174`, 9 Tracks) ist separat — nicht anfassen, die sieht laut Screenshot 2
   korrekt aus.

### Verifizierung
```bash
grep -n "grid-template-columns" backend/app/templates/static/css/themes.css
# → darf KEINE bp-order-mat-* Zeile mehr ausgeben
```
Im Browser (Strg+Shift+R): Material-Namen stehen **linksbündig** direkt nach dem Badge,
Qty/Sell/Buy/Price/Total rechtsbündig in einer Zeile, B/Y-Buttons ganz rechts ohne Umbruch.

---

## BUG 2 — Material-Namen ganz links, nur Namen (kein Qty links)

Folgt großteils aus Bug 1 (sobald `1fr` wieder auf der Name-Spalte liegt, steht der Name
links). Zusätzlich: die Qty-Spalte soll NICHT vor dem Namen stehen. DOM-Reihenfolge ist
bereits badge→name→qty→… (korrekt), also nach Bug-1-Fix erledigt. Prüfen, dass die
Qty-Zahl rechts neben dem Namen steht, nicht davor.

---

## BUG 3 — Inline-Build-Steps in der Order-Ansicht (KERN-WUNSCH)

> User: „Wenn ich auf ein Item (Rokh) klicke, sollen Build-Steps nur bei den Materialien
> erscheinen, die auch gebaut werden können — dort in der Liste. Wie im Shopper (Screenshot 4),
> genau so auch in den Orders."

### Ausgangslage (verifiziert)
- Im **Shopper** funktioniert das bereits: `bp-browser.js:1435-1481` setzt bei baubaren
  Materialien (`hasSubStep`) ein Aufklapp-Chevron `BP.toggleMatSubStep(type_id)` und rendert
  die Sub-Materialien inline. Export vorhanden (`bp-browser.js:7223`).
- In der **Order-Ansicht** (Row-Rendering `bp-browser.js:3717-3815`) fehlt dieses Chevron.
  Dort gibt es nur die B/Y-Action-Spalte, kein Aufklappen baubarer Sub-Materialien.

### Fix
1. In der Order-Row (~3732, direkt vor/nach dem Badge-Span) für baubare Materialien dasselbe
   Aufklapp-Chevron rendern wie im Shopper. Baubar = Material hat Sub-Materialien / einen
   Blueprint und ist NICHT in `RAW_BUY_CATEGORIES` (siehe Bug 5). Beispiel analog Z.1455:
   ```javascript
   var hasSub = isBuildable(m);   // siehe Bug 5: Blueprint vorhanden && nicht RAW_BUY
   html += '<span class="bp-mat-col-badge">' +
       (hasSub ? '<span class="bp-material-expand" onclick="event.stopPropagation();BP.toggleOrderMatSubStep(' +
                 _activeOrderIndex + ',' + i + ',' + mi + ')"><i class="bi bi-chevron-right" ' +
                 'id="bpOrdChev_'+i+'_'+mi+'"></i></span>' : '') +
       badgeHtml + '</span>';
   ```
2. Eine Order-Variante von `toggleMatSubStep` (z. B. `toggleOrderMatSubStep`) bauen, die unter
   der Zeile eine eingerückte Sub-Material-Liste ein-/ausklappt — **dieselbe** Render-Funktion
   wie im Shopper wiederverwenden (DRY; der User betont „selber Inhalt"). Sub-Zeilen mit
   eigenem Badge (`matCategoryBadge(sm.category_id)`), Menge, Preis.
3. Nur baubare Materialien bekommen das Chevron. Mineralien/Ore (RAW_BUY) und Items ohne
   Blueprint bekommen KEINS.
4. Neue Funktion im `return { … }`-Block exportieren.

### Verifizierung
Order öffnen → baubare Materialien (Auto-Integrity Preservation Seal, Core Temperature
Regulator, Life Support Backup Unit) haben ein Chevron und klappen ihre Sub-Materialien
inline auf; Mineralien (Tritanium, Zydrine …) haben keins.

---

## BUG 4 — Aggregierte Zusammenfassung wie Screenshot 2

Screenshot 2 („AGGREGATED MATERIALS") ist das gewünschte Ergebnis und existiert bereits
(`bp-browser.js:3936+`, `style.css:2168/2174`). Nach Bug 1 prüfen, dass diese Tabelle in der
Order-Ansicht sichtbar/korrekt ausgerichtet ist (Build / Buy / Total / Sell / Buy / Avg /
Total). Falls sie nur im Shopper auftaucht: auch in der Order-Ansicht unten anzeigen.

---

## BUG 5 — Mineralien sind nicht baubar → Build-Button ausgrauen

### Ausgangslage (verifiziert)
- Die Entscheidungs-Logik kennt RAW-Buy bereits: `bp-browser.js:3274`
  `var RAW_BUY_CATEGORIES = [4, 42, 43, 53];` → für diese Kategorien immer „buy".
- ABER die B/Y-Toggle-Buttons (`bp-browser.js:3783-3790`) werden bedingungslos gerendert;
  der **„B" (Build)**-Button ist bei Mineralien NICHT deaktiviert.

### Fix
1. Helper `isBuildable(m)` einführen (zentral, auch von Bug 3 genutzt):
   ```javascript
   var RAW_BUY_CATEGORIES = [4, 42, 43, 53];
   function isBuildable(m) {
       if (!m) return false;
       if (RAW_BUY_CATEGORIES.indexOf(m.category_id) !== -1) return false;
       return !!(m.has_blueprint || (m.materials && m.materials.length) || m.buildable);
   }
   ```
   (Welches Feld „hat Blueprint" markiert, im Backend-Response prüfen — `has_blueprint`/
   `is_buildable`/Vorhandensein von Sub-Materials.)
2. Beim B-Button: wenn `!isBuildable(m)` → `disabled`, ausgegraut, Tooltip „Mineral/Rohstoff —
   nicht baubar", und kein `onclick`. Der Y-(Buy)-Button bleibt aktiv und ist vorausgewählt.

### Verifizierung
Mineralien (M-Badge) zeigen einen ausgegrauten, nicht klickbaren B-Button; baubare Items
zeigen ihn normal.

---

## BUG 6 — Preise werden nicht korrekt aktualisiert

### Hinweis aus den Screenshots
In den Build-Steps (Screenshot 3) stehen Sub-Materialien mit **×0** (Chiral Structures ×0,
Water ×0, …) und „-" als Preis. D. h. die Sub-Step-Mengen werden als 0 aufgelöst → Preis/
Summe bleiben leer/falsch. Das ist vermutlich die Hauptursache für „Preise updaten nicht".

### Fix (erst diagnostizieren)
1. Prüfen, wo die Sub-Step-Mengen berechnet werden (Build-Tree-Aufbau). `×0` heißt: die
   benötigte Menge des Sub-Materials wird nicht aus (Runs × Basismenge ÷ ME-Faktor)
   abgeleitet, sondern bleibt 0. Dort die Mengenberechnung fixen.
2. Preisquelle: `getEffectivePrice(type_id)` (`bp-browser.js:161+`) — sicherstellen, dass nach
   einem Preis-Refresh / Override / Stationswechsel die Order-Ansicht **neu gerendert** wird
   (re-render der Material-Liste, nicht nur des Caches). Prüfen, ob das Render nach
   `loadPrices()`/Override erneut aufgerufen wird.
3. Wenn Custom-/Override-Preise gesetzt werden: Re-Render triggern.

### Verifizierung
Sub-Materialien zeigen echte Mengen (kein ×0) und echte Preise; nach Preis-Refresh ändern
sich die Summen sichtbar.

---

## BUG 7 — Stationswechsel (T2-Rig vs. ohne) ändert Materialkosten nicht

### Erwartung
Material-Rigs (z. B. T2 Material Efficiency Rig) und Struktur-Boni reduzieren den
**Materialverbrauch**. Ein Stations-/Rig-Wechsel muss die Materialmengen (und damit die
Materialkosten) sichtbar ändern.

### Fix (diagnostizieren)
1. Prüfen, ob die Material-Mengenberechnung den **Rig-/Struktur-Materialbonus** überhaupt
   einbezieht. Aktuell werden Mengen vermutlich nur mit ME (Blueprint-ME) reduziert, der
   Rig-/Struktur-Materialbonus der gewählten Station fehlt.
2. EVE-Formel Materialmenge:
   `qty = max(runs, ceil(runs × base_qty × (1 − ME/100) × (1 − structure_mat_bonus) × (1 − rig_mat_bonus × security_mult)))`
   Der Rig-Bonus hängt vom Security-Status des Systems ab (Highsec ×1, Lowsec ×1.9, Nullsec ×2.1).
3. Die Stations-/Rig-Config muss diese Boni liefern und in die Mengenberechnung einfließen.
   Beim Stationswechsel Material-Liste neu berechnen + neu rendern (hängt mit Bug 6 #2 zusammen).

### Verifizierung
Station mit T2-Material-Rig wählen → Materialmengen/-kosten sinken sichtbar gegenüber „ohne Rig".

---

## BUG 8 — Build-Cost weiterhin fehlerhaft (Anschluss an Bug A)

Dein EIV-Fix (Bug A) ist drin, aber die angezeigten Baukosten stimmen laut User noch nicht.
Wahrscheinliche Restursachen:
- Sub-Step-Mengen = 0 (siehe Bug 6) → Baukosten der Sub-Builds = 0 → Gesamt falsch.
- Job-Cost pro baubarem Sub-Step wird nicht in die Rollup-Summe übernommen.

### Fix
1. Zuerst Bug 6 (×0-Mengen) fixen — danach Build-Cost neu prüfen.
2. Verifizieren, dass `total_job_cost` (EIV-Formel) je baubarem Step korrekt berechnet und in
   die aggregierte Gesamtsumme einbezogen wird.
3. Gegen einen bekannten In-Game-Wert testen (wie in Bug A: < 1 % Abweichung).

---

## REIHENFOLGE
1. **Bug 1** (Layout/themes.css) — schaltet alles Sichtbare frei.
2. **Bug 5** (`isBuildable`-Helper) — Basis für Bug 3.
3. **Bug 3** (Inline-Build-Steps in Orders) — Kern-Wunsch.
4. **Bug 6** (×0-Mengen / Re-Render) — Basis für Bug 7 & 8.
5. **Bug 7** (Rig-Materialbonus), **Bug 8** (Build-Cost-Rollup).
6. **Bug 2/4** sind nach Bug 1 meist miterledigt — nur verifizieren.

## ABSCHLUSS-CHECK
- [ ] `grep grid-template-columns themes.css` → keine bp-order-mat-* mehr.
- [ ] Order-Ansicht: Name links, Spalten in einer Zeile ausgerichtet (Strg+Shift+R!).
- [ ] Baubare Materialien klappen inline auf, Mineralien nicht.
- [ ] B-Button bei Mineralien ausgegraut.
- [ ] Keine ×0-Sub-Mengen mehr; Preise/Summen aktualisieren sich.
- [ ] Stationswechsel mit Rig ändert Materialkosten.
- [ ] Neue JS-Funktionen im `return { }`-Block exportiert.
- [ ] `node --check bp-browser.js` ok; Docker-Rebuild gezeigt.

*Erstellt: 2026-06-25 — Code-Analyse @ `fc5633f`.*
