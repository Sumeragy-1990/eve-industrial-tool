#!/bin/bash
# fix_db_duplicates.sh
# Bereinigt doppelte/dreifache Mineralien in der Datenbank
# Einmalig ausführen, dann nie wieder nötig (der Code-Fix verhindert neue Duplikate)

set -e

echo "=== EVE Industrial Tool — DB Duplikate bereinigen ==="
echo ""

# Schritt 1: Vor dem Fix zählen
echo ">>> Vorher: Anzahl blueprint_materials Zeilen:"
docker exec eve-db psql -U eve -d eve_industrial -t -c "SELECT COUNT(*) FROM blueprint_materials;"

echo ""
echo ">>> Vorher: Anzahl DUPLIKATE (gleiche bp+activity+material):"
docker exec eve-db psql -U eve -d eve_industrial -t -c "
SELECT COUNT(*) FROM blueprint_materials
WHERE id NOT IN (
    SELECT MIN(id) FROM blueprint_materials 
    GROUP BY blueprint_type_id, activity_id, material_type_id
);"

echo ""
echo ">>> Bereinigung wird durchgeführt..."

# Schritt 2: Duplikate löschen (behält jeweils die älteste Zeile per MIN(id))
docker exec eve-db psql -U eve -d eve_industrial -c "
DELETE FROM blueprint_materials 
WHERE id NOT IN (
    SELECT MIN(id) FROM blueprint_materials 
    GROUP BY blueprint_type_id, activity_id, material_type_id
);"

echo ""
echo ">>> Nachher: Anzahl blueprint_materials Zeilen:"
docker exec eve-db psql -U eve -d eve_industrial -t -c "SELECT COUNT(*) FROM blueprint_materials;"

echo ""
echo ">>> Prüfe auf verbliebene Duplikate (sollte 0 sein):"
docker exec eve-db psql -U eve -d eve_industrial -t -c "
SELECT COUNT(*) FROM blueprint_materials
WHERE id NOT IN (
    SELECT MIN(id) FROM blueprint_materials 
    GROUP BY blueprint_type_id, activity_id, material_type_id
);"

echo ""
echo ">>> Preis-Cache Status:"
docker exec eve-db psql -U eve -d eve_industrial -t -c "SELECT COUNT(*) as cached_prices FROM cached_prices;"

echo ""
echo "=== Bereinigung abgeschlossen ==="
echo ""
echo "Nächste Schritte:"
echo "1. Wenn cached_prices = 0: curl -X POST http://192.168.178.24:8082/api/market/refresh"
echo "2. Browser Hard-Reload: Strg+Shift+R"
echo "3. Blueprint aufrufen und Mineralien prüfen — sollten jetzt nur 1x erscheinen"
