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
    return {
      projectId: project.ProjectID || '', projectName: project.ProjectName || '', builderName: project.BuilderName || '',
      status, brochureCount: linked.length,
      filenames: linked.map((item) => item.Filename || item.filename || '').filter(Boolean).join('; '),
      driveFileIds: linked.map((item) => item.DriveFileId || item.DriveFileID).join('; '),
      sourceUrls: [...new Set(sources)].join('; '), failureReason: linked.length ? '' : failureReason
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

const CSV_COLUMNS = ['projectId', 'projectName', 'builderName', 'status', 'brochureCount', 'filenames', 'driveFileIds', 'sourceUrls', 'failureReason'];
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
