'use strict';

const DIRECTIONS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
const SPACE_TYPES = {
  residential: new Set(['Entrance','Living room','Kitchen','Master bedroom','Bedroom','Puja','Toilet','Balcony','Staircase']),
  commercial: new Set(['Entrance','Reception/Counter','Owner cabin','Work area','Storage','Pantry','Washroom','Staircase'])
};
const GUIDANCE_VERSION = 'traditional-v1';
const GUIDANCE = Object.freeze({
  Kitchen: { preferred:['SE','ESE','SSE'],alternative:['NW','WNW','NNW'],text:'Traditional guidance commonly considers South-East for the kitchen; North-West is sometimes an alternative.' },
  'Master bedroom': { preferred:['SW','SSW','WSW'],alternative:[],text:'Traditional guidance commonly considers South-West for the master bedroom.' },
  Puja: { preferred:['NE','NNE','ENE'],alternative:[],text:'Traditional guidance commonly considers North-East for puja.' }
});
function guidanceFor(type, direction) {
  const rule = GUIDANCE[type];
  if (!rule || direction === 'Center') return { status:'review_needed',text:direction === 'Center' ? 'Center overlap: check exact room boundary and circulation.' : 'Direction recorded. Review this space with the complete plan and site context.' };
  if (rule.preferred.includes(direction)) return { status:'aligned',text:rule.text };
  if (rule.alternative.includes(direction)) return { status:'alternative',text:rule.text };
  return { status:'review_needed',text:`${rule.text} This marked position needs individual review, not an automatic defect verdict.` };
}

