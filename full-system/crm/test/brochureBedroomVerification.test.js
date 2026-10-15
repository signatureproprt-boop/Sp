const test=require('node:test'),assert=require('node:assert/strict');
const {validateReview,reviewPrompt}=require('../src/services/brochureCompletenessService');
const data={ConfigDetails:[{Tower:'I/J',Type:'Apartment',BHK:4}]};
function review(count){return {Complete:true,Pages:[{Page:1,Kind:'floor plan',HasConfigurations:true}],ConfigChecks:[{Index:0,Supported:true,Page:1,BedroomCount:count,BedroomCountSource:'Count of BEDROOM-labelled rooms within one apartment; servant excluded'}],Findings:[]};}
test('rejects a five-bedroom plan misread as four BHK even when marked supported',()=>{
 assert.throws(()=>validateReview(review(5),data,1),e=>e.code==='BROCHURE_REVIEW_FINDINGS'&&/counted 5/.test(e.message));
 assert.equal(validateReview(review(5),{ConfigDetails:[{Tower:'I/J',BHK:5}]},1).Status,'automated_checks_passed');
});
test('every known BHK requires independent page-bound count evidence',()=>{
 const missing=review(4);delete missing.ConfigChecks[0].BedroomCount;assert.throws(()=>validateReview(missing,data,1),/bedroom count evidence/);
 const wrong=review(4);wrong.ConfigChecks[0].Page=2;assert.throws(()=>validateReview(wrong,data,1),/page-bound/);
 assert.match(reviewPrompt(data,1),/exclude servant\/staff rooms/);
});
