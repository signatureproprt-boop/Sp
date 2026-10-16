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
 await ctx.onBrochureAutoFill({size:1});assert.equal(applied,0);assert.match(elements['autofill-status'].textContent,/does not match THE ULTIMA/);
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
test('manual edits during reading survive without an AI overwrite, including configuration edits',async()=>{
 const start=html.indexOf('  let brochureReadInProgress = false;'),end=html.indexOf('  function applyAutoFill(',start);
 for (const edit of ['scalar','configuration']) {
  const elements={'f-project-name':{value:'THE ULTIMA'},'f-location1':{value:'Vesu'},'autofill-status':{textContent:''},'project-modal':{classList:{contains:()=>false}}};
  let applied=0;
  const ctx={document:{getElementById:id=>elements[id]},editingId:'project',configRows:[{BHK:3}],MEDIA_LIMITS:{brochure:999},pendingBrochureFile:null,
   fileToBase64Full:async()=> 'cGRm',toast:()=>{},applyAutoFill:()=>applied++};
  ctx.requestBrochureExtraction=async()=>{
   if(edit==='scalar') elements['f-location1'].value='Althan'; else ctx.configRows[0].BHK=5;
   return {ok:true,data:{ProjectName:'THE ULTIMA',Location1:'Surat',ConfigDetails:[{BHK:4}]}};
  };
  vm.createContext(ctx);vm.runInContext(html.slice(start,end),ctx);
  await ctx.onBrochureAutoFill({size:1});
  assert.equal(applied,0);
  assert.match(elements['autofill-status'].textContent,/Form edited.*Your edits were kept/);
  assert.equal(elements['f-location1'].value,edit==='scalar'?'Althan':'Vesu');
  assert.equal(ctx.configRows[0].BHK,edit==='configuration'?5:3);
 }
});
test('provider capacity errors preserve typed status and full retry delay',async()=>{
 const ctx={module:{exports:{}},Buffer,structuredClone,AbortSignal,Date,process:{env:{GEMINI_API_KEY:'test',GEMINI_BROCHURE_MODEL:'gemini-3.1-flash-lite'}},
 require:n=>n==='./brochureCompletenessService'?{...require('../src/services/brochureCompletenessService'),countPdfPages:async()=>1}:require(n),
 fetch:async()=>({ok:false,status:429,headers:{get:()=> '90'},json:async()=>({error:{message:'Quota exceeded',details:[{retryDelay:'67000s'}]}})})};
 vm.runInNewContext(fs.readFileSync(require.resolve('../src/services/brochureExtractionService'),'utf8'),ctx);
 await assert.rejects(ctx.module.exports.extractBrochure(Buffer.from('%PDF test').toString('base64')),e=>e.code==='AI_RATE_LIMIT'&&e.status===429&&e.retryAfterSeconds===67000);
});

test('frontend stops after capacity cooldown instead of spinning through PDFs',async()=>{
 const start=html.indexOf('  let uploadedBatch = null,'),end=html.indexOf('  async function retryUploadedBrochureBatch()',start);
 const elements={};const element=id=>elements[id]||(elements[id]={textContent:'',innerHTML:'',disabled:false});
 const ready={JobID:'job',Projects:2,Total:2,Saved:0,Failed:0,Pending:2,WithoutStoredBrochure:0,Items:[],Status:'ready'};
 const paused={...ready,Status:'cooldown',NextRetryAt:'2099-01-01T00:00:00Z',PauseReason:'High demand'};
 let steps=0;
 const ctx={document:{getElementById:element},esc:String,AbortController,setTimeout,clearTimeout,loadProjects:async()=>{},fetch:async(_url,opt)=>{
   const data=opt?.method==='POST'?(steps++,paused):ready;
   return {ok:true,status:200,json:async()=>({ok:true,data}),text:async()=>JSON.stringify({ok:true,data})};
 }};
 vm.createContext(ctx);vm.runInContext(html.slice(start,end),ctx);await ctx.startUploadedBrochureBatch();
 assert.equal(steps,1);assert.equal(element('uploaded-batch-start').disabled,false);
 assert.match(element('uploaded-batch-summary').textContent,/Paused — AI unavailable/);
 assert.doesNotMatch(element('uploaded-batch-summary').textContent,/Processing/);
});
