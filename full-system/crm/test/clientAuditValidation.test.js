'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {V2LeadService,isValidPhone}=require('../src/services/v2LeadService');
test('invalid identity is rejected before client create or edit writes',()=>{
 const db={Leads:[{LeadID:'L1',PrimaryMobile:'9876543210'}]};
 let writes=0;
 const svc=new V2LeadService({read:()=>db,write:()=>writes++});
 for(const phone of ['0000000000','abc','abc9876543210','123','']){
  assert.equal(svc.createLead({ClientName:'Audit',PrimaryMobile:phone}).ok,false);
  assert.equal(svc.updateLead('L1',{PrimaryMobile:phone}).ok,false);
 }
 assert.equal(writes,0);
 assert.equal(isValidPhone('+91 98765-43210'),true);
});

test('unchanged client score reads do not queue snapshots or alter client edit time',()=>{
 const {V2ScoringService}=require('../src/services/v2ScoringService');
 const db={Leads:[{LeadID:'L1',UpdatedAt:'2026-01-01'}]};
 let writes=0;
 const svc=new V2ScoringService({read:()=>db,write:()=>writes++});
 let score=25;
 svc.calculateClientScore=()=>({ok:true,score,calculationVersion:'test',calculatedAt:new Date().toISOString(),factors:[]});
 assert.equal(svc.recalculateClientScore('L1').ok,true);
 assert.equal(svc.recalculateClientScore('L1').unchanged,true);
 assert.equal(writes,1);
 assert.equal(db.Leads[0].UpdatedAt,'2026-01-01');
 score=50;
 assert.equal(svc.recalculateClientScore('L1').ok,true);
 assert.equal(writes,2);
});
