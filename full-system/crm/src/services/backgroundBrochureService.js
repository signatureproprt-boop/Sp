'use strict';
const crypto = require('node:crypto');
const { UploadedBrochureBatchService } = require('./uploadedBrochureBatchService');
const inScope = (p, scope) => Boolean(scope.CompanyID && scope.BrokerageID &&
  String(p.CompanyID || p.CompanyId || '') === scope.CompanyID && String(p.BrokerageID || p.BrokerageId || '') === scope.BrokerageID);
const residential = p => String(p.Category || '').trim().toLowerCase() === 'residential';
const blank = value => value == null || value === '' || Array.isArray(value) && value.length === 0;
function fillMissing(project, proposal, item) {
  const out = {}, review = [];
  for (const [key, value] of Object.entries(proposal)) {
    if (key === 'BuilderID' || key === 'Specifications') continue;
    if (key === 'Notes') { out.Notes = value; continue; }
    if (blank(project[key]) || key === 'BuilderName' && /^unknown builder$/i.test(String(project[key]).trim())) out[key] = key === 'ConfigDetails' ? value.map(({FloorPlanMediaID,PriceMin,PriceMax,...row}) => row) : value;
    else if (JSON.stringify(project[key]) !== JSON.stringify(value)) review.push(key);
  }
  if (out.BuilderName) out.BuilderID = null;
  item.ReviewFields = review;
  if (review.length) item.ReviewDraft = Object.fromEntries(review.map(key => [key, proposal[key]]));
  return out;
}
class BackgroundBrochureService {
  constructor(repo, deps = {}) {
    this.repo = repo; this.deps = deps; this.now = deps.now || (() => Date.now());
  }
  configs() { return this.repo.read().BrochureAutomations || []; }
  persist(config) {
    const db = this.repo.read(); db.BrochureAutomations ||= [];
    const i = db.BrochureAutomations.findIndex(c => c.AutomationID === config.AutomationID);
    config.UpdatedAt = new Date(this.now()).toISOString();
    if (i < 0) db.BrochureAutomations.push(config); else db.BrochureAutomations[i] = config;
    this.repo.write(db);
  }
  scope(actor) {
    if (!actor?.companyId || !actor?.brokerageId || !actor?.userId) throw new Error('Tenant-scoped administrator required');
    return { CompanyID:String(actor.companyId), BrokerageID:String(actor.brokerageId) };
  }
  get(actor) {
    const scope = this.scope(actor);
    return this.configs().find(c => c.CompanyID === scope.CompanyID && c.BrokerageID === scope.BrokerageID) || null;
  }
  setEnabled(actor, enabled) {
    const scope = this.scope(actor);
    const config = this.get(actor) || { AutomationID:crypto.randomUUID(), ...scope, Category:'Residential', CreatedAt:new Date(this.now()).toISOString() };
    config.Enabled = enabled === true; config.OwnerUserID = actor.userId; delete config.LastError;
    this.persist(config); return this.status(actor);
  }
  batch(config) {
    return new UploadedBrochureBatchService(this.repo, { ...this.deps, visible:p => inScope(p,config) && residential(p) && this.authorized(config), policy:fillMissing });
  }
  status(actor) {
    const config = this.get(actor);
    if (!config) return { ok:true, data:null };
    const batch = this.batch(config), job = batch.latest('worker:' + config.AutomationID).data;
    return { ok:true, data:{...config, Batch:job, NeedsReview:(job?.Items || []).filter(i => i.ReviewFields?.length || i.Status === 'failed').length} };
  }
  authorized(config) {
    const user = (this.repo.read().Users || []).find(u => u.UserID === config.OwnerUserID);
    return Boolean(user && String(user.Status).toUpperCase() === 'ACTIVE' && String(user.Role).toUpperCase() === 'ADMIN' && inScope(user,config));
  }
  async tick(configId) {
    const config = this.configs().find(c => c.AutomationID === configId);
    if (!config?.Enabled) return { state:'paused' };
    if (!this.authorized(config)) { config.Enabled=false; config.LastError='Enabling administrator is no longer authorized'; this.persist(config); return {state:'disabled'}; }
    const batch = this.batch(config), actorId = 'worker:' + config.AutomationID;
    let job = batch.latest(actorId).data;
    if (!job) job = batch.start(actorId).data;
    // Refresh category/source membership before processing. Completed jobs are
    // extended only with new stored files, never re-read automatically.
    const db = this.repo.read(), raw = (db.UploadedBrochureBatches || []).find(j => j.JobID === job.JobID);
    const eligible = this.repo.list('BuilderProjects').filter(p => p.Active !== false && residential(p) && inScope(p,config));
    const seen = new Set((raw.Items || []).map(i => i.ProjectID + ':' + i.FileKey));
    for (const p of eligible) for (const media of p.Brochures || []) {
      const key = media.DriveFileID || media.DriveFileId || media.StoragePath;
      if (!key || media.verified !== true || String(media.downloadStatus).toLowerCase() !== 'downloaded' || seen.has(p.ProjectID + ':' + key)) continue;
      seen.add(p.ProjectID + ':' + key);
      raw.Items.push({ItemID:crypto.randomUUID(), ProjectID:p.ProjectID, ProjectName:p.ProjectName, MediaID:media.MediaID || null, FileKey:String(key), Filename:media.Filename || 'brochure.pdf', Status:'pending', Attempts:0});
    }
    raw.WithoutStoredBrochure = eligible.filter(p => !(p.Brochures || []).some(m => m.verified === true && String(m.downloadStatus).toLowerCase() === 'downloaded' && (m.DriveFileID || m.DriveFileId || m.StoragePath))).length;
    batch.save(raw); await batch.flush();
    if (Date.parse(raw.NextRetryAt || '') > this.now() || !raw.Items.some(i => ['pending','reading'].includes(i.Status))) {
      const state = Date.parse(raw.NextRetryAt || '') > this.now() ? 'cooldown' : 'complete';
      config.LastHeartbeatAt = new Date(this.now()).toISOString(); config.LastState = state; this.persist(config); await batch.flush();
      return {state, nextRetryAt:raw.NextRetryAt, reason:raw.PauseReason || null};
    }
    config.LastHeartbeatAt = new Date(this.now()).toISOString(); this.persist(config); await batch.flush();
    const out = await batch.step(raw.JobID, actorId); await batch.flush();
    if (!out.ok) return {state:'busy'};
    const latest = this.configs().find(c => c.AutomationID === configId);
    if (latest) { latest.LastHeartbeatAt = new Date(this.now()).toISOString(); latest.LastState=out.data.Status; this.persist(latest); await batch.flush(); }
    return {state:out.data.Status === 'cooldown' ? 'cooldown' : 'processed', nextRetryAt:out.data.NextRetryAt, reason:out.data.PauseReason || null};
  }
}
module.exports = { BackgroundBrochureService, fillMissing, inScope, residential };
