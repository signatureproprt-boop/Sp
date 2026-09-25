#!/usr/bin/env python3
"""Cloud Shell launcher for guarded Builder Project tenant repair. No secrets printed."""
import json
import os
import subprocess
import sys

SERVICE = "signature-realty-crm"
REGION = "asia-south1"
EXPECTED = 679


def output(args):
    return subprocess.check_output(args, stderr=subprocess.DEVNULL)


def main():
    try:
        service = json.loads(output([
            "gcloud", "run", "services", "describe", SERVICE,
            "--region=" + REGION, "--format=json"
        ]))
        settings = {
            item["name"]: item
            for container in service["spec"]["template"]["spec"]["containers"]
            for item in container.get("env", [])
        }
        ref = settings["MONGO_URL"]["valueFrom"]["secretKeyRef"]
        env = os.environ.copy()
        env["MONGO_URL"] = output([
            "gcloud", "secrets", "versions", "access",
            str(ref.get("key", "latest")), "--secret", ref["name"]
        ]).decode().strip()
        env["MONGO_DB"] = settings.get("MONGO_DB", {}).get("value", "signature_properties")
        env.pop("TENANT_REPAIR_APPLY", None)
        env.pop("TENANT_REPAIR_EXPECTED_COUNT", None)
        cmd = ["node", "scripts/repairLegacyBuilderTenants.js"]
        dry = subprocess.run(cmd, env=env, text=True, capture_output=True, check=True)
        line = next(line for line in dry.stdout.splitlines() if line.startswith("TENANT_REPAIR="))
        report = json.loads(line.partition("=")[2])
        print(line)
        if "--apply" not in sys.argv:
            return
        if report["dryRun"] is not True or report["unscoped"] != EXPECTED or report["total"] != EXPECTED:
            raise ValueError("Preflight count changed; repair stopped")
        if report["companyId"] != "COMP-DEFAULT" or report["brokerageId"] != "BRK-DEFAULT":
            raise ValueError("Active tenant changed; repair stopped")
        env["TENANT_REPAIR_APPLY"] = "true"
        env["TENANT_REPAIR_EXPECTED_COUNT"] = str(EXPECTED)
        done = subprocess.run(cmd, env=env, text=True, capture_output=True)
        if done.returncode:
            raise RuntimeError("Repair stopped; database may be unchanged. Inspect local backup and rerun audit.")
        print(next(line for line in done.stdout.splitlines() if line.startswith("TENANT_REPAIR=")))
    except Exception as error:
        print("REPAIR_LAUNCHER_FAILED=" + str(error).replace(
            os.environ.get("MONGO_URL", "__no_secret__"), "[redacted]"))
        sys.exit(1)


if __name__ == "__main__":
    main()
