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
    # The authorized operation clears the entire Transactions array, including
    # legacy/malformed entries. An ID is not needed to select those entries.
    # Block any live cross-collection reference, even if its target lacks an ID.
    dependencies = {}
    for name, rows in payload.items():
        if name in ("Transactions", "Timeline", "Audit") or not isinstance(rows, list):
            continue
        count = sum(isinstance(row, dict) and row.get("TransactionID") not in (None, "")
                    for row in rows)
        if count:
            dependencies[name] = count
    if dependencies:
        raise ValueError("Linked records need a scoped cleanup first: " + json.dumps(dependencies))
    return leads, txns

def mapping_report(payload):
    from collections import Counter, defaultdict
    names = ("Leads", "Transactions", "Requirements")
    if not isinstance(payload, dict) or any(not isinstance(payload.get(n), list) for n in names):
        raise ValueError("Expected CRM arrays missing; no changes made.")
    def key(row, field):
        value = row.get(field) if isinstance(row, dict) else None
        return str(value).strip() if value is not None else ""
    def source(row):
        return {k: row[k] for k in ("_source", "Source", "SourceTab", "CreatedBy", "ConfirmationStatus") if row.get(k)}
    leads, txns, reqs = (payload[n] for n in names)
    lead_ids = Counter(key(r, "LeadID") for r in leads)
    txn_map = defaultdict(list)
    for t in txns:
        if key(t, "TransactionID"):
            txn_map[key(t, "TransactionID")].append(t)
    grouped = defaultdict(list)
    unresolved = []
    for index, r in enumerate(reqs):
        if not isinstance(r, dict):
            unresolved.append({"row": index, "reason": "not_object"})
            continue
        lid = key(r, "LeadID")
        linked = txn_map.get(key(r, "TransactionID"), [])
        parents = {key(t, "LeadID") for t in linked if key(t, "LeadID")}
        if not lid and len(parents) == 1:
            lid = next(iter(parents))
        item = {"row": index, "RequirementID": key(r, "RequirementID"),
                "TransactionID": key(r, "TransactionID"), "source": source(r)}
        if not lid or lead_ids[lid] != 1 or (parents and parents != {lid}):
            unresolved.append({**item, "LeadID": lid, "reason": "missing_ambiguous_or_conflicting_lead"})
        else:
            grouped[lid].append((r, item))
    detail_fields = ("BudgetMin", "BudgetMax", "Location1", "Location2", "Location3",
                     "BHK", "Preferences", "PropertyType", "TransactionType", "Type",
                     "Purpose", "City", "AreaMin", "AreaMax")
    by_lead = []
    for index, lead in enumerate(leads):
        if not isinstance(lead, dict):
            by_lead.append({"row": index, "invalidLead": True})
            continue
        lid = key(lead, "LeadID")
        basics = lead.get("SheetBasicRequirements", [])
        basics = basics if isinstance(basics, list) else []
        requirements = []
        for req, item in grouped[lid]:
            values = {k: req[k] for k in detail_fields if req.get(k) not in (None, "", [])}
            covered = bool(values) and any(isinstance(b, dict) and all(b.get(k) == v for k, v in values.items()) for b in basics)
            requirements.append({**item, "detailFields": list(values),
                                 "knownDetailsExactlyCoveredBySheetBasic": covered})
        by_lead.append({"LeadID": lid, "source": source(lead),
                        "sheetBasicCount": len(basics), "requirements": len(requirements),
                        "transactions": sum(key(t, "LeadID") == lid for t in txns),
                        "requirementMapping": requirements})
    summary = {"status": "MAPPING_READ_ONLY", "clients": len(leads), "transactions": len(txns),
               "requirements": len(reqs), "sheetBasicTotal": sum(x.get("sheetBasicCount", 0) for x in by_lead),
               "leadsWithoutSheetBasic": sum(x.get("sheetBasicCount", 0) == 0 for x in by_lead),
               "leadsWithZeroRequirements": sum(x.get("requirements", 0) == 0 for x in by_lead),
               "leadsWithOneRequirement": sum(x.get("requirements", 0) == 1 for x in by_lead),
               "leadsWithMultipleRequirements": sum(x.get("requirements", 0) > 1 for x in by_lead),
               "unresolvedRequirements": len(unresolved),
               "duplicateLeadIDs": {k:v for k,v in lead_ids.items() if v > 1},
               "transactionsWithoutID": sum(not key(t, "TransactionID") for t in txns),
               "deleted": 0}
    return {"summary": summary, "leadMapping": by_lead, "unresolved": unresolved}

