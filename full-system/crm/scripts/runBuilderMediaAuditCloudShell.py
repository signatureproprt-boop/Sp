#!/usr/bin/env python3
"""Run the read-only Builder Project completeness and Drive audit in Cloud Shell."""
import json
import os
import subprocess
import sys

SERVICE = "signature-realty-crm"
REGION = "asia-south1"

def output(args):
    return subprocess.check_output(args, stderr=subprocess.DEVNULL)

def main():
    service = json.loads(output([
        "gcloud", "run", "services", "describe", SERVICE,
        "--region=" + REGION, "--format=json"
    ]))
    items = {
        item["name"]: item
        for container in service["spec"]["template"]["spec"]["containers"]
        for item in container.get("env", [])
    }
    env = os.environ.copy()
    for name in ("MONGO_URL", "MONGO_DB", "GOOGLE_DRIVE_FOLDER_ID"):
        item = items.get(name)
        if not item:
            if name == "MONGO_DB":
                env[name] = "signature_properties"
                continue
            raise RuntimeError(name + " is not configured in Cloud Run")
        ref = item.get("valueFrom", {}).get("secretKeyRef")
        if ref:
            env[name] = output([
                "gcloud", "secrets", "versions", "access",
                str(ref.get("key", "latest")), "--secret", ref["name"]
            ]).decode().strip()
        else:
            env[name] = item.get("value", "")
    result = subprocess.run(["node", "scripts/auditBuilderMediaDrive.js"],
                            env=env, text=True, capture_output=True)
    if result.returncode:
        print("MEDIA_AUDIT_FAILED=" + result.stderr.replace(env["MONGO_URL"], "[redacted]")[-800:], file=sys.stderr)
        raise SystemExit(result.returncode)
    print(result.stdout.strip())

if __name__ == "__main__":
    main()
