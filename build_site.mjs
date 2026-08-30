#!/usr/bin/env node
/*
 * build_site.mjs — builds the app, seals the routine, and packs the result into
 * docs/ as an encrypted, passphrase-gated site that GitHub Pages can serve as-is.
 *
 * Nothing readable is published. The whole app — markup, styles, script, the
 * exercise list — is encrypted with AES-256-GCM under a key derived from the
 * passphrase, and the only plaintext file on the site is docs/index.html, the
 * unlock page, which carries the salt and the iteration count but no secret. A
 * visitor without the passphrase can download every byte of the site and still
 * has nothing.
 *
 *     BACKLOG_PASSPHRASE='…' node build_site.mjs     # or it will prompt
 *
 * Two things are encrypted, under the same key:
 *
 *   docs/app.bin   the whole built app, which is what the site serves
 *   routine.enc    routine.json — the exercises, doses and cues — so the routine
 *                  is not sitting readable in a public repository either
 *
 * routine.json itself is git-ignored. This script seals it when it is present
 * and unseals it when it is not, so a fresh clone plus the passphrase is enough
 * to get back to a working tree. --routine-only stops after that step, which is
 * what `npm run dev` needs.
 *
 * This is Node rather than Python on purpose: the build already needs Node, and
 * node:crypto does AES-256-GCM and PBKDF2 in the standard library. Requiring pip
 * and a Rust toolchain as well put the whole thing out of reach on a phone.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const p = (...xs) => path.join(HERE, ...xs);

const BUILT = p("dist", "index.html");
const GATE = p("gate.html");
const STATE = p("vault.json");
const SYNC = p("worker.json");
const ROUTINE = p("routine.json");
const ROUTINE_ENC = p("routine.enc");
const DOCS = p("docs");

const ITERATIONS = 600_000;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const CHECK_LABEL = "backlog/vault-check";

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const die = (msg) => { console.error("build_site: " + msg); process.exit(1); };

/* ---------- keys ---------- */

const derive = (passphrase, salt) =>
  crypto.pbkdf2Sync(passphrase, salt, ITERATIONS, 32, "sha256");

/* Lets a rebuild notice a mistyped passphrase before it republishes. */
const checksum = (key) =>
  crypto.createHmac("sha256", key).update(CHECK_LABEL).digest("hex");

/*
 * A nonce fixed by the content, so rebuilding an unchanged app reproduces the
 * same bytes and git stays quiet. Distinct plaintexts still get distinct
 * nonces, which is what GCM actually requires.
 */
function nonceFor(key, name, plaintext) {
  const tag = crypto.createHash("sha256").update(plaintext).digest();
  return crypto.createHmac("sha256", key)
    .update(Buffer.concat([Buffer.from(name, "utf8"), Buffer.from([0]), tag]))
    .digest().subarray(0, NONCE_BYTES);
}

function seal(key, name, plaintext) {
  const nonce = nonceFor(key, name, plaintext);
  const c = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([c.update(plaintext), c.final()]);
  // The tag trails the ciphertext, which is what WebCrypto expects on the way back.
  return Buffer.concat([nonce, body, c.getAuthTag()]);
}

function unseal(key, sealed) {
  const d = crypto.createDecipheriv("aes-256-gcm", key, sealed.subarray(0, NONCE_BYTES));
  d.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  return Buffer.concat([
    d.update(sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES)),
    d.final(),
  ]);
}

/* ---------- the passphrase ---------- */

const KEY_ENTER = ["\r", "\n", "\u0004"];
const KEY_INTERRUPT = "\u0003";
const KEY_BACKSPACE = ["\u007f", "\b"];

function askHidden(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (KEY_ENTER.includes(ch)) {
          stdin.removeListener("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stderr.write("\n");
          return resolve(buf);
        }
        if (ch === KEY_INTERRUPT) {
          stdin.setRawMode(false);
          process.stderr.write("\n");
          process.exit(130);
        }
        if (KEY_BACKSPACE.includes(ch)) buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function readPassphrase() {
  const fromEnv = process.env.BACKLOG_PASSPHRASE;
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) die("set BACKLOG_PASSPHRASE, or run this from a terminal.");

  const passphrase = await askHidden("Passphrase: ");
  if (!passphrase) die("empty passphrase.");
  if (!fs.existsSync(STATE) || has("--change-passphrase")) {
    if (passphrase !== await askHidden("Again: ")) die("the two passphrases differ.");
  }
  return passphrase;
}

/* Reuses the stored salt so an unchanged app re-encrypts to identical bytes. */
function loadState(passphrase) {
  const changing = has("--change-passphrase");

  if (fs.existsSync(STATE) && !changing) {
    const state = JSON.parse(fs.readFileSync(STATE, "utf8"));
    const key = derive(passphrase, Buffer.from(state.salt, "hex"));
    const want = Buffer.from(state.check, "hex");
    const got = Buffer.from(checksum(key), "hex");
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) {
      die("that is not the passphrase the site was last built with.\n" +
          "Re-run with --change-passphrase to re-encrypt under a new one.\n\n" +
          "Note that changing it does NOT re-encrypt the sessions already stored\n" +
          "in the Worker, which were sealed under the old key. Back them up with\n" +
          "backup.mjs first, republish, then restore them.");
    }
    return key;
  }

  const salt = crypto.randomBytes(SALT_BYTES);
  const key = derive(passphrase, salt);
  fs.writeFileSync(STATE, JSON.stringify(
    { salt: salt.toString("hex"), iterations: ITERATIONS, check: checksum(key) }, null, 2) + "\n");
  console.log(changing ? "passphrase set" : "new vault created");
  return key;
}

