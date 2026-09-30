'use strict';

const pendingProjectFolderEnsures = new Map();

const PROJECT_SUBFOLDERS = [
  'Brochures',
  'Floor Plans',
  'Project Images',
  'Price Lists',
  'RERA Documents',
  'Payment Plans',
  'Videos',
  'Other Documents'
];

function safeFolderName(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function brochureFilename(value) {
  try {
    const pathname = new URL(String(value), 'https://example.invalid').pathname;
    return decodeURIComponent(pathname.split('/').pop() || '').toLowerCase();
  } catch (_) { return ''; }
}

class BuilderProjectDriveService {
  constructor(repository, driveClient) {
    this.repo = repository;
    this.drive = driveClient;
  }

  _sameTenant(row, tenant = {}) {
    if (tenant.companyId && row.CompanyID !== tenant.companyId) return false;
    if (tenant.brokerageId && row.BrokerageID !== tenant.brokerageId) return false;
    return true;
  }

  async linkExistingBrochures({ dryRun = true, limit = 20, offset = 0, tenant = {}, projectIds = null, folderHints = {} } = {}) {
    if (!this.drive || typeof this.drive.listFilesInFolder !== 'function') {
      return { ok: false, statusCode: 503, error: 'Google Drive file listing is unavailable' };
    }
    const db = this.repo.read();
    const candidates = (db.BuilderProjects || []).filter((row) =>
      row.Active !== false && this._sameTenant(row, tenant) &&
      (!projectIds || projectIds.includes(String(row.ProjectID))) &&
      !(row.Brochures || []).some((item) => item.verified === true && (item.DriveFileID || item.DriveFileId))
    );
    const start = Math.max(0, Number(offset) || 0);
    const projects = candidates.slice(start, start + Math.max(1, Math.min(100, Number(limit) || 20)));
    const rootId = process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID;
    // A saved folder can be an empty duplicate while the PDF lives in another
    // folder for the same ProjectID. Inspect all exact project folders.
    const rootFolders = rootId ? (await this.drive.listFilesInFolder(rootId)).filter((file) =>
      file.mimeType === 'application/vnd.google-apps.folder'
    ) : [];
    const result = { totalCandidates: candidates.length, offset: start, inspected: 0, linked: 0,
      ready: 0, empty: 0, unmatched: 0, ambiguous: 0, errors: [], examples: [] };
    for (const project of projects) {
      result.inspected += 1;
      try {
        const projectId = String(project.ProjectID);
        let hinted = null;
        if (folderHints[projectId]) {
          if (!rootId || typeof this.drive.getFileMetadata !== 'function') {
            throw new Error('Drive folder verification is unavailable');
          }
          hinted = await this.drive.getFileMetadata(folderHints[projectId]);
          if (hinted.trashed || hinted.mimeType !== 'application/vnd.google-apps.folder' ||
              !hinted.parents?.includes(rootId) ||
              ![projectId, `Project-${projectId}`].some((prefix) =>
                hinted.name === prefix || String(hinted.name || '').startsWith(`${prefix} `))) {
            throw new Error('Hinted folder does not belong to this project under the configured Drive root');
          }
        }
        const matches = [
          ...(hinted ? [hinted] : []),
          ...(project.DriveFolderID ? [{ id: project.DriveFolderID }] : []),
          ...rootFolders.filter((file) => [projectId, `Project-${projectId}`].some((prefix) =>
            file.name === prefix || String(file.name || '').startsWith(`${prefix} `)
          ))
        ].filter((file, index, all) => all.findIndex((item) => item.id === file.id) === index);
        if (matches.length === 0) { result.empty += 1; continue; }
        const expectedNames = new Set([
          project.BrochureUrl,
          ...(project.Brochures || []).flatMap((row) => [row.OriginalUrl, row.SourceUrl])
        ].map(brochureFilename).filter((name) => name.endsWith('.pdf')));
        const files = [];
        const matching = [];
        for (const folder of matches) {
          const brochureFolderId = project.DriveFolderID === folder.id && project.DriveSubfolders?.Brochures
            ? project.DriveSubfolders.Brochures : (await this.drive.findFolder('Brochures', folder.id))?.id;
          if (!brochureFolderId) continue;
          for (const file of await this.drive.listFilesInFolder(brochureFolderId)) {
            if (file.mimeType !== 'application/pdf' && !/\.pdf$/i.test(file.name || '')) continue;
            files.push(file);
            if (expectedNames.has(String(file.name || '').toLowerCase())) {
              matching.push({ file, folderId: brochureFolderId, projectFolderId: folder.id });
            }
          }
        }
        if (files.length === 0) { result.empty += 1; continue; }
        if (matching.length === 0) {
          result.unmatched += 1;
          result.examples.push({ projectId: project.ProjectID, projectName: project.ProjectName,
            reason: 'PDF filename does not match the CRM brochure URL', filenames: files.slice(0, 3).map((file) => file.name) });
          continue;
        }
        // Multiple physical copies may be linked only when Drive confirms the bytes
        // are identical. Filename and size alone do not establish that.
        const sameBytes = matching.length > 1 && matching.every(({ file }) =>
          file.md5Checksum && file.md5Checksum === matching[0].file.md5Checksum &&
          Number(file.size) > 0 && Number(file.size) === Number(matching[0].file.size)
        );
        if (matching.length !== 1 && !sameBytes) {
          result.ambiguous += 1;
          result.examples.push({ projectId: project.ProjectID, projectName: project.ProjectName,
            reason: `${matching.length} PDFs match the CRM brochure number; content is not confirmed identical` });
          continue;
        }
        const selected = matching.sort((a, b) => String(a.file.id).localeCompare(String(b.file.id)))[0];
        const { file, folderId, projectFolderId } = selected;
        result.ready += 1;
        result.examples.push({ projectId: project.ProjectID, projectName: project.ProjectName,
          fileId: file.id, filename: file.name, identicalCopies: matching.length });
        if (dryRun) continue;
        project.Brochures = Array.isArray(project.Brochures) ? project.Brochures : [];
        // A matching file ID may already exist in an unverified legacy row.
        // Complete that record instead of leaving it unusable or adding a duplicate.
        const existing = project.Brochures.find((row) => row.DriveFileID === file.id || row.DriveFileId === file.id);
        const linkedRecord = {
          ...(existing || {}),
          MediaID: existing?.MediaID || this.repo.createId('MED'),
          Filename: file.name, fileName: file.name,
          DriveFileID: file.id, DriveFileId: file.id,
          DriveWebViewLink: file.webViewLink || `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view`,
          DriveWebContentLink: file.webContentLink || null,
          OriginalUrl: existing?.OriginalUrl || project.BrochureUrl || null,
          Url: `/api/v2/builder-projects/${encodeURIComponent(project.ProjectID)}/brochure`,
          mimeType: 'application/pdf', sizeBytes: Number(file.size || 0) || null,
          storageType: 'google-drive', stored: true, verified: true,
          downloadStatus: 'downloaded', Source: 'ExistingProjectDriveFolder',
          UploadedAt: existing?.UploadedAt || new Date().toISOString()
        };
        if (existing) Object.assign(existing, linkedRecord);
        else project.Brochures.push(linkedRecord);
        // Other media may already depend on the saved project folder. Change
        // only the brochure reference when the PDF is in a duplicate folder.
        project.DriveSubfolders = { ...(project.DriveSubfolders || {}), Brochures: folderId };
        project.DriveFolderID ||= projectFolderId;
        project.DriveFolderURL ||= `https://drive.google.com/drive/folders/${encodeURIComponent(projectFolderId)}`;
        project.UpdatedAt = new Date().toISOString();
        this.repo.write(db);
        result.linked += 1;
      } catch (error) {
        result.errors.push({ projectId: project.ProjectID, error: String(error.message || error).slice(0, 200) });
      }
    }
    return { ok: true, data: { dryRun, ...result } };
  }

  async ensureProjectFolder(projectId, tenant = {}) {
    const key = JSON.stringify([
      String(projectId),
      tenant.companyId || null,
      tenant.brokerageId || null
    ]);
    const pending = pendingProjectFolderEnsures.get(key);
    if (pending) return pending;

    const operation = this._ensureProjectFolder(projectId, tenant);
    pendingProjectFolderEnsures.set(key, operation);
    try {
      return await operation;
    } finally {
      if (pendingProjectFolderEnsures.get(key) === operation) {
        pendingProjectFolderEnsures.delete(key);
      }
    }
  }

  async _ensureProjectFolder(projectId, tenant = {}) {
    const db = this.repo.read();
    const project = (db.BuilderProjects || []).find((row) =>
      row.ProjectID === projectId && row.Active !== false && this._sameTenant(row, tenant)
    );
    if (!project) return { ok: false, statusCode: 404, error: 'Project not found' };

    if (project.DriveFolderID && PROJECT_SUBFOLDERS.every((name) => project.DriveSubfolders?.[name])) {
      return { ok: true, created: false, data: project };
    }

    if (!this.drive || typeof this.drive.createFolder !== 'function') {
      return { ok: false, statusCode: 503, error: 'Google Drive client is not configured' };
    }

    const rootFolderId = process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID;
    if (!rootFolderId) {
      return { ok: false, statusCode: 503, error: 'BUILDER_PROJECTS_DRIVE_FOLDER_ID is not configured' };
    }

    const findOrCreate = async (name, parentId) => {
      // A failed lookup must stop the upload: creating blindly makes duplicates.
      const existing = await this.drive.findFolder(name, parentId);
      if (existing?.id) return existing;
      try {
        return await this.drive.createFolder(name, parentId);
      } catch (error) {
        // Drive may have created the folder even when the response timed out.
        const recovered = await this.drive.findFolder(name, parentId);
        if (recovered?.id) return recovered;
        throw error;
      }
    };

    if (typeof this.drive.findFolder !== 'function') {
      return { ok: false, statusCode: 503, error: 'Google Drive folder lookup is not configured' };
    }

    let created = false;
    if (!project.DriveFolderID) {
      const folderName = safeFolderName(`${project.ProjectID} ${project.ProjectName || 'Project'}`);
      const existing = await this.drive.findFolder(folderName, rootFolderId);
      const root = existing || await findOrCreate(folderName, rootFolderId);
      if (!root?.id) throw new Error('Google Drive project folder creation failed');
      created = !existing;
      project.DriveFolderID = root.id;
      project.DriveFolderURL = root.url || `https://drive.google.com/drive/folders/${root.id}`;
      project.UpdatedAt = new Date().toISOString();
      this.repo.write(db);
    }

    project.DriveSubfolders = project.DriveSubfolders || {};
    for (const name of PROJECT_SUBFOLDERS) {
      if (project.DriveSubfolders[name]) continue;
      const child = await findOrCreate(name, project.DriveFolderID);
      if (!child?.id) throw new Error(`Google Drive subfolder creation failed: ${name}`);
      project.DriveSubfolders[name] = child.id;
      project.UpdatedAt = new Date().toISOString();
      this.repo.write(db);
    }
    return { ok: true, created, data: project };
  }

  async uploadProjectFile(projectId, category, filename, buffer, mimeType, tenant = {}) {
    const existing = (this.repo.read().BuilderProjects || []).find((row) =>
      row.ProjectID === projectId && row.Active !== false && this._sameTenant(row, tenant)
    );
    const ensured = existing?.DriveFolderID && existing.DriveSubfolders?.[category]
      ? { ok: true, data: existing }
      : await this.ensureProjectFolder(projectId, tenant);
    if (!ensured.ok) return ensured;
    const project = ensured.data;
    const folderId = project.DriveSubfolders?.[category];
    if (!folderId) return { ok: false, statusCode: 400, error: `Unknown Drive category: ${category}` };
    if (!this.drive || typeof this.drive.uploadBuffer !== 'function') {
      return { ok: false, statusCode: 503, error: 'Google Drive upload client is not configured' };
    }
    const uploaded = await this.drive.uploadBuffer(safeFolderName(filename) || 'file', buffer, folderId, mimeType);
    return { ok: true, data: uploaded, project };
  }
}

module.exports = { BuilderProjectDriveService, PROJECT_SUBFOLDERS, safeFolderName };
