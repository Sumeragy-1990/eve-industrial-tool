const fs = require('fs');
const code = fs.readFileSync('backend/app/templates/static/js/bp-browser.js', 'utf8');

const fnMatch = code.match(/function _createSubOrdersRecursive\(buildSteps, parentOrderId, subComponents, meLevel, teLevel, parentConfig, depth\) \{[\s\S]*?\n                \}/);
if (!fnMatch) { console.log('ERROR: could not extract function'); process.exit(1); }

const hasFix = fnMatch[0].includes('{steps: _subS.sub_steps');
console.log('Fix: ' + (hasFix ? 'JA (v114)' : 'NEIN'));

const _productionOrders = [];
let _subCnt = 0;
let _activeOrderIndex = -1;
let _mainOrderIdx = 0;
const order = { id: 'test-123', order_number: '0001' };
_productionOrders.push(order);
_mainOrderIdx = 0;
function getEffectivePrice() { return { price: 1000 }; }

eval(fnMatch[0]);

const buildStepsData = {
    product_type_id: 20183, product_name: "Golem",
    steps: [{
        sub_steps: [
            { product_type_id: 638, product_name: "Raven", blueprint_type_id: 638, runs_needed: 1, materials: [{material_type_id:1}], sub_steps: [
                { product_type_id: 57479, product_name: "Core Temp Regulator", blueprint_type_id: 57479, runs_needed: 1, materials: [{material_type_id:2}], sub_steps: [] },
                { product_type_id: 57486, product_name: "Life Support Backup", blueprint_type_id: 57486, runs_needed: 25, materials: [{material_type_id:3}], sub_steps: [] },
                { product_type_id: 57478, product_name: "Auto-Integrity Seal", blueprint_type_id: 57478, runs_needed: 50, materials: [{material_type_id:4}], sub_steps: [] }
            ]},
            { product_type_id: 11478, product_name: "R.A.M.", blueprint_type_id: 11478, runs_needed: 1, materials: [{}], sub_steps: [] },
            { product_type_id: 11533, product_name: "Magpulse Thruster", blueprint_type_id: 11533, runs_needed: 375, materials: [{}], sub_steps: [] },
            { product_type_id: 11550, product_name: "Graviton Reactor", blueprint_type_id: 11550, runs_needed: 675, materials: [{}], sub_steps: [] },
            { product_type_id: 11534, product_name: "Gravimetric Sensor", blueprint_type_id: 11534, runs_needed: 863, materials: [{}], sub_steps: [] },
            { product_type_id: 11552, product_name: "Scalar Capacitor", blueprint_type_id: 11552, runs_needed: 3000, materials: [{}], sub_steps: [] },
            { product_type_id: 11558, product_name: "Sustained Shield", blueprint_type_id: 11558, runs_needed: 3795, materials: [{}], sub_steps: [] },
            { product_type_id: 11540, product_name: "Quantum Microprocessor", blueprint_type_id: 11540, runs_needed: 6000, materials: [{}], sub_steps: [] },
            { product_type_id: 11544, product_name: "Titanium Diborite", blueprint_type_id: 11544, runs_needed: 37500, materials: [{}], sub_steps: [] }
        ]
    }]
};

_createSubOrdersRecursive(buildStepsData, order.id, null, 10, 20, {}, 1);

const count = _productionOrders.length - 1;
console.log('Sub-Orders: ' + count + ' (expected 12)');
if (count !== 12) {
    for (var i = 1; i < _productionOrders.length; i++) {
        console.log('  ' + _productionOrders[i].name);
    }
    process.exit(1);
} else {
    console.log('PASS');
}
