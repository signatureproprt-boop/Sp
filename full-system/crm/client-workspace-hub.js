
let clients=[];
let queryState={page:1,limit:24,total:0,totalPages:1,loading:false};
let searchTimer=null;
const esc=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const enc=s=>encodeURIComponent(s||'');
function safePhone(v){const raw=String(v??'').trim();if(!raw||/^(#|error|n\/a|na|null|undefined|-+)$/i.test(raw)||raw.includes('#ERROR'))return '';const digits=raw.replace(/\D/g,'');return digits.length>=7?digits:'';}
function phoneLabel(v){return safePhone(v)?String(v).trim():'Phone unavailable';}
async function doLogout(){await fetch('/api/auth/logout',{method:'POST',credentials:'include'}).catch(()=>{});window.location.href='/login.html';}
function norm(v){const a={Verified:'Contacted',Active:'Qualified',Inactive:'Lost',Blacklisted:'Lost',Converted:'Won'};return a[String(v||'').trim()]||String(v||'New').trim()||'New'}
function fmtBudget(r){if(!r)return '—';const f=n=>n==null?'':n>=1e7?'₹'+(n/1e7).toFixed(1)+'Cr':n>=1e5?'₹'+(n/1e5).toFixed(0)+'L':'₹'+Number(n).toLocaleString('en-IN');return [f(r.BudgetMin),f(r.BudgetMax)].filter(Boolean).join(' – ')||'—'}
function budgetRange(v){return ({under50:[null,4999999],"50to100":[5000000,9999999],"100to200":[10000000,19999999],over200:[20000000,null]})[v]||[null,null]}
function buildQuery(){
 const p=new URLSearchParams();
 const q=document.getElementById('search').value.trim(), status=document.getElementById('status').value;
 const cat=document.getElementById('category').value, txn=FILTER_TXN, bud=document.getElementById('budget').value;
 const loc=document.getElementById('location').value.trim(), source=document.getElementById('source').value, type=document.getElementById('clientType').value;
 if(q)p.set('q',q); if(status)p.set('status',status); if(cat)p.set('category',cat); if(txn)p.set('transactionType',txn);
 if(loc)p.set('location',loc); if(source)p.set('source',source); if(type)p.set('clientType',type);
 const [min,max]=budgetRange(bud); if(min!=null)p.set('budgetMin',String(min)); if(max!=null)p.set('budgetMax',String(max));
 p.set('page',String(queryState.page)); p.set('limit',String(queryState.limit));
 return p;
}
async function fetchJsonWithTimeout(url, options={}, timeoutMs=12000){
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{
   const res=await fetch(url,{...options,signal:controller.signal});
   const text=await res.text();
   let json={};
   try{json=text?JSON.parse(text):{}}catch(_){json={ok:false,error:text||('HTTP '+res.status)}}
   if(!res.ok||json.ok===false) throw new Error(json.error||('HTTP '+res.status));
   return json;
 }catch(e){
   if(e.name==='AbortError') throw new Error('Clients API timed out after 12 seconds');
   throw e;
 }finally{clearTimeout(timer)}
}
async function load(resetPage=false){
 if(resetPage)queryState.page=1;
 queryState.loading=true;
 const grid=document.getElementById('grid');
 grid.innerHTML='<div class="load" style="grid-column:1/-1">Loading clients…</div>';
 const queryUrl='/api/v2/clients/query?'+buildQuery().toString();
 try{
   let j;
   try{
     j=await fetchJsonWithTimeout(queryUrl,{credentials:'include'});
   }catch(primaryError){
     // Only use the legacy endpoint for route compatibility errors.
     // Never retry a timeout/5xx request because the legacy endpoint enriches
     // the full client set and can amplify a backend performance problem.
     const retryable = /HTTP (404|405)/.test(String(primaryError?.message || ''));
     if (!retryable) throw primaryError;
     const p=new URLSearchParams();
     const q=document.getElementById('search').value.trim();
     const status=document.getElementById('status').value;
     const source=document.getElementById('source').value;
     if(q)p.set('q',q);
     if(status)p.set('status',status);
     if(source)p.set('source',source);
     p.set('limit','100');
     const fallback=await fetchJsonWithTimeout('/api/v2/clients?'+p.toString(),{credentials:'include'});
     const rows=Array.isArray(fallback.data)?fallback.data:[];
     const start=(queryState.page-1)*queryState.limit;
     const pageRows=rows.slice(start,start+queryState.limit);
     j={ok:true,data:pageRows,totalCount:rows.length,summary:{
       totalClients:rows.length,
       hotCount:rows.filter(x=>Number(typeof x.ClientScore==='object'?x.ClientScore?.total:x.ClientScore||0)>=70).length,
       activeNeeds:rows.reduce((n,x)=>n+Number(x._activeNeeds||0),0),
       openTransactions:rows.reduce((n,x)=>n+Number(x._openTransactions||0),0)
     },pagination:{
       page:queryState.page,limit:queryState.limit,total:rows.length,
       totalPages:Math.max(1,Math.ceil(rows.length/queryState.limit)),
       hasNext:start+pageRows.length<rows.length,hasPrev:queryState.page>1
     }};
   }
   clients=Array.isArray(j.data)?j.data:[];
   queryState=Object.assign(queryState,j.pagination||{});
   updateStats(j.totalCount,j.summary||{});
   render();
   renderPager();
 }catch(e){
   grid.innerHTML='<div class="empty" style="grid-column:1/-1">Unable to load clients: '+esc(e.message)+'<br><button class="btn" style="margin-top:12px;background:#fdf8ec;color:var(--brown)" onclick="load()">Retry</button></div>';
   document.getElementById('pager').innerHTML='';
 }finally{queryState.loading=false}
}
function updateStats(total,summary={}){document.getElementById('s-total').textContent=Number(summary.totalClients??total??queryState.total??0);document.getElementById('s-req').textContent=Number(summary.activeNeeds??0);document.getElementById('s-txn').textContent=Number(summary.openTransactions??0);document.getElementById('s-hot').textContent=Number(summary.hotCount??0)}
let FILTER_TXN='';
function setChip(el,key,value){if(key==='txn')FILTER_TXN=value;document.querySelectorAll('.chip[data-txn]').forEach(x=>x.classList.toggle('active',x===el));load(true)}
function scheduleLoad(){clearTimeout(searchTimer);searchTimer=setTimeout(()=>load(true),300)}
function firstNeed(c){return (c._needSummaries||[])[0]||{}}
function needValue(n,keys){for(const k of keys){const v=n?.[k];if(v!==undefined&&v!==null&&String(v).trim()!=='')return v}return ''}
function budgetNumber(n){return Number(needValue(n,['BudgetMax','Budget','BudgetTo','MaxBudget'])||0)}
function investorFlag(c){return c.ClientIntent==='Investor'||c.ClientIntent==='Both'||(Array.isArray(c.Tags)&&c.Tags.includes('Investor'))}
function needDigest(c,r){
 const txn=needValue(r,['TransactionType','transactionType','Transaction'])||c.RequirementType||'';
 const cat=needValue(r,['SubCategory','Category','category'])||c.PropertyType||'';
 const loc=needValue(r,['Location1','Location','location'])||c.Area||c.Location1||'';
 const bud=fmtBudget(r);
 return [txn,cat,loc,bud!=='—'?bud:''].filter(Boolean).join(' • ');
}
function render(){
 const rows=clients;
 const grid=document.getElementById('grid');
 if(!rows.length){grid.innerHTML='<div class="empty" style="grid-column:1/-1">No clients found for the selected filters.</div>';return}
 grid.innerHTML=rows.map(c=>{
  const r=firstNeed(c),status=norm(c.ClientStatus||c.LeadStatus),score=typeof c.ClientScore==='object'?c.ClientScore?.total:c.ClientScore;
  const txn=needValue(r,['TransactionType','transactionType','Transaction'])||'',cat=needValue(r,['Category','category'])||'';
  const stamp=c._lastContact||c.UpdatedAt||c.CreatedAt;
  return '<article class="card"><div class="card-head"><div><div class="name">'+esc(c.ClientName||c.Name||'Unnamed')+'</div><div class="id">'+esc(c.LeadID||'')+'</div></div><span class="status">'+esc(status)+'</span></div>'+
  '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">'+(cat?'<span class="source">'+esc(cat)+'</span>':'')+(txn?'<span class="source">'+esc(txn)+'</span>':'')+(investorFlag(c)?'<span class="source" style="background:#f3e8ff;color:#6b21a8">Investor</span>':'')+'</div>'+
  '<div class="phone">📞 '+esc(phoneLabel(c.PrimaryMobile||c.Phone))+'</div>'+
  '<div style="font-size:11px;color:var(--brown2);font-weight:700;margin:5px 0 2px">'+esc(needDigest(c,r)||'Transaction details pending')+'</div>'+
  '<div style="font-size:10px;color:var(--muted);margin-bottom:7px">'+
    (c.Priority?('Priority: '+esc(c.Priority)):'')+
    (c.NextActionType?(' · Next: '+esc(c.NextActionType)):'')+
    (c.NextFollowUpAt?(' · '+esc(new Date(c.NextFollowUpAt).toLocaleString('en-IN'))):'')+
  '</div>'+
  '<div class="meta"><div><span>Transactions</span><b>'+esc(c._activeNeeds||0)+'</b></div><div><span>Open</span><b>'+esc(c._openTransactions||0)+'</b></div><div><span>Latest Budget</span><b>'+esc(fmtBudget(r))+'</b></div><div><span>Score</span><b>'+esc(score==null?'—':score)+'</b></div></div>'+
  '<div style="font-size:10px;color:var(--muted);margin-top:9px">Last contact: '+esc(stamp?new Date(stamp).toLocaleDateString('en-IN'):'—')+'</div>'+
  '<div class="actions"><a class="primary" href="/client-workspace?id='+enc(c.LeadID)+'">Open Workspace →</a>'+(safePhone(c.PrimaryMobile||c.Phone)?'<a href="tel:'+enc(safePhone(c.PrimaryMobile||c.Phone))+'">☎ Call</a>':'<a href="#" aria-disabled="true" style="opacity:.5;pointer-events:none">☎ Call unavailable</a>')+'</div></article>'
 }).join('')
}
function renderPager(){
 const el=document.getElementById('pager'),p=queryState;
 if(!p.total){el.innerHTML='';return}
 el.innerHTML='<button class="btn" style="background:#fff;border:1px solid var(--border);color:var(--brown)" '+(p.hasPrev?'':'disabled')+' onclick="changePage(-1)">← Previous</button><span style="font-size:12px;color:var(--muted)">Page '+p.page+' of '+p.totalPages+' · '+p.total+' clients</span><button class="btn" style="background:#fff;border:1px solid var(--border);color:var(--brown)" '+(p.hasNext?'':'disabled')+' onclick="changePage(1)">Next →</button>'
}
function changePage(delta){const next=queryState.page+delta;if(next<1||next>queryState.totalPages)return;queryState.page=next;load()}
function openNewClient(){document.getElementById('new-client-modal').classList.add('show');document.getElementById('nc-name').focus()}
function closeNewClient(){document.getElementById('new-client-modal').classList.remove('show')}
async function createClient(){
 const err=document.getElementById('nc-error');err.textContent='';
 const name=document.getElementById('nc-name').value.trim(), mobile=document.getElementById('nc-mobile').value.trim();
 const txn=document.getElementById('nc-txn').value, cat=document.getElementById('nc-cat').value;
 if(!name||!mobile||!txn||!cat){err.textContent='Name, Mobile, Transaction and Category are required.';return}
 const bhk=(document.getElementById('nc-bhk')?.value||'').trim();
 const requirement={category:cat,locations:[],
   BudgetMax:document.getElementById('nc-budget').value?Number(document.getElementById('nc-budget').value):undefined};
 if(bhk) requirement.BHK=bhk;
 const loc=document.getElementById('nc-location').value.trim();if(loc){requirement.Location1=loc;requirement.locations=[loc]}
 try{
  const res=await fetch('/api/v2/quick-capture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
   client:{
     name,primaryMobile:mobile,
     city:'Surat',
     source:document.getElementById('nc-source').value||undefined
   },
   transaction:{transactionType:txn},requirement
  })});
  const j=await res.json();
  if(!j.ok){err.textContent=j.requiresConfirmation?'Possible duplicate found. Existing client should be opened instead.':(j.error||'Unable to create client.');return}
  closeNewClient();window.location.href='/client-workspace?id='+encodeURIComponent(j.client?.leadId||j.leadId||'');
 }catch(e){err.textContent='Network error: '+e.message}
}
window.__signatureClientsBooted = true;
try {
  load();
} catch (bootError) {
  const grid = document.getElementById('grid');
  if (grid) grid.innerHTML = '<div class="empty" style="grid-column:1/-1">Unable to start Clients: '+esc(bootError?.message || bootError)+'<br><button class="btn" style="margin-top:12px;background:#fdf8ec;color:var(--brown)" onclick="load()">Retry</button></div>';
}
