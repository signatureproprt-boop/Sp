'use strict';
async function dispatchWorker() {
  const {google} = require('googleapis');
  const auth = new google.auth.GoogleAuth({scopes:['https://www.googleapis.com/auth/cloud-platform']});
  const token = await auth.getAccessToken();
  const project=process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || 'signature-509218';
  const response=await fetch(`https://run.googleapis.com/v2/projects/${encodeURIComponent(project)}/locations/asia-south1/jobs/residential-brochure-worker:run`,{method:'POST',signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:'{}'});
  if(!response.ok)throw Error('Worker execution request failed');
  // The operation acknowledgement is not a claim that a PDF was processed.
  return {requested:true};
}
module.exports={dispatchWorker};
