'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { V2Router } = require('../src/api/v2Router');
const { V2LeadService } = require('../src/services/v2LeadService');
const { BuilderProjectService } = require('../src/services/builderProjectService');

test('explicit requirement filters reject unknown values and accept matching known values', () => {
  const router = Object.create(V2Router.prototype);
  for (const filter of [{category:'Residential'}, {subCategory:'Flat'}, {txnType:'Purchase'}, {budgetMin:10,budgetMax:20}, {bhk:3}]) {
    assert.equal(router._reqMatchesFilters({}, filter, []), false);
  }
  assert.equal(router._reqMatchesFilters({Category:'Residential', BHKMin:3.5, BudgetMin:10, BudgetMax:20}, {category:'Residential', bhk:3, budgetMin:15,budgetMax:25}, []), true);
});

test('builder BHK supports decimal and legacy labels without fabricating unknown status', () => {
  const svc = new BuilderProjectService({list:()=>[
    {ProjectID:'numeric',ConfigDetails:[{Type:'Apartment',BHK:3.5}]},
    {ProjectID:'legacy',ConfigDetails:[{Type:'3.5 BHK'}]},
    {ProjectID:'other',ConfigDetails:[{Type:'Apartment',BHK:3}]}
  ]});
  assert.deepEqual(svc.list({bhk:'3.5 BHK'}).data.map(p=>p.ProjectID), ['numeric','legacy']);
  const normalized=svc._normalizePayload({ProjectStatus:'Unverified',ConfigDetails:[{Type:'Apartment',BHK:3.5},{Type:'Apartment',BHK:'3x5'}]});
  assert.equal(normalized.ConfigDetails[0].BHK,3.5);
  assert.equal(normalized.ConfigDetails[1].BHK,null);
  assert.equal(normalized.ProjectStatus,null);
});

test('client edit blocks duplicate normalized primary identity before writing', () => {
  const db={Leads:[{LeadID:'one',PrimaryMobile:'9876543210'}, {LeadID:'two',PrimaryMobile:'+91 87654-32109'}]};
  let writes=0;
  const svc=new V2LeadService({read:()=>db,write:()=>writes++});
  const result=svc.updateLead('one',{PrimaryMobile:'87654 32109'});
  assert.equal(result.ok,false);
  assert.equal(result.duplicateResult,'EXACT_MATCH');
  assert.equal(writes,0);
  assert.equal(db.Leads[0].PrimaryMobile,'9876543210');
});

test('contact clear respects explicit empty values and normalizes replacement mobile', () => {
  const db={Leads:[{LeadID:'one',PrimaryMobile:'9876543210',AlternateMobile:'8765432109',WhatsApp:'9876543210',Email:'old@example.com'}],Activities:[]};
  const svc=new V2LeadService({read:()=>db,write:()=>{},addTimelineEntry:()=>{}});
  const result=svc.updateLead('one',{PrimaryMobile:'+91 98765-43210',AlternateMobile:'',WhatsApp:null,Email:''});
  assert.equal(result.ok,true,result.error);
  assert.equal(db.Leads[0].PrimaryMobile,'9876543210');
  assert.equal(db.Leads[0].Phone,'9876543210');
  assert.equal(db.Leads[0].AlternateMobile,null);
  assert.equal(db.Leads[0].WhatsApp,null);
  assert.equal(db.Leads[0].Email,null);
});

test('client search normalizes formatted primary and alternate mobile numbers', () => {
  const router=Object.create(V2Router.prototype);
  router.repo={read:()=>({Leads:[
    {LeadID:'one',PrimaryMobile:'9876543210'},
    {LeadID:'two',PrimaryMobile:'8765432109',AlternateMobile:'+91 76543-21098'}
  ]})};
  router._enrichClientsForList=rows=>rows;
  assert.equal(router._queryClientsByNeed({q:'+91 98765-43210'}).data[0].LeadID,'one');
  assert.equal(router._queryClientsByNeed({q:'76543 21098'}).data[0].LeadID,'two');
});
