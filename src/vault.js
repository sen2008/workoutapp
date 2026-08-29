/*
 * Where the log lives.
 *
 * In the published site the unlock page hands the app a window.VAULT holding
 * the key derived from the passphrase. Everything below goes through it, so the
 * app itself never sees the key and nothing leaves this browser unsealed: the
 * Worker, its KV store and Cloudflare hold ciphertext and a version number.
 *
 * Under `npm run dev` there is no unlock page. The fallback keeps the log in
 * localStorage in the clear so the UI can be worked on, and says so — it is a
 * development convenience, not a second way to run this for real.
 */

import { merge, empty } from "./merge.js";

const DEV_KEY = "backlog:dev";
const DEBOUNCE = 1200;

const devVault = {
  sealed: false,
  async load() {
    try {
      const raw = localStorage.getItem(DEV_KEY);
      return raw ? { data: JSON.parse(raw), source: "cache" } : { data: null, source: "empty" };
    } catch {
      return { data: null, source: "empty" };
    }
  },
  async save(data) {
    localStorage.setItem(DEV_KEY, JSON.stringify(data));
    return { updated: new Date().toISOString() };
  },
  attach() {},
};

export function openStore() {
  const vault = typeof window !== "undefined" && window.VAULT ? window.VAULT : devVault;

  let listeners = [];
  let timer = null;
  let pending = null;      // the newest state waiting to be written
  let inflight = false;
  let onRemote = null;     // called when a merge changed what the app should show

  const emit = (status, detail) => listeners.forEach((fn) => fn(status, detail));

  /* A 409 means another device saved since this one loaded. The Worker hands
     back what it holds, the two are merged, and the merge is what gets written
     — so neither side's session is lost and the app is told to re-render. */
  vault.attach({
    merge,
    onMerged: (merged) => { if (onRemote) onRemote(merged); },
  });

  async function flush() {
    if (inflight || !pending) return;
    const data = pending;
    pending = null;
    inflight = true;
    emit("saving");
    try {
      const res = await vault.save(data);
      emit("saved", res && res.updated);
    } catch (err) {
      // Keep the unwritten state so the next edit retries it rather than
      // dropping it on the floor.
      pending = pending ? merge(data, pending) : data;
      emit(err && err.offline ? "offline" : "unsaved", err && err.message);
    }
    inflight = false;
    if (pending) setTimeout(flush, 400);
  }

  if (typeof window !== "undefined") {
    // A phone backgrounding the tab is the normal way this app is closed, so
    // the last tap has to survive it.
    const now = () => { if (timer) { clearTimeout(timer); timer = null; } flush(); };
    window.addEventListener("pagehide", now);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") now();
    });
  }

  return {
    sealed: vault.sealed !== false,

    onStatus(fn) { listeners.push(fn); return () => { listeners = listeners.filter((x) => x !== fn); }; },
    onRemote(fn) { onRemote = fn; },

    async load() {
      try {
        const res = await vault.load();
        return { data: res && res.data ? res.data : empty(), source: (res && res.source) || "empty" };
      } catch (err) {
        return { data: empty(), source: "error", error: err && err.message };
      }
    },

    /* Debounced: ticking six boxes is one save, not six writes racing each
       other for the same version number. */
    save(data) {
      pending = pending ? merge(pending, data) : data;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; flush(); }, DEBOUNCE);
    },

    flushNow() { if (timer) { clearTimeout(timer); timer = null; } return flush(); },
  };
}