def run(apply, status_only=False, mapping=False):
    if apply:
        raise ValueError("Deletion paused: Google Sheet details must be preserved. Run --mapping.")
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
    client = MongoClient(uri, serverSelectionTimeoutMS=30000, connectTimeoutMS=30000, socketTimeoutMS=60000)
    owner = "transaction-cleanup-" + uuid.uuid4().hex
    acquired = False
    db = client[setting("MONGO_DB", "signature_properties")]
    locks = db.get_collection("distributed_locks", write_concern=WriteConcern(w="majority"))
    snapshots = db.get_collection("db_snapshot", write_concern=WriteConcern(w="majority"))
    stage = "connecting"
    try:
        client.admin.command("ping")
        if mapping:
            stage = "reading_mapping"
            snap = snapshots.find_one({"_id": "singleton"},
                                      {"payload.Leads": 1, "payload.Transactions": 1, "payload.Requirements": 1})
            report = mapping_report((snap or {}).get("payload"))
            output = Path.home() / ("crm-lead-mapping-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + ".json")
            with output.open("x", encoding="utf-8") as handle:
                json.dump(report, handle, indent=2, default=str)
            print(json.dumps(report["summary"]))
            for item in report["leadMapping"]:
                if item.get("requirements", 0) > 1:
                    print("MULTIPLE_REQUIREMENTS " + json.dumps(item, default=str))
            for item in report["unresolved"]:
                print("UNRESOLVED " + json.dumps(item, default=str))
            print("REPORT_FILE " + str(output))
            return
        if status_only:
            stage = "reading_counts"
            rows = list(snapshots.aggregate([
                {"$match": {"_id": "singleton"}},
                {"$project": {"_id": 0,
                    "clients": {"$cond": [{"$isArray": "$payload.Leads"},
                                          {"$size": "$payload.Leads"}, None]},
                    "transactions": {"$cond": [{"$isArray": "$payload.Transactions"},
                                               {"$size": "$payload.Transactions"}, None]}
                }}
            ], maxTimeMS=30000))
            if len(rows) != 1 or any(rows[0].get(k) is None for k in ("clients", "transactions")):
                raise ValueError("Expected CRM snapshot arrays not found.")
            print(json.dumps({"status": "READ_ONLY", **rows[0]}))
            return
        stage = "acquiring_write_lock"
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
        stage = "reading_snapshot"
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
        stage = "removing_transactions"
        result = snapshots.update_one(query, {"$set": {
            "payload.Transactions": [], "updatedAt": datetime.now(timezone.utc)}})
        if result.matched_count != 1:
            raise ValueError("Snapshot changed concurrently; no cleanup applied.")
        stage = "confirming_result"
        after = snapshots.find_one({"_id": "singleton"})["payload"]
        unchanged = all(after.get(k) == v for k, v in payload.items() if k != "Transactions")
        if after.get("Transactions") != [] or not unchanged:
            raise ValueError("Write completed but verification differs; do not rerun blindly.")
        print(json.dumps({"status": "DONE", "deletedTransactions": len(txns),
                          "remainingTransactions": 0, "clientsPreserved": len(leads),
                          "otherCollectionsUnchanged": True}))
    except PyMongoError as error:
        # Never print a Mongo URL or credentials in an exception.
        raise ValueError("Database operation failed at " + stage + " (" + type(error).__name__ +
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
    parser.add_argument("--status", action="store_true", help="Read counts only, without acquiring any write lock")
    parser.add_argument("--mapping", action="store_true", help="Read-only lead, Sheet basics and requirement mapping")
    args = parser.parse_args()
    if sum((args.apply, args.status, args.mapping)) > 1:
        parser.error("Choose only one mode: --apply, --status or --mapping")
    try:
        import pymongo
    except ImportError:
        with tempfile.TemporaryDirectory(prefix="crm-cleanup-") as temp:
            subprocess.run([sys.executable, "-m", "venv", temp], check=True)
            python = str(Path(temp) / "bin" / "python")
            subprocess.run([python, "-m", "pip", "install", "--quiet", "pymongo[srv]==4.10.1"], check=True)
            return subprocess.call([python, str(Path(__file__).resolve()), *sys.argv[1:]])
    try:
        run(args.apply, args.status, args.mapping)
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
