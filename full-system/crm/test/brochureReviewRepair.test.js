'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const completeness = require('../src/services/brochureCompletenessService');
const page = {Page:1,Kind:'floor plan',HasConfigurations:true};
const candidate = {ProjectName:'THE ULTIMA',ConfigDetails:[{Type:'Apartment',CarpetAreaSqft:1000}],Amenities:[],Highlights:[]};
const approved = {Complete:true,Pages:[page],ConfigChecks:[{Index:0,Supported:true}],Findings:[]};
function harness(responses) {
 const prompts=[];
 const ctx={module:{exports:{}},Buffer,AbortSignal,structuredClone,process:{env:{GEMINI_API_KEY:'test',GEMINI_MODEL:'gemini-3.1-flash-lite'}},
 require:n=>n==='./brochureCompletenessService'?{...completeness,countPdfPages:async()=>1}:require(n),
 fetch:async(url,options)=>{
  assert.match(url,/gemini-3.1-flash-lite/);
  const body=JSON.parse(options.body);prompts.push(body.contents[0].parts[0].text);
  const result=responses.shift();assert.ok(result,'unexpected extra AI call');
  if(result.error)return {ok:false,status:503,json:async()=>({error:{message:result.error}})};
  return {ok:true,json:async()=>({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(result)}]}}]})};
 }};
 vm.runInNewContext(fs.readFileSync(require.resolve('../src/services/brochureExtractionService'),'utf8'),ctx);
 return {service:ctx.module.exports,prompts};
}
const pdf=Buffer.from('%PDF test').toString('base64');
test('Complete false exposes exact page findings instead of generic failure',()=>{
 assert.throws(()=>completeness.validateReview({...approved,Complete:false,Findings:[{Page:1,Issue:'Private terrace 500 sqft missing'}]},candidate,1),e=>e.code==='BROCHURE_REVIEW_FINDINGS' && /page 1: Private terrace 500/.test(e.message));
});
test('re-reads omissions once and requires a fresh complete review of corrected data',async()=>{
 const corrected={...candidate,Amenities:['Gym']};
 const h=harness([candidate,{...approved,Complete:false,Findings:[{Page:1,Issue:'Gym omitted'}]},corrected,approved]);
 const result=await h.service.extractBrochure(pdf);
 assert.equal(result.Amenities[0],'Gym');
 assert.equal(result.CompletenessReview.Status,'automated_checks_passed');
 assert.equal(h.prompts.length,4);assert.match(h.prompts[2],/Gym omitted/);
 assert.match(h.prompts[3],/"Gym"/);
});
test('malformed review retries only review, without weakening validation',async()=>{
 const h=harness([candidate,{Complete:true},approved]);
 const result=await h.service.extractBrochure(pdf);
 assert.equal(result.ProjectName,'THE ULTIMA');assert.equal(h.prompts.length,3);
 assert.match(h.prompts[2],/^Independently audit/);
});
test('persistent omissions fail closed after one correction and are not cached',async()=>{
 const bad={...approved,Complete:false,Findings:[{Page:1,Issue:'Terrace unreadable'}]};
 const h=harness([candidate,bad,candidate,bad,candidate,approved]);
 await assert.rejects(h.service.extractBrochure(pdf),/page 1: Terrace unreadable/);
 assert.equal(h.prompts.length,4);
 await h.service.extractBrochure(pdf);assert.equal(h.prompts.length,6);
});
test('upstream high demand does not trigger correction retries',async()=>{
 const h=harness([{error:'High demand'}]);
 await assert.rejects(h.service.extractBrochure(pdf),/High demand/);
 assert.equal(h.prompts.length,1);
});
test('printed terrace omission can be corrected but still requires independent review',async()=>{
 const missing={...candidate,SourceEvidence:['Page 1: Private Terrace 500 sqft']};
 const fixed={...missing,ConfigDetails:[...candidate.ConfigDetails,{Type:'Terrace Flat',TerraceAreaSqft:500}]};
 const review={...approved,ConfigChecks:[{Index:0,Supported:true},{Index:1,Supported:true}]};
 const h=harness([missing,fixed,review]);
 const result=await h.service.extractBrochure(pdf);
 assert.equal(result.ConfigDetails[1].TerraceAreaSqft,500);
 assert.equal(h.prompts.length,3);
});
