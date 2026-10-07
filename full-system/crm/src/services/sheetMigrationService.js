'use strict';
const crypto = require('node:crypto');
const { GoogleSheetSyncService } = require('./googleSheetSyncService');
const { AccessControlService } = require('./accessControlService');
const SOURCE_ID = '1nkjzrMRDCMoWFnzxxovvxu-fzILv6Li-VfBY4VLr-QI';
const empty = value => value == null || value === '';
const copy = value => JSON.parse(JSON.stringify(value));
function phone(value) {
  const raw = String(value ?? '').trim();
  if (!/^[+\d][\d\s().-]*$/.test(raw)) return '';
  let digits = raw.replace(/\D/g, '');
  if (/^91\d{10}$/.test(digits)) digits = digits.slice(2);
  else if (/^0\d{10}$/.test(digits)) digits = digits.slice(1);
  return /^\d{10}$/.test(digits) ? digits : '';
}
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function planMigration(db, input, actor = {}) {
  if (input?.spreadsheetId !== SOURCE_ID || !Array.isArray(input.records) || !input.records.length || input.records.length > 1000) {
    throw new Error('Original Sheet and 1–1000 source records are required');
  }
  const next = copy(db);
  next.Leads ||= [];
  next._V2Counters ||= { Lead: 0, Transaction: 0, Requirement: 0 };
  const access = new AccessControlService({
    readLead: id => next.Leads.find(lead => lead.LeadID === id),
    getUser: id => (next.Users || []).find(user => user.UserID === id),
    getTransaction: id => (next.Transactions || []).find(tx => tx.TransactionID === id)
  });
  const issues = [], changes = [], seen = new Map(), sourceVariants = new Map();
  for (const item of input.records) {
    const key = `${item?.tab}:${phone(item?.row?.Phone)}`;
    if (!sourceVariants.has(key)) sourceVariants.set(key, new Set());
    sourceVariants.get(key).add(digest(item?.row || {}));
  }
  const service = new GoogleSheetSyncService({});
  const repairs = Array.isArray(input.identityRepairs) ? input.identityRepairs : [];
  if (repairs.length && String(actor.role).toUpperCase() !== 'ADMIN') throw new Error('Identity repair requires an administrator');
  for (const repair of repairs) {
    const item = input.records.find(r => r.tab === repair.sourceTab && r.sourceRow === repair.sourceRow && String(r.row?.['Lead ID'] || '') === repair.legacyId);
    if (!item || !phone(item.row.Phone)) throw new Error('Identity repair needs a valid original source row');
    const target = next.Leads.filter(l => l.LeadID === repair.oldLeadId && l.LegacyID === repair.legacyId && String(l.ClientName || '').trim().toLowerCase() === String(item.row.Name || '').trim().toLowerCase());
    if (!target.length && next.Leads.some(l => l.LeadID === repair.legacyId && l.LegacyID === repair.legacyId && phone(l.PrimaryMobile) === phone(item.row.Phone))) continue;
    if (target.length !== 1 || next.Leads.filter(l => l.LeadID === repair.oldLeadId).length < 2 || next.Leads.some(l => l.LeadID === repair.legacyId)) throw new Error('Identity repair no longer matches the duplicate ID; preview stopped');
    const lead = target[0];
    if (phone(lead.PrimaryMobile || lead.Phone) && phone(lead.PrimaryMobile || lead.Phone) !== phone(item.row.Phone)) throw new Error('Identity repair phone conflicts with current CRM client');
    const before = { LeadID: lead.LeadID, LegacyID: lead.LegacyID, PrimaryMobile: lead.PrimaryMobile, SheetBasicRequirements: copy(lead.SheetBasicRequirements || []), SheetSourceTabs: copy(lead.SheetSourceTabs || []) };
    lead.IdentityRepairHistory = [...(lead.IdentityRepairHistory || []), { Before: before, RepairedAt: new Date().toISOString(), RepairedBy: actor.userId, SourceTab: item.tab, SourceRow: item.sourceRow }];
    lead.LeadID = repair.legacyId;
    lead.PrimaryMobile = phone(item.row.Phone);
    lead.SheetBasicRequirements = (lead.SheetBasicRequirements || []).filter(n => n.SourceTab === item.tab);
    lead.SheetSourceTabs = [item.tab];
    lead.UpdatedAt = new Date().toISOString();
    // Shared-ID work has no reliable per-client identity. Preserve it and flag it;
    // never guess that an existing call/transaction belongs to the renamed client.
    for (const collection of ['Transactions','Requirements','Activities','FollowUps']) {
      for (const record of next[collection] || []) if (record.LeadID === repair.oldLeadId && !record.IdentityMappingReview) record.IdentityMappingReview = { Reason: 'Previously shared client ID; verify owner', PreviousLeadID: repair.oldLeadId, SeparateLeadID: repair.legacyId };
    }
    changes.push({ tab: item.tab, row: item.sourceRow, legacyId: repair.legacyId, leadId: lead.LeadID, action: 'IDENTITY_REPAIRED', fields: ['LeadID','PrimaryMobile','SheetBasicRequirements','SheetSourceTabs','IdentityRepairHistory'] });
  }
  const originalIds = new Map();
  for (const lead of next.Leads) originalIds.set(String(lead.LeadID), (originalIds.get(String(lead.LeadID)) || 0) + 1);
  const now = new Date().toISOString();
  const reviewedRows = input.reviewedRows === true;
  for (const item of input.records) {
    const tab = item?.tab, row = item?.row;
    const ref = { tab, row: item?.sourceRow, legacyId: String(row?.['Lead ID'] || '') };
    const issue = reason => issues.push({ ...ref, reason });
    if (!['Comm','Sale','Rent'].includes(tab) || !row || typeof row !== 'object' || Array.isArray(row)) { issue('Invalid source row'); continue; }
    if (Object.values(row).some(v => typeof v === 'object' || String(v ?? '').length > 10000)) { issue('Invalid source values'); continue; }
    const key = phone(row.Phone);
    const invalidPhone = !key;
    if (invalidPhone && (!reviewedRows || !ref.legacyId || !String(row.Phone || '').trim() || String(row.Phone).includes('#'))) { issue('Invalid phone; source row was skipped'); continue; }
    const sourceKey = `${tab}:${key}`;
    const duplicate = !invalidPhone && sourceVariants.get(sourceKey).size > 1;
    if (duplicate && !reviewedRows) { issue('Conflicting repeated source rows; all versions were skipped'); continue; }
    if (!reviewedRows && seen.has(sourceKey)) {
      if (seen.get(sourceKey) !== digest(row)) issue('Conflicting repeated source row');
      continue;
    }
    seen.set(sourceKey, digest(row));
    let matches = invalidPhone ? next.Leads.filter(l => l.InvalidPhoneRaw === String(row.Phone) && l.LegacyID === ref.legacyId) : next.Leads.filter(l => phone(l.PrimaryMobile || l.Phone) === key);
    const legacyMatches = next.Leads.filter(l => ref.legacyId && (l.LeadID === ref.legacyId || l.LegacyID === ref.legacyId));
    if (invalidPhone && !matches.length && legacyMatches.length === 1) {
      const candidate = legacyMatches[0];
      const sameName = !String(row.Name || '').trim() || String(candidate.ClientName || '').trim().toLowerCase() === String(row.Name || '').trim().toLowerCase();
      const sameRaw = String(candidate.PrimaryMobile || candidate.Phone || '') === String(row.Phone);
      const stripped = String(row.Phone).replace(/\D/g, '');
      const sameImportedDigits = (String(candidate.CreatedBy || '').includes('GoogleSheet') || String(candidate._source || '').startsWith('GoogleSheet:')) && phone(candidate.PrimaryMobile || candidate.Phone) === stripped;
      if (sameName && (sameRaw || sameImportedDigits)) matches = [candidate];
    }
    if (matches.length > 1 || (matches[0] && originalIds.get(String(matches[0].LeadID)) > 1)) { issue('CRM identity conflict; no records were merged'); continue; }
    if (legacyMatches.some(l => !matches.includes(l))) { issue('Source ID belongs to a different or unresolved CRM client'); continue; }
    const staged = { Leads: [], Transactions: [], Requirements: [], _V2Counters: { Lead: 0, Transaction: 0, Requirement: 0 } };
    // Parse basic details without treating a malformed number as a callable identity.
    const parsed = service._syncOneRowInDb(staged, tab, invalidPhone ? { ...row, Phone: '9000000000' } : row);
    if (!parsed.ok) { issue(parsed.error); continue; }
    const source = staged.Leads[0];
    if (invalidPhone) source.PrimaryMobile = '';
    let lead = matches[0], created = false;
    if (lead && !access.canAccessLeadRecord(lead, actor)) { issue('Client is outside the administrator scope'); continue; }
    if (!lead) {
      let id = ref.legacyId;
      if (!id || next.Leads.some(l => l.LeadID === id)) {
        do { id = `L${String(++next._V2Counters.Lead).padStart(6,'0')}`; } while (next.Leads.some(l => l.LeadID === id));
      }
      lead = { LeadID: id, LegacyID: ref.legacyId || null, CreatedAt: source.CreatedAt, CreatedBy: actor.userId || 'SheetMigration', ClientStatus: 'New', AssignedAgentID: source.AssignedAgentID || 'USR-0001', _source: `GoogleSheet:${tab}`, _v2: true };
      if (actor.companyId) lead.CompanyID = actor.companyId;
      if (actor.brokerageId) lead.BrokerageID = actor.brokerageId;
      next.Leads.push(lead); created = true;
    }
    const fields = [];
    const addTag = tag => { const tags = Array.isArray(lead.Tags) ? lead.Tags : []; if (!tags.includes(tag)) { lead.Tags = [...tags, tag]; fields.push('Tags'); } };
    if (duplicate) addTag('Duplicate Number');
    if (invalidPhone) {
      addTag('Invalid Number');
      if (lead.PhoneValidity !== 'INVALID' || lead.InvalidPhoneRaw !== String(row.Phone)) {
        lead.PhoneValidity = 'INVALID'; lead.InvalidPhoneRaw = String(row.Phone);
        lead.PhoneValidationReason = 'Invalid number supplied in original Sheet';
        fields.push('PhoneValidity','InvalidPhoneRaw','PhoneValidationReason');
      }
    }
    // CRM statuses, assignments, notes, follow-ups and transactions are authoritative.
    for (const field of ['ClientName','PrimaryMobile','Email','City','LeadSource','ClientType']) {
      if (empty(lead[field]) && !empty(source[field])) { lead[field] = source[field]; fields.push(field); }
    }
    const need = source.SheetBasicRequirements[0];
    const needs = Array.isArray(lead.SheetBasicRequirements) ? lead.SheetBasicRequirements : [];
    const sourceNeeds = needs.filter(n => n.SourceTab === tab);
    const rowNeed = needs.find(n => n.SourceTab === tab && n.SourceRow === item.sourceRow);
    if (reviewedRows && duplicate) {
      if (!rowNeed) { lead.SheetBasicRequirements = [...needs, { ...need, SourceRow: item.sourceRow, SourceLegacyID: ref.legacyId, DuplicateNumber: true }]; fields.push('SheetBasicRequirements'); }
    }
    else if (sourceNeeds.length > 1) { issue('Multiple basic needs in the same tab; basic details were skipped'); }
    else if (!sourceNeeds.length) { lead.SheetBasicRequirements = [...needs, need]; fields.push('SheetBasicRequirements'); }
    else {
      for (const [field,value] of Object.entries(need)) {
        if (['CreatedAt','UpdatedAt','CreatedBy','Source','SourceTab','ConfirmationStatus'].includes(field)) continue;
        if (empty(sourceNeeds[0][field]) && !empty(value)) { sourceNeeds[0][field] = value; fields.push(`Basic.${field}`); }
      }
    }
    const tabs = Array.isArray(lead.SheetSourceTabs) ? lead.SheetSourceTabs : [];
    if (!tabs.includes(tab)) { lead.SheetSourceTabs = [...tabs,tab]; fields.push('SheetSourceTabs'); }
    // Retain all original columns as source details, without applying Sheet work state to CRM.
    const imported = Array.isArray(lead.ImportedSheetDetails) ? lead.ImportedSheetDetails : [];
    if (!imported.some(detail => detail.SpreadsheetID === SOURCE_ID && detail.SourceTab === tab && (!reviewedRows || detail.SourceRow === item.sourceRow))) {
      lead.ImportedSheetDetails = [...imported, { SpreadsheetID: SOURCE_ID, SourceTab: tab, SourceRow: item.sourceRow, Columns: copy(row), ImportedAt: now, ...(duplicate ? {DuplicateNumber:true} : {}), ...(invalidPhone ? {InvalidNumber:true} : {}) }];
      fields.push('ImportedSheetDetails');
    }
    if (fields.length || created) { lead.UpdatedAt = now; changes.push({ ...ref, leadId: lead.LeadID, action: created ? 'CREATED' : 'FILLED_MISSING', fields }); }
  }
  // Ignore generated timestamps in the preview token, but bind all client data and source rows.
  const token = digest({ source: input, clients: db.Leads || [], counters: db._V2Counters || {}, actor, ...(repairs.length ? { work: ['Transactions','Requirements','Activities','FollowUps'].map(k => [k, db[k] || []]) } : {}) });
  return { next, report: { token, sourceRows: input.records.length, created: new Set(changes.filter(x=>x.action === 'CREATED').map(x=>x.leadId)).size,
    updated: new Set(changes.filter(x=>x.action !== 'CREATED').map(x=>x.leadId)).size, issues, changes, clientsBefore: (db.Leads || []).length, clientsAfter: next.Leads.length } };
}
module.exports = { planMigration, SOURCE_ID, phone };
