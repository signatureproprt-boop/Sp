'use strict';

// This workbook is a CRM projection, never an import source. All values are
// explicitly typed so phones and user notes cannot become spreadsheet formulas.
const SOURCE_SHEET_ID = '1nkjzrMRDCMoWFnzxxovvxu-fzILv6Li-VfBY4VLr-QI';
const CLIENT_HEADERS = ['Client ID', 'Name', 'Phone', 'Email', 'Client Status', 'Assigned To', 'Next Follow-up', 'Source', 'Notes', 'Updated At', 'Requirement', 'Work Summary'];
const WORK_HEADERS = ['Record ID', 'Client ID', 'Name', 'Phone', 'Transaction ID', 'Record Type', 'Transaction Type', 'Category', 'Status', 'Stage', 'Budget Min', 'Budget Max', 'Location', 'BHK', 'Property Type', 'Assigned To', 'Next Follow-up', 'Lost Reason', 'Notes', 'Updated At'];
const HEADERS = {
  Overview: ['Metric', 'Value'], Clients: CLIENT_HEADERS, Work: WORK_HEADERS,
  Sale: WORK_HEADERS, Comm: WORK_HEADERS, Rent: WORK_HEADERS, Lost: WORK_HEADERS, Closed: WORK_HEADERS,
  Requirements: ['Requirement ID', 'Client ID', 'Transaction ID', 'Status', 'Stage', 'Budget Min', 'Budget Max', 'Location', 'BHK', 'Property Type', 'Details', 'Updated At'],
  FollowUps: ['Follow-up ID', 'Client ID', 'Transaction ID', 'Requirement ID', 'Status', 'Due At', 'Assigned To', 'Notes', 'Updated At'],
  'Sync Issues': ['Issue ID', 'Collection', 'Record ID', 'Reason']
};
const TABS = Object.keys(HEADERS);
const str = v => v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
const id = v => str(v).trim();
const scalar = v => typeof v === 'number' && Number.isFinite(v) ? v : str(v);
function field(row, key) {
  const f = row.Fields?.[key];
  if (f && typeof f === 'object' && f.state) return f.state === 'KNOWN' ? f.value ?? '' : '';
  return row[key] ?? '';
}
function buildProjection(db, snapshotAt) {
  const out = Object.fromEntries(TABS.map(t => [t, []]));
  const issue = (collection, key, reason) => out['Sync Issues'].push([`${collection}:${key}:${reason}`, collection, key, reason]);
  function unique(collection, key) {
    const list = Array.isArray(db[collection]) ? db[collection] : [];
    const grouped = new Map();
    list.forEach((row, i) => {
      const k = id(row?.[key]);
      if (!k) { issue(collection, `source-row-${i + 1}`, `Missing ${key}; excluded`); return; }
      grouped.set(k, [...(grouped.get(k) || []), row]);
    });
    const result = new Map();
    for (const [k, rows] of grouped) {
      if (rows.length !== 1) issue(collection, k, `Duplicate ${key}; all conflicting records excluded`);
      else result.set(k, rows[0]);
    }
    return result;
  }
  const leads = unique('Leads', 'LeadID');
  const transactions = unique('Transactions', 'TransactionID');
  const requirements = unique('Requirements', 'RequirementID');
  const followUps = unique('FollowUps', 'FollowUpID');
  const phoneOwners = new Map();
  for (const [key, lead] of leads) {
    const phone = str(lead.PrimaryMobile || lead.Phone).replace(/\D/g, '');
    const normalized = phone.length === 12 && phone.startsWith('91') ? phone.slice(2) : phone;
    if (normalized.length === 10) phoneOwners.set(normalized, [...(phoneOwners.get(normalized) || []), key]);
  }
  // Never merge different people or silently select a winner for duplicate identity.
  for (const owners of phoneOwners.values()) if (owners.length > 1) for (const key of owners) {
    issue('Leads', key, 'Phone shared by multiple Client IDs; identity review required');
    leads.delete(key);
  }
  const validTx = new Map();
  for (const [key, txn] of transactions) {
    if (!leads.has(id(txn.LeadID))) { issue('Transactions', key, 'Client missing or ambiguous; excluded'); continue; }
    validTx.set(key, txn);
  }
  const reqByTxn = new Map();
  for (const [key, req] of requirements) {
    const txn = validTx.get(id(req.TransactionID));
    if (!leads.has(id(req.LeadID)) || (req.TransactionID && (!txn || id(txn.LeadID) !== id(req.LeadID)))) { issue('Requirements', key, 'Client/transaction link missing or conflicting; excluded'); continue; }
    if (req.TransactionID) reqByTxn.set(id(req.TransactionID), [...(reqByTxn.get(id(req.TransactionID)) || []), req]);
    out.Requirements.push([key, req.LeadID, req.TransactionID, req.RequirementStatus || req.Status, req.PipelineStage,
      field(req, 'BudgetMin'), field(req, 'BudgetMax'), field(req, 'Location1'), field(req, 'BHK'), req.PropertyType || req.SubCategory,
      { Fields: req.Fields || {}, Notes: req.Notes || req.SpecialNotes || '', Preferences: req.Preferences || '' }, req.UpdatedAt]);
  }
  function addWork(key, leadKey, txnKey, kind, row, req = {}) {
    const lead = leads.get(leadKey);
    const value = k => field(row, k) !== '' ? field(row, k) : field(req, k);
    const status = row.RequirementStatus || row.TransactionStatus || row.Status || row.ConfirmationStatus || 'UNCONFIRMED';
    const stage = row.PipelineStage || '';
    const type = row.TransactionType || row.Type || req.TransactionType || '';
    const category = row.Category || req.Category || '';
    const result = [key, leadKey, lead.ClientName || lead.Name, lead.PrimaryMobile || lead.Phone, txnKey, kind,
      type, category, status, stage, value('BudgetMin'), value('BudgetMax'), value('Location1'), value('BHK'),
      value('PropertyType') || value('SubCategory'), lead.AssignedAgentID, lead.NextFollowUp,
      row.LostReason || req.LostReason || '', row.Notes || req.Notes || req.Preferences || '', row.UpdatedAt || lead.UpdatedAt];
    out.Work.push(result);
    const states = [status, stage].map(v => str(v).trim().toLowerCase());
    if (states.includes('lost')) out.Lost.push(result);
    else if (states.some(v => ['closed', 'completed', 'won', 'deal closed'].includes(v))) out.Closed.push(result);
    else if (/commercial/i.test(category)) out.Comm.push(result);
    else if (/rent|lease/i.test(type)) out.Rent.push(result);
    else if (/sale|sell|purchase|buy/i.test(type)) out.Sale.push(result);
    else issue('Work', key, 'Category/type not classified; visible in Work only');
  }
  for (const [key, txn] of validTx) {
    const reqs = reqByTxn.get(key) || [];
    const imported = str(txn._source).startsWith('GoogleSheet:') || txn.CreatedBy === 'GoogleSheetSync';
    addWork(`TXN:${key}`, id(txn.LeadID), key, imported ? 'Imported transaction' : 'Transaction', txn, reqs.length === 1 ? reqs[0] : {});
    if (reqs.length > 1) issue('Transactions', key, 'Multiple requirements; see Requirements tab for individual details');
  }
  for (const [key, req] of requirements) {
    if (leads.has(id(req.LeadID)) && !req.TransactionID) addWork(`REQ:${key}`, id(req.LeadID), '', 'Client requirement', req);
  }
  for (const [leadKey, lead] of leads) {
    const basics = Array.isArray(lead.SheetBasicRequirements) ? lead.SheetBasicRequirements : [];
    const seen = new Set();
    for (const basic of basics) {
      const tab = id(basic.SourceTab);
      if (!tab || seen.has(tab)) { issue('SheetBasicRequirements', leadKey, 'Missing or duplicate SourceTab; review required'); continue; }
      seen.add(tab);
      // An imported transaction already represents this same source tab.
      const represented = [...validTx.values()].some(txn => id(txn.LeadID) === leadKey &&
        (txn._source === `GoogleSheet:${tab}` ||
          (str(txn.TransactionType || txn.Type).toLowerCase() === str(basic.TransactionType).toLowerCase() &&
           str(txn.Category).toLowerCase() === str(basic.Category).toLowerCase())));
      if (represented) continue;
      const clientStatus = str(lead.ClientStatus || lead.LeadStatus).toLowerCase();
      const currentBasic = { ...basic };
      for (const k of ['TransactionType', 'Category', 'BudgetMin', 'BudgetMax', 'Location1', 'BHK', 'PropertyType', 'SubCategory', 'Notes']) {
        if (field(lead, k) !== '') currentBasic[k] = field(lead, k);
      }
      addWork(`BASIC:${leadKey}:${tab}`, leadKey, '', 'Unconfirmed Sheet need',
        ['lost', 'closed', 'won'].includes(clientStatus) ? { ...currentBasic, Status: lead.ClientStatus || lead.LeadStatus } : currentBasic);
    }
    if (!out.Work.some(row => row[1] === leadKey)) {
      const clientStatus = str(lead.ClientStatus || lead.LeadStatus).toLowerCase();
      if (['lost', 'closed', 'won'].includes(clientStatus)) addWork(`LEAD:${leadKey}`, leadKey, '', 'Client without work',
        { Status: lead.ClientStatus || lead.LeadStatus, LostReason: lead.LostReason, Notes: lead.Notes });
    }
  }
  for (const [key, follow] of followUps) {
    if (!leads.has(id(follow.LeadID)) || (follow.TransactionID && !validTx.has(id(follow.TransactionID)))) {
      issue('FollowUps', key, 'Client/transaction missing or ambiguous; excluded'); continue;
    }
    out.FollowUps.push([key, follow.LeadID, follow.TransactionID, follow.RequirementID, follow.Status || follow.FollowUpStatus,
      follow.DueAt || follow.FollowUpDate || follow.ScheduledAt || follow.NextFollowUpDate, follow.AssignedUser || follow.AssignedTo || follow.AssignedAgentID,
      follow.Notes || follow.Note, follow.UpdatedAt]);
  }
  // One client row and fixed summary columns, independent of number of needs.
  const needKeys = ['TransactionType', 'Category', 'PropertyType', 'SubCategory', 'BudgetMin', 'BudgetMax', 'Location1', 'Location2', 'Location3', 'BHK', 'BHKMin', 'BHKMax', 'AreaMin', 'AreaMax', 'Furnishing', 'BusinessUse', 'PossessionTimeline', 'Preferences', 'SpecialNotes', 'Notes'];
  const describe = row => needKeys.map(k => {
    const v = field(row, k); return v === '' || v == null ? '' : `${k}: ${str(v)}`;
  }).filter(Boolean).join(' | ');
  for (const [key, lead] of leads) {
    const confirmed = out.Requirements.filter(r => id(r[1]) === key)
      .map(r => requirements.get(id(r[0]))).sort((a,b) => id(a.RequirementID).localeCompare(id(b.RequirementID)));
    const current = describe(lead);
    const needs = confirmed.length ? confirmed.map(r => `${r.RequirementID}: ${describe(r)}`)
      : current ? [current] : (lead.SheetBasicRequirements || []).map(r => `Unconfirmed: ${describe(r)}`);
    const work = {};
    for (const collection of ['Transactions', 'FollowUps', 'Shortlists', 'SiteVisits', 'Activities']) {
      work[collection] = (db[collection] || []).filter(r => id(r.LeadID || r.ClientID) === key);
    }
    out.Clients.push([key, lead.ClientName || lead.Name, lead.PrimaryMobile || lead.Phone, lead.Email,
      lead.ClientStatus || lead.LeadStatus, lead.AssignedAgentID, lead.NextFollowUp, lead.LeadSource || lead.Source || lead._source,
      lead.Notes, lead.UpdatedAt, needs.filter(Boolean).join('\n'), work]);
  }
  // Deduplicate issue keys without suppressing distinct reasons.
  out['Sync Issues'] = [...new Map(out['Sync Issues'].map(row => [row[0], row])).values()];
  out.Overview = [
    ['Mode', 'CRM → Sheet reporting only; edit in CRM'], ['Source snapshot', snapshotAt || 'Unknown'],
    ['Sync status', out['Sync Issues'].length ? 'NEEDS REVIEW — see Sync Issues; migration not complete' : 'SYNCED'],
    ['Clients', out.Clients.length], ['Work records', out.Work.length], ['Sale', out.Sale.length], ['Comm', out.Comm.length],
    ['Rent', out.Rent.length], ['Lost', out.Lost.length], ['Closed', out.Closed.length], ['Sync issues', out['Sync Issues'].length],
    ['Views', 'Work is the master list. Sale/Comm/Rent/Lost/Closed show the same record IDs; do not add their totals to Work.']
  ];
  for (const tab of TABS) out[tab] = out[tab].map(row => row.map(scalar));
  return out;
}

