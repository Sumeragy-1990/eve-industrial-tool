#!/usr/bin/env bash
# ── EVE Industrial Tool – Backup Helper ─────────────────────────
# Erstellt einen Git-Commit + Datei-Backup vor Änderungen.
# Aufruf: ./_backup.sh "beschreibung der aktuellen änderungen"
# ───────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(git rev-list --count HEAD 2>/dev/null || echo "0")
COMMENT="${1:-checkpoint}"
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
DATE=$(date +%Y%m%d_%H%M%S)
TAG="v1.${VERSION}"

echo "════════════════════════════════════════════════════════════"
echo " Backup: ${TAG} — ${COMMENT}"
echo "═══════════════════════════════════════════════════════════"

# 1. Backup aller geänderten Dateien ins _backups/ Verzeichnis
mkdir -p "_backups/${TAG}"
for f in $(git ls-files --modified --others --exclude-standard 2>/dev/null); do
    mkdir -p "_backups/${TAG}/$(dirname "$f")"
    cp "$f" "_backups/${TAG}/${f}" 2>/dev/null || true
done
echo "   ✓ Dateien gesichert nach _backups/${TAG}/"

# 2. Git-Commit (nur wenn es Änderungen gibt)
if git diff --quiet && git diff --cached --quiet; then
    echo "   − Keine Änderungen zu committen"
else
    git add -A
    git commit -m "v${VERSION}: ${COMMENT}"
    echo "   ✓ Commit: v${VERSION} — ${COMMENT}"
fi

echo "═══════════════════════════════════════════════════════════"
