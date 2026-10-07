'use strict';
const {createReportRunner} = require('./crmSheetReportRunner');
function createExistingRequirementRunner({mongoStore,env=process.env}) {
  return createReportRunner({mongoStore,env:{CRM_REPORT_SHEET_ID:env.CRM_EXISTING_REQUIREMENT_SHEET_ID},lockName:'crm-existing-sheet-requirement',serviceFactory:()=>{
    const {google}=require('googleapis');
    const {createDriveAuth}=require('./googleDriveClient');
    const {ExistingSheetRequirementService}=require('./existingSheetRequirementService');
    return new ExistingSheetRequirementService({sheets:google.sheets({version:'v4',auth:createDriveAuth(env)}),spreadsheetId:env.CRM_EXISTING_REQUIREMENT_SHEET_ID});
  }});
}
module.exports={createExistingRequirementRunner};
