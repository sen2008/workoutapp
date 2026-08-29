import React, { useState, useEffect, useMemo, useRef } from "react";
import { openStore } from "./vault.js";
import { SHAPE } from "./merge.js";

/* ────────────────────────────────────────────────────────────
   Backlog — mid-back rehab + strength tracker
   Two tracks: RESET (the PT handout) and LOAD (progressive work).
   Strength moves carry a load field so overload is visible over time.
   ──────────────────────────────────────────────────────────── */

/*
 * The routine itself lives in routine.json, which git ignores. What is
 * committed is routine.enc, the same file sealed under the site passphrase — so
 * the cues, the doses and what they say about the person doing them are not
 * readable in a public repository. build_site.py unseals it before the build.
 */
import SEED from "../routine.json";

const ZONES = {
  neck: { label: "neck", color: "#6E5A86" },
  thoracic: { label: "mid-back", color: "#2F6F6B" },
  core: { label: "core", color: "#A8563C" },
  carry: { label: "carry", color: "#3A5C7A" },
  hips: { label: "hips", color: "#5B7A63" },
};

const FEEL = [
  { v: 0, label: "quiet", color: "#2F6F6B" },
  { v: 1, label: "aware of it", color: "#5B7A63" },
  { v: 2, label: "nagging", color: "#8C7A4E" },
  { v: 3, label: "sore", color: "#A8563C" },
  { v: 4, label: "rough", color: "#8C3A2E" },
];

const TRACKS = {
  reset: { label: "Reset", blurb: "Handout work — mobility and activation. Fine on a bad day." },
  load: { label: "Load", blurb: "Strength. Log the band or hold so you can see it go up." },
};

/* Reference: a user-supplied link (their HEP portal page, which has the
   photo and video) or a fallback image search for the exercise name. */
const refUrl = (e) => e.ref?.trim()
  ? e.ref.trim()
  : `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(e.name + " exercise physical therapy")}`;
const isCustom = (e) => Boolean(e.ref?.trim());

/* ── Position diagrams ──────────────────────────────────────
   Drawn here rather than sourced: schematic setup views, showing
   body orientation, band anchor, and direction of travel. */

const S = { stroke: "#E7EBEC", strokeWidth: 3.5, strokeLinecap: "round", strokeLinejoin: "round", fill: "none" };
const PROP = { stroke: "rgba(231,235,236,.28)", strokeWidth: 3, strokeLinecap: "round", fill: "none" };
const BAND = { stroke: "#A8563C", strokeWidth: 3, strokeLinecap: "round", fill: "none", strokeDasharray: "1 7" };
const ARROW = { stroke: "#2F6F6B", strokeWidth: 3, strokeLinecap: "round", fill: "none", markerEnd: "url(#ah)" };

const Defs = () => (
  <defs>
    <marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#2F6F6B" />
    </marker>
  </defs>
);

const Head = ({ x, y, r = 9 }) => <circle cx={x} cy={y} r={r} {...S} />;

