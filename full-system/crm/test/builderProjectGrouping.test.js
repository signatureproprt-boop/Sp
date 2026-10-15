const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync(require('node:path').join(__dirname,'../builder-projects.html'),'utf8');
function context(fetch){
  const elements=new Map();
  const scope=vm.createContext({URLSearchParams,fetch,window:{addEventListener(){}},document:{getElementById(id){if(!elements.has(id))elements.set(id,{value:'',innerHTML:''});return elements.get(id);}}});
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],scope);
  vm.runInContext('render = function() {}; updateBuilderNameOptions = function() {};',scope);
  return {scope,elements};
}
test('complete groups include later API pages with the same filters',async()=>{
  const queries=[];
  const {scope}=context(async url=>{const q=new URL(url,'http://test').searchParams;queries.push(q);return {ok:true,json:async()=>({ok:true,data:[{ProjectID:q.get('page')}],pagination:{total:2,totalPages:2}})};});
  vm.runInContext("projectGrouping='category-location-builder'; currentCategory='Residential'; document.getElementById('filter-location').value='Vesu';",scope);
  await vm.runInContext('loadProjects()',scope);
  assert.equal(vm.runInContext('allProjects.length',scope),2);
  assert.equal(queries[1].get('category'),'Residential');assert.equal(queries[1].get('location'),'Vesu');
  assert.equal(queries[1].get('page'),'2');
});
test('groups normalize location case, retain unknowns and escape names',()=>{
  const {scope}=context();
  vm.runInContext('renderCard = p => p.ProjectID;',scope);
  const result=vm.runInContext(`renderProjectGroups([{ProjectID:'A',Category:'Residential',Location1:' vesu ',BuilderName:'<Builder>'},{ProjectID:'B',Category:'Residential',Location1:'Vesu',BuilderName:'<Builder>'},{ProjectID:'C'}],['category','location','builder'])`,scope);
  assert.match(result.replace(/<[^>]*>/g,' ').replace(/\s+/g,' '),/Vesu 2 projects/);assert.match(result,/&lt;Builder&gt;/);assert.match(result,/Location not set/);assert.match(result,/Unknown Builder/);assert.match(result,/Uncategorized/);
  assert.equal(vm.runInContext("groupLabel({Category:'Marketing description'}, 'category')",scope),'Category needs review');
  assert.equal(vm.runInContext("groupLabel({Category:' residential '}, 'category')",scope),'Residential');
});
test('failed later page does not display incomplete groups',async()=>{
  const {scope,elements}=context(async url=>({ok:true,json:async()=>new URL(url,'http://test').searchParams.get('page')==='1'?{ok:true,data:[{ProjectID:'A'}],pagination:{totalPages:2}}:{ok:false,error:'Second page unavailable'}}));
  vm.runInContext("projectGrouping='category-location-builder'",scope);
  await vm.runInContext('loadProjects()',scope);
  assert.match(elements.get('grid').innerHTML,/Failed to load: Second page unavailable/);
  assert.equal(vm.runInContext('allProjects.length',scope),0);
});
