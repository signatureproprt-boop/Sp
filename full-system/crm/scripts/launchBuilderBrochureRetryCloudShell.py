#!/usr/bin/env python3
"""Deploy and start one durable, OAuth-backed brochure recovery Cloud Run Job."""
import json
import subprocess
import sys
from pathlib import Path

PROJECT = "signature-509218"
REGION = "asia-south1"
SERVICE = "signature-realty-crm"
JOB = "builder-brochure-retry"
IMAGE_BASE = f"{REGION}-docker.pkg.dev/{PROJECT}/signature-realty/signature-realty-crm"
OAUTH_SECRETS = {
    "SIG_REALTY_GOOGLE_CLIENT_ID": "signature-realty-google-client-id",
    "SIG_REALTY_GOOGLE_CLIENT_SECRET": "signature-realty-google-client-secret",
    "SIG_REALTY_GOOGLE_REFRESH_TOKEN": "signature-realty-google-refresh-token",
}


def output(args):
    return subprocess.check_output(args, text=True)


def secret_ref(env, name, fallback=None):
    ref = env.get(name, {}).get("valueFrom", {}).get("secretKeyRef", {})
    if ref.get("name"):
        return f"{name}={ref['name']}:{ref.get('key', 'latest')}"
    if fallback:
        state = output(["gcloud", "secrets", "versions", "describe", "latest", "--secret", fallback,
                        "--project", PROJECT, "--format=value(state)"]).strip()
        if state != "ENABLED":
            raise RuntimeError(f"{fallback}: latest secret version is not enabled")
        return f"{name}={fallback}:latest"
    else:
        raise RuntimeError(f"{name} must be a Cloud Run Secret Manager reference; secret values are never put in job arguments")


def main():
    crm = Path(__file__).resolve().parent.parent
    service = json.loads(output(["gcloud", "run", "services", "describe", SERVICE,
                                 "--project", PROJECT, "--region", REGION, "--format=json"]))
    spec = service["spec"]["template"]["spec"]
    env = {item["name"]: item for item in spec["containers"][0].get("env", [])}
    if env.get("OBJECT_STORAGE_PROVIDER", {}).get("value") != "GOOGLE_DRIVE":
        raise RuntimeError("CRM Drive provider is not GOOGLE_DRIVE; no Job was started")
    root = env.get("BUILDER_PROJECTS_DRIVE_FOLDER_ID", {}).get("value", "")
    if not root or "," in root:
        raise RuntimeError("Builder Projects Drive folder is missing; no Job was started")
    mongo_db = env.get("MONGO_DB", {}).get("value", "signature_properties")
    if "," in mongo_db:
        raise RuntimeError("Invalid Mongo database name")
    secrets = [secret_ref(env, "MONGO_URL")]
    secrets.extend(secret_ref(env, name, fallback) for name, fallback in OAUTH_SECRETS.items())

    jobs = json.loads(output(["gcloud", "run", "jobs", "list", "--project", PROJECT,
                              "--region", REGION, "--format=json"]))
    if any(item.get("metadata", {}).get("name") == JOB or item.get("name", "").endswith("/" + JOB)
           for item in jobs):
        existing = json.loads(output(["gcloud", "run", "jobs", "executions", "list", "--job", JOB,
                                      "--project", PROJECT, "--region", REGION, "--format=json"]))
        if any(not item.get("status", {}).get("completionTime") for item in existing):
            raise RuntimeError("Brochure recovery Job is already running; no second execution started")

    revision = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=crm, text=True).strip()
    image = f"{IMAGE_BASE}:brochure-retry-{revision}"
    print("BACKEND_STEP=build", flush=True)
    subprocess.run(["gcloud", "builds", "submit", str(crm), "--project", PROJECT,
                    "--tag", image, "--quiet"], check=True)
    args = ["gcloud", "run", "jobs", "deploy", JOB, "--project", PROJECT,
            "--region", REGION, "--image", image, "--command=node",
            "--args=scripts/retryBuilderBrochuresJob.js,--apply", "--tasks=1", "--parallelism=1",
            "--max-retries=0", "--task-timeout=86400s", "--cpu=1", "--memory=1Gi",
            "--set-env-vars=" + f"STORAGE_MODE=mongo,MONGO_DB={mongo_db},OBJECT_STORAGE_PROVIDER=GOOGLE_DRIVE,GOOGLE_DRIVE_FOLDER_ID={root}",
            "--set-secrets=" + ",".join(secrets), "--quiet"]
    if spec.get("serviceAccountName"):
        args.append("--service-account=" + spec["serviceAccountName"])
    print("BACKEND_STEP=deploy-job", flush=True)
    subprocess.run(args, check=True)
    print("BACKEND_STEP=start-job", flush=True)
    subprocess.run(["gcloud", "run", "jobs", "execute", JOB, "--project", PROJECT,
                    "--region", REGION, "--async", "--quiet"], check=True)
    print("BACKEND_STARTED=" + JOB, flush=True)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print("BACKEND_FAILED=" + str(error), file=sys.stderr)
        sys.exit(1)
