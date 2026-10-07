'use strict';
const crypto = require('node:crypto');
const ROOTS = ['Transactions','Requirements','RequirementHistory','Activities','FollowUps','Timeline','Matches','Shortlists','SiteVisits','Negotiations','NegotiationHistory','Tokens','Deals','Payments','Commission','CommissionLedger','Closings','ClosingHistory','BrokerShares','BrokerSubmissions','TransactionShares'];
const OPTIONAL = ['Documents','Notifications','BuilderBrochureShares'];
const LEAD_WORK_FIELDS = ['NextFollowUp','NextFollowUpAt','NextFollowUpDate','FollowUpStatus','SiteVisitDate','LastContact','LastContactDate','LastContactChannel','NextActionType','NextActionNote','last_activity_at','ClientScore','ClientScoreBreakdown','ClientScoreCalculatedAt','ClientScoreCalculationVersion'];
const copy = x => JSON.parse(JSON.stringify(x));
const hash = x => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
function state(db) { return { Leads: db.Leads || [], ...Object.fromEntries([...ROOTS,...OPTIONAL].map(k=>[k,db[k]||[]])) }; }
function planClientWorkCleanup(db, input, actor) {
  if (String(actor?.role).toUpperCase() !== 'ADMIN') throw new Error('Administrator required');
  if (!['cleanup','restore'].includes(input?.action)) throw new Error('Choose cleanup or restore');
  const next=copy(db), before=state(db);
  const token=hash({before,backups:db.ClientWorkCleanupBackups||[],input,actor});
  if(input.action==='restore') {
    const backup=(next.ClientWorkCleanupBackups||[]).find(b=>b.BackupID===input.backupId && !b.RestoredAt);
    if(!backup) throw new Error('Recoverable cleanup backup not found');
    if(hash(before)!==backup.AfterHash) throw new Error('Client work changed after cleanup; restore stopped to preserve new work');
    Object.assign(next,copy(backup.Before));
    backup.RestoredAt=new Date().toISOString(); backup.RestoredBy=actor.userId;
    return {next,report:{token,action:'restore',backupId:backup.BackupID,clients:next.Leads.length,counts:backup.Counts,changed:true}};
  }
  const leadIds=new Set((db.Leads||[]).map(l=>l.LeadID).filter(Boolean));
  const txnIds=new Set((db.Transactions||[]).map(t=>t.TransactionID).filter(Boolean));
  const reqIds=new Set((db.Requirements||[]).map(r=>r.RequirementID).filter(Boolean));
  const linked=r=>r && (leadIds.has(r.LeadID)||leadIds.has(r.ClientID)||txnIds.has(r.TransactionID)||reqIds.has(r.RequirementID));
  const counts={};
  for(const k of ROOTS) {counts[k]=(next[k]||[]).length; next[k]=[];}
  for(const k of OPTIONAL) {const rows=next[k]||[];counts[k]=rows.filter(linked).length;next[k]=rows.filter(r=>!linked(r));}
  let changedLeads=0;
  for(const lead of next.Leads||[]) {
    let changed=false;
    for(const f of LEAD_WORK_FIELDS) if(Object.hasOwn(lead,f)){delete lead[f];changed=true;}
    if(changed) changedLeads++;
  }
  const changed=Object.values(counts).some(n=>n>0)||changedLeads>0;
  let backupId=null;
  if(changed) {
    backupId='CLIENT-WORK-'+hash(before).slice(0,20);
    next.ClientWorkCleanupBackups ||= [];
    if(next.ClientWorkCleanupBackups.some(b=>b.BackupID===backupId && !b.RestoredAt)) throw new Error('An unresolved cleanup backup already exists');
    next.ClientWorkCleanupBackups.push({BackupID:backupId,CreatedAt:new Date().toISOString(),CreatedBy:actor.userId,Before:copy(before),AfterHash:hash(state(next)),Counts:counts});
  }
  return {next,report:{token,action:'cleanup',backupId,clients:(db.Leads||[]).length,counts,changed,changedLeads}};
}
module.exports={planClientWorkCleanup};
