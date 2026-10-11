'use strict';
const crypto = require('node:crypto');
const { BuilderProjectService } = require('./builderProjectService');
const { ProjectMediaCanaryMigrationService } = require('./projectMediaCanaryMigrationService');
const { extractBrochure } = require('./brochureExtractionService');
const mongoStore = require('../data/mongoStore');
const running = new Set();
const stored = m => m && m.verified === true && String(m.downloadStatus || '').toLowerCase() === 'downloaded' && (m.DriveFileID || m.DriveFileId || m.StoragePath);
const identity = p => String(p.ProjectName || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, '');
const unique = rows => Array.from(new Set((rows || []).filter(x => typeof x === 'string').map(x => x.trim()).filter(Boolean)));
function grouped(rows) {
  const groups = new Map();
  const fields = ['Type','BHK','CarpetAreaSqft','SuperBuiltUpAreaSqft','TerraceAreaSqft','ParkingAllotted','ServantRoom'];
  for (const row of rows) {
    const label = /[a-z]/i.test(String(row.FlatType || '')) ? String(row.FlatType).trim() : null;
    const key = JSON.stringify([label, ...fields.map(f => row[f] == null || row[f] === '' ? null : row[f])]);
    if (!groups.has(key)) groups.set(key, { ...row, towers: new Set(), flats: new Set() });
    const g = groups.get(key);
    String(row.Tower || '').split('/').filter(Boolean).forEach(x => g.towers.add(x.trim()));
    String(row.FlatType || '').split('/').filter(Boolean).forEach(x => g.flats.add(x.trim()));
  }
  return [...groups.values()].map(({ towers, flats, ...r }) => ({ ...r, Tower: [...towers].join('/'), FlatType: [...flats].join('/') }));
}
function buildPayload(project, data, appendConfigs = false) {
  const actual = identity(data), expected = identity(project);
  if (!actual || !expected || !(actual === expected || actual.startsWith(expected) || expected.startsWith(actual))) {
    throw new Error('Review required: PDF project name does not match CRM project (' + String(data.ProjectName || 'missing') + ')');
  }
  const payload = {};
  for (const key of ['BuilderName','Location1','Address','RERANumber','Category','ProjectStatus','TotalUnits','ProjectArea','TotalTowers','TotalFloors','FloorHeightFt','SalesPersonName','PossessionDate','Overview']) {
    if (data[key] != null && data[key] !== '') payload[key] = data[key];
  }
  if (payload.BuilderName) payload.BuilderID = null; // Resolve the printed developer, not a stale imported builder ID.
  // Preserve richer reviewed point lists when an AI pass misses an item.
  payload.Amenities = unique([...(project.Amenities || []), ...(data.Amenities || [])]);
  payload.Highlights = unique([...(project.Highlights || []), ...(project.Specifications || []), ...(data.Highlights || [])]).filter(x => !/^(YoutubeVideo|Broucher|Brochure)$/i.test(x));
  payload.Specifications = [];
  const evidence = unique(data.SourceEvidence);
  const warnings = unique(data.ReadingWarnings);
  const configs = (data.ConfigDetails || []).filter(x => x && (x.Type || x.BHK)).map(c => {
    const row = { ...c, Type: c.Type || 'Apartment', AreaSqft: null, BuiltUpAreaSqft: null };
    for (const key of ['CarpetAreaSqft','SuperBuiltUpAreaSqft','TerraceAreaSqft']) {
      if (row[key] == null || row[key] === '') { row[key] = null; continue; }
      const number = Number(row[key]);
      const label = key === 'CarpetAreaSqft' ? /carpet|c\.?\s*a\.?/i : key === 'TerraceAreaSqft' ? /terrace/i : /saleable|super.?built|s\.?\s*a\.?/i;
      const printedNumber = new RegExp('(^|[^0-9.])' + String(number).replace('.', '\\.') + '([^0-9.]|$)');
      const supported = Number.isFinite(number) && number > 0 && evidence.some(e => /(?:page|pg\.?|p\.)\s*\d+/i.test(e) && label.test(e) && printedNumber.test(e.replace(/,/g,'')));
      if (!supported) { warnings.push(key + ' omitted: missing printed page/area evidence'); row[key] = null; }
      else row[key] = number;
    }
    return row;
  });
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
    this.visible = deps.visible || (() => true);
    this.lock = deps.lock || (mongoStore.isEnabled() ? (name, fn) => mongoStore.withDistributedLock(name, fn, { leaseMs: 600000 }) : async (_name, fn) => ({ acquired: true, result: await fn() }));
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
    const items = job.Items.map(({ Draft, Before, ...item }) => item);
    return { ...job, Items: items, Total: items.length, Saved: items.filter(x => x.Status === 'saved').length,
      Failed: items.filter(x => x.Status === 'failed').length, Pending: items.filter(x => x.Status === 'pending' || x.Status === 'reading').length,
      Projects: new Set(items.map(x => x.ProjectID)).size };
  }
  latest(actorId) { return { ok: true, data: this.view(this.jobs().filter(j => j.ActorID === actorId).at(-1)) }; }
  retry(jobId, actorId) {
    const job = this.jobs().find(j => j.JobID === jobId && j.ActorID === actorId);
    if (!job) return { ok: false, statusCode: 404, error: 'Batch not found' };
    if (running.has(jobId) || job.Items.some(i => i.Status === 'reading')) return { ok: false, statusCode: 409, error: 'Pause and wait for the current PDF before retrying failed PDFs' };
    for (const item of job.Items) if (item.Status === 'failed') { item.Status = 'pending'; item.Error = null; }
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
        const item = job.Items.find(i => ['pending','reading'].includes(i.Status));
        if (!item) { job.Status = 'complete'; this.save(job); return { ok: true, data: this.view(job) }; }
        item.Status = 'reading'; item.Attempts++; item.StartedAt = new Date().toISOString(); job.Status = 'running'; this.save(job);
        try {
          const before = this.projects.get(item.ProjectID).data;
          if (!before || before.Active === false || !this.visible(before)) throw new Error('Project unavailable');
          const media = (before.Brochures || []).find(m => stored(m) && String(m.DriveFileID || m.DriveFileId || m.StoragePath) === item.FileKey);
          if (!media) throw new Error('Uploaded brochure changed or removed');
          if (!item.Draft) {
            const file = await this.media.getProjectBrochureFile(item.ProjectID, media.MediaID, item.FileKey);
            if (!file.ok) throw new Error(file.error || 'Stored PDF unavailable');
            if (!file.buffer || file.buffer.length > 50 * 1024 * 1024) throw new Error('PDF exceeds AI reader limit (50 MB; source ' + Math.round((file.buffer?.length || 0) / 1024 / 1024) + ' MB)');
            item.Digest = crypto.createHash('sha256').update(file.buffer).digest('hex');
            item.Draft = await this.extract(file.buffer.toString('base64'), null, actorId + ':' + item.ProjectID);
            this.save(job); // A failed save can be retried without paying for another AI read.
          }
          const current = this.projects.get(item.ProjectID).data;
          if (!current || !this.visible(current)) throw new Error('Project unavailable');
          if (current.UpdatedAt !== before.UpdatedAt) throw new Error('Review required: project edited while AI was reading');
          const append = job.Items.some(i => i.ProjectID === item.ProjectID && i.Status === 'saved');
          const payload = buildPayload(current, item.Draft, append);
          item.Before = Object.fromEntries(Object.keys(payload).map(k => [k, current[k] == null ? null : current[k]]));
          const result = this.projects.update(item.ProjectID, payload);
          if (!result.ok) throw new Error(result.error || 'Project save failed');
          item.Status = 'saved'; item.SavedAt = new Date().toISOString(); item.Error = null;
          item.Warnings = unique(item.Draft.ReadingWarnings);
          delete item.Draft;
        } catch (error) { item.Status = 'failed'; item.Error = String(error.message || error).slice(0,1000); }
        if (!job.Items.some(i => ['pending','reading'].includes(i.Status))) job.Status = 'complete';
        this.save(job);
        return { ok: true, data: this.view(job) };
      });
      return locked.acquired ? locked.result : { ok: false, statusCode: 409, error: 'Another instance is reading this batch' };
    } finally { running.delete(jobId); }
  }
}
module.exports = { UploadedBrochureBatchService, buildPayload, grouped };
