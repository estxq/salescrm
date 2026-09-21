import { all, insert, update, removeWhere } from './db.js';

// Zoom only reports upcoming meetings: the moment an interview is over it
// vanishes from Zoom's list, and would vanish from the calendar with it. So
// every Zoom-only meeting the app sees is remembered here, and once it's in the
// past (and Zoom no longer lists it) it stays on the calendar as history.
//
// Zoom stays the source of truth while a meeting is upcoming — each sighting
// refreshes the stored time/topic, so a meeting moved in Zoom moves here too.
// One that is gone from Zoom while still in the future was deleted, so it's
// dropped rather than kept as a phantom.

const idOf = (e) => String(e.zoom_id);

// Concurrent requests can each insert the same meeting (storage is
// read-modify-write). Reading collapses those duplicates: the first wins.
function dedupe(entries) {
  const seen = new Map();
  for (const e of entries) if (!seen.has(idOf(e))) seen.set(idOf(e), e);
  return [...seen.values()];
}

export async function readZoomLog() {
  return dedupe(await all('zoom_meeting_log'));
}

// Brings the log in line with what Zoom lists right now, then returns it split
// into { byId, past } — `past` being remembered meetings that are over and no
// longer listed.
export async function syncZoomLog(liveMeetings) {
  const entries = await readZoomLog();
  const byId = new Map(entries.map((e) => [idOf(e), e]));
  const liveIds = new Set(liveMeetings.map((m) => String(m.id)));

  for (const m of liveMeetings) {
    const known = byId.get(String(m.id));
    if (!known) {
      const created = await insert('zoom_meeting_log', (id) => ({
        id,
        zoom_id: m.id,
        topic: m.topic,
        start_time: m.start_time,
        join_url: m.join_url,
        outcome: null,
        first_seen: new Date().toISOString(),
      }));
      byId.set(String(m.id), created);
    } else if (known.topic !== m.topic || known.start_time !== m.start_time || known.join_url !== m.join_url) {
      const updated = await update('zoom_meeting_log', known.id, (e) => {
        e.topic = m.topic;
        e.start_time = m.start_time;
        e.join_url = m.join_url;
      });
      byId.set(String(m.id), updated);
    }
  }

  const now = Date.now();
  const gone = [...byId.values()].filter((e) => !liveIds.has(idOf(e)));
  const deleted = gone.filter((e) => new Date(e.start_time).getTime() > now);
  if (deleted.length) {
    const ids = new Set(deleted.map((e) => e.id));
    await removeWhere('zoom_meeting_log', (e) => ids.has(e.id) || deleted.some((d) => idOf(d) === idOf(e)));
    deleted.forEach((e) => byId.delete(idOf(e)));
  }
  const past = gone.filter((e) => new Date(e.start_time).getTime() <= now);
  return { byId, past };
}

// Agent logged how a Zoom-only meeting went: keep it with the meeting so it
// still shows once the meeting is over.
export async function setZoomOutcome(zoomId, { topic, start_time }, outcome) {
  const existing = (await readZoomLog()).find((e) => idOf(e) === String(zoomId));
  if (existing) return update('zoom_meeting_log', existing.id, (e) => void (e.outcome = outcome));
  return insert('zoom_meeting_log', (id) => ({
    id,
    zoom_id: Number(zoomId),
    topic: topic || 'Zoom meeting',
    start_time: start_time || new Date().toISOString(),
    join_url: '',
    outcome,
    first_seen: new Date().toISOString(),
  }));
}

export async function forgetZoomMeeting(zoomId) {
  await removeWhere('zoom_meeting_log', (e) => idOf(e) === String(zoomId));
}
