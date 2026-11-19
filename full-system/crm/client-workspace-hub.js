
let clients=[];
let CLIENT_BUCKET='';
let queryState={page:1,limit:24,total:0,totalPages:1,loading:false};
let searchTimer=null;
let clientLoadVersion=0;
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
 const sourceTab=document.getElementById('sourceTab').value; if(sourceTab)p.set('sourceTab',sourceTab);
 const q=document.getElementById('search').value.trim(), status=document.getElementById('status').value;
 if(CLIENT_BUCKET==='activeRequirements')p.set('view','activeRequirements');
 if(CLIENT_BUCKET==='contactPending')p.set('view','contactPending');
 if(CLIENT_BUCKET==='all')p.set('view','all');
 if(!CLIENT_BUCKET && status==='New')p.set('view','newLeads');
 if(!CLIENT_BUCKET && status==='Follow-up')p.set('view','followUpsDue');
 const cat=document.getElementById('category').value, txn=FILTER_TXN, bud=document.getElementById('budget').value;
 const loc=document.getElementById('location').value.trim(), source=document.getElementById('source').value, type=document.getElementById('clientType').value;
 if(!status && CLIENT_BUCKET!=='all')p.set('excludeLost','true');
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
   if(!res.ok||json.ok===false) { const error=new Error(json.error||('HTTP '+res.status)); error.responseReceived=true; error.statusCode=res.status; throw error; }
   return json;
 }catch(e){
   if(e.name==='AbortError') throw new Error('Request timed out after 12 seconds');
   throw e;
 }finally{clearTimeout(timer)}
}
async function load(resetPage=false){
 const version=++clientLoadVersion;
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
     const rows=(Array.isArray(fallback.data)?fallback.data:[]).filter(c=>status||norm(c.ClientStatus||c.LeadStatus)!=='Lost');
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
   if(version!==clientLoadVersion)return;
   clients=Array.isArray(j.data)?j.data:[];
   queryState=Object.assign(queryState,j.pagination||{});
   updateStats(j.totalCount,j.summary||{});
   render();
   renderPager();
 }catch(e){
   if(version!==clientLoadVersion)return;
   grid.innerHTML='<div class="empty" style="grid-column:1/-1">Unable to load clients: '+esc(e.message)+'<br><button class="btn" style="margin-top:12px;background:#fdf8ec;color:var(--brown)" onclick="load()">Retry</button></div>';
   document.getElementById('pager').innerHTML='';
 }finally{if(version===clientLoadVersion)queryState.loading=false}
}
function updateStats(total,summary={}){
 document.getElementById('s-total').textContent=Number(summary.totalClients??total??queryState.total??0);
 document.getElementById('s-req').textContent=Number(summary.activeNeeds??0);
 document.getElementById('s-txn').textContent=Number(summary.openTransactions??0);
 document.getElementById('s-hot').textContent=Number(summary.hotCount??0);
 const counts=summary.queueCounts||{};
 document.querySelectorAll('[data-queue-count]').forEach(el=>{const value=counts[el.dataset.queueCount];if(value!==undefined)el.textContent=Number(value).toLocaleString('en-IN')});
}
let CLIENT_VIEW='card';
function setView(view){
 CLIENT_VIEW=view==='list'?'list':'card';
 document.querySelectorAll('[data-view]').forEach(b=>{const active=b.dataset.view===CLIENT_VIEW;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active))});
 render();
}
function setStatus(status){
 CLIENT_BUCKET='';
 document.getElementById('status').value=status;
 document.querySelectorAll('[data-status]').forEach(b=>{const active=b.dataset.status===status;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active))});
 document.querySelectorAll('[data-bucket]').forEach(b=>{b.classList.remove('active');b.setAttribute('aria-pressed','false')});
 load(true);
}
function setBucket(bucket){
 CLIENT_BUCKET=bucket;
 document.getElementById('status').value=bucket==='contactPending'?'Contacted':'';
 document.querySelectorAll('[data-status]').forEach(b=>{b.classList.remove('active');b.setAttribute('aria-pressed','false')});
 document.querySelectorAll('[data-bucket]').forEach(b=>{const active=b.dataset.bucket===bucket;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active))});
 load(true);
}
function renderList(rows){
 const body=rows.map(c=>{
  const r=firstNeed(c),phone=c.PrimaryMobile||c.Phone,status=norm(c.ClientStatus||c.LeadStatus);
  const statusLabel=CLIENT_BUCKET==='activeRequirements'?'Requirement Active':status;
  return '<tr><td><strong>'+esc(c.ClientName||c.Name||'Unnamed')+'</strong><div class="id">'+esc(c.LeadID)+'</div></td><td>'+esc(phoneLabel(phone))+'</td><td><span class="status">'+esc(statusLabel)+'</span></td><td class="need-cell">'+esc((r.Unconfirmed?'Unconfirmed: ':'')+(needDigest(c,r)||'Property details pending'))+'</td><td>'+esc(c.NextFollowUpAt?new Date(c.NextFollowUpAt).toLocaleString('en-IN'):'—')+'</td><td><div class="actions"><a class="primary" href="/client-workspace?id='+enc(c.LeadID)+'">Open Workspace →</a>'+(safePhone(phone)?'<a href="/client-workspace?id='+enc(c.LeadID)+'&amp;startCall=1">☎ Call &amp; Log</a>':'')+'</div></td></tr>';
 }).join('');
 return '<table class="client-table" aria-label="Clients list"><thead><tr><th scope="col">Client</th><th scope="col">Mobile</th><th scope="col">Status</th><th scope="col">Property details</th><th scope="col">Next follow-up</th><th scope="col">Actions</th></tr></thead><tbody>'+body+'</tbody></table>';
}
let FILTER_TXN='';
function setChip(el,key,value){if(key==='txn')FILTER_TXN=value;document.querySelectorAll('.chip[data-txn]').forEach(x=>x.classList.toggle('active',x===el));load(true)}
function scheduleLoad(){clearTimeout(searchTimer);searchTimer=setTimeout(()=>load(true),300)}
function firstNeed(c){
 const confirmed=(c._needSummaries||[]).filter(n=>!['LOST','CLOSED','ARCHIVED'].includes(String(n.RequirementStatus||'').toUpperCase()));
 if(confirmed.length)return confirmed[0];
 const basics=Array.isArray(c.SheetBasicRequirements)?c.SheetBasicRequirements:[];
 const tab=document.getElementById('sourceTab').value;
 const basic=basics.find(n=>!tab||n.SourceTab===tab);
 if(basic)return {...basic,Unconfirmed:true};
 return {...c,...(c.RequirementProfile||{}),TransactionType:c.RequirementType,Unconfirmed:true};
}
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
 grid.classList.toggle('list-view',CLIENT_VIEW==='list');
 if(!rows.length){grid.innerHTML='<div class="empty" style="grid-column:1/-1">No clients found for the selected filters.</div>';return}
 if(CLIENT_VIEW==='list'){grid.innerHTML=renderList(rows);return}
 grid.innerHTML=rows.map(renderClientCard).join('');
}
function localDateInput(value){
 if(!value)return '';
 const d=new Date(value);
 if(Number.isNaN(d.getTime()))return '';
 return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);
}
function localTimeInput(value){
 if(!value)return '';
 const d=new Date(value);
 if(Number.isNaN(d.getTime()))return '';
 return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(11,16);
}
function renderClientCard(c){
 const r=firstNeed(c),status=norm(c.ClientStatus||c.LeadStatus);
 const statusLabel=CLIENT_BUCKET==='activeRequirements'?'Requirement Active':status;
 const statusClass=String(statusLabel||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
 const leadId=String(c.LeadID||''),needId=String(needValue(r,['RequirementID','requirementId','ReqID'])||'');
 const txn=needValue(r,['TransactionType','transactionType','Transaction'])||c.RequirementType||'';
 const cat=needValue(r,['SubCategory','Category','category'])||c.PropertyType||'';
 const loc=needValue(r,['Location1','Location','location'])||c.Area||c.Location1||'';
 const budget=fmtBudget(r),stamp=c._lastContact;
 const phone=safePhone(c.PrimaryMobile||c.Phone);
 const summary=(r.Unconfirmed?'Unconfirmed: ':'')+(needDigest(c,r)||'Property details pending');
 const next=c.NextFollowUpAt?new Date(c.NextFollowUpAt).toLocaleString('en-IN'):'Follow-up not scheduled';
 const lost=status==='Lost';
 const lostReason=c.LostReason||c.LossReason||c.ReasonLost||'Reason not recorded';
 const lostDate=c.LostAt||c.LostDate||c.UpdatedAt||'';
 const head='<div class="card-head client-card-head"><div><div class="name">'+esc(c.ClientName||c.Name||'Unnamed')+'</div><div class="id">'+esc(leadId)+'</div></div><span class="status status-'+esc(statusClass)+'">'+esc(statusLabel)+'</span></div>'+
  '<div class="client-tags">'+(cat?'<span class="source">'+esc(cat)+'</span>':'')+(txn?'<span class="source">'+esc(txn)+'</span>':'')+(investorFlag(c)?'<span class="source investor-tag">Investor</span>':'')+'</div>'+
  '<div class="client-requirement"><div class="client-requirement-label">Requirement</div><div class="client-requirement-text">'+esc(summary)+'</div><div class="client-detail-line">'+(budget!=='—'?'<span>Budget: '+esc(budget)+'</span>':'')+(loc?'<span>Location: '+esc(loc)+'</span>':'')+'</div></div>';
 if(lost){
  return '<article class="card client-card" data-lead-id="'+esc(leadId)+'">'+head+
   '<div class="client-lost-meta"><div><b>Lost reason</b><span>'+esc(lostReason)+'</span></div><div><b>Lost date</b><span>'+esc(lostDate?new Date(lostDate).toLocaleDateString('en-IN'):'—')+'</span></div></div>'+
   '<div class="client-actions"><button class="client-action primary-action" type="button" data-card-action="reopen">↻ Reopen</button><a class="client-action" href="/client-workspace?id='+enc(leadId)+'">Open Workspace</a></div></article>';
 }
 return '<article class="card client-card" data-lead-id="'+esc(leadId)+'" data-requirement-id="'+esc(needId)+'">'+head+
  '<div class="client-next"><span class="client-next-label">Next follow-up</span><span>'+esc(next)+'</span></div>'+
  '<div class="client-last-contact">Last contact: '+esc(stamp?new Date(stamp).toLocaleDateString('en-IN'):'—')+'</div>'+
  '<div class="client-actions"><button class="client-action primary-action" type="button" data-card-action="toggle-call">☎ Call Log</button><button class="client-action" type="button" data-card-action="toggle-share">↗ Share Requirement</button><button class="client-action" type="button" data-card-action="quick-update">✎ Quick Update</button></div>'+
  '<a class="client-workspace-link" href="/client-workspace?id='+enc(leadId)+'">Open Workspace →</a>'+
  '<section class="client-popover client-call-popover" data-client-popover="call" hidden><div class="client-popover-head"><b>Log a call</b><button type="button" data-card-action="close-popovers" aria-label="Close">×</button></div>'+
   '<label>Call outcome<select data-call-outcome><option value="">Choose result</option><option value="CONNECTED_REQUIREMENT">Baat hui — requirement mili</option><option value="CONNECTED_NO_REQUIREMENT">Baat hui — abhi requirement nahi</option><option value="NO_ANSWER">Phone nahi uthaya</option><option value="PHONE_OFF">Phone band</option><option value="BUSY">Busy</option><option value="CALLBACK_REQUESTED">Callback bola</option><option value="NOT_INTERESTED">Interested nahi</option><option value="WRONG_NUMBER">Wrong number</option></select></label>'+
   '<label data-lost-reason-wrap hidden>Lost reason<select data-lost-reason><option value="">Choose reason</option><option>Not interested</option><option>Wrong number</option><option>Budget mismatch</option><option>Bought elsewhere</option><option>Requirement fulfilled</option><option>Other</option></select></label>'+
   '<label>Call note <textarea data-call-note rows="2" placeholder="Short note about the call"></textarea></label>'+
   '<div class="client-followup-fields"><label>Next date<input type="date" data-followup-date value="'+esc(localDateInput(c.NextFollowUpAt))+'"></label><label>Time<input type="time" data-followup-time value="'+esc(localTimeInput(c.NextFollowUpAt))+'"></label></div>'+
   '<div class="client-popover-error" role="alert" data-call-error></div><div class="client-popover-actions"><button type="button" class="client-action primary-action" data-card-action="save-call">Save call</button><a class="client-phone-link" '+(phone?'href="tel:'+esc(phone)+'"':'aria-disabled="true"')+'>'+ (phone?'Call client':'Phone unavailable')+'</a></div></section>'+
  '<section class="client-popover client-share-popover" data-client-popover="share" hidden><div class="client-popover-head"><b>Share requirement</b><button type="button" data-card-action="close-popovers" aria-label="Close">×</button></div>'+
   '<div class="client-share-options"><a class="client-share-option" href="/client-workspace?id='+enc(leadId)+'">⌂ Match in Inventory <small>Open Smart Match for this requirement</small></a><button type="button" class="client-share-option" data-card-action="load-brokers">♧ Send to Broker Network <small>Only requirement details are shared</small></button><button type="button" class="client-share-option" data-card-action="copy-requirement">▣ Copy Requirement Summary <small>No client name or phone is copied</small></button></div>'+
   '<div class="client-broker-panel" data-broker-panel hidden><div data-broker-list>Loading active brokers…</div><label>Optional note<textarea rows="2" data-broker-note placeholder="Add a short note for brokers"></textarea></label><div class="client-popover-error" role="alert" data-broker-error></div><button type="button" class="client-action primary-action" data-card-action="send-brokers">Create secure share links</button><div data-broker-results></div></div></section>'+
  '<section class="client-popover client-quick-popover" data-client-popover="quick" hidden><div class="client-popover-head"><b>Quick update</b><button type="button" data-card-action="close-popovers" aria-label="Close">×</button></div><p>Requirement details aur stage history ke liye client workspace kholen.</p><a class="client-action primary-action" href="/client-workspace?id='+enc(leadId)+'">Open Workspace</a></section></article>';
}
function renderPager(){
 const el=document.getElementById('pager'),p=queryState;
 if(!p.total){el.innerHTML='';return}
 el.innerHTML='<button class="btn" style="background:#fff;border:1px solid var(--border);color:var(--brown)" '+(p.hasPrev?'':'disabled')+' onclick="changePage(-1)">← Previous</button><span style="font-size:12px;color:var(--muted)">Page '+p.page+' of '+p.totalPages+' · '+p.total+' clients</span><button class="btn" style="background:#fff;border:1px solid var(--border);color:var(--brown)" '+(p.hasNext?'':'disabled')+' onclick="changePage(1)">Next →</button>'
}
function changePage(delta){const next=queryState.page+delta;if(next<1||next>queryState.totalPages)return;queryState.page=next;load()}
function openNewClient(){document.getElementById('new-client-modal').classList.add('show');updateCaptureFields();document.getElementById('nc-name').focus()}
function closeNewClient(){document.getElementById('new-client-modal').classList.remove('show')}
function updateCaptureFields(){
 const category=document.getElementById('nc-cat').value;
 document.getElementById('nc-bhk-wrap').hidden=category!=='Residential';
 const renting=/Rent|Lease/.test(document.getElementById('nc-txn').value);
 document.getElementById('nc-budget-label').textContent=renting?'Monthly Rent (₹)':'Budget / Expected Price (₹)';
}
let creatingClient=false;
async function createClient(){
 if(creatingClient)return;
 const err=document.getElementById('nc-error');err.textContent='';
 const name=document.getElementById('nc-name').value.trim(), mobile=document.getElementById('nc-mobile').value.trim();
 const txn=document.getElementById('nc-txn').value, cat=document.getElementById('nc-cat').value;
 if(!name||!mobile){err.textContent='Name and Mobile are required.';return}
 const bhk=(document.getElementById('nc-bhk')?.value||'').trim();
 const requirement={category:cat,locations:[],
   BudgetMax:document.getElementById('nc-budget').value?Number(document.getElementById('nc-budget').value):undefined};
 if(bhk&&cat==='Residential') requirement.BHK=bhk;
 const loc=document.getElementById('nc-location').value.trim();if(loc){requirement.Location1=loc;requirement.locations=[loc]}
 try{
  creatingClient=true;
  const j=await fetchJsonWithTimeout('/api/v2/quick-capture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
   client:{
     name,primaryMobile:mobile,
     city:'Surat',
     source:document.getElementById('nc-source').value||undefined
   },
   transaction:{transactionType:txn},requirement
  })});
  if(!j.ok){err.textContent=j.requiresConfirmation?'Possible duplicate found. Existing client should be opened instead.':(j.error||'Unable to create client.');return}
  closeNewClient();window.location.href='/client-workspace?id='+encodeURIComponent(j.client?.leadId||j.leadId||'');
 }catch(e){err.textContent=e.responseReceived&&e.statusCode<500?e.message:('Save could not be confirmed: '+e.message+'. Search this mobile before retrying; the request may still complete.')}
 finally{creatingClient=false}
}
document.getElementById('grid')?.addEventListener('click',handleClientCardAction);
document.getElementById('grid')?.addEventListener('change',function(event){
 if(!event.target.matches('[data-call-outcome]'))return;
 const card=event.target.closest('.client-card'),result=event.target.value;
 const wrap=card?.querySelector('[data-lost-reason-wrap]'),save=card?.querySelector('[data-card-action="save-call"]');
 if(wrap)wrap.hidden=!['NOT_INTERESTED','WRONG_NUMBER'].includes(result);
 if(save)save.textContent=result==='CONNECTED_REQUIREMENT'?'Save & Add Requirement →':'Save call';
 if(result==='CONNECTED_REQUIREMENT'){
  const date=card.querySelector('[data-followup-date]'),time=card.querySelector('[data-followup-time]');
  if(date)date.value='';if(time)time.value='';
 }
});

