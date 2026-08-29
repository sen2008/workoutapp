#!/usr/bin/env python3
"""
build_site.py — builds the app, seals the routine, and packs the result into
docs/ as an encrypted, passphrase-gated site that GitHub Pages can serve as-is.

Nothing readable is published. The whole app — markup, styles, script, the
exercise list — is encrypted with AES-256-GCM under a key derived from the
passphrase, and the only plaintext file on the site is docs/index.html, the
unlock page, which carries the salt and the iteration count but no secret. A
visitor without the passphrase can download every byte of the site and still
has nothing.

    BACKLOG_PASSPHRASE='…' python3 build_site.py     # or it will prompt

Two things are encrypted, under the same key:

  docs/app.bin   the whole built app, which is what the site serves
  routine.enc    routine.json — the exercises, doses and cues — so the routine
                 is not sitting readable in a public repository either

routine.json itself is git-ignored. This script seals it when it is present and
unseals it when it is not, so a fresh clone plus the passphrase is enough to get
back to a working tree. --routine-only stops after that step, which is what
`npm run dev` needs.

The passphrase is the whole security boundary: it is never stored, and it cannot
be recovered or reset without rebuilding. Use a long one.
"""

import base64
import hashlib
import hmac
import json
import os
import shutil
import subprocess
import sys
from getpass import getpass
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

HERE = Path(__file__).parent
BUILT = HERE / "dist" / "index.html"
ROUTINE = HERE / "routine.json"
ROUTINE_ENC = HERE / "routine.enc"
GATE = HERE / "gate.html"
STATE = HERE / "vault.json"
SYNC = HERE / "worker.json"
DOCS = HERE / "docs"

ITERATIONS = 600_000
SALT_BYTES = 16
NONCE_BYTES = 12
CHECK_LABEL = b"backlog/vault-check"


# ---------- keys ----------

