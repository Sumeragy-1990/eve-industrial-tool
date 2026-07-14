/**
 * Runtime-Test: window.buyListCopyClipboard etc. NACH generateBuyList-Aufruf
 * Simuliert die Closure-Umgebung von exportBuyOrder
 */
const fs = require('fs');
const code = fs.readFileSync('backend/app/templates/static/js/bp-browser.js', 'utf8');

// Extrahiere generateBuyList + Helfer + exportBuyOrder + _buyListData
const buyListSection = code.match(/\/\/ ═══════════════════════════════════════════════\n\s+\/\/  ORDER BUY LIST \(Phase E\)[\s\S]*?GLOBAL BUILD CONFIG/s);
if (!buyListSection) {
    console.log('ERROR: buy list section not found');
    process.exit(1);
}

const section = buyListSection[0];
console.log('Section:', section.substring(0, 100) + '...');

// Prüfe ob alle 3 window-Zuweisungen in generateBuyList sind
const inGenerate = section.match(/\s+window\.buyListCopyClipboard\s*=\s*buyListCopyClipboard/g);
console.log('window.buyListCopyClipboard in section:', inGenerate ? inGenerate.length : 0);

// Prüfe ob Helfer-Funktionen als function declarations existieren
const fnClip = section.match(/function buyListCopyClipboard\(\)/);
const fnCsv = section.match(/function buyListExportCsv\(\)/);
const fnText = section.match(/function buyListExportText\(\)/);
console.log('buyListCopyClipboard declared:', !!fnClip);
console.log('buyListExportCsv declared:', !!fnCsv);
console.log('buyListExportText declared:', !!fnText);

// Simuliere den Scope
const _buyListData = [{name:'Test',qty:10}];
function _formatQty(n) { return n.toLocaleString(); }

// Definiere die Funktionen
eval(section.replace('let _buyListData = null;', ''));

if (typeof buyListCopyClipboard !== 'function') {
    console.log('FAIL: buyListCopyClipboard is', typeof buyListCopyClipboard);
} else {
    console.log('OK: buyListCopyClipboard is function');
}

if (typeof buyListExportText !== 'function') {
    console.log('FAIL: buyListExportText is', typeof buyListExportText);
} else {
    console.log('OK: buyListExportText is function');
}

// Simuliere generateBuyList window assignments
window = {};
eval(section.match(/\s+window\.buyListCopyClipboard\s*=\s*buyListCopyClipboard[\s\S]*?window\.buyListExportText\s*=\s*buyListExportText/)[0]);

console.log('After assignment - window.buyListCopyClipboard:', typeof window.buyListCopyClipboard);
console.log('After assignment - window.buyListExportText:', typeof window.buyListExportText);

if (typeof window.buyListCopyClipboard === 'function' && typeof window.buyListExportText === 'function') {
    console.log('\nPASS: Alle Buy-List Buttons sollten funktionieren');
} else {
    console.log('\nFAIL: Buttons würden nicht funktionieren');
    process.exit(1);
}
