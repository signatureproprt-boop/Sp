#!/usr/bin/env python3
"""Build the current CRM, deploy its 404 fix, and start durable brochure linking.

Run in Cloud Shell from the CRM directory. No Mongo secret is printed or copied
to local files: the Cloud Run Job receives the same Secret Manager reference as
the existing service. The job continues independently of Cloud Shell.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

PROJECT = "signature-509218"
REGION = "asia-south1"
SERVICE = "signature-realty-crm"
JOB = "builder-brochure-link"
IMAGE_BASE = f"{REGION}-docker.pkg.dev/{PROJECT}/signature-realty/signature-realty-crm"


def run(args, *, capture=False, cwd=None):
    print("BACKEND_STEP=" + " ".join(args[:3]), flush=True)
    if capture:
        return subprocess.check_output(args, text=True, cwd=cwd)
    subprocess.run(args, check=True, cwd=cwd)


def main():
    crm = Path(__file__).resolve().parent.parent
    if not (crm / "Dockerfile").exists() or not (crm / "scripts/linkBuilderBrochuresCloudShell.js").exists():
        raise RuntimeError("Run from the updated CRM checkout")
    running = subprocess.run(["pgrep", "-f", "[n]ode scripts/linkBuilderBrochuresCloudShell.js"],
                             capture_output=True, text=True)
    if running.returncode == 0:
        raise RuntimeError("A Cloud Shell linking process is still running. Stop it before launching the Job.")

    service = json.loads(run([
        "gcloud", "run", "services", "describe", SERVICE,
        "--project", PROJECT, "--region", REGION, "--format=json"
    ], capture=True))
    spec = service["spec"]["template"]["spec"]
    env = {item["name"]: item for item in spec["containers"][0].get("env", [])}
    mongo = env.get("MONGO_URL", {}).get("valueFrom", {}).get("secretKeyRef", {})
    if not mongo.get("name"):
        raise RuntimeError("MONGO_URL must be configured via Secret Manager in Cloud Run")
    root = env.get("BUILDER_PROJECTS_DRIVE_FOLDER_ID", {}).get("value", "")
    if not root or "," in root:
        raise RuntimeError("Builder Projects Drive root is missing or invalid")
    mongo_db = env.get("MONGO_DB", {}).get("value", "signature_properties")
    if "," in mongo_db:
        raise RuntimeError("MONGO_DB is invalid")
    service_account = spec.get("serviceAccountName")
    revision = run(["git", "rev-parse", "--short", "HEAD"], capture=True, cwd=crm).strip()
    image = f"{IMAGE_BASE}:builder-link-{revision}"

    run(["gcloud", "builds", "submit", str(crm), "--project", PROJECT,
         "--tag", image, "--quiet"])
    # Deploying the same image to the service makes the DriveFileId 404 fix live.
    run(["gcloud", "run", "deploy", SERVICE, "--project", PROJECT,
         "--region", REGION, "--image", image, "--quiet"])

    job_args = ["gcloud", "run", "jobs", "deploy", JOB, "--project", PROJECT,
                "--region", REGION, "--image", image,
                "--command=node", "--args=scripts/linkBuilderBrochuresCloudShell.js,--apply",
                "--tasks=1", "--parallelism=1", "--max-retries=0",
                "--task-timeout=14400s", "--cpu=1", "--memory=1Gi",
                "--set-env-vars=" + f"STORAGE_MODE=mongo,MONGO_DB={mongo_db},BUILDER_PROJECTS_DRIVE_FOLDER_ID={root}",
                "--set-secrets=" + f"MONGO_URL={mongo['name']}:{mongo.get('key', 'latest')}",
                "--quiet"]
    if service_account:
        job_args.append("--service-account=" + service_account)
    run(job_args)
    run(["gcloud", "run", "jobs", "execute", JOB,
         "--project", PROJECT, "--region", REGION, "--async", "--quiet"])
    print("BACKEND_STARTED=" + JOB, flush=True)
    print("STATUS_COMMAND=gcloud run jobs executions list --job " + JOB +
          " --project " + PROJECT + " --region " + REGION, flush=True)


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        print(f"BACKEND_FAILED=command exited {error.returncode}", file=sys.stderr)
        sys.exit(error.returncode)
    except Exception as error:
        print(f"BACKEND_FAILED={error}", file=sys.stderr)
        sys.exit(1)
