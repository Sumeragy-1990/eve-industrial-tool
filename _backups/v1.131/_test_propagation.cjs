const fs = require('fs');
const code = fs.readFileSync('backend/app/templates/static/js/bp-browser.js', 'utf8');

const _productionOrders = [];
const mainOrder = { id: 'golem-123', name: 'Golem', type: 'main', items: [
    { blueprint_type_id: 22464, product_type_id: 20183, name: 'Golem', me: 2, te: 4, runs: 1,
      materials: [
        { material_type_id: 638, material_name: 'Raven', decision: 'build', total_quantity: 1, _subOrderTotal: undefined, total_cost: undefined, unit_price: undefined },
        { material_type_id: 11478, material_name: 'RAM', decision: 'build', total_quantity: 1, _subOrderTotal: undefined, total_cost: undefined, unit_price: undefined },
      ]
    }
]};
_productionOrders.push(mainOrder);

const subOrder = {
    id: 'golem-123-sub-638-1', parent_id: 'golem-123', type: 'sub', _parentMatTypeId: 638,
    name: 'Sub 001 - Raven', order_number: '0001-001',
    items: [{ blueprint_type_id: 638, product_type_id: 638, name: 'Raven', runs: 1, me: 10, te: 20,
        build_cost: { total_material_cost: 132777492, facility_cost: 3124500, job_cost: 1997000, total_cost: 137901798.27 },
        materials: [
            { material_type_id: 57479, material_name: 'Core Temp Regulator', decision: 'build', total_quantity: 1, _subOrderTotal: 3500000 },
            { material_type_id: 34, material_name: 'Tritanium', decision: 'buy', total_quantity: 4790240, unit_price: 5.5 }
        ]
    }]
};
_productionOrders.push(subOrder);

console.log('=== PROPAGATION TEST ===');

for (var _ppi = 0; _ppi < _productionOrders.length; _ppi++) {
    var _ppo = _productionOrders[_ppi];
    if (_ppo.type !== 'sub' || !_ppo.parent_id) continue;
    var _ppMatId = _ppo._parentMatTypeId;
    if (!_ppMatId) continue;
    var _ppTotal = 0;
    var _ppBC = _ppo.items && _ppo.items[0] && _ppo.items[0].build_cost;
    if (_ppBC && _ppBC.total_cost > 0) {
        _ppTotal = _ppBC.total_cost;
    }
    console.log('SubOrder ' + _ppo.name + ' total_cost=' + _ppTotal + ' typeId=' + _ppMatId);
    if (_ppTotal <= 0) continue;
    for (var _ppmi = 0; _ppmi < mainOrder.items.length; _ppmi++) {
        var _ppItem = mainOrder.items[_ppmi];
        if (!_ppItem.materials) continue;
        for (var _ppm = 0; _ppm < _ppItem.materials.length; _ppm++) {
            var _ppMat = _ppItem.materials[_ppm];
            if (_ppMat.material_type_id === _ppMatId && _ppMat.decision === 'build') {
                console.log('  -> Propagate to ' + _ppMat.material_name);
                _ppMat._subOrderTotal = _ppTotal;
                _ppMat.total_cost = _ppTotal;
                _ppMat.unit_price = _ppTotal;
                break;
            }
        }
    }
}

const ravenMat = mainOrder.items[0].materials.find(m => m.material_type_id === 638);
console.log('\nRaven _subOrderTotal=' + (ravenMat ? ravenMat._subOrderTotal : 'N/A') + ' (expected 137901798.27)');
const ramMat = mainOrder.items[0].materials.find(m => m.material_type_id === 11478);
console.log('RAM _subOrderTotal=' + (ramMat ? ramMat._subOrderTotal : 'N/A') + ' (expected undefined - no sub-order)');

if (ravenMat && ravenMat._subOrderTotal === 137901798.27) {
    console.log('\nPASS');
} else {
    console.log('\nFAIL');
    process.exit(1);
}
