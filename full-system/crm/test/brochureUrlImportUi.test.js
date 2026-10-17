'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync(require.resolve('../builder-projects.html'),'utf8');
const start=html.indexOf('  async function importMediaFromUrl()');
const code=html.slice(start,html.indexOf('  // ── Fix Unknown Builders',start));
function setup({kind='brochure',refreshFailure=false,wrongProject=false,switchProject=false}={}) {
 const initial={ProjectID:'one',ProjectName:'Aagam Shopping World'},updated={...initial,Brochures:[{MediaID:'stored-pdf'}]},calls=[],messages=[],rendered=[];
 const elements={'media-url-kind':{value:kind},'media-url-input':{value:'https://example.com/source.pdf'},'media-status':{textContent:''}},button={disabled:false};
 const ctx={editingId:'one',allProjects:[initial],document:{getElementById:id=>elements[id],querySelector:()=>button},toast:m=>messages.push(m),renderMediaSection:p=>rendered.push(p),render:()=>{},fetch:async(url,options)=>{
 calls.push({url,options});
 if(options?.method==='POST'){if(switchProject)ctx.editingId='two';return {ok:true,status:200,json:async()=>({ok:true,data:kind==='brochure'?{projectId:'one',mediaResults:[]}:(wrongProject?{ProjectID:'other'}:updated)})};}
 return {ok:!refreshFailure,json:async()=>({ok:!refreshFailure,data:wrongProject?{ProjectID:'other'}:updated})};
 }};vm.createContext(ctx);vm.runInContext(code,ctx);return {ctx,calls,messages,rendered,elements,button,initial};
}
test('brochure migration report cannot replace project row or hide stored PDF',async()=>{
 const s=setup();await s.ctx.importMediaFromUrl();assert.equal(s.calls.length,2);assert.equal(s.calls[1].url,'/api/v2/builder-projects/one');assert.equal(s.ctx.allProjects[0].ProjectName,'Aagam Shopping World');assert.equal(s.rendered[0].Brochures[0].MediaID,'stored-pdf');assert.equal(s.messages.length,0);assert.equal(s.button.disabled,false);
});
test('failed refresh or mismatched project preserves original directory row',async()=>{
 for(const options of [{refreshFailure:true},{wrongProject:true}]){const s=setup(options);await s.ctx.importMediaFromUrl();assert.equal(s.ctx.allProjects[0],s.initial);assert.equal(s.rendered.length,0);assert.equal(s.messages.length,1);assert.equal(s.button.disabled,false);}
});
test('photo imports retain direct project response',async()=>{const s=setup({kind:'photo'});await s.ctx.importMediaFromUrl();assert.equal(s.calls.length,1);assert.equal(s.rendered[0].ProjectID,'one');});
test('completion after project switch cannot paint old media into new form',async()=>{const s=setup({switchProject:true});await s.ctx.importMediaFromUrl();assert.equal(s.calls[1].url,'/api/v2/builder-projects/one');assert.equal(s.ctx.allProjects[0].ProjectID,'one');assert.equal(s.rendered.length,0);assert.equal(s.elements['media-url-input'].value,'https://example.com/source.pdf');});
