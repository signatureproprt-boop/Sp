'use strict';
let clientBrochureFlow = null;

async function brochureApi(url, options) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || 'Could not complete this action');
  return result;
}

async function openClientBrochures(requirementId) {
  document.getElementById('client-brochure-modal')?.remove();
  const requirement=(workspace.requirements || []).find(r=>r.RequirementID===requirementId) || (workspace.transactions || []).find(r=>r.TransactionID===requirementId) || {};
  clientBrochureFlow = {requirement,requirementId, projects:[], selected:null, share:null};
  const modal = document.createElement('div');
  modal.id = 'client-brochure-modal'; modal.className = 'modal-overlay';
  modal.innerHTML = `<div class="modal" style="max-width:760px;max-height:90vh;overflow:auto" role="dialog" aria-label="Client shortlist and brochures">
    <div class="modal-header"><span class="modal-title">Shortlist &amp; Brochures</span><button class="modal-close" onclick="document.getElementById('client-brochure-modal').remove()">×</button></div>
    <div class="modal-body"><p><b>${esc(workspace.lead.ClientName)}</b> · Select a project and review its brochure before sharing.</p>
    <h3>Shortlisted properties</h3><div id="client-brochure-shortlist">Loading…</div>
    <button class="btn btn-primary" onclick="shareShortlistOnWhatsApp(clientBrochureFlow.requirementId)">Review &amp; share shortlist</button>
    <button class="btn btn-ghost" onclick="openManualShortlistFromBrochure()">＋ Add manual property</button>
    <h3>Find builder project</h3><label for="client-brochure-search">Project or builder name</label><input id="client-brochure-search" placeholder="Search project or builder" style="width:100%">
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0">
      <label>Category<select id="client-project-category" aria-label="Project category"><option value="">Choose category</option><option>Residential</option><option>Commercial</option><option>Industrial</option><option>Land</option></select></label>
      <label>Builder<input id="client-project-builder" aria-label="Project builder" placeholder="Builder name"></label>
      <label>Location<input id="client-project-location" aria-label="Project location" placeholder="Location"></label>
      <label>BHK<select id="client-project-bhk" aria-label="Project BHK"><option value="">All BHK</option>${[1,2,3,4,5].map(n=>`<option>${n} BHK</option>`).join('')}</select></label>
      <label>Carpet min sqft<input id="client-project-min" aria-label="Project carpet minimum sqft" type="number" min="0"></label>
      <label>Carpet max sqft<input id="client-project-max" aria-label="Project carpet maximum sqft" type="number" min="0"></label></div>
    <p id="client-project-scope" role="status"></p><button class="btn btn-ghost" onclick="searchClientBrochures()">Search Projects</button><div id="client-brochure-projects"></div>
    <div id="client-brochure-preview"></div><p id="client-brochure-error" role="alert" style="color:#991b1b"></p>
    </div></div>`;
  document.body.appendChild(modal);
  document.getElementById('client-project-category').value=requirement.Category || '';
  document.getElementById('client-project-category').disabled=!!requirement.Category;
  document.getElementById('client-project-location').value=requirement.Location1 || requirement.Location || '';
  const fields=requirement.Fields || requirement;
  const bhk=String(fields.BHK || fields.BHKMin || '').match(/\d+/)?.[0];
  document.getElementById('client-project-bhk').value=bhk ? bhk+' BHK' : '';
  document.getElementById('client-project-min').value=fields.CarpetAreaMin || '';
  document.getElementById('client-project-max').value=fields.CarpetAreaMax || '';
  try {
    await renderClientBrochureShortlist();
    await searchClientBrochures();
  } catch(e) { brochureFlowError(e); }
}
function brochureFlowError(error) { const el=document.getElementById('client-brochure-error'); if(el) el.textContent=error.message; }
function openManualShortlistFromBrochure() { const id=clientBrochureFlow.requirementId; document.getElementById('client-brochure-modal').remove(); openManualShortlistModal(id); }

async function renderClientBrochureShortlist() {
  const result=await brochureApi(`/api/v2/shortlist/${encodeURIComponent(clientBrochureFlow.requirementId)}?status=Active`);
  const rows=result.data || [];
  document.getElementById('client-brochure-shortlist').innerHTML=rows.length ? rows.map(row=>`<div style="padding:8px;border-bottom:1px solid #ddd"><b>${esc(row.Property?.Title || row.PropertyID)}</b> · ${esc(row.Property?.Location1 || '')}${(row.Property?.MediaLinks?.brochures || []).filter(url=>/^https?:\/\//i.test(url) || url.startsWith('/')).map(url=>` · <a href="${escAttr(url)}" target="_blank" rel="noopener">View brochure</a>`).join('')}</div>`).join('') : '<p>No property shortlisted yet. Choose a builder project below or add a manual property.</p>';
}

