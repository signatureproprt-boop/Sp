'use strict';
const mongo = require('../src/data/mongoStore');
const {JsonRepository} = require('../src/data/repository');
const {BackgroundBrochureService} = require('../src/services/backgroundBrochureService');
async function main() {
  if (!process.argv.includes('--apply') && !process.argv.includes('--check-storage')) throw Error('Pass --apply to run the residential worker');
  if (process.env.STORAGE_MODE !== 'mongo' || !process.env.MONGO_URL) throw Error('Durable Mongo storage required');
  await mongo.initMongo();
  try {
    if (process.argv.includes('--check-storage')) { console.log('RESIDENTIAL_WORKER_STORAGE=ready'); return; }
    const lock = await mongo.withDistributedLock('residential-brochure-worker', async () => {
      const service = new BackgroundBrochureService(new JsonRepository(), {flush:async()=>{const s=await mongo.flush();if(s.lastError)throw Error('Queue persistence failed');}});
      const deadline = Date.now() + 60 * 60 * 1000;
      for (const config of service.configs().filter(c => c.Enabled)) {
        while (Date.now() < deadline) {
          const out = await service.tick(config.AutomationID);
          console.log('RESIDENTIAL_WORKER=' + JSON.stringify({automationId:config.AutomationID,...out}));
          if (out.state !== 'processed') break;
        }
      }
    }, {leaseMs:7200000});
    if (!lock.acquired) console.log('RESIDENTIAL_WORKER=already-running');
  } finally { await mongo.flush(); await mongo.close(); }
}
if(require.main===module)main().catch(()=>{console.error('RESIDENTIAL_WORKER_FAILED: inspect CRM job status and infrastructure logs');process.exitCode=1;});
module.exports={main};
