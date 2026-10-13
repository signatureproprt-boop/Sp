# CRM-owned reporting workbook

Workbook: https://docs.google.com/spreadsheets/d/1ICS50baVcDnFJt6UMTcvNzBAMDbs6tX19T9TA-4b3uk/edit
Owner account used to create it: signatureproperties127@gmail.com.

All work is performed in CRM. This separate workbook receives a projection of the durable Mongo snapshot. It is NOT an import source. The original source workbook is retained unchanged. Do not delete it until counts, identities, budgets, follow-ups and lifecycle status are reconciled and the owner approves retirement.

## Deployment and access

CRM_REPORT_SHEET_ID enables the report and pauses legacy incoming Sheet imports (both the recurring CSV import and webhook processing). Cloud Build config points at the new workbook. The legacy /api/sync/google-sheet/export endpoint stays disabled.

Sheets API access uses the existing CRM Google Drive OAuth credentials (SIG_REALTY_GOOGLE_CLIENT_ID, SIG_REALTY_GOOGLE_CLIENT_SECRET, SIG_REALTY_GOOGLE_REFRESH_TOKEN), falling back to Cloud Run application-default credentials. That identity needs Editor access to ONLY the new workbook. Existing refresh-token scopes must permit Sheets operations; Drive scope is supported by the Sheets API. Enable the Sheets API on the credential project if needed. Never make the workbook public to solve access errors.

Authenticated admin endpoints:
- GET /api/sync/crm-report: instance-local last attempt and configured destination.
- POST /api/sync/crm-report: run and await sync (ADMIN_UPDATE permission).

An attempt is made at startup, after durable successful mutations, and every 60 seconds while the instance has CPU. Cloud Run min-instances=0 and request-based CPU can delay background refresh when idle; this is eventual reporting, not a guaranteed wall-clock schedule. Admin POST runs within an active request. If unattended minute-by-minute refresh is required, configure an authenticated scheduler separately.

## Identity and data

Clients has one row per unambiguous CRM LeadID. Work has one row per TransactionID and preliminary Sheet needs not already represented by same-kind work. Preliminary needs use LeadID plus SourceTab as identity; no CRM records are created or removed. Confirmed work supersedes the corresponding preliminary view, while original basic details remain in CRM. Requirements and FollowUps use their own permanent IDs.

Sale/Comm/Rent/Lost/Closed are exclusive views of Work. Comm takes precedence over residential transaction type; Lost/Closed take precedence over category. Transaction status is independent from client status. Lost clients with no work have a separate client-only row. Do not sum Clients, Work, Requirements and their views as one population.

Duplicate source IDs, shared normalized phone identities, orphan references and malformed records are reported in Sync Issues. Conflicting clients and dependent work are excluded rather than merged or assigned arbitrarily. This means a report with issues is explicitly incomplete. Overview says NEEDS REVIEW until these are resolved; do not use its displayed count as proof that migration is complete.

Updates preserve existing ID row slots. Obsolete slots are cleared and reused; sync never unconditionally appends the entire CRM list. All tabs update in one atomic batch. Phones and notes are typed as stringValue, so +91 and formula-like text remain literal. No database payload writes are performed by reporting.

## Verification gate

1. Confirm Cloud Build success and Cloud Run traffic on this code.
2. Confirm report credential identity can edit the new workbook and Sheets API is enabled.
3. Run the authenticated admin sync. Overview must show a current source snapshot; do not confuse an empty prepared workbook with live sync.
4. Resolve Sync Issues, especially the existing COMM-0057 collision, from authoritative source data; never merge distinct clients just to hit a target count.
5. Run sync twice, edit an existing CRM record, and verify the same IDs retain one row. Verify Lost/Closed removes it from the active view, while other work for that client stays active.
6. Retain original Sheet until reconciliation is complete. No legacy Apps Script is removed by this deployment; its write permissions/triggers must be retired separately before deleting the old Sheet.

Limits: 500,000 scanned managed cells, 1.8 MB atomic batch and 45,000 characters per cell. Exceeding a limit stops before writing. Workbook header changes also stop before writing. Last successful snapshot remains visible if a later sync fails.
