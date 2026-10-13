'use strict';
const { normalizePhone } = require('./v2LeadService');
const TABS = ['Comm', 'Sale', 'Rent'];
const text = v => v == null ? '' : Array.isArray(v) ? v.join(', ') : String(v);
const value = c => c?.userEnteredValue?.stringValue ?? c?.userEnteredValue?.numberValue ?? c?.formattedValue ?? '';
function summary(lead, requirements) {
  const keys = ['BudgetMin', 'BudgetMax', 'Location1', 'Location2', 'Location3', 'BHK', 'BHKMin', 'BHKMax', 'AreaMin', 'AreaMax', 'CarpetArea', 'BuiltUpArea', 'Furnishing', 'BusinessType', 'BusinessUse', 'PossessionTimeline', 'Preferences', 'SpecialNotes'];
  function line(row) {
    const parts = [row.TransactionType || row.RequirementType, row.Category || row.PropertyType, row.SubCategory].filter(Boolean).map(text);
    for (const k of keys) {
      const f = row.Fields?.[k];
      const v = f?.state ? (f.state === 'KNOWN' ? f.value : null) : row[k];
      if (v !== undefined && v !== null && v !== '') parts.push(`${k}: ${text(v)}`);
    }
    if (row.RequirementStatus) parts.push(`Status: ${row.RequirementStatus}`);
    if (row.LostReason) parts.push(`Lost reason: ${row.LostReason}`);
    return parts.join(' | ');
  }
  if (requirements.length) return requirements.map((r, i) => `${i + 1}. ${line(r)}`).join('\n');
  // Imported preliminary Sheet snapshots never overwrite their source cells.
  return line(lead);
}
function plan(db, sheets) {
  const requests = [], issues = [];
  const leads = db.Leads || [], requirements = db.Requirements || [];
  for (const sheet of sheets) {
    const props = sheet.properties;
    const rows = sheet.data?.[0]?.rowData || [];
    const headers = (rows[0]?.values || []).map(value);
    const indexes = ['Lead ID', 'Phone', 'Requirement'].map(h => headers.indexOf(h));
    if (indexes.some(i => i < 0) || indexes.some(i => headers.filter(h => h === headers[i]).length !== 1)) throw new Error(`Missing or ambiguous existing headers in ${props.title}`);
    const [idCol, phoneCol, reqCol] = indexes;
    const rowIds = new Map();
    rows.slice(1).forEach(r => { const id = text(value(r.values?.[idCol])).trim(); if(id) rowIds.set(id,(rowIds.get(id)||0)+1); });
    for (let i = 1; i < rows.length; i++) {
      const cells = rows[i].values || [];
      const id = text(value(cells[idCol])).trim();
      if (!id) continue;
      const candidates = leads.filter(l => l.LeadID === id || l.LegacyID === id);
      if (rowIds.get(id) !== 1 || candidates.length !== 1) { issues.push(`${props.title}:${i+1}:ambiguous identity`); continue; }
      const lead = candidates[0];
      const phone = normalizePhone(value(cells[phoneCol]));
      if (!phone || phone !== normalizePhone(lead.PrimaryMobile || lead.Phone)) { issues.push(`${props.title}:${i+1}:phone mismatch`); continue; }
      const confirmed = requirements.filter(r => r.LeadID === lead.LeadID && !String(r._source || r.Source || '').startsWith('GoogleSheet:') && r.CreatedBy !== 'GoogleSheetSync');
      const desired = summary(lead, confirmed);
      if (!desired || desired === text(value(cells[reqCol]))) continue;
      const current = cells[reqCol] || {};
      if (current.userEnteredValue?.formulaValue || current.dataValidation || current.chipRuns?.length) { issues.push(`${props.title}:${i+1}:controlled requirement cell`); continue; }
      if (desired.length > 45000) throw new Error('Requirement summary exceeds cell limit');
      requests.push({updateCells: {range: {sheetId: props.sheetId, startRowIndex:i, endRowIndex:i+1, startColumnIndex:reqCol, endColumnIndex:reqCol+1}, rows:[{values:[{userEnteredValue:{stringValue:desired}}]}], fields:'userEnteredValue'}});
    }
  }
  return {requests, issues};
}
class ExistingSheetRequirementService {
  constructor({sheets, spreadsheetId}) { this.sheets=sheets; this.spreadsheetId=spreadsheetId; }
  async sync(db, snapshotAt) {
    const options={timeout:30000,retry:false};
    const meta=(await this.sheets.spreadsheets.get({spreadsheetId:this.spreadsheetId,fields:'sheets.properties'},options)).data;
    const tabs=TABS.map(t=>meta.sheets.find(s=>s.properties.title===t));
    if(tabs.some(t=>!t)) throw new Error('Existing lead tabs missing');
    if(tabs.reduce((n,s)=>n+s.properties.gridProperties.rowCount*s.properties.gridProperties.columnCount,0)>150000) throw new Error('Lead Sheet exceeds scan limit');
    function col(n) { let s=''; while(n){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26)}return s; }
    const data=(await this.sheets.spreadsheets.get({spreadsheetId:this.spreadsheetId,ranges:tabs.map(s=>`'${s.properties.title}'!A1:${col(s.properties.gridProperties.columnCount)}${s.properties.gridProperties.rowCount}`),fields:'sheets(properties,data(rowData(values(userEnteredValue,formattedValue,dataValidation,chipRuns))))'},options)).data;
    const selected=(data.sheets || []).filter(s=>TABS.includes(s.properties.title));
    if(selected.length!==TABS.length) throw new Error('Existing lead tab data missing');
    const result=plan(db,selected);
    if(Buffer.byteLength(JSON.stringify(result.requests))>1800000) throw new Error('Requirement update exceeds batch limit');
    if(result.requests.length) await this.sheets.spreadsheets.batchUpdate({spreadsheetId:this.spreadsheetId,requestBody:{requests:result.requests}},options);
    return {ok:true,complete:result.issues.length===0,updated:result.requests.length,issues:result.issues.length,snapshotAt,spreadsheetId:this.spreadsheetId};
  }
}
module.exports={ExistingSheetRequirementService,plan,summary};
