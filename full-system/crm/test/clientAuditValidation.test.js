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
