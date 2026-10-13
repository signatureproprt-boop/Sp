'use strict';
const { parse } = require('csv-parse/sync');
const { planMigration, SOURCE_ID, phone } = require('./sheetMigrationService');
const SOURCE_TABS={Comm:'1338146659',Sale:'606119692',Rent:'0'};

async function readSourceRecords(download) {
  const records=[],skipped=[];
  for(const [tab,gid] of Object.entries(SOURCE_TABS)){
    const csv=await download(SOURCE_ID,tab,gid);
    const grid=parse(csv,{skip_empty_lines:false,relax_column_count:true});
    const seen=new Set();
    const headers=(grid[0]||[]).map((value,index)=>{
      const base=String(value||'').trim()||('Column '+(index+1));
      const name=seen.has(base)?base+' [Column '+(index+1)+']':base;seen.add(name);return name;
    });
    if(!headers.includes('Phone'))throw new Error('Source headers are not recognized');
    const rows=grid.slice(1).map(values=>Object.fromEntries(headers.map((key,i)=>[key,values[i]??''])));
    if(rows.length>5000)throw new Error('Source tab exceeds safe import size');
    rows.forEach((row,index)=>{
      const raw=String(row.Phone||'').trim();
      if(!raw||raw.includes('#')){if(raw)skipped.push({tab,sourceRow:index+2,reason:'Spreadsheet error in phone; skipped'});return;}
      if(!String(row.Name||'').trim()&&!String(row['Lead ID']||'').trim())return;
      records.push({tab,sourceRow:index+2,row});
    });
  }
  if(!records.length||records.length>1000)throw new Error('Source import requires 1–1000 meaningful rows');
  return {spreadsheetId:SOURCE_ID,records,reviewedRows:true,skipped};
}

function comm57Repair(db,source){
  const rows=source.records.filter(item=>item.tab==='Rent'&&item.row['Lead ID']==='RENT-0006'&&String(item.row.Name||'').trim().toLowerCase()==='dr arohi'&&phone(item.row.Phone));
  if(rows.length!==1)throw new Error('Dr Arohi source identity is not uniquely verified');
  const item=rows[0];
  const already=(db.Leads||[]).find(l=>l.LeadID==='RENT-0006'&&l.LegacyID==='RENT-0006'&&phone(l.PrimaryMobile||l.Phone)===phone(item.row.Phone));
  if(already)return [];
  const matches=(db.Leads||[]).filter(l=>l.LeadID==='COMM-0057'&&l.LegacyID==='RENT-0006'&&String(l.ClientName||'').trim().toLowerCase()==='dr arohi');
  if(matches.length!==1)throw new Error('CRM Dr Arohi identity does not match the source repair');
  return [{oldLeadId:'COMM-0057',legacyId:'RENT-0006',sourceTab:'Rent',sourceRow:item.sourceRow}];
}
function buildSourcePlan(db,source,actor,{repairComm57=false}={}){
  const input={...source,identityRepairs:repairComm57?comm57Repair(db,source):[]};
  const plan=planMigration(db,input,actor);
  return {...plan,report:{...plan.report,skippedSourceRows:source.skipped||[],identityRepairs:input.identityRepairs}};
}
function enabledImportActor(db){
  const config=db.SourceSheetImport;
  if(!config?.enabled||config.sourceId!==SOURCE_ID||!config.actor?.userId)return null;
  const user=(db.Users||[]).find(u=>u.UserID===config.actor.userId);
  const role=String(user?.Role||(db.Roles||[]).find(r=>r.RoleID===user?.RoleID)?.Name||'').toUpperCase();
  if(!user||String(user.Status||'Active').toLowerCase()!=='active'||!['ADMIN','SUPER_ADMIN'].includes(role))return null;
  const companyId=user.CompanyID||user.CompanyId||null,brokerageId=user.BrokerageID||user.BrokerageId||null;
  if(String(companyId||'')!==String(config.actor.companyId||'')||String(brokerageId||'')!==String(config.actor.brokerageId||''))return null;
  return {...config.actor,role:'ADMIN'};
}
module.exports={readSourceRecords,buildSourcePlan,comm57Repair,enabledImportActor,SOURCE_ID,SOURCE_TABS};
