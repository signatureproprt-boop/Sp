'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const completeness=require('../src/services/brochureCompletenessService');
test('brochure vision model is independent of the lightweight general model and supports a dedicated override',async()=>{
 for(const [env,expected] of [
  [{GEMINI_MODEL:'gemini-3.1-flash-lite'},'gemini-3.8-flash'],
  [{GEMINI_MODEL:'gemini-3.1-flash-lite',GEMINI_AGENT_MODEL:'configured-vision'},'configured-vision'],
  [{GEMINI_AGENT_MODEL:'configured-vision',GEMINI_BROCHURE_MODEL:'brochure-override'},'brochure-override']
 ]){
  let calls=0;
  const ctx={module:{exports:{}},Buffer,AbortSignal,structuredClone,process:{env:{GEMINI_API_KEY:'test',...env}},
   require:n=>n==='./brochureCompletenessService'?{...completeness,countPdfPages:async()=>1}:require(n),
   fetch:async(url)=>{assert.ok(url.includes('/'+expected+':generateContent'));calls++;return {ok:true,json:async()=>({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(calls===1?{ProjectName:'Kronis'}:{Complete:true,Pages:[{Page:1,Kind:'cover',HasConfigurations:false}],ConfigChecks:[],Findings:[]})}]}}]})};}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/services/brochureExtractionService'),'utf8'),ctx);
  assert.equal((await ctx.module.exports.extractBrochure(Buffer.from('%PDF fixture').toString('base64'))).ProjectName,'Kronis');assert.equal(calls,2);
 }
});

function overloadHarness(responses) {
 const calls=[];
 const ctx={module:{exports:{}},Buffer,AbortSignal,structuredClone,process:{env:{GEMINI_API_KEY:'test'}},
 require:n=>n==='./brochureCompletenessService'?{...completeness,countPdfPages:async()=>1}:require(n),
 fetch:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});const item=responses.shift();assert.ok(item,'unbounded extra call');return item.status?{ok:false,status:item.status,json:async()=>({error:{message:'Provider unavailable'}})}:{ok:true,json:async()=>({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(item)}]}}]})};}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../src/services/brochureExtractionService'),'utf8'),ctx);
 return {service:ctx.module.exports,calls};
}
const approval={Complete:true,Pages:[{Page:1,Kind:'cover',HasConfigurations:false}],ConfigChecks:[],Findings:[]};
const fixture=Buffer.from('%PDF overload fixture').toString('base64');
test('503 switches to alternate full vision model and still independently reviews',async()=>{
 const h=overloadHarness([{status:503},{ProjectName:'Kronis'},approval]);
 assert.equal((await h.service.extractBrochure(fixture)).ProjectName,'Kronis');
 assert.match(h.calls[0].url,/gemini-3.8-flash/);
 assert.ok(h.calls.slice(1).every(c=>c.url.includes('gemini-3.6-flash')));
 assert.equal(h.calls[1].body.generationConfig.thinkingConfig.thinkingLevel,'medium');
 assert.ok(h.calls[2].body.generationConfig.responseJsonSchema);
});
test('quota/authentication failures never trigger an alternate-model request',async()=>{
 for(const status of [429,401,403]){
  const h=overloadHarness([{status}]);
  await assert.rejects(h.service.extractBrochure(fixture),e=>e.status===status);
  assert.equal(h.calls.length,1);
 }
});
test('fallback shares the original overload limit and cannot loop',async()=>{
 const h=overloadHarness([{status:503},{status:503},{status:503}]);
 await assert.rejects(h.service.extractBrochure(fixture),e=>e.status===503);
 assert.equal(h.calls.length,3);
});
test('review overload can switch models without re-extracting or skipping review',async()=>{
 const h=overloadHarness([{ProjectName:'Kronis'},{status:503},approval]);
 assert.equal((await h.service.extractBrochure(fixture)).ProjectName,'Kronis');
 assert.equal(h.calls.length,3);
 assert.match(h.calls[1].body.contents[0].parts[0].text,/^Independently audit/);
 assert.match(h.calls[2].body.contents[0].parts[0].text,/^Independently audit/);
 assert.match(h.calls[2].url,/gemini-3.6-flash/);
});
