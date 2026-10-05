#!/usr/bin/env python3
"""Remove all CRM transaction rows, preserving clients and other collections."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timedelta, timezone

PROJECT = "signature-509218"
REGION = "asia-south1"
SERVICE = "signature-realty-crm"

def gcloud(*args):
    return subprocess.check_output(
        ["gcloud", *args, "--project=" + PROJECT],
        stderr=subprocess.DEVNULL, text=True).strip()

def validate(payload):
    if not isinstance(payload, dict):
        raise ValueError("Snapshot payload is missing.")
    leads = payload.get("Leads")
    txns = payload.get("Transactions")
    if not isinstance(leads, list) or not isinstance(txns, list):
        raise ValueError("Expected Leads and Transactions arrays were not found.")
    if any(not isinstance(t, dict) or not t.get("TransactionID") for t in txns):
        raise ValueError("Malformed transactions found; no records removed.")
    ids = {str(t["TransactionID"]) for t in txns}
    dependencies = {}
    for name, rows in payload.items():
        if name in ("Transactions", "Timeline", "Audit") or not isinstance(rows, list):
            continue
        count = sum(isinstance(row, dict) and str(row.get("TransactionID", "")) in ids
                    for row in rows)
        if count:
            dependencies[name] = count
    if dependencies:
        raise ValueError("Linked records need a scoped cleanup first: " + json.dumps(dependencies))
    return leads, txns

def run(apply):
    from pymongo import MongoClient
    from pymongo.errors import DuplicateKeyError, PyMongoError
    from pymongo.write_concern import WriteConcern
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
    client = MongoClient(uri, serverSelectionTimeoutMS=20000, socketTimeoutMS=20000)
    owner = "transaction-cleanup-" + uuid.uuid4().hex
    acquired = False
    db = client[setting("MONGO_DB", "signature_properties")]
    locks = db.get_collection("distributed_locks", write_concern=WriteConcern(w="majority"))
    snapshots = db.get_collection("db_snapshot", write_concern=WriteConcern(w="majority"))
    try:
        if apply:
            for attempt in range(15):
                now = datetime.now(timezone.utc)
                try:
                    result = locks.update_one(
                        {"_id": "db-snapshot-write", "$or": [
                            {"expiresAt": {"$lte": now}}, {"expiresAt": {"$exists": False}}]},
                        {"$set": {"owner": owner, "expiresAt": now + timedelta(seconds=120),
                                  "updatedAt": now}}, upsert=True)
                    acquired = bool(result.matched_count or result.upserted_id)
                    if acquired:
                        break
                except DuplicateKeyError:
                    pass
                time.sleep(1)
            if not acquired:
                raise ValueError("CRM is busy writing; no transactions removed.")
        snap = snapshots.find_one({"_id": "singleton"})
        if not snap:
            raise ValueError("CRM snapshot not found.")
        payload = snap.get("payload")
        leads, txns = validate(payload)
        if not apply or not txns:
            print(json.dumps({"mode": "APPLY" if apply else "PREVIEW",
                              "clients": len(leads), "transactions": len(txns), "deleted": 0}))
            return
        query = {"_id": "singleton", "payload.Transactions": txns,
                 "updatedAt": snap.get("updatedAt")}
        result = snapshots.update_one(query, {"$set": {
            "payload.Transactions": [], "updatedAt": datetime.now(timezone.utc)}})
        if result.matched_count != 1:
            raise ValueError("Snapshot changed concurrently; no cleanup applied.")
        after = snapshots.find_one({"_id": "singleton"})["payload"]
        unchanged = all(after.get(k) == v for k, v in payload.items() if k != "Transactions")
        if after.get("Transactions") != [] or not unchanged:
            raise ValueError("Write completed but verification differs; do not rerun blindly.")
        print(json.dumps({"status": "DONE", "deletedTransactions": len(txns),
                          "remainingTransactions": 0, "clientsPreserved": len(leads),
                          "otherCollectionsUnchanged": True}))
    except PyMongoError as error:
        # Never print a Mongo URL or credentials in an exception.
        raise ValueError("Database operation failed (" + type(error).__name__ +
                         ", code=" + str(getattr(error, "code", None)) + "). Cleanup not confirmed.")
    finally:
        if acquired:
            try:
                locks.delete_one({"_id": "db-snapshot-write", "owner": owner})
            except PyMongoError:
                print("Cleanup lock release failed; its lease expires automatically.", file=sys.stderr)
        client.close()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        import pymongo
    except ImportError:
        with tempfile.TemporaryDirectory(prefix="crm-cleanup-") as temp:
            subprocess.run([sys.executable, "-m", "venv", temp], check=True)
            python = str(Path(temp) / "bin" / "python")
            subprocess.run([python, "-m", "pip", "install", "--quiet", "pymongo[srv]==4.10.1"], check=True)
            return subprocess.call([python, str(Path(__file__).resolve()), *sys.argv[1:]])
    try:
        run(args.apply)
        return 0
    except ValueError as error:
        print("STOPPED: " + str(error), file=sys.stderr)
        return 1
    except Exception:
        print("STOPPED: Could not complete cleanup; check Cloud Shell access. No success confirmed.",
              file=sys.stderr)
        return 1

if __name__ == "__main__":
    sys.exit(main())