async function searchClientBrochures() {
  const root=document.getElementById('client-brochure-projects'); root.textContent='Searching…';
  clientBrochureFlow.selected=null;clientBrochureFlow.share=null;
  document.getElementById('client-brochure-preview').replaceChildren();
  try {
    const params=new URLSearchParams({limit:'50',q:document.getElementById('client-brochure-search').value.trim()});
    for(const [id,key] of [['category','category'],['builder','builder'],['location','location'],['bhk','bhk'],['min','carpetMin'],['max','carpetMax']]) {
      const value=document.getElementById('client-project-'+id).value.trim();if(value) params.set(key,value);
    }
    if(!params.get('category')) {root.textContent='Choose a category before searching.';return;}
    const min=Number(params.get('carpetMin')),max=Number(params.get('carpetMax'));
    if(params.has('carpetMin')&&params.has('carpetMax')&&min>max) {root.textContent='Minimum sqft cannot exceed maximum sqft.';return;}
    const request=clientBrochureFlow.searchVersion=(clientBrochureFlow.searchVersion || 0)+1;
    const result=await brochureApi('/api/v2/builder-projects?'+params);
    if(request!==clientBrochureFlow.searchVersion)return;
    clientBrochureFlow.filters=Object.fromEntries(params);
    document.getElementById('client-project-scope').textContent=[params.get('category'),params.get('builder'),params.get('location'),params.get('bhk'),params.has('carpetMin')||params.has('carpetMax') ? `Carpet ${params.get('carpetMin')||'0'}–${params.get('carpetMax')||'any'} sqft` : ''].filter(Boolean).join(' · ');
    clientBrochureFlow.projects=result.data || [];
    root.innerHTML=clientBrochureFlow.projects.map((project,i)=>{
      const files=(project.Brochures || []).filter(row=>row.verified===true && String(row.downloadStatus).toLowerCase()==='downloaded' && (row.DriveFileID || row.DriveFileId || row.StoragePath));
      return `<div style="padding:10px;border-bottom:1px solid #ddd"><b>${esc(project.ProjectName)}</b> · ${esc(ShortlistShare.builder(project.BuilderName))}<div>${esc(project.Location1 || project.Location || '')}</div>${files.length ? files.map((file,j)=>`<button class="btn btn-ghost" onclick="selectClientBrochure(${i},${j})">${esc(file.Name || file.name || file.FileName || 'Brochure '+(j+1))}</button>`).join('') : '<span>No verified brochure available</span>'}</div>`;
    }).join('') || '<p>No matching projects found.</p>';
    if(Number(result.pagination?.total)>clientBrochureFlow.projects.length) root.innerHTML+='<p>Showing the first 50 projects. Refine the project or builder name.</p>';
  } catch(e) { root.textContent='Could not load projects.';brochureFlowError(e); }
}

function selectClientBrochure(projectIndex, fileIndex) {
  const project=clientBrochureFlow.projects[projectIndex];
  const file=project.Brochures.filter(row=>row.verified===true && String(row.downloadStatus).toLowerCase()==='downloaded' && (row.DriveFileID || row.DriveFileId || row.StoragePath))[fileIndex];
  clientBrochureFlow.selected={project,file}; clientBrochureFlow.share=null;clientBrochureFlow.requestId=crypto.randomUUID();
  const phone=resolveLeadPhone(true);
  const configs=(project.ConfigDetails || []).map((config,index)=>({config,index})).filter(({config})=>ShortlistShare.matchesLayout(config,clientBrochureFlow.filters || {}));
  document.getElementById('client-brochure-preview').innerHTML=`<h3>Review sharing details</h3><p><b>${esc(project.ProjectName)}</b><br>${esc(file.Name || file.name || file.FileName || 'Brochure.pdf')}<br>Client: ${esc(workspace.lead.ClientName)}<br>WhatsApp: ${esc(phone || 'Number missing')}</p>
    <label>Unit configuration<select id="client-selected-layout" aria-label="Unit configuration"><option value="">${configs.length ? 'Choose BHK / sqft layout' : 'Configuration not available — brochure only'}</option>${configs.map(({config,index})=>`<option value="${index}">${esc(ShortlistShare.layout(config) || 'Layout '+(index+1))}</option>`).join('')}</select></label>
    <button id="client-brochure-prepare" class="btn btn-primary" ${phone?'':'disabled'} onclick="prepareClientBrochure()">Add to shortlist &amp; prepare brochure</button><div id="client-brochure-send"></div>`;
}

