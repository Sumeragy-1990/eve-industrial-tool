/**
 * Self-Test: Buy List Buttons
 * Prüft ob generateBuyList und buyListCopyClipboard etc. korrekt exponiert sind.
 */
const fs = require('fs');
const code = fs.readFileSync('backend/app/templates/static/js/bp-browser.js', 'utf8');

let errors = [];
function check(desc, condition) {
    if (condition) {
        console.log('  ✓ ' + desc);
    } else {
        console.log('  ✗ ' + desc);
        errors.push(desc);
    }
}

console.log('=== Buy-List Button Self-Test ===');

// 1. BP.generateBuyList muss existieren
const bpGenerateBuyList = code.match(/generateBuyList:\s*generateBuyList/);
check('BP.generateBuyList exportiert', bpGenerateBuyList !== null);

// 2. generateBuyList Funktion muss definiert sein
const fnMatch = code.match(/async function generateBuyList\(\)/);
check('generateBuyList Funktion definiert', fnMatch !== null);

// 3. window.buyListCopyClipboard muss in generateBuyList gesetzt werden
const winClip = code.match(/window\.buyListCopyClipboard\s*=\s*buyListCopyClipboard/);
check('window.buyListCopyClipboard = buyListCopyClipboard', winClip !== null);

// 4. Alle 3 Helfer müssen gesetzt werden
const winCsv = code.match(/window\.buyListExportCsv\s*=\s*buyListExportCsv/);
check('window.buyListExportCsv = buyListExportCsv', winCsv !== null);
const winText = code.match(/window\.buyListExportText\s*=\s*buyListExportText/);
check('window.buyListExportText = buyListExportText', winText !== null);

// 5. Helper functions müssen definiert sein
const fnClip = code.match(/function buyListCopyClipboard\(\)/);
check('buyListCopyClipboard Funktion definiert', fnClip !== null);
const fnCsv = code.match(/function buyListExportCsv\(\)/);
check('buyListExportCsv Funktion definiert', fnCsv !== null);
const fnText = code.match(/function buyListExportText\(\)/);
check('buyListExportText Funktion definiert', fnText !== null);

// 6. HTML onclick Handler
const html = fs.readFileSync('backend/app/templates/blueprints.html', 'utf8');
const htmlClip = html.match(/onclick="buyListCopyClipboard\(\)"/);
check('HTML buyListCopyClipboard onclick', htmlClip !== null);
const htmlCsv = html.match(/onclick="buyListExportCsv\(\)"/);
check('HTML buyListExportCsv onclick', htmlCsv !== null);
const htmlText = html.match(/onclick="buyListExportText\(\)"/);
check('HTML buyListExportText onclick', htmlText !== null);

// 7. BP.generateBuyList darf NICHT in exportBuyOrder sein (muss IIFE-Ebene sein)
// Finde generateBuyList: im BP namespace
const bpNamespace = code.match(/window\.BP\s*=\s*\{[\s\S]*?generateBuyList:\s*generateBuyList[\s\S]*?\};/);
check('generateBuyList im BP namespace', bpNamespace !== null);

// 8. generateBuyList muss VOR window.BP definiert sein
const gblIdx = code.indexOf('async function generateBuyList()');
const bpIdx = code.indexOf('window.BP = {');
check('generateBuyList vor BP definiert', gblIdx > 0 && bpIdx > 0 && gblIdx < bpIdx);

console.log('');
if (errors.length === 0) {
    console.log('✓ ALLE TESTS BESTANDEN');
} else {
    console.log('✗ ' + errors.length + ' FEHLER:');
    errors.forEach(e => console.log('  - ' + e));
    process.exit(1);
}
