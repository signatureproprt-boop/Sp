const test=require('node:test'),assert=require('node:assert/strict');
const {validateReview}=require('../src/services/brochureCompletenessService');
function review(Field,ConfigIndex=null){return {Complete:true,Pages:[{Page:1,Kind:'floor plan',HasConfigurations:true}],ConfigChecks:[{Index:0,Supported:true,Page:1}],Findings:[{Page:1,Kind:'not_stated',Field,ConfigIndex,Issue:'Not printed in source'}]};}
test('all missing schema facts are reviewed without inventing a value',()=>{
 for(const field of ['ProjectName','Overview'])assert.equal(validateReview(review(field),{ConfigDetails:[{}]},1).Status,'automated_checks_passed');
 for(const field of ['Tower','FlatType','Type','BHK']){
  assert.equal(validateReview(review(field,0),{ConfigDetails:[{[field]:null}]},1).Status,'automated_checks_passed');
  assert.throws(()=>validateReview(review(field,0),{ConfigDetails:[{[field]:3}]},1),/unsupported extracted value/);
 }
 assert.throws(()=>validateReview(review('InventedField'),{ConfigDetails:[{}]},1),/InventedField/);
});