async function prepareClientBrochure() {
  const button=document.getElementById('client-brochure-prepare'); if(button.disabled)return;
  button.disabled=true;button.textContent='Preparing…';
  brochureFlowError({message:''});
  try {
    const {project,file}=clientBrochureFlow.selected;
    const layoutValue=document.getElementById('client-selected-layout').value;
    if((project.ConfigDetails || []).some(c=>ShortlistShare.matchesLayout(c,clientBrochureFlow.filters || {})) && layoutValue==='')throw new Error('Select the BHK / sqft layout first.');
    const selectedConfigIndex=layoutValue===''?null:Number(layoutValue);
    const result=await brochureApi(`/api/v2/builder-projects/${encodeURIComponent(project.ProjectID)}/brochure-shares`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({leadId:workspace.lead.LeadID,requirementId:clientBrochureFlow.requirementId,brochureFileKey:file.DriveFileID || file.DriveFileId || file.StoragePath,channel:'whatsapp_text',clientRequestId:clientBrochureFlow.requestId,selectedConfigIndex})});
    clientBrochureFlow.share=result.data;
    const text=ShortlistShare.message([{PropertyID:project.ProjectID,Property:{Title:project.ProjectName,BuilderName:project.BuilderName,Category:project.Category,Location1:project.Location1,Status:project.ProjectStatus,RERANumber:project.RERANumber,ConfigDetails:selectedConfigIndex===null?[]:[project.ConfigDetails[selectedConfigIndex]],MediaLinks:{brochures:[result.data.url]}}}],workspace.lead,window.location.origin);
    const cardRows=[{Property:{Title:project.ProjectName,BuilderName:project.BuilderName,Location1:project.Location1,Category:project.Category,ConfigDetails:selectedConfigIndex===null?[]:[project.ConfigDetails[selectedConfigIndex]],Status:project.ProjectStatus}}];
    const url=`https://wa.me/${result.data.recipientPhone}?text=${encodeURIComponent(text)}`;
    document.getElementById('client-brochure-send').innerHTML=`<p>Brochure prepared. Review the selected layout and branded card before sharing.</p><div id="prepared-property-card"></div><a href="${escAttr(result.data.url)}" target="_blank" rel="noopener">View selected PDF</a> · <a class="btn btn-primary" href="${escAttr(url)}" target="_blank" rel="noopener">Open WhatsApp</a>
      <p>WhatsApp does not confirm sending back to CRM. Confirm below after you send it.</p><label><input id="client-brochure-sent" type="checkbox"> I sent this brochure to this client</label><p><label for="client-brochure-followup">Follow-up date (optional)</label><input id="client-brochure-followup" type="date"></p><button id="client-brochure-confirm" class="btn btn-primary" onclick="confirmClientBrochureSent()">Confirm sent &amp; save follow-up</button>`;
    await ShortlistShare.renderCards(document.getElementById('prepared-property-card'),cardRows,workspace.lead);
    button.textContent='Added to shortlist';await renderClientBrochureShortlist();
  } catch(e) {button.disabled=false;button.textContent='Retry preparation';brochureFlowError(e);}
}

async function confirmClientBrochureSent() {
  if(!document.getElementById('client-brochure-sent').checked){brochureFlowError(new Error('Confirm that you sent the brochure first.'));return;}
  brochureFlowError({message:''});
  const button=document.getElementById('client-brochure-confirm');if(button.disabled)return;button.disabled=true;button.textContent='Saving…';
  try {
    const date=document.getElementById('client-brochure-followup').value;
    const result=await brochureApi(`/api/v2/builder-projects/${encodeURIComponent(clientBrochureFlow.selected.project.ProjectID)}/brochure-shares/${encodeURIComponent(clientBrochureFlow.share.ShareID)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({sent:true,followUpAt:date?date+'T10:00:00+05:30':null})});
    document.getElementById('client-brochure-send').innerHTML='<p role="status">Sent confirmation saved in client history'+(date?' and follow-up scheduled.':'.')+'</p>';
    await loadWorkspace();
  } catch(e){button.disabled=false;button.textContent='Retry confirmation';brochureFlowError(e);}
}