def derive(passphrase: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", passphrase.encode(), salt, ITERATIONS, 32)


def checksum(key: bytes) -> str:
    """Lets a rebuild notice a mistyped passphrase before it republishes."""
    return hmac.new(key, CHECK_LABEL, hashlib.sha256).hexdigest()


def nonce_for(key: bytes, name: str, plaintext: bytes) -> bytes:
    """
    A nonce fixed by the content, so rebuilding an unchanged app reproduces the
    same bytes and git stays quiet. Distinct plaintexts still get distinct
    nonces, which is what GCM actually requires.
    """
    tag = hashlib.sha256(plaintext).digest()
    return hmac.new(key, name.encode() + b"\0" + tag, hashlib.sha256).digest()[:NONCE_BYTES]


def seal(key: bytes, name: str, plaintext: bytes) -> bytes:
    nonce = nonce_for(key, name, plaintext)
    return nonce + AESGCM(key).encrypt(nonce, plaintext, None)


# ---------- the routine ----------

def sync_routine(key: bytes) -> int:
    """
    routine.json is the working copy and is git-ignored; routine.enc is what the
    repository carries. Whichever exists is the source of truth, and after this
    both do.
    """
    if ROUTINE.exists():
        plain = ROUTINE.read_bytes()
        json.loads(plain)          # refuse to seal something that will not parse
        return write(ROUTINE_ENC, seal(key, "routine.enc", plain))

    if not ROUTINE_ENC.exists():
        sys.exit(
            "build_site.py: neither routine.json nor routine.enc is here.\n"
            "Start from the sample and edit it:\n"
            "    cp routine.sample.json routine.json"
        )

    nonce = ROUTINE_ENC.read_bytes()[:NONCE_BYTES]
    body = ROUTINE_ENC.read_bytes()[NONCE_BYTES:]
    try:
        plain = AESGCM(key).decrypt(nonce, body, None)
    except Exception:
        sys.exit("build_site.py: routine.enc will not open with that passphrase.")
    ROUTINE.write_bytes(plain)
    print(f"routine.json unsealed ({len(json.loads(plain))} exercises)")
    return 0


def run_build() -> None:
    print("building")
    npm = shutil.which("npm")
    if not npm:
        sys.exit("build_site.py: npm is not on PATH. Install Node, or run `npm run build` yourself and pass --no-build.")
    result = subprocess.run([npm, "run", "build"], cwd=HERE)
    if result.returncode != 0:
        sys.exit("build_site.py: the build failed — nothing was published.")


# ---------- the built app ----------

# Vite emits the bundle as a module script. The unlock page boots the app with
# document.write(), where a classic script's timing is the one that is the same
# everywhere — and the bundle is built as an IIFE precisely so this is safe.
MODULE_TAG = '<script type="module" crossorigin>'


def patch_app(html: str, sync: dict | None) -> str:
    found = html.count(MODULE_TAG)
    if found != 1:
        sys.exit(
            f"build_site.py: expected exactly one {MODULE_TAG!r} in dist/index.html, "
            f"found {found}. The build output has changed shape — update MODULE_TAG."
        )
    html = html.replace(MODULE_TAG, "<script>")

    if sync:
        # The Worker's address and token travel inside the ciphertext, so only
        # someone who can already unlock the log can reach the stored sessions.
        html = html.replace(
            "<script>",
            "<script>window.BACKLOG_SYNC = " + json.dumps(sync) + ";</script>\n<script>",
            1,
        )
    return html


# ---------- output ----------

def write(path: Path, data: bytes) -> bool:
    """Writes only on change, so an untouched file keeps its place in git."""
    if path.exists() and path.read_bytes() == data:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return True


def load_state(passphrase: str) -> bytes:
    """Reuses the stored salt so an unchanged app re-encrypts to identical bytes."""
    changing = "--change-passphrase" in sys.argv

    if STATE.exists() and not changing:
        state = json.loads(STATE.read_text())
        key = derive(passphrase, bytes.fromhex(state["salt"]))
        if not hmac.compare_digest(checksum(key), state["check"]):
            sys.exit(
                "build_site.py: that is not the passphrase the site was last built with.\n"
                "Re-run with --change-passphrase to re-encrypt under a new one.\n"
                "\n"
                "Note that changing it does NOT re-encrypt the sessions already stored\n"
                "in the Worker, which were sealed under the old key. Back them up with\n"
                "backup.py first, republish, then restore them."
            )
        return key

    salt = os.urandom(SALT_BYTES)
    key = derive(passphrase, salt)
    STATE.write_text(json.dumps(
        {"salt": salt.hex(), "iterations": ITERATIONS, "check": checksum(key)}, indent=2) + "\n")
    print("passphrase set" if changing else "new vault created")
    return key


def read_passphrase() -> str:
    passphrase = os.environ.get("BACKLOG_PASSPHRASE")
    if passphrase:
        return passphrase
    if not sys.stdin.isatty():
        sys.exit("build_site.py: set BACKLOG_PASSPHRASE, or run this from a terminal.")
    passphrase = getpass("Passphrase: ")
    if not passphrase:
        sys.exit("build_site.py: empty passphrase.")
    if not STATE.exists() or "--change-passphrase" in sys.argv:
        if passphrase != getpass("Again: "):
            sys.exit("build_site.py: the two passphrases differ.")
    return passphrase


def load_sync() -> dict | None:
    """Optional. Without worker.json the log lives in this browser only."""
    if not SYNC.exists():
        return None
    cfg = json.loads(SYNC.read_text())
    for field in ("url", "token"):
        if not cfg.get(field):
            sys.exit(f"build_site.py: worker.json is missing {field!r}.")
    return {"url": cfg["url"].rstrip("/"), "token": cfg["token"]}


def main():
    if not GATE.exists():
        sys.exit(f"build_site.py: {GATE} is missing.")

    key = load_state(read_passphrase())
    salt = json.loads(STATE.read_text())["salt"]

    changed_routine = sync_routine(key)
    if "--routine-only" in sys.argv:
        print("routine.json is ready — `npm run dev` will pick it up")
        return

    if "--no-build" not in sys.argv:
        run_build()
    if not BUILT.exists():
        sys.exit("build_site.py: dist/index.html is missing. Run `npm run build` first.")

    sync = load_sync()
    app = patch_app(BUILT.read_text(), sync).encode()
    changed = changed_routine + write(DOCS / "app.bin", seal(key, "app.bin", app))

    # The unlock page: the one file on the site that is not ciphertext.
    gate = GATE.read_text()
    gate = gate.replace('/*__SALT__*/""', json.dumps(salt))
    gate = gate.replace("/*__ITERATIONS__*/0", str(ITERATIONS))
    if "__SALT__" in gate or "__ITERATIONS__" in gate:
        sys.exit("build_site.py: gate.html placeholders did not substitute.")
    changed += write(DOCS / "index.html", gate.encode())

    # Publish the tree verbatim — no Jekyll pass.
    changed += write(DOCS / ".nojekyll", b"")

    total = sum(f.stat().st_size for f in DOCS.rglob("*") if f.is_file())
    print(f"docs/  {total/1e3:.0f} kB")
    print(f"{changed} file(s) written")
    print(f"AES-256-GCM, PBKDF2-SHA256 x {ITERATIONS:,}")
    print("saving sessions: " + (sync["url"] if sync else "this browser only (no worker.json)"))


if __name__ == "__main__":
    main()
