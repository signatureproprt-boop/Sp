'use strict';
(() => {
  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-label', 'Dashboard work');
  dialog.style.cssText = 'margin:auto;padding:20px;border:1px solid #ddd;border-radius:12px;width:min(660px,94vw);max-height:90vh;overflow:auto;color:#382718';
  document.body.append(dialog);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let generation = 0;
  const rows = result => Array.isArray(result.data) ? result.data : [];
  const indiaDay = value => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
  async function request(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {credentials:'include', ...options, signal:controller.signal});
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Unable to load CRM data');
      return result;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error(options.method === 'POST' ? 'Save confirmation timed out. Check the client before scheduling again.' : 'Request timed out. Please try again.');
      throw error;
    } finally { clearTimeout(timer); }
  }
  const workspaceLink = (id, label) => id ? `<a href="/client-workspace?id=${encodeURIComponent(id)}">${escape(label || id)}</a>` : 'Client unavailable';
  function shell(title) {
    generation++;
    dialog.innerHTML = `<button type="button" id="work-close" style="float:right">Close</button><h2>${escape(title)}</h2><div id="work-content" style="margin-top:16px">Loading…</div>`;
    dialog.querySelector('#work-close').onclick = () => dialog.close();
    if (!dialog.open) dialog.showModal();
    return generation;
  }
  dialog.addEventListener('close', () => generation++);
  async function showFollowups() {
    const run = shell('Due follow-ups');
    const content = dialog.querySelector('#work-content');
    try {
      const results = await Promise.all(['today','overdue'].map(preset => request('/api/v2/followups?preset='+preset+'&limit=200')));
      if (run !== generation) return;
      const seen = new Set();
      const due = results.flatMap(rows).filter(row => {
        const id = row.FollowUpID || row.followUpId || row.id;
        if (id && seen.has(id)) return false;
        if (id) seen.add(id);
        return true;
      }).sort((a,b) => new Date(a.dueAt || a.DueAt) - new Date(b.dueAt || b.DueAt));
      content.innerHTML = due.length ? due.map(row => `<article style="border-bottom:1px solid #ddd;padding:12px 0">${workspaceLink(row.LeadID || row.leadId, row.ClientName || row.LeadID || row.leadId)}<p>${escape(row.Notes || row.notes || row.ActivityType || 'Follow-up')}</p><p>${escape(new Date(row.dueAt || row.DueAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}))} IST · ${escape(row.status || row.Status)}</p></article>`).join('') : '<p>No due follow-ups.</p>';
    } catch (error) { if (run === generation) content.textContent = error.message; }
  }
  async function showVisits() {
    const run = shell('Site visits');
    const content = dialog.querySelector('#work-content');
    content.innerHTML = `<h3>Schedule a site visit</h3><p>Choose the client, their requirement and the property to visit.</p><label>Client search <input id="visit-client-search" placeholder="Name or Lead ID"></label> <button id="visit-client-search-btn" type="button">Find client</button><form id="visit-form" style="display:grid;gap:10px;margin:14px 0"><label>Client <select id="visit-client" required><option value="">Select client</option></select></label><label>Requirement <select id="visit-requirement" required disabled><option value="">Select a client first</option></select></label><label>Property search <input id="visit-property-search" placeholder="Property name or ID"></label><button id="visit-property-search-btn" type="button">Find property</button><label>Property <select id="visit-property" required><option value="">Select property</option></select></label><label>Date (India time) <input id="visit-date" type="date" required></label><label>Time (India time) <input id="visit-time" type="time" required></label><label>Meeting point <input id="visit-meeting"></label><button id="visit-save" type="submit">Schedule visit</button></form><p id="visit-message" role="status"></p><h3>Today's site visits</h3><div id="visit-list">Loading…</div>`;
    const find = id => dialog.querySelector('#'+id);
    const message = find('visit-message');
    let clientVersion = 0, propertyVersion = 0, requirementVersion = 0;
    const resetRequirements = () => { requirementVersion++; find('visit-requirement').disabled = true; find('visit-requirement').innerHTML = '<option value="">Select a client first</option>'; };
    const searchClients = async () => {
      const version = ++clientVersion;
      resetRequirements();
      find('visit-client').innerHTML = '<option value="">Loading clients…</option>';
      try {
        const result = await request('/api/v2/clients/query?excludeLost=true&limit=24&q='+encodeURIComponent(find('visit-client-search').value.trim()));
        if (run !== generation || version !== clientVersion) return;
        find('visit-client').innerHTML = '<option value="">Select client</option>'+rows(result).map(c=>`<option value="${escape(c.LeadID)}">${escape(c.ClientName || c.Name || c.LeadID)} · ${escape(c.LeadID)}</option>`).join('');
        message.textContent = rows(result).length ? 'Choose a client. Refine the search if needed.' : 'No clients found.';
      } catch(error) { if (run === generation && version === clientVersion) { find('visit-client').innerHTML = '<option value="">Client search unavailable</option>'; message.textContent=error.message; } }
    };
    const searchProperties = async () => {
      const version = ++propertyVersion;
      find('visit-property').innerHTML = '<option value="">Loading properties…</option>';
      try {
        const result = await request('/api/v2/inventory?limit=50&q='+encodeURIComponent(find('visit-property-search').value.trim()));
        if (run !== generation || version !== propertyVersion) return;
        find('visit-property').innerHTML = '<option value="">Select property</option>'+rows(result).map(p=>`<option value="${escape(p.PropertyID)}">${escape(p.Title || p.Project || p.PropertyID)} · ${escape(p.PropertyID)} · ${escape(p.ListingStatus || p.Status || '')}</option>`).join('');
      } catch(error) { if (run === generation && version === propertyVersion) { find('visit-property').innerHTML = '<option value="">Property search unavailable</option>'; message.textContent=error.message; } }
    };
    find('visit-client-search-btn').onclick = searchClients;
    find('visit-property-search-btn').onclick = searchProperties;
    find('visit-client-search').onkeydown = event => { if(event.key==='Enter'){event.preventDefault();searchClients();} };
    find('visit-client').onchange = async () => {
      resetRequirements();
      const id = find('visit-client').value;
      if (!id) return;
      const version = requirementVersion;
      try {
        const result = await request('/api/v2/clients/'+encodeURIComponent(id)+'/workspace');
        if (run !== generation || version !== requirementVersion) return;
        const requirements = (result.data.requirements || []).filter(r => !['Lost','Closed','Cancelled'].includes(r.Status || r.RequirementStatus));
        find('visit-requirement').innerHTML = '<option value="">Select requirement</option>'+requirements.map(r=>`<option value="${escape(r.RequirementID)}">${escape(r.RequirementID)} · ${escape(r.TransactionType || r.Purpose || '')} · ${escape(r.Category || '')}</option>`).join('');
        find('visit-requirement').disabled = !requirements.length;
        message.innerHTML = requirements.length ? '' : `No open requirement. ${workspaceLink(id,'Open client to confirm a requirement')}.`;
      } catch(error) { if (run === generation && version === requirementVersion) message.textContent=error.message; }
    };
    find('visit-date').value = indiaDay(Date.now());
    find('visit-form').onsubmit = async event => {
      event.preventDefault();
      const requirementId = find('visit-requirement').value;
      if (!requirementId || find('visit-requirement').disabled) {message.textContent='Choose an open client requirement first.';return;}
      const button = find('visit-save');
      button.disabled=true;
      message.textContent='Saving visit…';
      try {
        await request('/api/v2/site-visit-bookings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requirementId,propertyIds:[find('visit-property').value],visitDate:find('visit-date').value,visitTime:find('visit-time').value,meetingPoint:find('visit-meeting').value})});
        if (run !== generation) return;
        message.innerHTML = `Site visit saved. ${workspaceLink(find('visit-client').value,'Open client')}`;
        await loadVisits();
      } catch(error) { if (run === generation) message.textContent=error.message; }
      finally { if (run === generation) button.disabled=false; }
    };
    async function loadVisits() {
      try {
        const result = await request('/api/v2/site-visit-bookings?leadId=all');
        if (run !== generation) return;
        const visits = rows(result).filter(v => v.VisitDate === indiaDay(Date.now()) && !['Cancelled','Completed','NoShow'].includes(v.Status));
        find('visit-list').innerHTML = visits.length ? visits.map(v=>`<article style="padding:10px 0">${workspaceLink(v.LeadID,v.ClientName || v.LeadID)} · ${escape(v.VisitTime)} IST · ${escape(v.Status)}<p>${escape(v.MeetingPoint || '')}</p></article>`).join('') : 'No site visits scheduled for today.';
      } catch(error) { if (run === generation) find('visit-list').textContent=error.message; }
    }
    await Promise.all([searchClients(),searchProperties(),loadVisits()]);
  }
  document.addEventListener('click', event => {
    const link = event.target.closest('[data-dashboard-action]');
    if (!link) return;
    event.preventDefault();
    if (link.dataset.dashboardAction === 'follow-ups') showFollowups();
    else showVisits();
  });
})();
