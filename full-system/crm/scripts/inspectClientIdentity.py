#!/usr/bin/env python3
"""Read-only evidence for the confirmed distinct clients sharing COMM-0057."""
import json
import os
import sys
import subprocess
import tempfile
from pathlib import Path
from datetime import datetime, timezone

PROJECT = "signature-509218"
REGION = "asia-south1"
SERVICE = "signature-realty-crm"
TARGET = "COMM-0057"

def gcloud(*args):
    return subprocess.check_output(["gcloud", *args, "--project=" + PROJECT],
                                   stderr=subprocess.DEVNULL, text=True).strip()

def inspect_payload(payload):
    if not isinstance(payload, dict) or any(not isinstance(payload.get(k), list)
            for k in ("Leads", "Transactions", "Requirements")):
        raise ValueError("Expected CRM arrays not found.")
    txids = {r.get("TransactionID") for r in payload["Transactions"]
             if isinstance(r, dict) and r.get("LeadID") == TARGET and isinstance(r.get("TransactionID"), str)}
    reqids = {r.get("RequirementID") for r in payload["Requirements"]
              if isinstance(r, dict) and (r.get("LeadID") == TARGET or r.get("TransactionID") in txids)
              and isinstance(r.get("RequirementID"), str)}
    targets = {TARGET} | (txids - {""}) | (reqids - {""})
    def refers(value):
        if isinstance(value, dict):
            return any(refers(v) for v in value.values())
        if isinstance(value, list):
            return any(refers(v) for v in value)
        return isinstance(value, str) and value in targets
    records = {}
    for name in ("Leads", "Transactions", "Requirements", "Activities", "FollowUps",
                 "Shortlists", "Timeline", "Audit", "RequirementHistory", "Deals",
                 "SiteVisits", "BrokerSubmissions"):
        rows = payload.get(name, [])
        if not isinstance(rows, list):
            continue
        selected = []
        for index, row in enumerate(rows):
            malformed = name in ("Transactions", "Requirements") and (
                not isinstance(row, dict) or not row.get("TransactionID" if name == "Transactions" else "RequirementID"))
            if refers(row) or malformed:
                selected.append({"rowIndex": index, "record": row})
        if selected:
            records[name] = selected
    return {"targetLeadID": TARGET, "distinctClientsConfirmedByUser": True,
            "records": records, "databaseWrites": 0}

def run():
    from pymongo import MongoClient
    from pymongo.errors import PyMongoError
    service = json.loads(gcloud("run", "services", "describe", SERVICE,
                               "--region=" + REGION, "--format=json"))
    containers = service["spec"]["template"]["spec"]["containers"]
    if len(containers) != 1:
        raise ValueError("Unexpected container configuration; stopped.")
    settings = {item["name"]: item for item in containers[0].get("env", [])}
    def setting(name, default=""):
        item = settings.get(name, {})
        if "value" in item:
            return item["value"]
        ref = item.get("valueFrom", {}).get("secretKeyRef")
        if ref:
            return gcloud("secrets", "versions", "access", str(ref.get("key", "latest")),
                          "--secret=" + ref["name"])
        return default
    if setting("STORAGE_MODE").lower() != "mongo":
        raise ValueError("Storage is not Mongo snapshot mode; stopped without changes.")
    uri = setting("MONGO_URL")
    if not uri:
        raise ValueError("MONGO_URL is missing.")
    client = MongoClient(uri, serverSelectionTimeoutMS=30000, connectTimeoutMS=30000, socketTimeoutMS=60000)
    try:
        db = client[setting("MONGO_DB", "signature_properties")]
        snap = db["db_snapshot"].find_one({"_id": "singleton"})
        if not snap:
            raise ValueError("Snapshot missing.")
        report = inspect_payload(snap.get("payload"))
        report["snapshotUpdatedAt"] = snap.get("updatedAt")
        output = Path.home() / ("crm-client-identity-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f") + ".json")
        fd = os.open(str(output), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2, default=str)
        print(json.dumps({"status": "IDENTITY_REPORT_READY", "databaseWrites": 0,
                          "recordCounts": {k: len(v) for k,v in report["records"].items()}}))
        print("REPORT_FILE " + str(output), flush=True)
        subprocess.run(["cloudshell", "download", str(output)], check=False)
    except PyMongoError as error:
        raise ValueError("Database read failed: " + type(error).__name__)
    finally:
        client.close()

def main():
    try:
        import pymongo
    except ImportError:
        with tempfile.TemporaryDirectory(prefix="crm-identity-") as temp:
            subprocess.run([sys.executable, "-m", "venv", temp], check=True)
            python = str(Path(temp) / "bin" / "python")
            subprocess.run([python, "-m", "pip", "install", "--quiet", "pymongo[srv]==4.10.1"], check=True)
            return subprocess.call([python, str(Path(__file__).resolve())])
    try:
        run()
        return 0
    except ValueError as error:
        print("STOPPED: " + str(error), file=sys.stderr)
        return 1
    except Exception:
        print("STOPPED: Report could not complete. No database changes made.", file=sys.stderr)
        return 1

if __name__ == "__main__":
    sys.exit(main())
