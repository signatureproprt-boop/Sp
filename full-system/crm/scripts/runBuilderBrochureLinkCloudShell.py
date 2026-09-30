#!/usr/bin/env python3
"""Run brochure linking in Cloud Shell. Dry run unless --apply is supplied."""
import json
import os
import subprocess
import sys

SERVICE = "signature-realty-crm"
REGION = "asia-south1"
PROJECT = "signature-509218"

def output(args):
    return subprocess.check_output(args)

def main():
    service = json.loads(output([
        "gcloud", "run", "services", "describe", SERVICE,
        "--region=" + REGION, "--project=" + PROJECT, "--format=json"
    ]))
    items = {
        item["name"]: item
        for container in service["spec"]["template"]["spec"]["containers"]
        for item in container.get("env", [])
    }
    env = os.environ.copy()
    for name in ("MONGO_URL", "MONGO_DB", "BUILDER_PROJECTS_DRIVE_FOLDER_ID"):
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
                str(ref.get("key", "latest")), "--secret", ref["name"], "--project=" + PROJECT
            ]).decode().strip()
        else:
            env[name] = item.get("value", "")
    command = ["node", "scripts/linkBuilderBrochuresCloudShell.js"]
    command.extend(arg for arg in sys.argv[1:] if arg.startswith("--inspect-projects="))
    if "--list-all" in sys.argv[1:]:
        command.append("--list-all")
    elif "--list" in sys.argv[1:]:
        command.append("--list")
    if "--recover-six" in sys.argv[1:]:
        command.append("--recover-six")
    if "--apply" in sys.argv[1:]:
        command.append("--apply")
    process = subprocess.Popen(command, env=env, text=True,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               bufsize=1)
    for line in process.stdout:
        print(line.replace(env["MONGO_URL"], "[redacted]"), end="", flush=True)
    if process.wait():
        raise SystemExit(process.returncode)

if __name__ == "__main__":
    main()
