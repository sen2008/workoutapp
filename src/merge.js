/*
 * Merging two versions of the log.
 *
 * The archive is one blob, so two devices that both save from a stale copy
 * would otherwise overwrite each other. The Worker refuses the second write
 * with a 409; this is what runs before the retry.
 *
 * Everything mergeable is stamped with the moment it changed, and the newer
 * stamp wins. That is per-day for the log, so a session logged on the phone and
 * a session logged on the laptop on different days both survive — only the same
 * day edited in two places at once has to pick a side.
 */

export const SHAPE = 3;

export const empty = () => ({ v: SHAPE, exercises: null, exercisesAt: 0, log: {} });

/* Older blobs predate the timestamps; treat them as infinitely old so anything
   carrying a real stamp wins, and fall back to a plain union otherwise. */
const stamp = (x) => (x && typeof x.at === "number" ? x.at : 0);

export function merge(mine, theirs) {
  if (!theirs) return mine;
  if (!mine) return theirs;

  const log = { ...theirs.log };
  for (const [day, entry] of Object.entries(mine.log || {})) {
    const other = log[day];
    if (!other || stamp(entry) >= stamp(other)) log[day] = entry;
  }

  /* A day deleted on one device (every box unticked) is a real edit, and it is
     already represented: the deleting device drops the key, so the surviving
     side's entry only wins if it is genuinely newer. */

  const mineNewer = (mine.exercisesAt || 0) >= (theirs.exercisesAt || 0);
  const from = mineNewer ? mine : theirs;

  return {
    v: SHAPE,
    exercises: from.exercises || mine.exercises || theirs.exercises,
    exercisesAt: Math.max(mine.exercisesAt || 0, theirs.exercisesAt || 0),
    log,
  };
}
