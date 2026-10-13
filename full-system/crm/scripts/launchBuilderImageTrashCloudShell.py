#!/usr/bin/env python3
"""Start a scoped Cloud Run Job that moves Builder Projects JPG/PNG to Trash."""
import json
import subprocess
import sys
from pathlib import Path

PROJECT = "signature-509218"
REGION = "asia-south1"
SERVICE = "signature-realty-crm"
JOB = "builder-project-images-trash"
ROOT_ID = "1_Y-siVnZu9rAmkwGbG3OSdIpQ82jTCLD"
IMAGE_BASE = f"{REGION}-docker.pkg.dev/{PROJECT}/signature-realty/signature-realty-crm"
OAUTH_SECRETS = {
    "SIG_REALTY_GOOGLE_CLIENT_ID": "signature-realty-google-client-id",
    "SIG_REALTY_GOOGLE_CLIENT_SECRET": "signature-realty-google-client-secret",
    "SIG_REALTY_GOOGLE_REFRESH_TOKEN": "signature-realty-google-refresh-token",
}


def output(args):
    return subprocess.check_output(args, text=True)


def main():
    crm = Path(__file__).resolve().parent.parent
    service = json.loads(output(["gcloud", "run", "services", "describe", SERVICE,
                                 "--project", PROJECT, "--region", REGION, "--format=json"]))
    spec = service["spec"]["template"]["spec"]
    env = {item["name"]: item for item in spec["containers"][0].get("env", [])}
    if env.get("BUILDER_PROJECTS_DRIVE_FOLDER_ID", {}).get("value") != ROOT_ID:
        raise RuntimeError("Builder Projects folder ID differs; no Job started")
    secrets = []
    for name, fallback in OAUTH_SECRETS.items():
        ref = env.get(name, {}).get("valueFrom", {}).get("secretKeyRef", {})
        secret = ref.get("name", fallback)
        version = ref.get("key", "latest")
        state = output(["gcloud", "secrets", "versions", "describe", str(version),
                        "--secret", secret, "--project", PROJECT, "--format=value(state)"]).strip()
        if state != "ENABLED":
            raise RuntimeError(f"{name} secret version is not enabled; no Job started")
        secrets.append(f"{name}={secret}:{version}")

    jobs = json.loads(output(["gcloud", "run", "jobs", "list", "--project", PROJECT,
                              "--region", REGION, "--format=json"]))
    if any(item.get("metadata", {}).get("name") == JOB or item.get("name", "").endswith("/" + JOB)
           for item in jobs):
        executions = json.loads(output(["gcloud", "run", "jobs", "executions", "list", "--job", JOB,
                                        "--project", PROJECT, "--region", REGION, "--format=json"]))
        if any(not item.get("status", {}).get("completionTime") for item in executions):
            raise RuntimeError("Image Trash Job is already running; no second execution started")

    revision = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=crm, text=True).strip()
    image = f"{IMAGE_BASE}:builder-image-trash-{revision}"
    print("IMAGE_TRASH_STEP=build", flush=True)
    subprocess.run(["gcloud", "builds", "submit", str(crm), "--project", PROJECT,
                    "--tag", image, "--quiet"], check=True)
    args = ["gcloud", "run", "jobs", "deploy", JOB, "--project", PROJECT,
            "--region", REGION, "--image", image, "--command=node",
            "--args=scripts/trashBuilderProjectImagesJob.js,--apply", "--tasks=1", "--parallelism=1",
            "--max-retries=0", "--task-timeout=86400s", "--cpu=1", "--memory=1Gi",
            "--set-env-vars=BUILDER_PROJECTS_DRIVE_FOLDER_ID=" + ROOT_ID,
            "--set-secrets=" + ",".join(secrets), "--quiet"]
    if spec.get("serviceAccountName"):
        args.append("--service-account=" + spec["serviceAccountName"])
    print("IMAGE_TRASH_STEP=deploy", flush=True)
    subprocess.run(args, check=True)
    print("IMAGE_TRASH_STEP=start", flush=True)
    subprocess.run(["gcloud", "run", "jobs", "execute", JOB, "--project", PROJECT,
                    "--region", REGION, "--async", "--quiet"], check=True)
    print("IMAGE_TRASH_STARTED=" + JOB, flush=True)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print("IMAGE_TRASH_FAILED=" + str(error), file=sys.stderr)
        sys.exit(1)
