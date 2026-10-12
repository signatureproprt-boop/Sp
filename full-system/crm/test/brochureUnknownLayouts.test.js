const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const ctx = {module:{exports:{}},require:name=>name==='node:crypto'?require(name):{},Set,Map};
vm.runInNewContext(fs.readFileSync(__dirname+'/../src/services/uploadedBrochureBatchService.js','utf8'),ctx);
const {grouped}=ctx.module.exports;
test('unknown-area numbered layouts remain separate',()=>{
 const rows=grouped([{Tower:'A',FlatType:'1',Type:'Apartment',BHK:3},{Tower:'A',FlatType:'2',Type:'Apartment',BHK:3}]);
 assert.equal(rows.length,2);
});
test('unlabelled unknown-area layouts do not merge across towers',()=>{
 assert.equal(grouped([{Tower:'A',Type:'Apartment',BHK:3},{Tower:'B',Type:'Apartment',BHK:3}]).length,2);
});
test('known matching layouts combine towers while private terrace variants stay separate',()=>{
 const rows=grouped([{Tower:'A',FlatType:'1',Type:'Apartment',BHK:3,CarpetAreaSqft:1200},{Tower:'B',FlatType:'2',Type:'Apartment',BHK:3,CarpetAreaSqft:1200},{Tower:'A',FlatType:'1',Type:'Terrace Flat',BHK:3,CarpetAreaSqft:1200,TerraceAreaSqft:400},{Tower:'B',FlatType:'2',Type:'Terrace Flat',BHK:3,CarpetAreaSqft:1200,TerraceAreaSqft:500}]);
 assert.equal(rows.length,3);assert.equal(rows[0].Tower,'A/B');assert.equal(rows[1].TerraceAreaSqft,400);assert.equal(rows[2].TerraceAreaSqft,500);
});
