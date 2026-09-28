# Karma scrape → brochures in Google Drive

## What the scrape does now
- Discovers Karma Group projects (category discovery, ~758 candidates) and processes **one project at a time**.
- Saves project details (name, builder, location, category, status, descriptions, configurations, source project ID / URL).
- Ingests **brochure PDFs only**. Photos, floor plans and videos are **not downloaded or uploaded** — their source URLs are kept as plain references only.
- Each brochure PDF is uploaded to Google Drive and the following are stored on the brochure record:
  `DriveFileId`, `DriveWebViewLink`, `DriveWebContentLink` (plus `StoragePath`, `verified`, `downloadStatus`).
- The Builder Projects card shows a **📄 Brochure** link (streamed via `/api/v2/builder-projects/:id/brochure`) and a **🗂 Drive** link (the `DriveWebViewLink`).

## Durability / resume
- The run checkpoints after every project (`KarmaScrapeRuns`), records per-project errors (project name, source id, stage, reason) and continues on failure.
- The POST endpoints return `202 accepted` immediately; the UI polls `/scrape/status` without holding the request open.
- If the instance is interrupted, status shows `interrupted` and **Resume** continues after the last checkpoint. A second scrape cannot start while one is running.

## Required Cloud Run configuration
Environment variables:
- `OBJECT_STORAGE_PROVIDER=GOOGLE_DRIVE`  ← brochures refuse a GridFS fallback unless this is set
- `GOOGLE_DRIVE_FOLDER_ID=<the Drive folder ID>`
- `KARMA_SCRAPE_INGEST_MEDIA=false`
- `KARMA_SCRAPE_INGEST_BROCHURES=true`
- `KARMA_SCRAPE_ALLOW_CREATE=true` (default; set `false` to only update already-matched projects)

Drive permission:
- The Cloud Run revision uses Application Default Credentials (its attached **service account**).
- That service account email must have **Editor** access to the `GOOGLE_DRIVE_FOLDER_ID` folder (share the folder with it).

To keep the background job alive on Cloud Run (scale-to-zero kills in-process work once the request returns), deploy with:
- `--no-cpu-throttling` (CPU always allocated)
- `--min-instances=1`
- a larger `--timeout` (e.g. 3600)
Even without these, the checkpoint + **Resume** flow lets the scrape finish across multiple runs.
