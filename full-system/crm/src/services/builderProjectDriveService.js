'use strict';

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
    const db = this.repo.read();
    const project = (db.BuilderProjects || []).find((row) =>
      row.ProjectID === projectId && row.Active !== false && this._sameTenant(row, tenant)
    );
    if (!project) return { ok: false, statusCode: 404, error: 'Project not found' };

    if (project.DriveFolderID) {
      return { ok: true, created: false, data: project };
    }

    if (!this.drive || typeof this.drive.createFolder !== 'function') {
      return { ok: false, statusCode: 503, error: 'Google Drive client is not configured' };
    }

    const rootFolderId = process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID;
    if (!rootFolderId) {
      return { ok: false, statusCode: 503, error: 'BUILDER_PROJECTS_DRIVE_FOLDER_ID is not configured' };
    }

    const folderName = safeFolderName(`${project.ProjectID} ${project.ProjectName || 'Project'}`);
    const root = await this.drive.createFolder(folderName, rootFolderId);
    if (!root?.id) throw new Error('Google Drive project folder creation failed');

    const subfolders = {};
    for (const name of PROJECT_SUBFOLDERS) {
      const child = await this.drive.createFolder(name, root.id);
      if (!child?.id) throw new Error(`Google Drive subfolder creation failed: ${name}`);
      subfolders[name] = child.id;
    }

    project.DriveFolderID = root.id;
    project.DriveFolderURL = root.url || `https://drive.google.com/drive/folders/${root.id}`;
    project.DriveSubfolders = subfolders;
    project.UpdatedAt = new Date().toISOString();
    this.repo.write(db);

    return { ok: true, created: true, data: project };
  }
}

module.exports = { BuilderProjectDriveService, PROJECT_SUBFOLDERS, safeFolderName };
