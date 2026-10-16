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