async function handleClientCardAction(event){
 const button=event.target.closest('[data-card-action]');
 if(!button)return;
 const card=button.closest('.client-card');
 if(!card)return;
 const action=button.dataset.cardAction;
 const hidePanels=()=>{card.querySelectorAll('[data-client-popover]').forEach(p=>p.hidden=true);card.classList.remove('is-open')};
 if(action==='close-popovers'){hidePanels();return}
 if(action==='toggle-call'||action==='toggle-share'||action==='quick-update'){
  const name=action==='toggle-call'?'call':action==='toggle-share'?'share':'quick';
  const panel=card.querySelector('[data-client-popover="'+name+'"]'),wasOpen=panel&&!panel.hidden;
  hidePanels();if(panel&&!wasOpen){panel.hidden=false;card.classList.add('is-open')}
  return;
 }
 if(action==='reopen'){
  button.disabled=true;
  try{await fetchJsonWithTimeout('/api/v2/clients/'+encodeURIComponent(card.dataset.leadId)+'/reactivate',{method:'POST',credentials:'include'});load(true)}
  catch(e){button.disabled=false;alert('Client reopen nahi hua: '+e.message)}
  return;
 }
 if(action==='load-brokers'){await loadCardBrokers(card,button);return}
 if(action==='send-brokers'){await sendCardRequirementToBrokers(card,button);return}
 if(action==='copy-requirement'){await copyCardRequirement(card);return}
 if(action==='save-call'){await saveCardCall(card,button);return}
}
async function loadCardBrokers(card,button){
 const panel=card.querySelector('[data-broker-panel]'),list=card.querySelector('[data-broker-list]'),error=card.querySelector('[data-broker-error]');
 panel.hidden=!panel.hidden;
 if(panel.hidden)return;
 error.textContent='';
 const reqId=card.dataset.requirementId;
 if(!reqId){list.textContent='Confirmed requirement nahi mili. Pehle Quick Update / Workspace mein requirement save karein.';return}
 if(list.dataset.loaded==='true')return;
 button.disabled=true;
 try{
  const j=await fetchJsonWithTimeout('/api/v2/broker-network?active=true',{credentials:'include'});
  const brokers=Array.isArray(j.data)?j.data:[];
  if(!brokers.length){list.innerHTML='<div class="client-empty-brokers">Active broker nahi mile. Broker Network mein broker add karein.</div>';return}
  list.innerHTML=brokers.map(b=>'<label class="client-broker-row"><input type="checkbox" value="'+esc(b.NetworkBrokerID)+'"><span><b>'+esc(b.Name||'Broker')+'</b><small>'+esc(b.Agency||'Independent broker')+' · '+esc(b.TrustLevel||'')+'</small></span></label>').join('');
  list.dataset.loaded='true';
 }catch(e){error.textContent='Broker list load nahi hui: '+e.message}
 finally{button.disabled=false}
}
function brokerShareMessage(share){
 const url=location.origin+'/share/req/'+share.Token;
 const note=cardShareNote||'';
 return 'Signature Properties — Property Requirement\n\nHi '+(share.BrokerName||'')+',\n\nAapke network me matching property ho to is secure link se details dekhein aur property submit karein:\n'+url+'\n\nClient ka naam, mobile aur email private rahenge. Aapko sirf requirement details dikhengi.'+(note?'\n\nNote: '+note:'');
}
let cardShareNote='';
async function sendCardRequirementToBrokers(card,button){
 const reqId=card.dataset.requirementId,error=card.querySelector('[data-broker-error]'),list=card.querySelector('[data-broker-list]'),results=card.querySelector('[data-broker-results]');
 const selected=Array.from(list.querySelectorAll('input[type="checkbox"]:checked')).map(x=>x.value);
 if(!reqId){error.textContent='Confirmed requirement nahi mili. Pehle requirement save karein.';return}
 if(!selected.length){error.textContent='Kam se kam ek broker select karein.';return}
 button.disabled=true;error.textContent='';results.textContent='Share links ban rahe hain…';
 try{
  cardShareNote=card.querySelector('[data-broker-note]').value.trim();
  const j=await fetchJsonWithTimeout('/api/v2/requirements/'+encodeURIComponent(reqId)+'/network-share',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({brokerIds:selected,message:cardShareNote,expiresInDays:30})});
  const shares=j.data?.shares||[];
  results.innerHTML=shares.length?'<div class="client-share-success">Secure links ready. Client details private rahenge.</div>'+shares.map(s=>{const ph=String(s.BrokerPhone||'').replace(/\D/g,'');const msg=encodeURIComponent(brokerShareMessage(s));const url=ph?'https://wa.me/'+ph+'?text='+msg:'https://wa.me/?text='+msg;return '<div class="client-share-result"><b>'+esc(s.BrokerName||'Broker')+'</b><a href="'+url+'" target="_blank" rel="noopener">Open WhatsApp</a></div>'}).join(''):'No share links returned.';
 }catch(e){results.textContent='';error.textContent='Requirement share nahi hui: '+e.message}
 finally{button.disabled=false}
}
async function copyCardRequirement(card){
 const summary=card.querySelector('.client-requirement-text')?.textContent||'';
 const details=Array.from(card.querySelectorAll('.client-detail-line span')).map(x=>x.textContent).join(' · ');
 const text='Property requirement: '+summary+(details?' · '+details:'');
 try{await navigator.clipboard.writeText(text);alert('Requirement summary copied. Client details copy nahi hue.')}
 catch(e){alert('Copy nahi hua. Workspace se summary copy karein.')}
}
async function saveCardCall(card,button){
 const leadId=card.dataset.leadId,select=card.querySelector('[data-call-outcome]'),outcome=select.value;
 const error=card.querySelector('[data-call-error]'),note=card.querySelector('[data-call-note]').value.trim();
 const date=card.querySelector('[data-followup-date]').value,time=card.querySelector('[data-followup-time]').value;
 const reasonWrap=card.querySelector('[data-lost-reason-wrap]'),reason=card.querySelector('[data-lost-reason]').value;
 const followResults=['NO_ANSWER','PHONE_OFF','BUSY','CALLBACK_REQUESTED'],lostResults=['NOT_INTERESTED','WRONG_NUMBER'];
 const followAt=date&&time?new Date(date+'T'+time).toISOString():'';
 if(!outcome){error.textContent='Call ka result select karein.';return}
 if(followResults.includes(outcome)&&!followAt){error.textContent='Phone nahi uthaya/phone band ho to next follow-up date aur time set karein.';return}
 if(lostResults.includes(outcome)&&!reason){reasonWrap.hidden=false;error.textContent='Lost reason choose karein.';return}
 button.disabled=true;error.textContent='Saving…';
 const labels={CONNECTED_REQUIREMENT:'Baat hui — requirement mili',CONNECTED_NO_REQUIREMENT:'Baat hui — abhi requirement nahi',NO_ANSWER:'Phone nahi uthaya',PHONE_OFF:'Phone band',BUSY:'Busy',CALLBACK_REQUESTED:'Callback bola',NOT_INTERESTED:'Interested nahi',WRONG_NUMBER:'Wrong number'};
 try{
  const activity=await fetchJsonWithTimeout('/api/v2/activities',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({LeadID:leadId,ActivityType:'CALL',Summary:'Call — '+labels[outcome],Outcome:labels[outcome],Notes:note||null,FollowUpDate:followAt||null,NextAction:followAt?'Call back':null})});
  if(followAt){
   await fetchJsonWithTimeout('/api/v2/followups',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({LeadID:leadId,ClientRequestID:(crypto.randomUUID?crypto.randomUUID():String(Date.now())),ActivityID:activity.data?.ActivityID||null,ActivityType:'CALL',DueAt:followAt,Notes:note||labels[outcome],Priority:'Medium'})});
  }
  let statusRes={ok:true};
  if(followResults.includes(outcome)){
   statusRes=await fetchJsonWithTimeout('/api/v2/clients/'+encodeURIComponent(leadId),{method:'PATCH',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({ClientStatus:'Follow-up',NextFollowUpAt:followAt,NextActionType:'Call',NextActionNote:note||labels[outcome]})});
  }else if(outcome==='CONNECTED_REQUIREMENT'||outcome==='CONNECTED_NO_REQUIREMENT'){
   statusRes=await fetchJsonWithTimeout('/api/v2/clients/'+encodeURIComponent(leadId),{method:'PATCH',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({ClientStatus:'Contacted',NextFollowUpAt:followAt||null,NextActionType:followAt?'Call':'',NextActionNote:note||null})});
  }else if(lostResults.includes(outcome)){
   statusRes=await fetchJsonWithTimeout('/api/v2/clients/'+encodeURIComponent(leadId)+'/lost',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({LostReason:reason,LostNote:note||null})});
  }
  if(!statusRes.ok)throw new Error(statusRes.error||'Stage update failed');
  if(outcome==='CONNECTED_REQUIREMENT'){
   window.location.href='/client-workspace?id='+encodeURIComponent(leadId)+'&openRequirement=1';
   return;
  }
  error.textContent='Call log saved.';
  load(true);
 }catch(e){button.disabled=false;error.textContent='Save confirm nahi hua: '+e.message+'. Retry se pehle client ka Call Log check karein.'}
}

window.__signatureClientsBooted = true;
try {
  load();
} catch (bootError) {
  const grid = document.getElementById('grid');
  if (grid) grid.innerHTML = '<div class="empty" style="grid-column:1/-1">Unable to start Clients: '+esc(bootError?.message || bootError)+'<br><button class="btn" style="margin-top:12px;background:#fdf8ec;color:var(--brown)" onclick="load()">Retry</button></div>';
}
