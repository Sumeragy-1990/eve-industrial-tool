# Gemini Recherche-Auftrag: EVE Online Industrial Tool / SquadB YouTube Channel

## Kontext
Wir bauen ein selbstgehostetes EVE Online Industrial Web-Tool (FastAPI + PostgreSQL + Docker). Der User hat eine Excel-Datei von "SquadB" (EVE ONLINE Excel workbook v1.6). Wir haben bereits:
- EVE SSO Login (funktioniert)
- Character Asset Sync (funktioniert)
- SDE Importer (50.235 Items in DB)
- Docker Deployment auf eve.sumeragy.de (Port 8082)

Jetzt wollen wir die Excel-Struktur als Web-Tool nachbauen.

## Excel Analyse (bereits gemacht)
Die Excel hat 18 Sheets:

1. **LICENCE** - Lizenz
2. **0.INTRO** - Charakter-Setup (Main, Trader Alts, Stationen, Schiffe)
3. **1A.CHAR.RESTOCK** - Character Restock Automator
   - Spalten: Material, Asset Card, Item ID, QTY, STOCK, GAP, TO BUY, Buy Statement, Market Card, Ave Price, Cost to Buy, Vol, Size
   - Kategorien: Minerals (Tritanium-Pyerite etc.), Moon Goop (Tungsten Carbide etc.), Planet Tech (Transmitter etc.), Datacores (alle 16 Typen), Decryptors
4. **1B.CORP.RESTOCK** - Gleiche Struktur für Corporation
5. **2.MARKET ORDERS** - Marktorder-Tracking
6. **3.SELLING TOOL** - Verkaufspreis-Optimierung mit Markdown
7. **4.CHAR BLUEPRINTS** - Character BPO Tracking (ME/PE levels)
8. **4.corp BLUEPRINTS** - Corporation BPO Tracking
9. **4.1 BPC Tracker** - Blueprint Copy Tracking
10. **5.Corp Tracker** - Corp Member Tracking (Name, Char ID, Location, Last Login)
11. **6.Daves SHIP Garage** - Schiffbau:
    - Build Cost Berechnung mit Materialliste
    - Profit Analyse (Lowest Sell, Highest Buy, Build Cost, Profit/Loss)
    - Beispiel: Golem benötigt Raven, R.A.M.- Starship Tech etc.
12. **6.Daves STRUCTURE Garage** - Structure Building (z.B. Raitaru)
13. **ID GRABBER** - Item ID Nachschlage-Tool
14. **typeids** - Type ID Referenzdaten
15. **BPO CORP Table, BPO CHAR Table, T2 BPC Table, BPC Table** - Blaupausen-Tabellen

## YouTube Video Haupt-Link
https://www.youtube.com/watch?v=KG6f_6Zrcag

## Aufgabe für Gemini
Bitte suche / analysiere:

### 1. YouTube Channel "SquadB" EVE Online
- Finde alle Videos die mit diesem EVE Online Excel Workbook zu tun haben
- Gibt es Playlists? Wie heißen die Videos?
- Welche Features zeigt er in den Videos speziell?
- Gibt es Tutorials zur Benutzung der Excel?

### 2. Wichtige Fragen für unsere Implementierung
- Wie funktioniert der **Restock Automator** genau? (GAP = QTY - STOCK, dann TO BUY?)
- Wie berechnet er die **Build Costs** für Schiffe/Strukturen?
- Wie funktioniert die **Profit-Berechnung** (Build Cost vs Sell Price)?
- Welche **ESI Endpunkte** werden für die Excel-Daten verwendet?
- Wie管理 er **Multiple Characters** (Multiboxing)?
- Wie funktioniert die **Blueprint Integration** (ME/PE, BPC vs BPO)?
- Gibt es spezielle **Formeln oder Logiken** die wichtig sind?

### 3. Priorisierung
Der User ist Co-CEO einer Corporation (Revolution of Chaos). Seine Priorität:
1. Corp Integration (Assets + Restock für Corp)
2. Ship/Structure Manufacturing Calculator
3. Blueprint Management
4. Market/Selling Tools
5. Corp Member Tracker

## Ergebnis-Format
Bitte gib eine strukturierte Zusammenfassung:
1. Liste aller relevanten SquadB Videos (Titel, Kurzbeschreibung)
2. Detaillierte Erklärung der wichtigsten Excel-Features
3. Empfohlene Architektur für das Web-Tool
4. Wichtige ESI Endpunkte die wir brauchen
5. Formeln/Logiken die wir implementieren müssen
