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