const POSES = {
  seated: (arrows, extra) => (
    <>
      <path d="M62 26 L62 84 L118 84" {...PROP} />
      <path d="M80 84 L78 52" {...S} />
      <Head x={78} y={41} />
      <path d="M80 84 L112 84 L112 108" {...S} />
      {extra}
      {arrows}
    </>
  ),
  seatedFold: (arrows, extra) => (
    <>
      <path d="M52 30 L52 84 L104 84" {...PROP} />
      <path d="M72 82 L96 56" {...S} />
      <Head x={104} y={48} />
      <path d="M72 82 L140 78" {...S} />
      <path d="M140 78 L142 104" {...S} />
      {extra}
      {arrows}
    </>
  ),
  supine: (arrows, extra) => (
    <>
      <path d="M20 104 L180 104" {...PROP} />
      <Head x={44} y={92} />
      <path d="M54 96 L104 96" {...S} />
      <path d="M104 96 L124 72 L142 100" {...S} />
      {extra}
      {arrows}
    </>
  ),
  sidelying: (arrows, extra) => (
    <>
      <path d="M20 104 L180 104" {...PROP} />
      <Head x={46} y={90} />
      <path d="M56 94 L108 94" {...S} />
      <path d="M108 94 L126 74 L148 92" {...S} />
      <path d="M62 92 L104 82" {...S} />
      {extra}
      {arrows}
    </>
  ),
  prone: (arrows, extra) => (
    <>
      <path d="M20 100 L180 100" {...PROP} />
      <Head x={48} y={88} />
      <path d="M58 92 L136 92 L154 92" {...S} />
      <path d="M64 90 L36 66" {...S} />
      <path d="M64 90 L44 96" {...S} />
      {extra}
      {arrows}
    </>
  ),
  quadruped: (arrows, extra) => (
    <>
      <path d="M20 104 L180 104" {...PROP} />
      <Head x={48} y={54} />
      <path d="M58 58 L128 60" {...S} />
      <path d="M62 60 L62 102" {...S} />
      <path d="M128 60 L128 84 L106 102" {...S} />
      {extra}
      {arrows}
    </>
  ),
  standing: (arrows, extra) => (
    <>
      <path d="M20 110 L180 110" {...PROP} />
      <Head x={100} y={26} />
      <path d="M100 36 L100 70" {...S} />
      <path d="M100 70 L88 108 M100 70 L112 108" {...S} />
      {extra}
      {arrows}
    </>
  ),
  hinge: (arrows, extra) => (
    <>
      <path d="M20 110 L180 110" {...PROP} />
      <Head x={54} y={44} />
      <path d="M64 48 L112 62" {...S} />
      <path d="M112 62 L114 108" {...S} />
      <path d="M70 50 L74 86" {...S} />
      {extra}
      {arrows}
    </>
  ),
  wall: (arrows, extra) => (
    <>
      <path d="M46 14 L46 110 M20 110 L180 110" {...PROP} />
      <Head x={78} y={34} />
      <path d="M78 44 L82 74" {...S} />
      <path d="M82 74 L96 108" {...S} />
      <path d="M78 48 L50 40" {...S} />
      {extra}
      {arrows}
    </>
  ),
};

const a = (d) => <path key={d} d={d} {...ARROW} />;
const band = (d) => <path key={d} d={d} {...BAND} />;
const anchor = (x, y) => <path key={`${x}${y}`} d={`M${x} ${y - 10} L${x} ${y + 10}`} stroke="rgba(231,235,236,.4)" strokeWidth="5" strokeLinecap="round" />;

/* pose + overlay per exercise, keyed by id */
const FIG = {
  p_scapret: ["seated", a("M96 56 L120 48"), <path key="a" d="M78 52 L62 44" {...S} />],
  p_cervret: ["seated", a("M92 38 L70 38"), null],
  p_tlext: ["seated", a("M84 44 L96 26"), <path key="a" d="M78 46 L98 30" {...S} />],
  p_openbook: ["sidelying", a("M104 82 A34 34 0 0 1 104 108"), null],
  p_scalene: ["seated", a("M70 34 L54 26"), <path key="a" d="M78 41 L66 34" {...S} />],
  p_levator: ["seated", a("M86 34 L100 24"), null],
  p_scm: ["seated", a("M88 32 L104 26"), null],
  p_hamstring: ["seatedFold", a("M120 74 L146 66"), null],
  p_fallout: ["supine", a("M124 72 L124 46"), null],
  p_march: ["supine", a("M124 72 L110 46"), null],
  p_pilates: ["supine", a("M142 100 L172 92"), null],
  p_segflex: ["supine", a("M44 80 L60 66"), null],
  l_cervres: ["seated", a("M92 38 L70 38"), <>{anchor(150, 42)}{band("M88 40 L150 42")}</>],
  l_horizab: ["standing", a("M64 46 L34 42 M136 46 L166 42"), <>{band("M34 44 L166 44")}<path d="M100 44 L64 46 M100 44 L136 46" {...S} /></>],
  l_row: ["standing", a("M118 56 L90 62"), <>{anchor(174, 50)}{band("M118 54 L174 50")}<path d="M100 48 L118 55" {...S} /></>],
  l_facepull: ["standing", a("M120 40 L92 32"), <>{anchor(174, 36)}{band("M120 38 L174 36")}<path d="M100 44 L120 38" {...S} /></>],
  l_prone_y: ["prone", a("M36 66 L30 52"), null],
  l_pulldown: ["standing", a("M126 34 L120 74"), <>{anchor(166, 16)}{band("M126 32 L166 16")}<path d="M100 44 L126 33" {...S} /></>],
  l_birddog: ["quadruped", a("M132 56 L162 48 M60 96 L26 88"), <>
    <path key="arm" d="M128 60 L162 50" {...S} /><path key="leg" d="M62 66 L26 90" {...S} /></>],
  l_deadbug: ["supine", a("M104 96 L82 70 M124 72 L150 80"), <path key="a" d="M96 94 L78 72" {...S} />],
  l_sideplank: ["sidelying", a("M92 88 L92 66"), <path key="a" d="M56 94 L58 108" {...S} />],
  l_carry: ["standing", a("M100 26 L100 12"), <>{anchor(140, 108)}{band("M118 66 L140 106")}<path d="M100 48 L118 66" {...S} /></>],
  l_hinge: ["hinge", a("M64 48 L96 30"), <>{anchor(120, 108)}{band("M74 60 L120 106")}</>],
  l_wallslide: ["wall", a("M52 38 L58 16"), null],
};

