'use strict';

function brochureStatusReport(projects, visible = () => true) {
  const rows = (projects || []).filter((p) => p.Active !== false && visible(p)).map((project) => {
    const brochures = Array.isArray(project.Brochures) ? project.Brochures : [];
    const linked = brochures.filter((item) => item?.verified === true && (item.DriveFileId || item.DriveFileID));
    const stored = brochures.filter((item) => item?.verified === true && item.StoragePath);
    const sources = [project.BrochureUrl, ...brochures.map((item) => item?.OriginalUrl || item?.SourceUrl)].filter(Boolean);
    const failureReason = String(project.Notes || '').match(/Brochure ingest failed:\s*([^|]+)/gi)?.at(-1)?.replace(/^Brochure ingest failed:\s*/i, '').trim() ||
      brochures.find((item) => item?.downloadStatus === 'failed')?.error || '';
    const status = linked.length ? 'Drive linked' : stored.length ? 'Stored outside Drive' : failureReason && (sources.length || brochures.length) ? 'Failed' : sources.length || brochures.length ? 'Pending' : 'No brochure source';
    const currentFileIds = linked.map((item) => item.DriveFileId || item.DriveFileID).sort();
    const brochureChecked = project.BrochureReview?.checked === true &&
      JSON.stringify(project.BrochureReview.fileIds || []) === JSON.stringify(currentFileIds);
    const missingFields = [
      ['Builder', project.BuilderName], ['Location', project.Location1], ['Address', project.Address],
      ['Configuration', project.ConfigDetails?.length || project.Configurations?.length],
      ['Price', project.PriceRange?.min ?? project.PriceRange?.max], ['Possession', project.PossessionDate],
      ['RERA', project.RERANumber], ['Overview', project.Overview || project.Description]
    ].filter(([, value]) => value == null || value === '' || value === 0).map(([label]) => label);
    return {
      projectId: project.ProjectID || '', projectName: project.ProjectName || '', builderName: project.BuilderName || '', category: project.Category || '',
      status, brochureCount: linked.length,
      filenames: linked.map((item) => item.Filename || item.filename || '').filter(Boolean).join('; '),
      driveFileIds: linked.map((item) => item.DriveFileId || item.DriveFileID).join('; '),
      sourceUrls: [...new Set(sources)].join('; '), failureReason: linked.length ? '' : failureReason,
      missingFields, formComplete: missingFields.length === 0,
      brochureChecked, brochureCheckedBy: brochureChecked ? project.BrochureReview.checkedBy || '' : '', brochureCheckedAt: brochureChecked ? project.BrochureReview.checkedAt || '' : '',
      formVerified: project.FormReview?.checked === true, formVerifiedBy: project.FormReview?.checkedBy || '', formVerifiedAt: project.FormReview?.checkedAt || ''
    };
  }).sort((a, b) => a.projectName.localeCompare(b.projectName) || a.projectId.localeCompare(b.projectId));
  const counts = { totalProjects: rows.length, driveLinked: 0, storedOutsideDrive: 0, failed: 0, pending: 0, noBrochureSource: 0, linkedFiles: 0 };
  for (const row of rows) {
    counts.linkedFiles += row.brochureCount;
    if (row.status === 'Drive linked') counts.driveLinked++;
    else if (row.status === 'Stored outside Drive') counts.storedOutsideDrive++;
    else if (row.status === 'Failed') counts.failed++;
    else if (row.status === 'Pending') counts.pending++;
    else counts.noBrochureSource++;
  }
  return { ok: true, generatedAt: new Date().toISOString(), counts, rows };
}

const CSV_COLUMNS = ['projectId', 'projectName', 'builderName', 'category', 'status', 'brochureCount', 'filenames', 'driveFileIds', 'sourceUrls', 'failureReason', 'missingFields', 'formComplete', 'brochureChecked', 'brochureCheckedBy', 'brochureCheckedAt', 'formVerified', 'formVerifiedBy', 'formVerifiedAt'];
function reportCsv(report) {
  const quote = (value) => {
    const text = String(value ?? '');
    // Spreadsheet applications can evaluate cells beginning with these symbols as formulas.
    const safe = /^[=+@\-\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  return '\uFEFF' + [CSV_COLUMNS.join(','), ...report.rows.map((row) => CSV_COLUMNS.map((key) => quote(row[key])).join(','))].join('\r\n') + '\r\n';
}

module.exports = { brochureStatusReport, reportCsv };