function cell(value) {
  if (value === '' || value == null) return {};
  if (typeof value === 'number' && Number.isFinite(value)) return { userEnteredValue: { numberValue: value } };
  const text = str(value);
  if (text.length > 45000) throw new Error('Report cell exceeds safe length; no report written');
  return { userEnteredValue: { stringValue: text } };
}

// Match by immutable ID, not row position, phone formatting or name. Existing
// IDs retain their slot even after source order changes; obsolete slots clear.
function reconcileRows(headers, desired, existing) {
  const desiredMap = new Map();
  for (const row of desired) {
    if (!id(row[0]) || desiredMap.has(id(row[0]))) throw new Error('Duplicate or empty report record ID');
    desiredMap.set(id(row[0]), row);
  }
  const slots = existing.slice(1).map(() => Array(headers.length).fill(''));
  const used = new Set();
  existing.slice(1).forEach((row, index) => {
    const key = id(row[0]);
    if (desiredMap.has(key) && !used.has(key)) { slots[index] = desiredMap.get(key); used.add(key); }
  });
  for (const [key, row] of desiredMap) if (!used.has(key)) {
    const empty = slots.findIndex(slot => !slot[0]);
    if (empty >= 0) slots[empty] = row; else slots.push(row);
    used.add(key);
  }
  return [headers, ...slots].map(row => headers.map((_, i) => scalar(row[i])));
}

