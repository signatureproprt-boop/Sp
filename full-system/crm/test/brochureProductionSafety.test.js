'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync(require.resolve('../builder-projects.html'),'utf8');
test('individual auto-fill leaves form unchanged for another project or missing name',async()=>{
 const start=html.indexOf('  let brochureReadInProgress = false;'),end=html.indexOf('  function applyAutoFill(',start);
 const messages=[];let applied=0;
 const elements={'f-project-name':{value:'THE ULTIMA'},'autofill-status':{textContent:''},'project-modal':{classList:{contains:()=>false}}};
 const ctx={document:{getElementById:id=>elements[id]},editingId:'project',MEDIA_LIMITS:{brochure:999},pendingBrochureFile:null,
 fileToBase64Full:async()=> 'cGRm',requestBrochureExtraction:async()=>({ok:true,data:{ProjectName:'THE ULTIMA II'}}),toast:m=>messages.push(m),applyAutoFill:()=>applied++};
 vm.createContext(ctx);vm.runInContext(html.slice(start,end),ctx);
 await ctx.onBrochureAutoFill({size:1});assert.equal(applied,0);assert.match(messages[0],/does not match THE ULTIMA/);
 ctx.requestBrochureExtraction=async()=>({ok:true,data:{}});await ctx.onBrochureAutoFill({size:1});assert.equal(applied,0);
 ctx.requestBrochureExtraction=async()=>({ok:true,data:{ProjectName:'the ultima',ConfigDetails:[]}});
 await ctx.onBrochureAutoFill({size:1});assert.equal(applied,1);
});
test('cards explicitly label missing areas while retaining printed values',()=>{
 const start=html.indexOf('    const facts = [];',html.indexOf('  function renderCard(')),end=html.indexOf('    if (p.TotalUnits)',start);
 const ctx={p:{ConfigDetails:[{Type:'Apartment',BHK:3,CarpetAreaSqft:null,SuperBuiltUpAreaSqft:2500}]},groupedConfigDetails:rows=>rows};
 vm.createContext(ctx);vm.runInContext('{'+html.slice(start,end)+';result=facts.join(" ");}',ctx);
 assert.match(ctx.result,/Carpet: not provided/);assert.match(ctx.result,/2500 super built-up sqft/);
 ctx.p.ConfigDetails=[{Type:'Apartment',BHK:4,CarpetAreaSqft:1500,SuperBuiltUpAreaSqft:null}];
 vm.runInContext('{'+html.slice(start,end)+';result=facts.join(" ");}',ctx);
 assert.match(ctx.result,/1500 carpet sqft/);assert.match(ctx.result,/Saleable \/ super built-up: not provided/);
});
test('provider capacity errors preserve typed status and full retry delay',async()=>{
 const ctx={module:{exports:{}},Buffer,structuredClone,AbortSignal,Date,process:{env:{GEMINI_API_KEY:'test',GEMINI_MODEL:'gemini-3.1-flash-lite'}},
 require:n=>n==='./brochureCompletenessService'?{...require('../src/services/brochureCompletenessService'),countPdfPages:async()=>1}:require(n),
 fetch:async()=>({ok:false,status:429,headers:{get:()=> '90'},json:async()=>({error:{message:'Quota exceeded',details:[{retryDelay:'67000s'}]}})})};
 vm.runInNewContext(fs.readFileSync(require.resolve('../src/services/brochureExtractionService'),'utf8'),ctx);
 await assert.rejects(ctx.module.exports.extractBrochure(Buffer.from('%PDF test').toString('base64')),e=>e.code==='AI_RATE_LIMIT'&&e.status===429&&e.retryAfterSeconds===67000);
});
