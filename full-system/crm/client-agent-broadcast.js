'use strict';
let agentBroadcast=null;
function agentNeedText(req){
 const fields=req.Fields||{}; const value=k=>fields[k]?.value??req[k];
 const range=(a,b)=>[value(a),value(b)].filter(v=>v!==undefined&&v!==null&&v!=='').join(' – ');
 return ['Signature Properties — Property Requirement',
  [req.TransactionType,req.Category,req.SubCategory].filter(Boolean).join(' · '),
  ['Location1','Location2'].map(value).filter(Boolean).join(' / '),
  value('BHK')?'BHK: '+value('BHK'):(range('BHKMin','BHKMax')?'BHK: '+range('BHKMin','BHKMax'):''),
  range('BudgetMin','BudgetMax')?'Budget / Rent (₹): '+range('BudgetMin','BudgetMax'):'',
  range('AreaMin','AreaMax')?'Area (sq.ft): '+range('AreaMin','AreaMax'):'',
  'Matching property ho to secure link par details submit karein.'].filter(Boolean).join('\n');
}
async function agentApi(url,options){const r=await fetch(url,options);const j=await r.json();if(!r.ok||!j.ok)throw Error(j.error||'Request failed');return j;}
function agentError(e){document.getElementById('net-error').textContent=e.message;}
async function openNetworkShareModal(reqId){
 const req=(workspace.requirements||[]).find(r=>r.RequirementID===reqId);
 if(!req){alert('Saved requirement not found');return;}
 NET_CURRENT_REQ=reqId;
 agentBroadcast={reqId,requestId:crypto.randomUUID(),shares:[],busy:false,text:agentNeedText(req)};
 const modal=document.getElementById('net-share-modal');modal.style.display='flex';
 modal.setAttribute('role','dialog');modal.setAttribute('aria-label','Broadcast requirement to agents');
 modal.querySelector('button[data-testid="net-close"]').previousElementSibling.textContent='👥 Broadcast to Agents';
 const note=modal.querySelector('textarea');note.value='';note.setAttribute('aria-label','Optional broker note');
 let preview=document.getElementById('net-preview');if(!preview){preview=document.createElement('pre');preview.id='net-preview';preview.style.cssText='white-space:pre-wrap;font:inherit;background:#faf7ef;padding:12px;border-radius:8px';note.before(preview);}
 preview.textContent=agentBroadcast.text+'\n\nSecure reply link will be added for each selected agent. Client contact details are hidden by default.';
 let error=document.getElementById('net-error');if(!error){error=document.createElement('p');error.id='net-error';error.setAttribute('role','alert');note.after(error);}error.textContent='';
 const send=modal.querySelector('[data-testid="net-send"]');send.textContent='Prepare WhatsApp Drafts';send.disabled=false;
 const out=document.getElementById('net-links-out');out.style.display='none';out.innerHTML='';
 const wrap=document.getElementById('net-broker-list');wrap.textContent='Loading agents…';
 try{
  const result=await agentApi('/api/v2/broker-network?active=true');
  const brokers=(result.data||[]).filter(b=>safePhone(b.Phone));
  wrap.innerHTML=brokers.map(b=>`<label style="display:flex;gap:10px;padding:8px;border-bottom:1px solid #ddd"><input type="checkbox" class="net-broker-cb" value="${escAttr(b.NetworkBrokerID)}" aria-label="${escAttr(b.Name)}"><span><b>${esc(b.Name)}</b> · ${esc(b.Phone)}<br>${esc(b.Agency||'')} · ${esc((b.Specializations||[]).join(', '))}</span></label>`).join('')||'<p>No active agents with valid phone numbers. Add agents in Broker Network.</p>';
  const history=await agentApi(`/api/v2/requirements/${encodeURIComponent(reqId)}/network-shares`);
  if(history.data?.length){agentBroadcast.shares=history.data;renderAgentDrafts();}
 }catch(e){agentError(e);}
}
function buildBrokerWhatsAppText(share,base){return (share.Message||agentBroadcast.text)+'\n\nReply / Submit Property: '+base+'/share/req/'+encodeURIComponent(share.Token);}
function renderAgentDrafts(){
 const out=document.getElementById('net-links-out');out.style.display='block';
 out.innerHTML='<b>Drafts prepared — WhatsApp Send is manual.</b>'+agentBroadcast.shares.map(s=>{
  const digits=safePhone(s.BrokerPhone);const phone=digits.length===10?'91'+digits:digits;const expired=s.Status==='Revoked'||new Date(s.ExpiresAt)<new Date();
  return `<div style="padding:10px 0;border-top:1px solid #bcd"><b>${esc(s.BrokerName)}</b> · ${esc(s.BrokerPhone)}<br>${s.SentAt?'Sent — manually confirmed '+esc(new Date(s.SentAt).toLocaleString('en-IN')):'Prepared; sending not confirmed'}${expired?' · Expired/revoked':`<div><a href="https://wa.me/${enc(phone)}?text=${encodeURIComponent(buildBrokerWhatsAppText(s,location.origin))}" target="_blank" rel="noopener">Open WhatsApp Draft</a> · <button type="button" onclick="copyBrokerMessage('${escAttr(s.ShareID)}')">Copy Message</button>${s.SentAt?'':` · <button type="button" onclick="confirmAgentSent('${escAttr(s.ShareID)}',this)">I sent this on WhatsApp</button>`}</div>`}</div>`;
 }).join('');
}
async function copyBrokerMessage(id){const s=agentBroadcast.shares.find(s=>s.ShareID===id);if(s)try{await navigator.clipboard.writeText(buildBrokerWhatsAppText(s,location.origin));}catch(e){agentError(Error('Copy failed. Use Open WhatsApp Draft.'));}}
async function sendNetworkShare(){
 if(agentBroadcast.busy)return;
 const brokerIds=Array.from(document.querySelectorAll('.net-broker-cb:checked')).map(b=>b.value);
 if(!brokerIds.length){agentError(Error('Select at least one agent.'));return;}
 const send=document.querySelector('[data-testid="net-send"]');send.disabled=true;agentBroadcast.busy=true;
 try{
  const note=document.getElementById('net-message').value.trim();
  const message=agentBroadcast.text+(note?'\nNote: '+note:'');
  const result=await agentApi(`/api/v2/requirements/${encodeURIComponent(agentBroadcast.reqId)}/network-share`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({brokerIds,message,expiresInDays:30,clientRequestId:agentBroadcast.requestId})});
  agentBroadcast.shares=result.data.shares;renderAgentDrafts();document.getElementById('net-error').textContent='';
 }catch(e){agentError(e);}finally{send.disabled=false;agentBroadcast.busy=false;}
}
async function confirmAgentSent(id,button){
 button.disabled=true;
 try{const result=await agentApi(`/api/v2/network-shares/${encodeURIComponent(id)}/sent`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});agentBroadcast.shares=agentBroadcast.shares.map(s=>s.ShareID===id?result.data:s);renderAgentDrafts();}catch(e){agentError(e);button.disabled=false;}
}