const Figure = ({ id }) => {
  const spec = FIG[id];
  if (!spec) return null;
  const [pose, arrows, extra] = spec;
  return (
    <svg viewBox="0 0 200 120" className="w-full" style={{ maxHeight: 200 }} role="img" aria-label="Position diagram">
      <Defs />
      {POSES[pose](arrows, extra)}
    </svg>
  );
};

const dkey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayKey = () => dkey(new Date());
const dayLabel = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
};
const lastNDays = (n) => {
  const out = [];
  for (let i = n - 1; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); out.push(dkey(d)); }
  return out;
};

const SAVE_WORDS = {
  loading: "",
  ready: "",
  saving: "saving…",
  saved: "saved",
  unsaved: "not saved — will retry",
  offline: "offline — saved on this device",
};

export default function Backlog() {
  const store = useMemo(() => openStore(), []);

  const [exercises, setExercises] = useState(SEED);
  const [exercisesAt, setExercisesAt] = useState(0);
  const [log, setLog] = useState({});
  const [done, setDone] = useState([]);
  const [loads, setLoads] = useState({});
  const [feel, setFeel] = useState(null);
  const [note, setNote] = useState("");
  const [track, setTrack] = useState("load");
  const [status, setStatus] = useState("loading");
  const [view, setView] = useState("today");
  const [fig, setFig] = useState(null);
  const [newName, setNewName] = useState("");
  const [newDose, setNewDose] = useState("");
  const [newZone, setNewZone] = useState("thoracic");
  const [newTrack, setNewTrack] = useState("load");

  const today = todayKey();

  /* The exercise list and the log are both needed to write a save, and the
     handlers below already hold whichever one they changed. This keeps the
     other one current without threading it through every call. */
  const latest = useRef({ exercises: SEED, exercisesAt: 0, log: {} });
  latest.current = { exercises, exercisesAt, log };

  const adopt = (data) => {
    if (!data) return;
    if (data.exercises?.length) setExercises(data.exercises);
    setExercisesAt(data.exercisesAt || 0);
    const nextLog = data.log || {};
    setLog(nextLog);
    const t = nextLog[todayKey()];
    setDone(t?.done || []);
    setLoads(t?.loads || {});
    setFeel(t?.feel ?? null);
    setNote(t?.note || "");
    if (t?.track) setTrack(t.track);
  };

  useEffect(() => {
    const off = store.onStatus((s) => setStatus(s));
    // A merge after a 409 means the copy on screen is no longer the whole truth.
    store.onRemote((merged) => adopt(merged));
    (async () => {
      const { data } = await store.load();
      adopt(data);
      setStatus("ready");
    })();
    return off;
  }, [store]);

  const persist = (nextEx, nextLog, nextExAt) => {
    store.save({ v: SHAPE, exercises: nextEx, exercisesAt: nextExAt, log: nextLog });
  };

  const active = useMemo(() => exercises.filter((e) => e.active && e.track === track), [exercises, track]);

  const commit = (nextDone, nextLoads, nextFeel, nextNote, nextTrack) => {
    const { exercises: ex, exercisesAt: exAt, log: currentLog } = latest.current;
    const nextLog = {
      ...currentLog,
      [today]: {
        done: nextDone, loads: nextLoads, feel: nextFeel, note: nextNote, track: nextTrack,
        of: ex.filter((e) => e.active && e.track === nextTrack).length,
        at: Date.now(),
      },
    };
    if (!nextDone.length && nextFeel === null && !nextNote) delete nextLog[today];
    setLog(nextLog);
    persist(ex, nextLog, exAt);
  };

  const toggle = (id) => {
    const next = done.includes(id) ? done.filter((x) => x !== id) : [...done, id];
    setDone(next); commit(next, loads, feel, note, track);
  };

  const setLoad = (id, v) => {
    const next = { ...loads, [id]: v };
    if (!v) delete next[id];
    setLoads(next); commit(done, next, feel, note, track);
  };

  const lastLoad = (id) => {
    const keys = Object.keys(log).sort().reverse();
    for (const k of keys) { if (k === today) continue; const v = log[k]?.loads?.[id]; if (v) return { v, k }; }
    return null;
  };

  /* Routine edits carry their own timestamp, so a device that only ticked boxes
     never overwrites a rotation change made somewhere else. */
  const reshape = (next) => {
    const at = Date.now();
    setExercises(next); setExercisesAt(at); persist(next, latest.current.log, at);
  };
  const setRef = (id, url) => reshape(exercises.map((e) => (e.id === id ? { ...e, ref: url } : e)));
  const setRotation = (id) => reshape(exercises.map((e) => (e.id === id ? { ...e, active: !e.active } : e)));
  const removeExercise = (id) => reshape(exercises.filter((e) => e.id !== id));
  const addExercise = () => {
    if (!newName.trim()) return;
    reshape([...exercises, { id: `x${Date.now()}`, name: newName.trim(), dose: newDose.trim() || "—", zone: newZone, track: newTrack, src: "you", cue: "", active: true, load: newTrack === "load" }]);
    setNewName(""); setNewDose("");
  };

  const spine = lastNDays(14).map((k) => {
    const e = log[k];
    const pct = e && e.of ? Math.min(1, e.done.length / e.of) : 0;
    const tint = e && e.feel !== null && e.feel !== undefined ? FEEL[e.feel].color : "#2F6F6B";
    return { key: k, pct, tint, isToday: k === today, load: e?.track === "load" };
  });

  const loadDays = lastNDays(7).filter((k) => log[k]?.track === "load" && log[k]?.done?.length).length;
  const pct = active.length ? Math.round((done.filter((id) => active.some((x) => x.id === id)).length / active.length) * 100) : 0;

  const dim = (o) => `rgba(231,235,236,${o})`;
  const field = { background: dim(0.06), border: `1px solid ${dim(0.12)}`, color: "#E7EBEC" };
  const figExercise = fig ? exercises.find((e) => e.id === fig) : null;

  return (
    <div className="min-h-screen w-full" style={{ background: "#14242B", color: "#E7EBEC", fontFamily: "'IBM Plex Mono', ui-monospace, monospace" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
        .disp { font-family: 'Barlow Condensed','Arial Narrow',sans-serif; letter-spacing:.01em; }
        .tap { transition: background-color .18s ease, border-color .18s ease, transform .18s ease; }
        .tap:active { transform: scale(.995); }
        button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible { outline:2px solid #E7EBEC; outline-offset:2px; }
        .vert { transition: height .5s cubic-bezier(.2,.7,.3,1); }
        @media (prefers-reduced-motion: reduce){ .vert,.tap{transition:none} }
        input,textarea,select{ color-scheme: dark; }
      `}</style>

      <div className="max-w-3xl mx-auto px-4 sm:px-5 pt-8 pb-16 flex gap-4 sm:gap-5">
        <div className="flex flex-col gap-1 pt-2 shrink-0" aria-hidden="true">
          {spine.map((s) => (
            <div key={s.key} className="relative w-3 rounded-sm overflow-hidden" style={{ height: 18, background: dim(0.09), boxShadow: s.isToday ? "0 0 0 1px #E7EBEC" : "none" }}>
              <div className="vert absolute bottom-0 left-0 w-full" style={{ height: `${s.pct * 100}%`, background: s.tint, opacity: s.load ? 1 : 0.5 }} />
            </div>
          ))}
        </div>

        <div className="flex-1 min-w-0">
          <header className="mb-6">
            <h1 className="disp text-5xl leading-none" style={{ fontWeight: 600 }}>BACKLOG</h1>
            <p className="text-xs mt-2" style={{ color: dim(0.55) }}>{dayLabel(today)} · {loadDays} load session{loadDays === 1 ? "" : "s"} in the last 7 days</p>
            <p className="text-xs mt-1 h-4" style={{ color: status === "unsaved" || status === "offline" ? "#A8563C" : dim(0.35) }}>{SAVE_WORDS[status] || ""}</p>
          </header>

          <nav className="flex gap-1 mb-6 text-xs">
            {["today", "history", "routine"].map((v) => (
              <button key={v} onClick={() => setView(v)} className="tap px-3 py-2 rounded uppercase tracking-wider"
                style={{ background: view === v ? "#2F6F6B" : dim(0.07), color: view === v ? "#FAFAF8" : dim(0.7) }}>{v}</button>
            ))}
          </nav>

          {status === "loading" && <p className="text-xs" style={{ color: dim(0.5) }}>Loading your log…</p>}

          {status !== "loading" && view === "today" && (
            <section>
              <div className="flex gap-1 mb-1">
                {Object.entries(TRACKS).map(([k, t]) => (
                  <button key={k} onClick={() => { setTrack(k); commit(done, loads, feel, note, k); }}
                    className="tap flex-1 rounded px-3 py-2 text-left"
                    style={{ background: track === k ? dim(0.1) : "transparent", border: `1px solid ${track === k ? "#2F6F6B" : dim(0.1)}` }}>
                    <span className="disp text-xl">{t.label}</span>
                  </button>
                ))}
              </div>
              <p className="text-xs mb-5" style={{ color: dim(0.5) }}>{TRACKS[track].blurb}</p>

              <div className="flex items-center gap-3 mb-4">
                <div className="flex-1 h-1 rounded-sm overflow-hidden" style={{ background: dim(0.09) }}>
                  <div className="vert h-full" style={{ width: `${pct}%`, background: "#2F6F6B" }} />
                </div>
                <span className="text-xs tabular-nums" style={{ color: dim(0.5) }}>{pct}%</span>
              </div>

              <ul className="flex flex-col gap-1">
                {active.map((e) => {
                  const on = done.includes(e.id);
                  const zone = ZONES[e.zone] || ZONES.thoracic;
                  const prev = e.load ? lastLoad(e.id) : null;
                  return (
                    <li key={e.id} className="tap rounded"
                      style={{ background: on ? dim(0.09) : dim(0.04), border: `1px solid ${on ? zone.color : dim(0.08)}` }}>
                      <div className="flex items-start gap-3 p-3">
                        <button onClick={() => toggle(e.id)} aria-pressed={on} aria-label={`Mark ${e.name} done`}
                          className="tap shrink-0 rounded-sm mt-0.5 flex items-center justify-center"
                          style={{ width: 22, height: 22, background: on ? zone.color : "transparent", border: `1px solid ${on ? zone.color : dim(0.25)}` }}>
                          {on && <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.5 L4.7 9 L10 3.2" fill="none" stroke="#FAFAF8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                        </button>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline gap-x-2 gap-y-1 flex-wrap">
                            <span className="disp text-lg leading-tight" style={{ opacity: on ? 0.65 : 1 }}>{e.name}</span>
                            <span className="text-xs tabular-nums" style={{ color: dim(0.45) }}>{e.dose}</span>
                            <span className="text-xs uppercase tracking-wider" style={{ color: zone.color }}>{zone.label}</span>
                          </div>
                          {e.cue && <p className="text-xs mt-1 leading-relaxed" style={{ color: dim(0.5) }}>{e.cue}</p>}

                          {e.load && (
                            <div className="flex items-center gap-2 mt-2 flex-wrap">
                              <input value={loads[e.id] ?? ""} onChange={(ev) => setLoad(e.id, ev.target.value)}
                                placeholder="band / hold / reps"
                                aria-label={`Load for ${e.name}`}
                                className="rounded px-2 py-1 text-xs" style={{ ...field, width: 150 }} />
                              {prev && <span className="text-xs" style={{ color: dim(0.4) }}>last: {prev.v} · {dayLabel(prev.k)}</span>}
                            </div>
                          )}
                        </div>

                        <button onClick={() => setFig(e.id)} aria-label={`Show position for ${e.name}`}
                          className="tap shrink-0 rounded px-2 py-1 text-xs" style={{ background: dim(0.07), color: dim(0.6) }}>pos</button>
                      </div>
                    </li>
                  );
                })}
                {!active.length && (
                  <li className="text-xs py-6" style={{ color: dim(0.45) }}>
                    Nothing in rotation on this track. Add or un-bench something under <span style={{ color: dim(0.75) }}>routine</span>.
                  </li>
                )}
              </ul>

              <div className="mt-8">
                <h2 className="disp text-2xl mb-2">How's the back?</h2>
                <div className="flex gap-1 flex-wrap">
                  {FEEL.map((f) => (
                    <button key={f.v} onClick={() => { const v = feel === f.v ? null : f.v; setFeel(v); commit(done, loads, v, note, track); }}
                      className="tap rounded px-3 py-2 text-xs"
                      style={{ background: feel === f.v ? f.color : dim(0.06), color: feel === f.v ? "#FAFAF8" : dim(0.65), border: `1px solid ${feel === f.v ? f.color : dim(0.1)}` }}>
                      {f.label}
                    </button>
                  ))}
                </div>
                <textarea value={note} onChange={(ev) => { setNote(ev.target.value); commit(done, loads, feel, ev.target.value, track); }}
                  placeholder="Anything worth remembering — what set it off, what helped."
                  rows={3} aria-label="Note for today"
                  className="w-full mt-3 rounded px-3 py-2 text-xs leading-relaxed" style={field} />
              </div>
            </section>
          )}

          {status !== "loading" && view === "history" && (
            <section>
              {(() => {
                const days = Object.keys(log).sort().reverse();
                if (!days.length) return <p className="text-xs" style={{ color: dim(0.45) }}>Nothing logged yet.</p>;
                return (
                  <ul className="flex flex-col gap-2">
                    {days.map((k) => {
                      const e = log[k];
                      const f = e.feel !== null && e.feel !== undefined ? FEEL[e.feel] : null;
                      const ratio = e.of ? Math.round((e.done.length / e.of) * 100) : 0;
                      return (
                        <li key={k} className="rounded p-3" style={{ background: dim(0.04), border: `1px solid ${dim(0.08)}` }}>
                          <div className="flex items-baseline gap-2 flex-wrap">
                            <span className="disp text-lg">{dayLabel(k)}</span>
                            <span className="text-xs uppercase tracking-wider" style={{ color: dim(0.45) }}>{TRACKS[e.track]?.label || e.track}</span>
                            <span className="text-xs tabular-nums ml-auto" style={{ color: dim(0.5) }}>{e.done.length}/{e.of || "—"} · {ratio}%</span>
                          </div>
                          {f && <p className="text-xs mt-1" style={{ color: f.color }}>{f.label}</p>}
                          {e.loads && Object.keys(e.loads).length > 0 && (
                            <p className="text-xs mt-1 leading-relaxed" style={{ color: dim(0.45) }}>
                              {Object.entries(e.loads).map(([id, v]) => `${exercises.find((x) => x.id === id)?.name || id}: ${v}`).join(" · ")}
                            </p>
                          )}
                          {e.note && <p className="text-xs mt-2 leading-relaxed" style={{ color: dim(0.6) }}>{e.note}</p>}
                        </li>
                      );
                    })}
                  </ul>
                );
              })()}
            </section>
          )}

          {status !== "loading" && view === "routine" && (
            <section>
              {Object.entries(TRACKS).map(([k, t]) => (
                <div key={k} className="mb-8">
                  <h2 className="disp text-2xl">{t.label}</h2>
                  <p className="text-xs mb-3" style={{ color: dim(0.5) }}>{t.blurb}</p>
                  <ul className="flex flex-col gap-1">
                    {exercises.filter((e) => e.track === k).map((e) => (
                      <li key={e.id} className="rounded p-3" style={{ background: dim(0.04), border: `1px solid ${dim(0.08)}`, opacity: e.active ? 1 : 0.55 }}>
                        <div className="flex items-start gap-2 flex-wrap">
                          <div className="flex-1 min-w-0">
                            <span className="disp text-lg">{e.name}</span>
                            <span className="text-xs ml-2 tabular-nums" style={{ color: dim(0.45) }}>{e.dose}</span>
                            <span className="text-xs ml-2 uppercase tracking-wider" style={{ color: (ZONES[e.zone] || ZONES.thoracic).color }}>{(ZONES[e.zone] || ZONES.thoracic).label}</span>
                          </div>
                          <button onClick={() => setRotation(e.id)} className="tap rounded px-2 py-1 text-xs"
                            style={{ background: e.active ? "#2F6F6B" : dim(0.07), color: e.active ? "#FAFAF8" : dim(0.6) }}>
                            {e.active ? "in rotation" : "benched"}
                          </button>
                          <a href={refUrl(e)} target="_blank" rel="noopener noreferrer"
                            className="tap rounded px-2 py-1 text-xs" style={{ background: dim(0.07), color: dim(0.6) }}>
                            {isCustom(e) ? "link" : "images"}
                          </a>
                          {e.src === "you" && (
                            <button onClick={() => removeExercise(e.id)} className="tap rounded px-2 py-1 text-xs"
                              style={{ background: dim(0.07), color: "#A8563C" }}>remove</button>
                          )}
                        </div>
                        <input defaultValue={e.ref || ""} onBlur={(ev) => { const v = ev.target.value.trim(); if (v !== (e.ref || "")) setRef(e.id, v); }}
                          placeholder="Paste the HEP portal link for this one (optional)"
                          aria-label={`Reference link for ${e.name}`}
                          className="w-full mt-2 rounded px-2 py-1 text-xs" style={field} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}

              <div className="rounded p-3" style={{ background: dim(0.04), border: `1px solid ${dim(0.08)}` }}>
                <h2 className="disp text-2xl mb-3">Add something</h2>
                <div className="flex flex-col gap-2">
                  <input value={newName} onChange={(ev) => setNewName(ev.target.value)} placeholder="Name" aria-label="New exercise name"
                    className="rounded px-2 py-2 text-xs" style={field} />
                  <input value={newDose} onChange={(ev) => setNewDose(ev.target.value)} placeholder="Dose — 3 × 10" aria-label="New exercise dose"
                    className="rounded px-2 py-2 text-xs" style={field} />
                  <div className="flex gap-2">
                    <select value={newZone} onChange={(ev) => setNewZone(ev.target.value)} aria-label="Zone"
                      className="flex-1 rounded px-2 py-2 text-xs" style={field}>
                      {Object.entries(ZONES).map(([k, z]) => <option key={k} value={k}>{z.label}</option>)}
                    </select>
                    <select value={newTrack} onChange={(ev) => setNewTrack(ev.target.value)} aria-label="Track"
                      className="flex-1 rounded px-2 py-2 text-xs" style={field}>
                      {Object.entries(TRACKS).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}
                    </select>
                  </div>
                  <button onClick={addExercise} className="tap rounded px-3 py-2 text-xs uppercase tracking-wider"
                    style={{ background: "#2F6F6B", color: "#FAFAF8" }}>Add</button>
                </div>
              </div>
            </section>
          )}
        </div>
      </div>

      {figExercise && (
        <div role="dialog" aria-modal="true" aria-label={`Position: ${figExercise.name}`}
          onClick={() => setFig(null)}
          className="fixed inset-0 flex items-end sm:items-center justify-center p-4 z-50"
          style={{ background: "rgba(10,18,22,.8)" }}>
          <div onClick={(ev) => ev.stopPropagation()} className="w-full max-w-md rounded p-4"
            style={{ background: "#1A2E36", border: `1px solid ${dim(0.14)}` }}>
            <div className="flex items-baseline gap-2 mb-2 flex-wrap">
              <span className="disp text-2xl">{figExercise.name}</span>
              <span className="text-xs tabular-nums" style={{ color: dim(0.45) }}>{figExercise.dose}</span>
            </div>
            <Figure id={figExercise.id} />
            {figExercise.cue && <p className="text-xs mt-3 leading-relaxed" style={{ color: dim(0.65) }}>{figExercise.cue}</p>}
            <p className="text-xs mt-3 leading-relaxed" style={{ color: dim(0.35) }}>
              Schematic — body orientation, band anchor, direction of travel. Not a form guide.
            </p>
            <div className="flex gap-2 mt-4">
              <a href={refUrl(figExercise)} target="_blank" rel="noopener noreferrer"
                className="tap flex-1 text-center rounded px-3 py-2 text-xs" style={{ background: dim(0.07), color: dim(0.7) }}>
                {isCustom(figExercise) ? "Open reference" : "Search images"}
              </a>
              <button onClick={() => setFig(null)} className="tap flex-1 rounded px-3 py-2 text-xs uppercase tracking-wider"
                style={{ background: "#2F6F6B", color: "#FAFAF8" }}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
