'use strict';

// Link matching brochure PDFs from existing project folders to CRM records.
// Run from Cloud Shell through runBuilderBrochureLinkCloudShell.py.
const mongoStore = require('../src/data/mongoStore');
const recoveryFolders = require('./builderBrochureRecoveryFolders.json');
const { JsonRepository } = require('../src/data/repository');
const { BuilderProjectDriveService } = require('../src/services/builderProjectDriveService');
const { createGoogleDriveClient } = require('../src/services/googleDriveClient');
const { brochureStatusReport, reportCsv } = require('../src/services/builderBrochureStatusReport');
const fs = require('node:fs');

async function main() {
  const apply = process.argv.includes('--apply');
  if (!process.env.MONGO_URL || !process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID) {
    throw new Error('MONGO_URL and BUILDER_PROJECTS_DRIVE_FOLDER_ID are required');
  }
  process.env.STORAGE_MODE = 'mongo';
  await mongoStore.initMongo();
  let summary;
  try {
    const repo = new JsonRepository();
    if (process.argv.includes('--audit-errors')) {
      const db = repo.read();
      const report = brochureStatusReport(db.BuilderProjects || []);
      const runs = (db.KarmaScrapeRuns || []).map((run) => ({
        runId: run.RunID, startedAt: run.StartedAt, mode: run.Mode,
        brochuresFailed: Number(run.BrochuresFailed || 0), recordedErrorDetails: (run.Errors || []).length
      }));
      const reasons = new Map();
      for (const row of report.rows.filter((row) => row.status === 'Failed')) {
        const reason = row.failureReason || 'Unknown';
        reasons.set(reason, (reasons.get(reason) || 0) + 1);
      }
      const filename = 'builder-brochure-errors.csv';
      fs.writeFileSync(filename, reportCsv(report));
      summary = { counts: report.counts, recentRuns: runs,
        topReasons: [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([reason, projects]) => ({ reason, projects })),
        note: 'BrochuresFailed counts attempts per run; project rows reflect current CRM state. Only recent error details are retained.',
        report: filename };
      await mongoStore.close();
      await new Promise((resolve) => process.stdout.write(`${JSON.stringify(summary)}\n`, resolve));
      process.exit(0);
    }
    const inspectArg = process.argv.find((arg) => arg.startsWith('--inspect-projects='));
    if (inspectArg) {
      const ids = inspectArg.slice('--inspect-projects='.length).split(',').filter(Boolean);
      const projects = (repo.read().BuilderProjects || []);
      summary = { projects: ids.map((id) => {
        const project = projects.find((row) => String(row.ProjectID) === id);
        return project ? {
          projectId: id, projectName: project.ProjectName, active: project.Active !== false,
          brochureUrl: project.BrochureUrl || null, driveFolderId: project.DriveFolderID || null,
          brochureFolderId: project.DriveSubfolders?.Brochures || null,
          brochures: (project.Brochures || []).map((row) => ({
            filename: row.Filename || row.fileName || null,
            originalUrl: row.OriginalUrl || row.SourceUrl || null,
            driveFileId: row.DriveFileID || row.DriveFileId || null,
            verified: row.verified === true, source: row.Source || null
          }))
        } : { projectId: id, missingFromCrm: true };
      }) };
      await mongoStore.close();
      await new Promise((resolve) => process.stdout.write(`${JSON.stringify(summary)}\n`, resolve));
      process.exit(0);
    }
    if (process.argv.includes('--list') || process.argv.includes('--list-all')) {
      const all = process.argv.includes('--list-all');
      const linked = (repo.read().BuilderProjects || []).flatMap((project) =>
        (project.Brochures || []).filter((row) => (all || row.Source === 'ExistingProjectDriveFolder') &&
          (row.DriveFileID || row.DriveFileId) &&
          (!all || /\.pdf$/i.test(row.Filename || row.fileName || row.OriginalUrl || '') || row.mimeType === 'application/pdf')).map((row) => ({
          projectId: project.ProjectID,
          projectName: project.ProjectName,
          filename: row.Filename || row.fileName,
          driveFileId: row.DriveFileID || row.DriveFileId,
          source: row.Source || null,
          verified: row.verified === true
        }))
      );
      summary = { linkedCount: linked.length, linked };
      await mongoStore.close();
      await new Promise((resolve) => process.stdout.write(`${JSON.stringify(summary)}\n`, resolve));
      process.exit(0);
    }
    const rootId = process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID;
    const drive = createGoogleDriveClient({ env: {} });
    // The project root does not change during linking; avoid listing it for
    // every project while still fetching each brochure folder afresh.
    const list = drive.listFilesInFolder.bind(drive);
    let rootFolders;
    drive.listFilesInFolder = async (id) => {
      if (id !== rootId) return list(id);
      rootFolders ||= await list(id);
      return rootFolders;
    };
    const svc = new BuilderProjectDriveService(repo, drive);
    const recovery = process.argv.includes('--recover-six');
    const scope = recovery ? { projectIds: Object.keys(recoveryFolders), folderHints: recoveryFolders } : {};
    const first = await svc.linkExistingBrochures({ dryRun: true, limit: 1, ...scope });
    if (!first.ok) throw new Error(first.error);
    const total = first.data.totalCandidates;
    summary = { dryRun: !apply, candidates: total, inspected: 0, ready: 0,
      linked: 0, empty: 0, unmatched: 0, ambiguous: 0, errors: [] };
    // Iterate backwards: successfully linked projects leave the candidates
    // list, but lower offsets remain stable.
    for (let offset = total - 1; offset >= 0; offset--) {
      const result = await svc.linkExistingBrochures({ dryRun: !apply, limit: 1, offset, ...scope });
      if (!result.ok) throw new Error(result.error);
      const data = result.data;
      for (const key of ['inspected', 'ready', 'linked', 'empty', 'unmatched', 'ambiguous']) {
        summary[key] += data[key] || 0;
      }
      summary.errors.push(...data.errors);
      if (apply && data.linked) {
        const persisted = await mongoStore.flush();
        if (persisted.lastError) throw new Error(`Mongo write failed: ${persisted.lastError}`);
      }
      if (data.ready || data.errors.length || summary.inspected % 25 === 0) {
        console.error(`LINK_PROGRESS=inspected:${summary.inspected},ready:${summary.ready},linked:${summary.linked},errors:${summary.errors.length}`);
      }
    }
  } finally {
    await mongoStore.close();
  }
  // A polling callback that was already in flight can race with close() and
  // open another Mongo connection. Flush the result before ending the CLI.
  await new Promise((resolve) => process.stdout.write(`${JSON.stringify(summary)}\n`, resolve));
  process.exit(0);
}

main().catch(async (error) => {
  await new Promise((resolve) => process.stderr.write(
    `LINK_FAILED=${String(error.message || error).slice(0, 300)}\n`, resolve));
  process.exit(1);
});