function finiteUnit(value) { return Number.isFinite(value) && value >= 0 && value <= 1; }
function directionFor(mark, region, angle, sourceWidth = 1, sourceHeight = 1) {
  const width = region.w * sourceWidth, height = region.h * sourceHeight;
  const dx = (mark.x - .5) * width, dy = (mark.y - .5) * height;
  if (Math.hypot(dx, dy) < Math.min(width, height) * .08) return { direction: 'Center', bearing: null };
  const screen = (Math.atan2(dy, dx) * 180 / Math.PI + 90 + 360) % 360;
  const bearing = (screen - angle + 360) % 360;
  return { direction: DIRECTIONS[Math.floor((bearing + 11.25) / 22.5) % 16], bearing: Math.round(bearing * 100) / 100 };
}
function sanitizeAnalysis(payload, project, actor, property = null) {
  const type = String(payload.propertyType || '').toLowerCase();
  if (!SPACE_TYPES[type]) throw new Error('Select residential or commercial property type');
  const source = payload.source || {};
  if (!/^[a-f0-9]{64}$/i.test(String(source.sha256 || ''))) throw new Error('Brochure or plan SHA-256 required');
  if (![source.width,source.height].every((v) => Number.isFinite(v) && v >= 30 && v <= 10000)) throw new Error('Invalid page size');
  const page = Number(source.page);
  if (!Number.isInteger(page) || page < 1 || page > 1000) throw new Error('Invalid brochure page');
  const north = payload.north || {};
  const coords = ['centerX','centerY','tipX','tipY'];
  if (!coords.every((k) => finiteUnit(north[k]))) throw new Error('Mark brochure compass center and N tip');
  const dx = (north.tipX - north.centerX) * Number(source.width);
  const dy = (north.tipY - north.centerY) * Number(source.height);
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 12) throw new Error('Compass N tip too close to center');
  const angle = (Math.round(Math.atan2(dy, dx) * 180 / Math.PI + 90) + 360) % 360;
  const layouts = payload.layouts;
  if (!Array.isArray(layouts) || layouts.length < 1 || layouts.length > 4) throw new Error('Select 1 to 4 layouts');
  const expectedCount = Number(payload.layoutCount);
  if (![1,2,4].includes(expectedCount) || layouts.length > expectedCount) throw new Error('Layout count mismatch');
  if (layouts.length > 1 && north.scopeConfirmed !== true) throw new Error('Confirm printed North applies to every selected layout');
  const safeLayouts = layouts.map((r, index) => {
    if (!['x','y','w','h'].every((k) => finiteUnit(r[k])) || r.w < .03 || r.h < .03 || r.x + r.w > 1.001 || r.y + r.h > 1.001) throw new Error(`Invalid layout ${index + 1} boundary`);
    if (!Array.isArray(r.rooms) || r.rooms.length > 60) throw new Error('Too many room markers');
    return {
      x:r.x,y:r.y,w:r.w,h:r.h,confirmed:r.confirmed === true,
      unit:String(r.unit || '').trim().slice(0,80),tower:String(r.tower || '').trim().slice(0,80),
      floor:String(r.floor || '').trim().slice(0,40),
      rooms:r.rooms.map((m) => {
        if (!SPACE_TYPES[type].has(m.type) || !finiteUnit(m.x) || !finiteUnit(m.y)) throw new Error('Invalid space marker');
        const computed = directionFor(m,r,angle,source.width,source.height);
        return { type:m.type,x:m.x,y:m.y,...computed,guidance:guidanceFor(m.type,computed.direction),reviewStatus:'suggested' };
      })
    };
  });
  return {
    ProjectID:project?.ProjectID || null,ProjectName:String(project?.ProjectName || property?.ProjectName || ''),
    PropertyID:property?.PropertyID || null,PropertyTitle:String(property?.Title || ''),
    CompanyID:actor.companyId || null,BrokerageID:actor.brokerageId || null,
    PropertyType:type,SpaceType:String(payload.spaceType || '').trim().slice(0,50),
    LayoutCount:expectedCount,Source:{ sha256:source.sha256.toLowerCase(),page,width:Number(source.width),height:Number(source.height),name:String(source.name || '').slice(0,150) },
    North:{ centerX:north.centerX,centerY:north.centerY,tipX:north.tipX,tipY:north.tipY,angle,scopeConfirmed:north.scopeConfirmed === true,verifiedBy:actor.userId },
    Layouts:safeLayouts,GuidanceVersion:GUIDANCE_VERSION
  };
}
class VastuAnalysisService {
  constructor(repo) { this.repo = repo; }
  list(projectId, actor, propertyId = null) {
    return this.repo.list('VastuAnalyses').filter((r) => (propertyId ? r.PropertyID === propertyId : r.ProjectID === projectId) &&
      (!r.CompanyID || r.CompanyID === actor.companyId) && (!r.BrokerageID || r.BrokerageID === actor.brokerageId));
  }
  saveDraft(payload, actor) {
    const property = payload.propertyId ? this.repo.find('Inventory','PropertyID',String(payload.propertyId)) : null;
    if (payload.propertyId && (!property || property._deleted)) throw new Error('Property not found');
    if (property && ((property.CompanyID && property.CompanyID !== actor.companyId) ||
        (property.BrokerageID && property.BrokerageID !== actor.brokerageId))) throw new Error('Property not available in this workspace');
    const linkedProjectId = property?.ProjectID || property?.ProjectId || null;
    if (property && !linkedProjectId && payload.projectId) throw new Error('Property has no verified project link');
    if (linkedProjectId && payload.projectId && linkedProjectId !== payload.projectId) throw new Error('Property belongs to a different project');
    const projectId = payload.projectId || linkedProjectId;
    const project = projectId ? this.repo.find('BuilderProjects','ProjectID',String(projectId)) : null;
    if ((!project && !property) || (projectId && (!project || project.Active === false))) throw new Error('Project not found');
    if (project && ((project.CompanyID && project.CompanyID !== actor.companyId) ||
        (project.BrokerageID && project.BrokerageID !== actor.brokerageId))) throw new Error('Project not available in this workspace');
    const data = sanitizeAnalysis(payload,project,actor,property), now = new Date().toISOString();
    const id = String(payload.analysisId || '');
    if (id) {
      const old = this.repo.find('VastuAnalyses','AnalysisID',id);
      if (!old || old.ProjectID !== data.ProjectID || (old.PropertyID || null) !== data.PropertyID || old.CreatedBy !== actor.userId || old.Status !== 'draft') throw new Error('Draft unavailable or already finalized');
      const updated = this.repo.update('VastuAnalyses','AnalysisID',id,{ ...data,UpdatedAt:now,Revision:(old.Revision || 1)+1 });
      return updated;
    }
    const row = { ...data,AnalysisID:this.repo.createId('VASTU'),Status:'draft',Revision:1,CreatedBy:actor.userId,CreatedAt:now,UpdatedAt:now };
    this.repo.create('VastuAnalyses',row); return row;
  }
  finalize(id, actor) {
    const old = this.repo.find('VastuAnalyses','AnalysisID',id);
    if (!old || old.CreatedBy !== actor.userId || old.Status !== 'draft') throw new Error('Draft unavailable or already finalized');
    if (old.Layouts.length !== old.LayoutCount || !old.Layouts.every((r) => r.confirmed) || old.Layouts.some((r) => !r.rooms.length)) throw new Error('Confirm every selected layout and mark its spaces before finalizing');
    const now = new Date().toISOString();
    const profile = this.repo.read().BrokerProfile || {};
    if (!profile.Name || !profile.Mobile || profile.Name === 'Vikash Bhatter' || profile.Mobile === '+91 90000 00001') throw new Error('Set real Digital Card name and mobile before finalizing');
    const identity = { name:String(profile.Name),mobile:String(profile.Mobile),agency:String(profile.Agency || 'Signature Properties') };
    return this.repo.update('VastuAnalyses','AnalysisID',id,{ Status:'final',FinalizedAt:now,UpdatedAt:now,IdentitySnapshot:identity });
  }
  recipients(id, actor) {
    const report = this.repo.find('VastuAnalyses','AnalysisID',id);
    if (!report || report.CompanyID !== (actor.companyId || null) || report.BrokerageID !== (actor.brokerageId || null)) throw new Error('Report not available');
    return this.repo.list('VastuReportRecipients').filter((r) => r.AnalysisID === id);
  }
  recordManualShare(id, leadId, channel, actor) {
    const report = this.repo.find('VastuAnalyses','AnalysisID',id);
    if (!report || report.Status !== 'final' || report.CompanyID !== (actor.companyId || null) || report.BrokerageID !== (actor.brokerageId || null)) throw new Error('Final report not available');
    if (!['whatsapp','email','download'].includes(channel)) throw new Error('Invalid share channel');
    const lead = this.repo.find('Leads','LeadID',leadId);
    if (!lead || (lead.CompanyID && lead.CompanyID !== actor.companyId) || (lead.BrokerageID && lead.BrokerageID !== actor.brokerageId)) throw new Error('Client not available');
    const row = {
      RecipientID:this.repo.createId('VREC'),AnalysisID:id,ProjectID:report.ProjectID,PropertyID:report.PropertyID || null,LeadID:lead.LeadID,
      RecipientSnapshot:{ name:String(lead.ClientName || lead.Name || '').slice(0,100),mobile:String(lead.PrimaryMobile || lead.Phone || '').slice(0,30) },
      Channel:channel,Status:'manual_share_recorded',
      // There is no provider delivery receipt or verified viewer identity here.
      DeliveryStatus:null,OpenedAt:null,RecordedBy:actor.userId,RecordedAt:new Date().toISOString(),
      CompanyID:report.CompanyID,BrokerageID:report.BrokerageID
    };
    this.repo.create('VastuReportRecipients',row);
    return row;
  }
}
module.exports = { VastuAnalysisService,directionFor,guidanceFor,sanitizeAnalysis,GUIDANCE_VERSION };
