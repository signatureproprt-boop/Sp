'use strict';
const crypto = require('node:crypto');
const { BuilderProjectService } = require('./builderProjectService');
const { ProjectMediaCanaryMigrationService } = require('./projectMediaCanaryMigrationService');
const { extractBrochure } = require('./brochureExtractionService');
const { preparePdfForAi } = require('./brochurePdfPreparationService');
const { REVIEW_VERSION } = require('./brochureCompletenessService');
const mongoStore = require('../data/mongoStore');
const running = new Set();
const stored = m => m && m.verified === true && String(m.downloadStatus || '').toLowerCase() === 'downloaded' && (m.DriveFileID || m.DriveFileId || m.StoragePath);
const identity = p => String(p.ProjectName || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, '');
const unique = rows => Array.from(new Set((rows || []).filter(x => typeof x === 'string').map(x => x.trim()).filter(Boolean)));
function grouped(rows) {
  const groups = new Map();
  const fields = ['Type','BHK','CarpetAreaSqft','SuperBuiltUpAreaSqft','TerraceAreaSqft','ParkingAllotted','ServantRoom'];
  for (const [index, row] of rows.entries()) {
    const hasArea = ['CarpetAreaSqft','SuperBuiltUpAreaSqft','BuiltUpAreaSqft'].some(f => Number(row[f]) > 0);
    // Matching BHK alone never proves that unknown-area layouts are identical.
    const unknownLayout = !hasArea ? [String(row.FlatType || '').trim() || null, String(row.Tower || '').trim() || null, index] : null;
    const label = /[a-z]/i.test(String(row.FlatType || '')) ? String(row.FlatType).trim() : null;
    const key = JSON.stringify([unknownLayout, label, ...fields.map(f => row[f] == null || row[f] === '' ? null : row[f])]);
    if (!groups.has(key)) groups.set(key, { ...row, towers: new Set(), flats: new Set() });
    const g = groups.get(key);
    String(row.Tower || '').split('/').filter(Boolean).forEach(x => g.towers.add(x.trim()));
    String(row.FlatType || '').split('/').filter(Boolean).forEach(x => g.flats.add(x.trim()));
  }
  return [...groups.values()].map(({ towers, flats, ...r }) => ({ ...r, Tower: [...towers].join('/'), FlatType: [...flats].join('/') }));
}
function buildPayload(project, data, appendConfigs = false) {
  const actual = identity(data), expected = identity(project);
  if (!actual || !expected || actual !== expected) {
    throw new Error('Review required: PDF project name does not match CRM project (' + String(data.ProjectName || 'missing') + ')');
  }
  const payload = {};
  for (const key of ['BuilderName','Location1','Address','RERANumber','Category','ProjectStatus','TotalUnits','ProjectArea','TotalTowers','TotalFloors','FloorHeightFt','SalesPersonName','PossessionDate','Overview']) {
    if (data[key] != null && data[key] !== '') payload[key] = data[key];
  }
  if (payload.BuilderName) payload.BuilderID = null; // Resolve the printed developer, not a stale imported builder ID.
  // Replace legacy/imported claims with audited source points; append only when processing another PDF in the same job.
  payload.Amenities = unique([...(appendConfigs ? project.Amenities || [] : []), ...(data.Amenities || [])]);
  payload.Highlights = unique([...(appendConfigs ? project.Highlights || [] : []), ...(data.Highlights || [])]).filter(x => !/^(YoutubeVideo|Broucher|Brochure)$/i.test(x));
  payload.Specifications = [];
  const evidence = unique(data.SourceEvidence);
  const warnings = unique(data.ReadingWarnings);
  const configs = (data.ConfigDetails || []).map((c, index) => {
    if (!c || !(c.Type || c.BHK)) return null;
    const row = { ...c, Type: c.Type || 'Apartment', AreaSqft: null, BuiltUpAreaSqft: null };
    for (const key of ['CarpetAreaSqft','SuperBuiltUpAreaSqft','TerraceAreaSqft']) {
      if (row[key] == null || row[key] === '') { row[key] = null; continue; }
      const number = Number(row[key]);
      const label = key === 'CarpetAreaSqft' ? /carpet|c\.?\s*a\.?/i : key === 'TerraceAreaSqft' ? /terrace/i : /saleable|super.?built|s\.?\s*a\.?/i;
      const printedNumber = new RegExp('(^|[^0-9.])' + String(number).replace('.', '\\.') + '([^0-9.]|$)');
      const checkedArea = data.CompletenessReview?.Version === REVIEW_VERSION && data.CompletenessReview?.Status === 'automated_checks_passed' &&
        (data.CompletenessReview.AreaChecks || []).some(a => a.ConfigIndex === index && a.Field === key && Math.abs(a.PrintedValue * (a.PrintedUnit === 'sqm' ? 10.76391041671 : 1) - number) <= 0.1);
      const supported = checkedArea || Number.isFinite(number) && number > 0 && evidence.some(e => /(?:page|pg\.?|p\.)\s*\d+/i.test(e) && label.test(e) && printedNumber.test(e.replace(/,/g,'')));
      if (!supported) { warnings.push(key + ' omitted: missing printed page/area evidence'); row[key] = null; }
      else row[key] = number;
    }
    return row;
  }).filter(Boolean);
  if (configs.length) payload.ConfigDetails = grouped([...(appendConfigs ? project.ConfigDetails || [] : []), ...configs]);
  for (const key of ['PriceMin','PriceMax']) if (data[key] != null && Number.isFinite(Number(data[key]))) payload[key] = Number(data[key]);
  const phone = String(data.SalesPersonPhone || '').trim();
  if (phone && /^(?:\+91)?[6-9]\d{9}$/.test(phone.replace(/[\s-]/g,''))) payload.SalesPersonPhone = phone;
  else if (phone) warnings.push('Printed sales contact (landline / unvalidated mobile): ' + phone);
  payload.Notes = unique([...String(project.Notes || '').split('\n'), ...evidence.map(x => 'PDF source: ' + x), ...warnings.map(x => 'Brochure warning: ' + x)]).join('\n');
  return payload;
}
class UploadedBrochureBatchService {
  constructor(repo, deps = {}) {
    this.repo = repo;
    this.projects = deps.projects || new BuilderProjectService(repo);
    this.media = deps.media || new ProjectMediaCanaryMigrationService(repo);
    this.extract = deps.extract || extractBrochure;
    this.prepare = deps.prepare || preparePdfForAi;
    this.visible = deps.visible || (() => true);
    this.now = deps.now || (() => Date.now());
    this.lock = deps.lock || (mongoStore.isEnabled() ? (name, fn) => mongoStore.withDistributedLock(name, fn, { leaseMs: 900000 }) : async (_name, fn) => ({ acquired: true, result: await fn() }));
  }
  jobs() { return this.repo.read().UploadedBrochureBatches || []; }
  save(job) {
    const db = this.repo.read();
    db.UploadedBrochureBatches = db.UploadedBrochureBatches || [];
    const i = db.UploadedBrochureBatches.findIndex(x => x.JobID === job.JobID);
    job.UpdatedAt = new Date().toISOString();
    if (i < 0) db.UploadedBrochureBatches.push(job); else db.UploadedBrochureBatches[i] = job;
    this.repo.write(db);
  }
  view(job) {
    if (!job) return null;
    const items = job.Items.map(({ Draft, Before, Checkpoint, ...item }) => item);
    return { ...job, Items: items, Total: items.length, Saved: items.filter(x => x.Status === 'saved').length, ChecksPassed: items.filter(x => x.Status === 'saved' && x.CompletenessReview?.Version === REVIEW_VERSION).length,
      Failed: items.filter(x => x.Status === 'failed').length, Pending: items.filter(x => x.Status === 'pending' || x.Status === 'reading').length,
      Projects: new Set(items.map(x => x.ProjectID)).size };
  }
  latest(actorId) { return { ok: true, data: this.view(this.jobs().filter(j => j.ActorID === actorId).at(-1)) }; }
  retry(jobId, actorId) {
    const job = this.jobs().find(j => j.JobID === jobId && j.ActorID === actorId);
    if (!job) return { ok: false, statusCode: 404, error: 'Batch not found' };
    if (Date.parse(job.NextRetryAt || '') > this.now()) return { ok: false, statusCode: 409, error: 'AI temporarily unavailable. Retry after ' + job.NextRetryAt };
    if (running.has(jobId) || job.Items.some(i => i.Status === 'reading')) return { ok: false, statusCode: 409, error: 'Pause and wait for the current PDF before retrying failed PDFs' };
    for (const item of job.Items) if (item.Status === 'failed' || (item.Status === 'saved' && item.CompletenessReview?.Version !== REVIEW_VERSION)) { item.Status = 'pending'; item.Error = null; item.Attempts = 0; if (item.Draft?.CompletenessReview?.Version !== REVIEW_VERSION) delete item.Draft; }
    delete job.NextRetryAt; delete job.PauseReason;
    job.Status = job.Items.some(i => i.Status === 'pending') ? 'ready' : 'complete'; this.save(job);
    return { ok: true, data: this.view(job) };
  }
  start(actorId) {
    const previous = this.jobs().filter(j => j.ActorID === actorId).at(-1);
    if (previous && previous.Items.some(i => ['pending','reading'].includes(i.Status))) return { ok: true, data: this.view(previous) };
    const projects = this.repo.list('BuilderProjects').filter(p => p.Active !== false && this.visible(p));
    const items = [];
    for (const p of projects) {
      const seen = new Set();
      for (const m of (p.Brochures || []).filter(stored)) {
        const key = String(m.DriveFileID || m.DriveFileId || m.StoragePath);
        if (seen.has(key)) continue; seen.add(key);
        items.push({ ItemID: crypto.randomUUID(), ProjectID: p.ProjectID, ProjectName: p.ProjectName, MediaID: m.MediaID || null,
          FileKey: key, Filename: m.Filename || 'brochure.pdf', Status: 'pending', Attempts: 0 });
      }
    }
    const job = { JobID: crypto.randomUUID(), ActorID: actorId, CreatedAt: new Date().toISOString(), Status: items.length ? 'ready' : 'complete', Items: items,
      WithoutStoredBrochure: projects.filter(p => !(p.Brochures || []).some(stored)).length };
    this.save(job);
    return { ok: true, data: this.view(job) };
  }
  async step(jobId, actorId) {
    if (running.has(jobId)) return { ok: false, statusCode: 409, error: 'Batch item already running' };
    running.add(jobId);
    try {
      const locked = await this.lock('uploaded-brochure-batch-' + jobId, async () => {
        const job = this.jobs().find(j => j.JobID === jobId && j.ActorID === actorId);
        if (!job) return { ok: false, statusCode: 404, error: 'Batch not found' };
        if (Date.parse(job.NextRetryAt || '') > this.now()) return { ok: true, data: this.view(job) };
        delete job.NextRetryAt; delete job.PauseReason;
        const item = job.Items.find(i => ['pending','reading'].includes(i.Status));
        if (!item) { job.Status = 'complete'; this.save(job); return { ok: true, data: this.view(job) }; }
        item.Status = 'reading'; item.Attempts++; item.StartedAt = new Date().toISOString(); job.Status = 'running'; this.save(job);
        try {
          const before = this.projects.get(item.ProjectID).data;
          if (!before || before.Active === false || !this.visible(before)) throw new Error('Project unavailable');
          const media = (before.Brochures || []).find(m => stored(m) && String(m.DriveFileID || m.DriveFileId || m.StoragePath) === item.FileKey);
          if (!media) throw new Error('Uploaded brochure changed or removed');
          if (item.Draft?.CompletenessReview?.Version !== REVIEW_VERSION) delete item.Draft;
          if (!item.Draft) {
            const file = await this.media.getProjectBrochureFile(item.ProjectID, media.MediaID, item.FileKey);
            if (!file.ok) throw new Error(file.error || 'Stored PDF unavailable');
            const prepared = await this.prepare(file.buffer);
            item.SourceBytes = file.buffer.length; item.AiBytes = prepared.buffer.length; item.OptimizedCopy = prepared.optimized; item.AiCopyDpi = prepared.resolution || null;
            item.Digest = crypto.createHash('sha256').update(file.buffer).digest('hex');
            item.Draft = await this.extract(prepared.buffer.toString('base64'), null, actorId + ':' + item.ProjectID, { checkpoint: item.Checkpoint, onCheckpoint: async checkpoint => { item.Checkpoint = checkpoint; this.save(job); } });
            if (prepared.optimized) item.Draft.ReadingWarnings = unique([...(item.Draft.ReadingWarnings || []), 'AI read a full-page ' + prepared.resolution + ' DPI optimized copy; original uploaded brochure retained']);
            // Persist the draft only on failure. Successful fields and queue state
            // share one snapshot write, rather than three serial full snapshots.
          }
          if (item.Draft.CompletenessReview?.Version !== REVIEW_VERSION || item.Draft.CompletenessReview?.Status !== 'automated_checks_passed') throw new Error('Review required: independent full-page checks were not completed');
          const current = this.projects.get(item.ProjectID).data;
          if (!current || !this.visible(current)) throw new Error('Project unavailable');
          if (current.UpdatedAt !== before.UpdatedAt) throw new Error('Review required: project edited while AI was reading');
          const append = job.Items.some(i => i.ProjectID === item.ProjectID && i.Status === 'saved');
          const payload = buildPayload(current, item.Draft, append);
          item.Before = Object.fromEntries(Object.keys(payload).map(k => [k, current[k] == null ? null : current[k]]));
          const result = this.projects.update(item.ProjectID, payload, db => {
            item.CompletenessReview = item.Draft.CompletenessReview;
            item.Status = 'saved'; item.SavedAt = new Date().toISOString(); item.Error = null;
            item.Warnings = unique(item.Draft.ReadingWarnings); delete item.Draft; delete item.Checkpoint;
            if (job.Status !== 'cooldown' && !job.Items.some(i => ['pending','reading'].includes(i.Status))) job.Status = 'complete';
            job.UpdatedAt = new Date().toISOString();
            db.UploadedBrochureBatches = db.UploadedBrochureBatches || [];
            const index = db.UploadedBrochureBatches.findIndex(j => j.JobID === job.JobID);
            if (index < 0) db.UploadedBrochureBatches.push(job); else db.UploadedBrochureBatches[index] = job;
          });
          if (!result.ok) throw new Error(result.error || 'Project save failed');
        } catch (error) {
          item.Error = String(error.message || error).slice(0,1000);
          const transient = [429,503].includes(error.status) || ['AI_RATE_LIMIT','AI_UNAVAILABLE'].includes(error.code) || /high demand|quota exceeded|exceeded your current quota|RESOURCE_EXHAUSTED/i.test(item.Error);
          if (transient) {
            item.Status = item.Attempts < 3 ? 'pending' : 'failed';
            item.ErrorCode = error.code || 'AI_UNAVAILABLE';
            const delay = Math.max(60 * Math.pow(2, Math.min(item.Attempts - 1, 4)), Number(error.retryAfterSeconds) || 0);
            job.NextRetryAt = new Date(this.now() + delay * 1000).toISOString();
            job.PauseReason = item.Error;
            job.Status = 'cooldown';
          } else { item.Status = 'failed'; item.ErrorCode = error.code || null; }
        }
        if (!job.Items.some(i => ['pending','reading'].includes(i.Status))) job.Status = 'complete';
        if (item.Status !== 'saved') this.save(job);
        return { ok: true, data: this.view(job) };
      });
      return locked.acquired ? locked.result : { ok: false, statusCode: 409, error: 'Another instance is reading this batch' };
    } finally { running.delete(jobId); }
  }
}
module.exports = { UploadedBrochureBatchService, buildPayload, grouped };
