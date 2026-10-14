'use strict';

function confirmBrochureSent(repo, share, payload, actor) {
  if (share.SentAt) return {ok:true,data:share,reused:true};
  const dueAt = payload.followUpAt || null;
  if (dueAt && (!Number.isFinite(Date.parse(dueAt)) || Date.parse(dueAt) <= Date.now())) return {ok:false,error:'Choose a future follow-up time'};
  const db = repo.read();
  const workId=share.RequirementID || share.TransactionID;
  if(workId) {
    const work=require('./clientWorkContext').resolveClientWork(repo,workId);
    if(!work || work.LeadID!==share.LeadID) return {ok:false,error:'Requirement ownership changed; review the client before confirming'};
  }
  const now = new Date().toISOString();
  const stored = (db.BuilderBrochureShares || []).find(row => row.ShareID === share.ShareID);
  if (!stored) return {ok:false,error:'Share unavailable'};
  if (stored.SentAt) return {ok:true,data:stored,reused:true};
  Object.assign(stored, {ShareStatus:'sent_confirmed_manually',SentAt:now,SentBy:actor.userId});
  db.Activities ||= []; db.Timeline ||= []; db.FollowUps ||= [];
  if (share.LeadID) {
    const lead=(db.Leads || []).find(row=>row.LeadID===share.LeadID);
    if(!lead) return {ok:false,error:'Client unavailable'};
    const links = {LeadID:share.LeadID,RequirementID:share.RequirementID || null,TransactionID:share.TransactionID || null,
      CompanyID:lead.CompanyID || actor.companyId || null,BrokerageID:lead.BrokerageID || actor.brokerageId || null};
    const title = `Brochure sent (confirmed by you): ${share.ProjectName || share.ProjectID}`;
    db.Activities.push({...links,ActivityID:repo.createId('ACT'),ActivityType:'WHATSAPP',Notes:title,ShareID:share.ShareID,CreatedAt:now,CreatedBy:actor.userId});
    db.Timeline.push({...links,TimelineID:repo.createId('TML'),EntityType:'BuilderBrochureShare',EntityID:share.ShareID,EventType:'BROCHURE_SENT',EventTitle:title,EventDate:now,CreatedAt:now,Payload:{ProjectID:share.ProjectID,BrochureName:share.BrochureName}});
    if (dueAt) db.FollowUps.push({...links,FollowUpID:repo.createId('FU'),ClientRequestID:`brochure-followup:${share.ShareID}`,DueAt:new Date(dueAt).toISOString(),ActivityType:'CALL',Status:'PENDING',Priority:'Medium',AssignedUser:actor.userId,Notes:`Follow up on ${share.ProjectName || share.ProjectID} brochure`,CreatedBy:actor.userId,CreatedAt:now,UpdatedAt:now});
  }
  repo.write(db);
  return {ok:true,data:stored};
}
module.exports={confirmBrochureSent};
