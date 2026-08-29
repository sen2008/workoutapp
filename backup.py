#!/usr/bin/env python3
"""
backup.py — pull the log out of the Worker and write it down in the clear,
somewhere that is not Cloudflare.

The log has no other copy. The catalogue in the coin archive is rebuilt from a
CSV on disk; this is not — every session only ever existed in a browser and then
in the Worker's KV store. So take a copy from time to time:

    python3 backup.py                    # -> backups/backlog-YYYY-MM-DD.json
    python3 backup.py --list             # what snapshots the Worker still holds
    python3 backup.py --snapshot 41      # pull an older version instead
    python3 backup.py --restore FILE     # push a backup back, replacing the log

backups/ is git-ignored, because what comes out of here is the readable log:
which days, which loads, how the back felt and what you wrote about it. Keep it
where you keep other things you would not publish.

Needs worker.json (the address and token) and the site passphrase.
"""

import argparse
import base64
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import date
from getpass import getpass
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

HERE = Path(__file__).parent
STATE = HERE / "vault.json"
SYNC = HERE / "worker.json"
BACKUPS = HERE / "backups"

NONCE_BYTES = 12


def config() -> dict:
    if not SYNC.exists():
        sys.exit("backup.py: worker.json is missing — there is no archive to back up.")
    cfg = json.loads(SYNC.read_text())
    for field in ("url", "token"):
        if not cfg.get(field):
            sys.exit(f"backup.py: worker.json is missing {field!r}.")
    cfg["url"] = cfg["url"].rstrip("/")
    return cfg


def key() -> bytes:
    if not STATE.exists():
        sys.exit("backup.py: vault.json is missing — build the site once first.")
    state = json.loads(STATE.read_text())
    passphrase = os.environ.get("BACKLOG_PASSPHRASE") or getpass("Passphrase: ")
    if not passphrase:
        sys.exit("backup.py: empty passphrase.")
    return hashlib.pbkdf2_hmac(
        "sha256", passphrase.encode(), bytes.fromhex(state["salt"]), state["iterations"], 32)


def call(cfg: dict, path: str, payload: dict | None = None) -> tuple[int, dict]:
    req = urllib.request.Request(
        cfg["url"] + path,
        data=json.dumps(payload).encode() if payload else None,
        method="PUT" if payload else "GET",
        headers={"authorization": "Bearer " + cfg["token"],
                 **({"content-type": "application/json"} if payload else {})},
    )
    try:
        with urllib.request.urlopen(req) as res:
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as err:
        body = err.read()
        try:
            return err.code, json.loads(body)
        except ValueError:
            return err.code, {"error": body.decode(errors="replace")}
    except urllib.error.URLError as err:
        sys.exit(f"backup.py: could not reach the Worker — {err.reason}")


def unseal(k: bytes, blob: str) -> dict:
    raw = base64.b64decode(blob)
    try:
        return json.loads(AESGCM(k).decrypt(raw[:NONCE_BYTES], raw[NONCE_BYTES:], None))
    except Exception:
        sys.exit("backup.py: that passphrase does not open the stored log.\n"
                 "If the site was rebuilt with --change-passphrase, the log is still\n"
                 "sealed under the old one.")


def seal(k: bytes, data: dict) -> str:
    nonce = os.urandom(NONCE_BYTES)
    return base64.b64encode(
        nonce + AESGCM(k).encrypt(nonce, json.dumps(data).encode(), None)).decode()


def summarise(data: dict) -> str:
    log = data.get("log") or {}
    days = sorted(log)
    span = f"{days[0]} to {days[-1]}" if days else "nothing logged"
    return f"{len(days)} day(s), {len(data.get('exercises') or [])} exercises, {span}"


def main():
    ap = argparse.ArgumentParser(description="Back up or restore the log.")
    ap.add_argument("--list", action="store_true", help="list the snapshots the Worker holds")
    ap.add_argument("--snapshot", type=int, metavar="N", help="pull snapshot N instead of the live log")
    ap.add_argument("--restore", metavar="FILE", help="push a backup file back, replacing the log")
    args = ap.parse_args()

    cfg = config()

    if args.list:
        status, body = call(cfg, "/snapshots")
        if status != 200:
            sys.exit(f"backup.py: {body.get('error', status)}")
        snaps = body.get("snapshots") or []
        if not snaps:
            print("no snapshots yet")
            return
        print(f"{len(snaps)} snapshot(s), newest first:")
        for s in snaps:
            print(f"  {s['version']:>5}   {s['updated']}")
        return

    k = key()

    if args.restore:
        path = Path(args.restore)
        if not path.exists():
            sys.exit(f"backup.py: {path} does not exist.")
        data = json.loads(path.read_text())
        print(f"restoring {path.name}: {summarise(data)}")

        status, current = call(cfg, "/records")
        version = current.get("version", 0) if status == 200 else 0
        if status == 200:
            print(f"this replaces version {version}, saved {current.get('updated')}")
            print("the Worker keeps the replaced version as a snapshot.")
        if input("type 'restore' to go ahead: ").strip() != "restore":
            sys.exit("nothing was changed.")

        status, body = call(cfg, "/records", {"version": version, "blob": seal(k, data)})
        if status != 200:
            sys.exit(f"backup.py: restore refused — {body.get('error', status)}")
        print(f"restored. the log is now version {body['version']}.")
        return

    path = f"/snapshots/{args.snapshot}" if args.snapshot is not None else "/records"
    status, body = call(cfg, path)
    if status == 404:
        sys.exit("backup.py: the Worker is holding nothing yet.")
    if status != 200:
        sys.exit(f"backup.py: {body.get('error', status)}")

    data = unseal(k, body["blob"])
    BACKUPS.mkdir(exist_ok=True)
    out = BACKUPS / f"backlog-{date.today().isoformat()}-v{body['version']}.json"
    out.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")

    print(f"{out}")
    print(f"  version {body['version']}, saved {body['updated']}")
    print(f"  {summarise(data)}")
    print("\nThis file is the log in the clear. backups/ is git-ignored — keep it somewhere private.")


if __name__ == "__main__":
    main()
