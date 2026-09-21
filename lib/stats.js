import { all, insert, removeWhere, update } from './db.js';
import { FOLLOWUP_OUTCOMES } from './deals.js';

// Counters for the Agent's Interviews page. Kept as a small log of events
// rather than derived from deals, because interviews booked straight in Zoom
// have no deal, and a reschedule leaves no trace of having happened once the
// new time is saved.
//
// Every meeting has a "ref": `deal-<id>-<n>` for a booking made here (a fresh
// one each time a meeting is scheduled, so "schedule another meeting" counts
// as another interview) or `zoom-<id>` for one booked in Zoom itself.
//   fixed        — the interview was put in the diary (once per ref)
//   attended     — the agent logged how it went, i.e. he went (once per ref)
//   rescheduled  — the meeting was moved (every time)

async function hasEvent(type, ref) {
  return (await all('meeting_events')).some((e) => e.type === type && e.ref === ref);
}

export async function recordOnce(type, ref, at) {
  if (!ref || (await hasEvent(type, ref))) return;
  await insert('meeting_events', (id) => ({ id, type, ref, at: at || new Date().toISOString() }));
}

export async function recordEvent(type, ref) {
  if (!ref) return;
  await insert('meeting_events', (id) => ({ id, type, ref, at: new Date().toISOString() }));
}

// Meetings the agent booked directly in Zoom are only visible while they're
// upcoming, so note each one the first time it's seen. One read, and a write
// only when something new turned up.
export async function recordZoomMeetingsSeen(zoomIds) {
  const known = new Set((await all('meeting_events')).filter((e) => e.type === 'fixed').map((e) => e.ref));
  for (const id of zoomIds) {
    const ref = `zoom-${id}`;
    if (!known.has(ref)) await recordOnce('fixed', ref);
  }
}

// A deleted meeting stops counting as fixed — unless it was already attended,
// in which case it did happen.
export async function forgetMeeting(ref) {
  if (!ref || (await hasEvent('attended', ref))) return;
  await removeWhere('meeting_events', (e) => e.ref === ref);
}

// Deals booked before this existed have no ref: give them one and count them
// as fixed, once.
export async function backfillDealRefs(deals) {
  for (const d of deals) {
    if (!d.scheduled_at || d.stat_ref) continue;
    const ref = `deal-${d.id}-legacy`;
    await update('deals', d.id, (x) => {
      x.stat_ref = ref;
    });
    await recordOnce('fixed', ref, d.updated_at || d.created_at); // when it was booked isn't known; last touched is the best guess
  }
}

// How the meetings the agent logged turned out — one count per meeting, taken
// from what he currently has logged (so changing his mind moves the count).
// Sources: a deal's current outcome and the outcomes on its earlier meetings,
// and Zoom-only meetings' outcomes (kept with the meeting; older ones that only
// exist as a notification are picked up from there).
export async function outcomeCounts() {
  const counts = Object.fromEntries(Object.keys(FOLLOWUP_OUTCOMES).map((k) => [k, 0]));
  const bump = (key) => {
    if (key in counts) counts[key] += 1;
  };
  for (const d of await all('deals')) {
    bump(d.outcome?.key);
    (d.past_meetings || []).forEach((h) => bump(h.outcome?.key));
  }
  // The log can hold duplicates from concurrent requests: one meeting, one count.
  const withOutcome = new Map();
  for (const e of await all('zoom_meeting_log')) {
    if (e.outcome && !withOutcome.has(String(e.zoom_id))) withOutcome.set(String(e.zoom_id), e.outcome.key);
  }
  withOutcome.forEach((key) => bump(key));
  const counted = new Set(withOutcome.keys());
  const legacy = (await all('notifications'))
    .filter((n) => n.type === 'meeting_outcome' && n.meta?.zoom_meeting_id != null)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  for (const n of legacy) {
    const id = String(n.meta.zoom_meeting_id);
    if (counted.has(id)) continue;
    counted.add(id);
    bump(n.meta.outcome);
  }
  return Object.entries(FOLLOWUP_OUTCOMES).map(([key, v]) => ({ key, label: v.label, count: counts[key] }));
}

export async function interviewStats() {
  const events = await all('meeting_events');
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  // fixed/attended are once-per-meeting, so count distinct meetings — concurrent
  // requests can race to log the same one twice. Reschedules count every event.
  const count = (type, since) => {
    const matching = events.filter((e) => e.type === type && (!since || new Date(e.at) >= since));
    return type === 'rescheduled' ? matching.length : new Set(matching.map((e) => e.ref)).size;
  };
  const block = (since) => ({
    fixed: count('fixed', since),
    attended: count('attended', since),
    rescheduled: count('rescheduled', since),
  });
  return { ...block(null), this_month: block(monthStart) };
}