/* ---------- output ---------- */

/* Writes only on change, so an untouched file keeps its place in git. */
function write(file, data) {
  if (fs.existsSync(file) && fs.readFileSync(file).equals(data)) return 0;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return 1;
}

/* ---------- the routine ---------- */

/*
 * routine.json is the working copy and is git-ignored; routine.enc is what the
 * repository carries. Whichever exists is the source of truth, and after this
 * both do.
 */
function syncRoutine(key) {
  if (fs.existsSync(ROUTINE)) {
    const plain = fs.readFileSync(ROUTINE);
    try { JSON.parse(plain.toString("utf8")); }
    catch { die("routine.json is not valid JSON — refusing to seal it."); }
    return write(ROUTINE_ENC, seal(key, "routine.enc", plain));
  }

  if (!fs.existsSync(ROUTINE_ENC)) {
    die("neither routine.json nor routine.enc is here.\n" +
        "Start from the sample and edit it:\n" +
        "    cp routine.sample.json routine.json");
  }

  let plain;
  try { plain = unseal(key, fs.readFileSync(ROUTINE_ENC)); }
  catch { die("routine.enc will not open with that passphrase."); }
  fs.writeFileSync(ROUTINE, plain);
  console.log(`routine.json unsealed (${JSON.parse(plain.toString("utf8")).length} exercises)`);
  return 0;
}

function runBuild() {
  console.log("building");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const r = spawnSync(npm, ["run", "build"], { cwd: HERE, stdio: "inherit" });
  if (r.error && r.error.code === "ENOENT") {
    die("npm is not on PATH. Install Node, or run `npm run build` yourself and pass --no-build.");
  }
  if (r.status !== 0) die("the build failed — nothing was published.");
}

/* ---------- the built app ---------- */

// Vite emits the bundle as a module script. The unlock page boots the app with
// document.write(), where a classic script's timing is the one that is the same
// everywhere — and the bundle is built as an IIFE precisely so this is safe.
const MODULE_TAG = '<script type="module" crossorigin>';

function patchApp(html, sync) {
  const found = html.split(MODULE_TAG).length - 1;
  if (found !== 1) {
    die(`expected exactly one ${MODULE_TAG} in dist/index.html, found ${found}. ` +
        "The build output has changed shape — update MODULE_TAG.");
  }
  html = html.replace(MODULE_TAG, "<script>");

  if (sync) {
    // The Worker's address and token travel inside the ciphertext, so only
    // someone who can already unlock the log can reach the stored sessions.
    html = html.replace("<script>",
      "<script>window.BACKLOG_SYNC = " + JSON.stringify(sync) + ";</script>\n<script>");
  }
  return html;
}

/* Optional. Without worker.json the log lives in this browser only. */
function loadSync() {
  if (!fs.existsSync(SYNC)) return null;
  const cfg = JSON.parse(fs.readFileSync(SYNC, "utf8"));
  for (const field of ["url", "token"]) {
    if (!cfg[field]) die(`worker.json is missing '${field}'.`);
  }
  return { url: cfg.url.replace(/\/+$/, ""), token: cfg.token };
}

/* ---------- main ---------- */

async function main() {
  if (!fs.existsSync(GATE)) die("gate.html is missing.");

  const key = loadState(await readPassphrase());
  const salt = JSON.parse(fs.readFileSync(STATE, "utf8")).salt;

  let changed = syncRoutine(key);
  if (has("--routine-only")) {
    console.log("routine.json is ready — `npm run dev` will pick it up");
    return;
  }

  if (!has("--no-build")) runBuild();
  if (!fs.existsSync(BUILT)) die("dist/index.html is missing. Run `npm run build` first.");

  const sync = loadSync();
  const app = Buffer.from(patchApp(fs.readFileSync(BUILT, "utf8"), sync), "utf8");
  changed += write(path.join(DOCS, "app.bin"), seal(key, "app.bin", app));

  // The unlock page: the one file on the site that is not ciphertext.
  let gate = fs.readFileSync(GATE, "utf8");
  gate = gate.replace('/*__SALT__*/""', JSON.stringify(salt));
  gate = gate.replace("/*__ITERATIONS__*/0", String(ITERATIONS));
  if (gate.includes("__SALT__") || gate.includes("__ITERATIONS__")) {
    die("gate.html placeholders did not substitute.");
  }
  changed += write(path.join(DOCS, "index.html"), Buffer.from(gate, "utf8"));

  // Publish the tree verbatim — no Jekyll pass.
  changed += write(path.join(DOCS, ".nojekyll"), Buffer.alloc(0));

  const total = fs.readdirSync(DOCS)
    .map((f) => fs.statSync(path.join(DOCS, f)).size)
    .reduce((a, b) => a + b, 0);
  console.log(`docs/  ${Math.round(total / 1e3)} kB`);
  console.log(`${changed} file(s) written`);
  console.log(`AES-256-GCM, PBKDF2-SHA256 x ${ITERATIONS.toLocaleString("en-US")}`);
  console.log("saving sessions: " + (sync ? sync.url : "this browser only (no worker.json)"));
}

main();