class CrmSheetReportService {
  constructor({ sheets, spreadsheetId, sourceSheetId = SOURCE_SHEET_ID } = {}) {
    this.spreadsheetId = id(spreadsheetId);
    if (!this.spreadsheetId || this.spreadsheetId === SOURCE_SHEET_ID || this.spreadsheetId === id(sourceSheetId)) {
      throw new Error('A separate CRM reporting spreadsheet is required');
    }
    this.sheets = sheets;
  }
  async sync(db, snapshotAt) {
    const began = Date.now();
    const projection = buildProjection(db, snapshotAt);
    const options = { timeout: 30000, retry: false };
    const metadata = (await this.sheets.spreadsheets.get({ spreadsheetId: this.spreadsheetId,
      fields: 'spreadsheetId,sheets.properties' }, options)).data;
    const byName = new Map((metadata.sheets || []).map(s => [s.properties.title, s.properties]));
    for (const tab of TABS) if (!byName.has(tab)) throw new Error(`Missing report tab: ${tab}`);
    const ranges = TABS.map(tab => `'${tab}'!A1:${String.fromCharCode(64 + Math.min(HEADERS[tab].length, byName.get(tab).gridProperties.columnCount || HEADERS[tab].length))}${byName.get(tab).gridProperties.rowCount}`);
    if (TABS.reduce((n, tab) => n + byName.get(tab).gridProperties.rowCount * HEADERS[tab].length, 0) > 500000) {
      throw new Error('Report exceeds safe scan size; no data written');
    }
    const existing = (await this.sheets.spreadsheets.values.batchGet({ spreadsheetId: this.spreadsheetId,
      ranges, valueRenderOption: 'UNFORMATTED_VALUE' }, options)).data.valueRanges || [];
    const requests = [];
    for (const [i, tab] of TABS.entries()) {
      const values = existing[i]?.values || [];
      const legacyClientHeaders = tab === 'Clients' && JSON.stringify(values[0]) === JSON.stringify(CLIENT_HEADERS.slice(0, 10));
      if (values.length && !legacyClientHeaders && JSON.stringify(values[0]) !== JSON.stringify(HEADERS[tab])) throw new Error(`Unexpected headers in ${tab}; no data written`);
      const rows = reconcileRows(HEADERS[tab], projection[tab], values);
      const props = byName.get(tab);
      if ((props.gridProperties.columnCount || HEADERS[tab].length) < HEADERS[tab].length) requests.push({ updateSheetProperties: {
        properties: { sheetId: props.sheetId, gridProperties: { columnCount: HEADERS[tab].length } }, fields: 'gridProperties.columnCount' } });
      if (rows.length > props.gridProperties.rowCount) requests.push({ updateSheetProperties: {
        properties: { sheetId: props.sheetId, gridProperties: { rowCount: rows.length + 100 } }, fields: 'gridProperties.rowCount' } });
      requests.push({ updateCells: { range: { sheetId: props.sheetId, startRowIndex: 0, endRowIndex: rows.length,
        startColumnIndex: 0, endColumnIndex: HEADERS[tab].length }, rows: rows.map(row => ({ values: row.map(cell) })), fields: 'userEnteredValue' } });
      if (rows.length > 1) requests.push({ repeatCell: { range: { sheetId: props.sheetId, startRowIndex: 1,
        endRowIndex: rows.length, startColumnIndex: 0, endColumnIndex: HEADERS[tab].length },
        cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } },
        fields: 'userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment' } });
      if (tab !== 'Overview') requests.push({ setBasicFilter: { filter: { range: { sheetId: props.sheetId,
        startRowIndex: 0, endRowIndex: Math.max(2, rows.length), startColumnIndex: 0, endColumnIndex: HEADERS[tab].length } } } });
    }
    const body = { requests };
    if (Buffer.byteLength(JSON.stringify(body)) > 1800000) throw new Error('Report exceeds atomic batch budget; no data written');
    if (Date.now() - began > 90000) throw new Error('Report preparation timed out; no data written');
    // One atomic write across all tabs: status changes cannot leave an active
    // copy behind while writing a second Lost/Closed record.
    await this.sheets.spreadsheets.batchUpdate({ spreadsheetId: this.spreadsheetId, requestBody: body }, options);
    return { ok: true, complete: projection['Sync Issues'].length === 0, clients: projection.Clients.length,
      work: projection.Work.length, issues: projection['Sync Issues'].length, snapshotAt, spreadsheetId: this.spreadsheetId };
  }
}

module.exports = { CrmSheetReportService, buildProjection, reconcileRows, cell, HEADERS, TABS, SOURCE_SHEET_ID };
