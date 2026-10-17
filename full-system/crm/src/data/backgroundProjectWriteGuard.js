'use strict';
const {isDeepStrictEqual} = require('node:util');

// A worker may read for minutes while another replica accepts manual edits.
// Check the acknowledged project under the snapshot write lock, rather than
// relying only on the worker's periodically refreshed in-memory UpdatedAt.
function assertBackgroundProjectsUnchanged(base, desired, remote) {
  for (const job of desired.UploadedBrochureBatches || []) {
    if (!String(job.ActorID || '').startsWith('worker:')) continue;
    const previous = (base.UploadedBrochureBatches || []).find(j => j.JobID === job.JobID);
    for (const item of job.Items || []) {
      if (item.Status !== 'saved' || previous?.Items?.some(i => i.ItemID === item.ItemID && i.Status === 'saved')) continue;
      const before = (base.BuilderProjects || []).find(p => p.ProjectID === item.ProjectID);
      const current = (remote.BuilderProjects || []).find(p => p.ProjectID === item.ProjectID);
      if (!before || !current || !isDeepStrictEqual(before, current)) {
        const error = new Error('Background project changed on another replica; reload before saving');
        error.code = 'BACKGROUND_PROJECT_CHANGED';
        throw error;
      }
    }
  }
}
module.exports = {assertBackgroundProjectsUnchanged};
