#!/usr/bin/env node
/*
 * backup.mjs — pull the log out of the Worker and write it down in the clear,
 * somewhere that is not Cloudflare.
 *
 * The log has no other copy. The catalogue in the coin archive is rebuilt from a
 * CSV on disk; this is not — every session only ever existed in a browser and
 * then in the Worker's KV store. So take a copy from time to time:
 *
 *     node backup.mjs                    # -> backups/backlog-YYYY-MM-DD-vN.json
 *     node backup.mjs --list             # what snapshots the Worker still holds
 *     node backup.mjs --snapshot 41      # pull an older version instead
 *     node backup.mjs --restore FILE     # push a backup back, replacing the log
 *
 * backups/ is git-ignored, because what comes out of here is the readable log:
 * which days, which loads, how the back felt and what you wrote about it. Keep
 * it where you keep other things you would not publish.
 *
 * Needs worker.json (the address and token) and the site passphrase.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(HERE, "vault.json");
const SYNC = path.join(HERE, "worker.json");
const BACKUPS = path.join(HERE, "backups");

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const die = (msg) => { console.error("backup: " + msg); process.exit(1); };

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

function config() {
  if (!fs.existsSync(SYNC)) die("worker.json is missing — there is no archive to back up.");
  const cfg = JSON.parse(fs.readFileSync(SYNC, "utf8"));
  for (const field of ["url", "token"]) {
    if (!cfg[field]) die(`worker.json is missing '${field}'.`);
  }
  cfg.url = cfg.url.replace(/\/+$/, "");
  return cfg;
}

async function key() {
  if (!fs.existsSync(STATE)) die("vault.json is missing — build the site once first.");
  const state = JSON.parse(fs.readFileSync(STATE, "utf8"));
  const passphrase = process.env.BACKLOG_PASSPHRASE || await askHidden("Passphrase: ");
  if (!passphrase) die("empty passphrase.");
  return crypto.pbkdf2Sync(
    passphrase, Buffer.from(state.salt, "hex"), state.iterations, 32, "sha256");
}

async function call(cfg, route, payload) {
  let res;
  try {
    res = await fetch(cfg.url + route, {
      method: payload ? "PUT" : "GET",
      headers: {
        authorization: "Bearer " + cfg.token,
        ...(payload ? { "content-type": "application/json" } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
  } catch (err) {
    die("could not reach the Worker — " + err.message);
  }
  let body;
  try { body = await res.json(); } catch { body = { error: "unreadable response" }; }
  return [res.status, body];
}

function unseal(k, blob) {
  const raw = Buffer.from(blob, "base64");
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", k, raw.subarray(0, NONCE_BYTES));
    d.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    const plain = Buffer.concat([
      d.update(raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES)),
      d.final(),
    ]);
    return JSON.parse(plain.toString("utf8"));
  } catch {
    die("that passphrase does not open the stored log.\n" +
        "If the site was rebuilt with --change-passphrase, the log is still\n" +
        "sealed under the old one.");
  }
}

function seal(k, data) {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const c = crypto.createCipheriv("aes-256-gcm", k, nonce);
  const body = Buffer.concat([c.update(Buffer.from(JSON.stringify(data), "utf8")), c.final()]);
  return Buffer.concat([nonce, body, c.getAuthTag()]).toString("base64");
}

function summarise(data) {
  const log = data.log || {};
  const days = Object.keys(log).sort();
  const span = days.length ? `${days[0]} to ${days[days.length - 1]}` : "nothing logged";
  return `${days.length} day(s), ${(data.exercises || []).length} exercises, ${span}`;
}

async function main() {
  const cfg = config();

  if (has("--list")) {
    const [status, body] = await call(cfg, "/snapshots");
    if (status !== 200) die(String(body.error || status));
    const snaps = body.snapshots || [];
    if (!snaps.length) return console.log("no snapshots yet");
    console.log(`${snaps.length} snapshot(s), newest first:`);
    for (const s of snaps) console.log(`  ${String(s.version).padStart(5)}   ${s.updated}`);
    return;
  }

  const k = await key();

  const restore = valueOf("--restore");
  if (restore) {
    if (!fs.existsSync(restore)) die(`${restore} does not exist.`);
    const data = JSON.parse(fs.readFileSync(restore, "utf8"));
    console.log(`restoring ${path.basename(restore)}: ${summarise(data)}`);

    const [status, current] = await call(cfg, "/records");
    const version = status === 200 ? current.version : 0;
    if (status === 200) {
      console.log(`this replaces version ${version}, saved ${current.updated}`);
      console.log("the Worker keeps the replaced version as a snapshot.");
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question("type 'restore' to go ahead: ");
    rl.close();
    if (answer.trim() !== "restore") die("nothing was changed.");

    const [code, body] = await call(cfg, "/records", { version, blob: seal(k, data) });
    if (code !== 200) die("restore refused — " + (body.error || code));
    console.log(`restored. the log is now version ${body.version}.`);
    return;
  }

  const snapshot = valueOf("--snapshot");
  const route = snapshot !== undefined ? `/snapshots/${snapshot}` : "/records";
  const [status, body] = await call(cfg, route);
  if (status === 404) die("the Worker is holding nothing yet.");
  if (status !== 200) die(String(body.error || status));

  const data = unseal(k, body.blob);
  fs.mkdirSync(BACKUPS, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const out = path.join(BACKUPS, `backlog-${day}-v${body.version}.json`);
  fs.writeFileSync(out, JSON.stringify(data, null, 2) + "\n");

  console.log(out);
  console.log(`  version ${body.version}, saved ${body.updated}`);
  console.log(`  ${summarise(data)}`);
  console.log("\nThis file is the log in the clear. backups/ is git-ignored — keep it somewhere private.");
}

main();
