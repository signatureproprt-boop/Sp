'use strict';

// Durable Cloud Run Job: one project at a time, persist each verified Drive
// link before advancing. A later execution resumes from remaining URLs.
const mongoStore = require('../src/data/mongoStore');
const { JsonRepository } = require('../src/data/repository');
const { KarmaGroupScraperService } = require('../src/services/karmaGroupScraperService');

const MAX_RUNTIME_MS = 23 * 60 * 60 * 1000;
const LOCK_LEASE_MS = 24 * 60 * 60 * 1000;

function eligible(project) {
  return project.Active !== false && Boolean(project.BrochureUrl) &&
    !(project.Brochures || []).some((row) => row.verified === true && (row.DriveFileId || row.DriveFileID));
}

async function main() {
  if (!process.argv.includes('--apply')) throw new Error('Pass --apply to start brochure recovery');
  if (process.env.OBJECT_STORAGE_PROVIDER !== 'GOOGLE_DRIVE') throw new Error('Google Drive provider is required');
  for (const name of ['MONGO_URL', 'GOOGLE_DRIVE_FOLDER_ID', 'SIG_REALTY_GOOGLE_CLIENT_ID',
    'SIG_REALTY_GOOGLE_CLIENT_SECRET', 'SIG_REALTY_GOOGLE_REFRESH_TOKEN']) {
    if (!process.env[name]) throw new Error(`${name} is required; no files were uploaded`);
  }
  process.env.STORAGE_MODE = 'mongo';
  await mongoStore.initMongo();
  try {
    const locked = await mongoStore.withDistributedLock('builder-brochure-retry-job', async () => {
      const repo = new JsonRepository();
      const scraper = new KarmaGroupScraperService(repo, { ingestMedia: false });
      const ids = (repo.read().BuilderProjects || []).filter(eligible).map((row) => row.ProjectID);
      const result = { candidates: ids.length, inspected: 0, linked: 0, recovered: 0, failed: 0, remaining: 0, errors: [] };
      const startedAt = Date.now();
      for (const id of ids) {
        if (Date.now() - startedAt > MAX_RUNTIME_MS) break;
        const db = repo.read();
        const project = (db.BuilderProjects || []).find((row) => row.ProjectID === id);
        if (!project || !eligible(project)) continue;
        result.inspected++;
        let outcome;
        try {
          outcome = await scraper._ingestBrochure(project, project.BrochureUrl, {});
          if (!outcome.ok) throw new Error(outcome.error);
          project.UpdatedAt = new Date().toISOString();
          repo.write(db);
          const saved = await mongoStore.flush();
          if (saved.lastError) throw new Error(`CRM save failed: ${saved.lastError}`);
          result.linked++;
          if (outcome.reused) result.recovered++;
        } catch (error) {
          if (String(error.message || error).startsWith('CRM save failed:')) throw error;
          result.failed++;
          const reason = String(error.message || error).slice(0, 220);
          result.errors.push({ projectId: id, reason });
          if (result.errors.length > 20) result.errors.shift();
        }
        console.log(`BROCHURE_PROGRESS=${JSON.stringify({ inspected: result.inspected, linked: result.linked, recovered: result.recovered, failed: result.failed, projectId: id })}`);
      }
      result.remaining = (repo.read().BuilderProjects || []).filter(eligible).length;
      return result;
    }, { leaseMs: LOCK_LEASE_MS });
    if (!locked.acquired) throw new Error('Another brochure recovery execution is active; no second run started');
    console.log(`BROCHURE_RESULT=${JSON.stringify(locked.result)}`);
  } finally {
    await mongoStore.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`BROCHURE_FAILED=${String(error.message || error).slice(0, 250)}`);
    process.exitCode = 1;
  });
}

module.exports = { eligible };
