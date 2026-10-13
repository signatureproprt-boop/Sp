'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {plan,summary,ExistingSheetRequirementService}=require('../src/services/existingSheetRequirementService');
const cell=v=>({userEnteredValue:{stringValue:v}});
const sheet=(rows,title='Comm',sheetId=1)=>({properties:{title,sheetId,gridProperties:{rowCount:10,columnCount:4}},data:[{rowData:[{values:['Lead ID','Phone','Requirement','Unrelated'].map(cell)},...rows.map(r=>({values:r.map(v=>typeof v==='string'?cell(v):v)}))]}]});
const db=()=>({Leads:[{LeadID:'L1',PrimaryMobile:'9876543210',RequirementType:'Rent',PropertyType:'Commercial',BudgetMax:100000,Location1:'Vesu'}],Requirements:[]});
test('writes exactly the existing Requirement cell and never adds or alters any other column or row',()=>{
  const input=db(),before=JSON.stringify(input);
  const s=sheet([['L1','+91 98765 43210','old','keep']]);
  const r=plan(input,[s]);assert.equal(r.requests.length,1);
  assert.deepEqual(r.requests[0].updateCells.range,{sheetId:1,startRowIndex:1,endRowIndex:2,startColumnIndex:2,endColumnIndex:3});
  assert.equal(r.requests[0].updateCells.fields,'userEnteredValue');
  const desired=r.requests[0].updateCells.rows[0].values[0].userEnteredValue.stringValue;
  assert.match(desired,/BudgetMax: 100000/);
  s.data[0].rowData[1].values[2]=cell(desired);
  assert.equal(plan(input,[s]).requests.length,0);
  input.Leads[0].BudgetMax=120000;
  assert.match(plan(input,[s]).requests[0].updateCells.rows[0].values[0].userEnteredValue.stringValue,/120000/);
  assert.equal(JSON.stringify(db()),before);
});
test('row sorting uses identity rather than saved row position',()=>{
 const s=sheet([['OTHER','9876543211','other','keep'],['L1','9876543210','old','keep']]);
 assert.equal(plan(db(),[s]).requests[0].updateCells.range.startRowIndex,2);
});
test('ambiguous identities, duplicate rows and changed phone are skipped',()=>{
 const s=sheet([['L1','9876543210','old','keep'],['L1','9876543210','old','keep']]);
 assert.equal(plan(db(),[s]).requests.length,0);
 const input=db(); input.Leads.push({...input.Leads[0]});
 assert.equal(plan(input,[sheet([['L1','9876543210','old','keep']])]).requests.length,0);
 assert.equal(plan(db(),[sheet([['L1','9876543211','old','keep']])]).requests.length,0);
});
test('imported preliminary data, formula cells and validation remain untouched',()=>{
 const input=db();input.Leads[0]={LeadID:'L1',PrimaryMobile:'9876543210',SheetBasicRequirements:[{BudgetMax:99999}]};
 assert.equal(plan(input,[sheet([['L1','9876543210','original','keep']])]).requests.length,0);
 for(const protectedCell of [{userEnteredValue:{formulaValue:'=A1'}},{...cell('old'),dataValidation:{condition:{type:'ONE_OF_LIST'}}}]) assert.equal(plan(db(),[sheet([['L1','9876543210',protectedCell,'keep']])]).requests.length,0);
});
test('multiple confirmed needs update one cell with current values and status',()=>{
 const input=db(); input.Requirements=[{LeadID:'L1',TransactionType:'Purchase',Category:'Residential',Fields:{BHKMin:{state:'KNOWN',value:3},BudgetMax:{state:'UNKNOWN',value:999}},RequirementStatus:'Active'},{LeadID:'L1',TransactionType:'Rent',Category:'Commercial',BudgetMax:30000,RequirementStatus:'Lost'}];
 const s=summary(input.Leads[0],input.Requirements); assert.match(s,/1\. Purchase/);assert.match(s,/BHKMin: 3/);assert.doesNotMatch(s,/999/);assert.match(s,/2\. Rent/);assert.match(s,/Status: Lost/);
 assert.equal(plan(input,[sheet([['L1','9876543210','old','keep']])]).requests.length,1);
});
test('sync reads live cell metadata and issues only precise content updates',async()=>{
 const tabs=['Comm','Sale','Rent'].map((title,i)=>sheet([['L1','9876543210','old','keep']],title,i));
 let calls=0,writes=[];
 const api={spreadsheets:{get:async({fields})=>{calls++; if(calls===2) assert.match(fields,/dataValidation/);return {data:{sheets:[...tabs,{properties:{title:'Hidden'}}]}}},batchUpdate:async({requestBody})=>{writes=requestBody.requests}}};
 const svc=new ExistingSheetRequirementService({sheets:api,spreadsheetId:'original'});
 const result=await svc.sync(db(),'v1');assert.equal(result.updated,3);assert.equal(writes.length,3);assert.ok(writes.every(r=>Object.keys(r).join()==='updateCells'));
 tabs[0].data[0].rowData[0].values[2]=cell('Missing requirement header');
 await assert.rejects(svc.sync(db(),'v2'),/headers/);
});
