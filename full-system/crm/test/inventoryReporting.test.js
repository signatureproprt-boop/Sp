'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {JsonRepository}=require('../src/data/repository');
const {InventoryService}=require('../src/services/inventoryService');
test('inventory reports normalize saved listing fields and exclude deleted listings without changing stored data',()=>{
  const inventory=[{PropertyID:'P1',ListingFor:'Sale',Category:'Residential',SubCategory:'Flat',ListingStatus:'Off-market',Location1:'Vesu',ProjectName:'QA',Fields:{AskingPrice:2600,CarpetArea:1000}},
    {PropertyID:'P2',ListingStatus:'Under Offer',Category:'Commercial'}, {PropertyID:'DELETED',Status:'AVAILABLE',_deleted:true}];
  const db={Leads:[],Inventory:inventory},repo=Object.create(JsonRepository.prototype);repo.read=()=>db;
  const report=repo.getInventoryAnalytics({}, {role:'ADMIN'});
  assert.equal(report.ok,true);assert.equal(report.data.totalInventory,2);assert.equal(report.data.inactive,1);assert.equal(report.data.negotiation,1);assert.equal(report.data.averagePrice,2600);
  const filtered=repo.collectReportingDataset({transactionType:'Sale',location:'Vesu',project:'QA'}, {role:'ADMIN'});
  assert.equal(filtered.data.inventory.length,1);assert.equal(filtered.data.inventory[0].Price,2600);assert.equal(filtered.data.inventory[0].PropertyType,'Flat');
  assert.equal(inventory[0].Status,undefined);assert.equal(inventory[0].Price,undefined);
});
test('editing listing BHK and carpet area keeps matching and card fields consistent',()=>{
  const listing={PropertyID:'P1',Fields:{BHK:'3BHK',CarpetArea:900}},db={Inventory:[listing]};
  const service=new InventoryService({read:()=>db,write:()=>{}});
  service.update('P1',{BHK:'4BHK',CarpetArea:1200});
  assert.equal(listing.BHK,'4BHK');assert.equal(listing.Fields.BHK,'4BHK');assert.equal(listing.Fields.CarpetArea,1200);
  service.update('P1',{BHK:null,CarpetArea:null});assert.equal(listing.Fields.BHK,null);assert.equal(listing.Fields.CarpetArea,null);
});
