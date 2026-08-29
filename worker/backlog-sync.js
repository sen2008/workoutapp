/*
 * backlog-sync — a Cloudflare Worker holding the rehab log, so the tracker is
 * the same log on the phone in the morning and the laptop in the evening.
 *
 * It stores one opaque blob and never sees a session. The log is sealed in the
 * browser under the passphrase that unlocks the site, so this Worker, its KV
 * store and Cloudflare itself hold nothing but ciphertext, a version number and
 * a timestamp. Nobody here can tell a rest day from a rough one.
 *
 *   GET  /records          -> {version, updated, blob} | 404 when empty
 *   PUT  /records          <- {version, blob} -> {version, updated}
 *   GET  /snapshots        -> {snapshots: [{version, updated}]}
 *   GET  /snapshots/:n     -> {version, updated, blob}
 *
 * PUT is a compare-and-set: `version` must match what is stored, or 0 for the
 * first write. A mismatch returns 409 with what is stored, and the browser
 * merges the two by day and retries — so a session logged on one device is not
 * lost to a save from another that never saw it.
 *
 * Snapshots exist because there is no other copy. Unlike a catalogue built from
 * a CSV on someone's disk, this log is only ever created here, and a bad merge
 * or a fat-fingered restore would otherwise be the end of it. Every write keeps
 * the one it replaced, the last SNAPSHOTS of them survive, and they are as
 * unreadable to Cloudflare as the live blob.
 *
 * Bindings: BACKLOG (KV namespace), SYNC_TOKEN (secret), ORIGIN (site URL).
 */

const KEY = "records";
const INDEX = "snapshots";
const SNAPSHOTS = 20;
const MAX_BLOB = 2 * 1024 * 1024; // a decade of daily logs is a rounding error next to this

const cors = origin => ({
  "access-control-allow-origin": origin,
  "access-control-allow-methods": "GET,PUT,OPTIONS",
  "access-control-allow-headers": "authorization,content-type",
  "access-control-max-age": "86400",
  vary: "origin",
});

const json = (body, status, origin) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...cors(origin) },
  });

/*
 * A token reaches the Worker either as a plain string (a Worker secret set in
 * Settings -> Variables and Secrets) or as a Secrets Store binding, which hands
 * the value back through .get(). Accept both, so how it was wired up in the
 * dashboard does not change whether this works.
 */
async function secret(binding) {
  if (!binding) return null;
  if (typeof binding === "string") return binding;
  if (typeof binding.get === "function") return await binding.get();
  return null;
}

/* Length-independent comparison, so a wrong token leaks nothing by timing. */
function tokenOk(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string") return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/* Keeps the replaced blob and evicts the oldest beyond SNAPSHOTS. Best effort:
   a failure here must not cost the caller their save. */
async function snapshot(env, previous) {
  if (!previous) return;
  try {
    const index = (await env.BACKLOG.get(INDEX, { type: "json" })) || [];
    await env.BACKLOG.put(`snap:${previous.version}`, JSON.stringify(previous));
    index.unshift({ version: previous.version, updated: previous.updated });

    const dropped = index.splice(SNAPSHOTS);
    await Promise.all(dropped.map(old => env.BACKLOG.delete(`snap:${old.version}`)));
    await env.BACKLOG.put(INDEX, JSON.stringify(index));
  } catch {
    /* The live record is already written; losing a snapshot is not worth a 500. */
  }
}

export default {
  async fetch(request, env, ctx) {
    const origin = env.ORIGIN || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    const token = await secret(env.SYNC_TOKEN);
    if (!token) return json({ error: "worker is missing its token" }, 500, origin);

    const auth = request.headers.get("authorization") || "";
    const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!tokenOk(given, token)) return json({ error: "unauthorized" }, 401, origin);

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/records") {
      if (request.method === "GET") {
        const stored = await env.BACKLOG.get(KEY, { type: "json" });
        if (!stored) return json({ error: "empty" }, 404, origin);
        return json(stored, 200, origin);
      }

      if (request.method === "PUT") {
        let body;
        try {
          body = await request.json();
        } catch {
          return json({ error: "malformed json" }, 400, origin);
        }

        if (typeof body?.blob !== "string" || !body.blob) return json({ error: "missing blob" }, 400, origin);
        if (body.blob.length > MAX_BLOB) return json({ error: "blob too large" }, 413, origin);
        if (!Number.isInteger(body.version) || body.version < 0) return json({ error: "missing version" }, 400, origin);

        const stored = await env.BACKLOG.get(KEY, { type: "json" });
        const current = stored ? stored.version : 0;
        if (body.version !== current) {
          // Another device saved since this tab loaded. Hand back what is here
          // so the browser can merge the two rather than overwriting one.
          return json({ error: "stale", version: current, updated: stored?.updated ?? null, blob: stored?.blob ?? null }, 409, origin);
        }

        const next = { version: current + 1, updated: new Date().toISOString(), blob: body.blob };
        await env.BACKLOG.put(KEY, JSON.stringify(next));
        // After the response: the save is what the caller is waiting on.
        ctx.waitUntil(snapshot(env, stored));
        return json({ version: next.version, updated: next.updated }, 200, origin);
      }

      return json({ error: "method not allowed" }, 405, origin);
    }

    if (path === "/snapshots" && request.method === "GET") {
      return json({ snapshots: (await env.BACKLOG.get(INDEX, { type: "json" })) || [] }, 200, origin);
    }

    const one = path.match(/^\/snapshots\/(\d+)$/);
    if (one && request.method === "GET") {
      const stored = await env.BACKLOG.get(`snap:${one[1]}`, { type: "json" });
      if (!stored) return json({ error: "no such snapshot" }, 404, origin);
      return json(stored, 200, origin);
    }

    return json({ error: "not found" }, 404, origin);
  },
};
