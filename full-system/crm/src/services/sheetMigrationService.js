'use strict';
const crypto = require('node:crypto');
const { GoogleSheetSyncService } = require('./googleSheetSyncService');
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
  const issues = [], changes = [], seen = new Map(), sourceVariants = new Map();
  for (const item of input.records) {
    const key = `${item?.tab}:${phone(item?.row?.Phone)}`;
    if (!sourceVariants.has(key)) sourceVariants.set(key, new Set());
    sourceVariants.get(key).add(digest(item?.row || {}));
  }
  const service = new GoogleSheetSyncService({});
  const originalIds = new Map();
  for (const lead of next.Leads) originalIds.set(String(lead.LeadID), (originalIds.get(String(lead.LeadID)) || 0) + 1);
  const now = new Date().toISOString();
  for (const item of input.records) {
    const tab = item?.tab, row = item?.row;
    const ref = { tab, row: item?.sourceRow, legacyId: String(row?.['Lead ID'] || '') };
    const issue = reason => issues.push({ ...ref, reason });
    if (!['Comm','Sale','Rent'].includes(tab) || !row || typeof row !== 'object' || Array.isArray(row)) { issue('Invalid source row'); continue; }
    if (Object.values(row).some(v => typeof v === 'object' || String(v ?? '').length > 10000)) { issue('Invalid source values'); continue; }
    const key = phone(row.Phone);
    if (!key) { issue('Invalid phone; source row was skipped'); continue; }
    const sourceKey = `${tab}:${key}`;
    if (sourceVariants.get(sourceKey).size > 1) { issue('Conflicting repeated source rows; all versions were skipped'); continue; }
    if (seen.has(sourceKey)) {
      if (seen.get(sourceKey) !== digest(row)) issue('Conflicting repeated source row');
      continue;
    }
    seen.set(sourceKey, digest(row));
    const matches = next.Leads.filter(l => phone(l.PrimaryMobile || l.Phone) === key);
    const legacyMatches = next.Leads.filter(l => ref.legacyId && (l.LeadID === ref.legacyId || l.LegacyID === ref.legacyId));
    if (matches.length > 1 || (matches[0] && originalIds.get(String(matches[0].LeadID)) > 1)) { issue('CRM identity conflict; no records were merged'); continue; }
    if (legacyMatches.some(l => !matches.includes(l))) { issue('Source ID belongs to a different or unresolved CRM client'); continue; }
    const staged = { Leads: [], Transactions: [], Requirements: [], _V2Counters: { Lead: 0, Transaction: 0, Requirement: 0 } };
    const parsed = service._syncOneRowInDb(staged, tab, row);
    if (!parsed.ok) { issue(parsed.error); continue; }
    const source = staged.Leads[0];
    let lead = matches[0], created = false;
    if (lead && ((actor.companyId && lead.CompanyID !== actor.companyId) || (actor.brokerageId && lead.BrokerageID !== actor.brokerageId))) { issue('Client is outside the administrator scope'); continue; }
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
    // CRM statuses, assignments, notes, follow-ups and transactions are authoritative.
    for (const field of ['ClientName','PrimaryMobile','Email','City','LeadSource','ClientType']) {
      if (empty(lead[field]) && !empty(source[field])) { lead[field] = source[field]; fields.push(field); }
    }
    const need = source.SheetBasicRequirements[0];
    const needs = Array.isArray(lead.SheetBasicRequirements) ? lead.SheetBasicRequirements : [];
    const sourceNeeds = needs.filter(n => n.SourceTab === tab);
    if (sourceNeeds.length > 1) { issue('Multiple basic needs in the same tab; basic details were skipped'); }
    else if (!sourceNeeds.length) { lead.SheetBasicRequirements = [...needs, need]; fields.push('SheetBasicRequirements'); }
    else {
      for (const [field,value] of Object.entries(need)) {
        if (['CreatedAt','UpdatedAt','CreatedBy','Source','SourceTab','ConfirmationStatus'].includes(field)) continue;
        if (empty(sourceNeeds[0][field]) && !empty(value)) { sourceNeeds[0][field] = value; fields.push(`Basic.${field}`); }
      }
    }
    const tabs = Array.isArray(lead.SheetSourceTabs) ? lead.SheetSourceTabs : [];
    if (!tabs.includes(tab)) { lead.SheetSourceTabs = [...tabs,tab]; fields.push('SheetSourceTabs'); }
    if (fields.length || created) { lead.UpdatedAt = now; changes.push({ ...ref, leadId: lead.LeadID, action: created ? 'CREATED' : 'FILLED_MISSING', fields }); }
  }
  // Ignore generated timestamps in the preview token, but bind all client data and source rows.
  const token = digest({ source: input, clients: db.Leads || [], counters: db._V2Counters || {}, actor });
  return { next, report: { token, sourceRows: input.records.length, created: changes.filter(x=>x.action === 'CREATED').length,
    updated: changes.filter(x=>x.action !== 'CREATED').length, issues, changes, clientsBefore: (db.Leads || []).length, clientsAfter: next.Leads.length } };
}
module.exports = { planMigration, SOURCE_ID, phone };
