# Backlog — mid-back rehab tracker

A tracker for a PT programme, published to GitHub Pages behind a passphrase, with
the log kept in a Cloudflare Worker that never sees it.

**The routine and the log are not readable in this repository.** It is public so
that Pages serves the site for free, which means anything committed here can be
read by anyone. So the exercises are committed only as `routine.enc`, sealed
under the site passphrase, and the log itself is never in git at all — it lives
in the Worker as ciphertext. `.gitignore` enforces the first; the second has
nowhere to leak from.

## What's here

```
publish.sh              build, encrypt and deploy in one command
build_site.mjs          builds the app and encrypts it into docs/
backup.mjs              pull the log out of the Worker, or push one back
gate.html               the unlock page (edit here, not in docs/)
routine.sample.json     a neutral starting routine, for a fresh setup
routine.enc             your routine, sealed — the committed copy
docs/                   the encrypted site, committed and served by Pages

src/
├── Backlog.jsx         the tracker: the two tracks, the diagrams, the views
├── vault.js            where the log goes — window.VAULT, or localStorage in dev
├── merge.js            how two devices' versions of a day get reconciled
└── main.jsx            mounts the app

worker/backlog-sync.js  the Cloudflare Worker that holds the log
wrangler.toml           its deploy config
```

Alongside those, on your machine only, sit `routine.json` (the routine in the
clear), `worker.json` (the Worker's address and token) and `backups/`. Git
ignores all three.

## Setting it up

```bash
npm install
```

That is the whole toolchain. Node does the encryption too, through `node:crypto`
— there is no Python, no pip, and nothing to compile.

Then the routine. On a fresh start:

```bash
cp routine.sample.json routine.json
```

Edit it — names, doses, cues, which zone each belongs to, whether it starts in
rotation. On a machine that already has `routine.enc` from a previous setup,
unseal that instead:

```bash
node build_site.mjs --routine-only
```

Then publish:

```bash
./publish.sh
```

The first run asks for a passphrase twice, creates `vault.json`, seals the
routine into `routine.enc`, encrypts the app into `docs/`, and pushes.
`.github/workflows/pages.yml` uploads `docs/` to Pages and refuses to deploy if
anything in it turns out to be readable.

That writes:

| file | what it is |
|---|---|
| `docs/index.html` | the unlock page — the only readable file on the site |
| `docs/app.bin` | the whole built app, encrypted |
| `docs/CNAME` | the custom domain (see below) — also plaintext, but that's just DNS |
| `routine.enc` | `routine.json`, encrypted |

`docs/CNAME` is written on every build from a constant at the top of
`build_site.mjs`. That's deliberate, not an oversight: a branch-based Pages
deploy lets you set the custom domain once in Settings and GitHub remembers it,
but an Actions-based one (what `pages.yml` runs) forgets it the moment a deploy
ships without the file — so it has to be part of every build, not a one-time
Settings change. Set the domain in Settings → Pages too; the field there is
what actually provisions the certificate, `CNAME` is what keeps GitHub from
dropping the domain on the next publish.

Everything is AES-256-GCM under a key derived from the passphrase with
PBKDF2-SHA256 at 600,000 iterations. The unlock page carries the salt and the
iteration count, which are not secrets. The passphrase is never stored and
cannot be reset — see *Changing the passphrase* below, which is not a reset.

Nonces are derived from file content, so rebuilding an unchanged app reproduces
identical bytes and git stays quiet. `vault.json` carries the salt; it is
committed, holds nothing secret, and catches a mistyped passphrase before it
republishes the site under a new one.

## Where the log goes

Ticking a box has to end up somewhere, and it is the one thing here with no
copy on disk: it is created on a phone in a hallway and nowhere else. That is
what `worker/backlog-sync.js` is for.

It holds one opaque blob. The log is sealed in the browser under the same
passphrase that unlocks the site, so the Worker, its KV store and Cloudflare
hold nothing but ciphertext, a version number and a timestamp. Nobody there can
tell a rest day from a rough one.

### Setting up the Worker

1. In the Cloudflare dashboard, create a **KV namespace** (any name).
2. Create a **Worker**, paste in `worker/backlog-sync.js`, and deploy.
3. Bind the KV namespace to the Worker as `BACKLOG`.
4. Add a **secret** called `SYNC_TOKEN` — a long random string.
   `ORIGIN` is set from `wrangler.toml`, not the dashboard. Point it at wherever
   the site is served from, scheme and host only.
5. Put the namespace ID into `wrangler.toml` if you deploy with Workers Builds.
6. Locally, write `worker.json` — git-ignored, and never published in the clear:

```json
{
  "url": "https://your-worker.workers.dev",
  "token": "the random string"
}
```

7. Run `./publish.sh` again.

Without `worker.json` the build simply omits all of this and the log stays in
the one browser that wrote it, so nothing breaks if you never set it up.

The address and token travel inside `app.bin`, so only someone who can already
unlock the site can reach them. They are not a second boundary — the passphrase
is the boundary. What they do buy is that a stranger who finds the Worker's URL
gets a 401 rather than a pile of ciphertext to grind on.

### Two devices, one log

Writes are compare-and-set. A save from a tab that has not seen another device's
save is refused with a 409, and the browser then merges the two rather than
picking a winner: every day carries the moment it last changed, and the newer
stamp wins for that day. A morning session logged on the phone and an evening
one logged on the laptop both survive; only the same day edited in two places
between saves has to choose.

Saves are debounced, so a set of six ticks is one write. The last one is flushed
when the tab is backgrounded, which on a phone is how the app is usually closed.

### Offline

The last blob is cached in the browser, as ciphertext. With no signal the app
still opens, still logs, and says `offline — saved on this device`; the next
time it opens with a connection, that session is merged back over whatever the
Worker holds and pushed. Losing the cache before that happens loses those
sessions, so it is a bridge across a train tunnel, not a second archive.

## Backups

The log has no other copy, so take one:

```bash
node backup.mjs                 # -> backups/backlog-2026-08-29-v41.json
node backup.mjs --list          # what older versions the Worker still holds
node backup.mjs --snapshot 38   # pull one of them instead
```

Every write also keeps the version it replaced, and the last 20 of those survive
in KV — as unreadable to Cloudflare as the live one. That covers a bad merge or
a mistake; it does not cover the account going away, which is what `backup.mjs`
is for.

Pushing one back replaces the live log, keeping the replaced version as a
snapshot:

```bash
node backup.mjs --restore backups/backlog-2026-08-29-v41.json
```

`backups/` is git-ignored, because what lands there is the log in the clear —
which days, which loads, how the back felt, and whatever got written in the
note. Keep it where you keep other things you would not publish.

## On a phone

Termux runs all of this. Node, git and bash are packages; the native pieces the
build uses (Rollup, Lightning CSS, Tailwind's engine) all ship `android-arm64`
binaries, so `npm install` resolves them rather than trying to compile.

```bash
pkg install nodejs git
termux-setup-storage        # once — grants access to the phone's storage
```

That second command is what makes the Downloads folder reachable. Android's
Downloads is not Termux's `~/Downloads`; after granting access it is at
`~/storage/downloads`, so a `routine.json` saved from a browser or a chat is:

```bash
cp ~/storage/downloads/routine.json .
```

Everything else is the same as anywhere else — `./publish.sh` and the rest.

## Working on it

```bash
node build_site.mjs --routine-only   # if routine.json isn't there yet
npm run dev
```

In dev there is no unlock page, so `src/vault.js` falls back to plain
localStorage and says so. That is a convenience for working on the UI, not a
second way to run this for real — nothing is encrypted and nothing syncs.

`npm run build` produces `dist/index.html`, one self-contained file. It is
git-ignored: it is the readable build that `docs/app.bin` is made from.

## Changing the passphrase

`build_site.mjs --change-passphrase` re-encrypts the app and the routine under a
new one. It does **not** re-encrypt the log already sitting in the Worker, which
was sealed under the old key and would become unreadable. Do it in this order:

```bash
node backup.mjs                                   # old passphrase
./publish.sh --change-passphrase                    # new passphrase
node backup.mjs --restore backups/backlog-….json  # new passphrase
```

## What this does and does not protect

The passphrase is the entire security boundary, so make it a long one. Anyone
can download `app.bin` and `routine.enc` and grind at them offline, and the
600,000 PBKDF2 iterations are the only thing slowing them down — a real cost per
guess, but no help at all against a passphrase worth guessing. A short or reused
one is the failure mode here, not the cryptography.

What is genuinely not readable to anyone without it: the log, the routine, and
the Worker's token. What is readable, and is meant to be: everything else in
this repository — this file, the build scripts, the unlock page, the Worker, and
the React source. That is the same trade the site makes to be hosted for free.

Two things worth being clear about:

- **The site is a lock, not a log.** There is no record of who opened it, and
  revoking access means rebuilding under a new passphrase, moving the stored log
  across as above, and telling whoever should still have it.
- **Cloudflare knows the shape, not the content.** It can see how large the blob
  is, how often it changes, and from roughly where — enough to know that someone
  logs something most evenings. It cannot see what.

For comparison, the usual "password page" for a static site just checks the
typed string in JavaScript and reveals content the browser already downloaded.
That protects nothing. Here the server never holds anything readable.
