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
//   rescheduled  — the interview was rescheduled (every time). It counts the moment the Agent
//                  flags it (his reschedule request), dated by the interview's own date; withdrawing
//                  the request takes it back. The Caller then setting the new time does not count
//                  again — but a Caller moving a meeting nobody asked to move still does.
//
// Attendance is also something the agent can state outright, per meeting: "attended" or
// "not attended" (collection `attendance`, one record per ref, changeable any time, past
// meetings included). That record wins: it is counted in the month the meeting took place,
// and a "not attended" removes the meeting from the attended count even if an outcome was
// logged. Meetings with no record keep the older rule (an outcome logged = he went).

async function hasEvent(type, ref) {
  return (await all('meeting_events')).some((e) => e.type === type && e.ref === ref);
}

export async function recordOnce(type, ref, at) {
  if (!ref || (await hasEvent(type, ref))) return;
  await insert('meeting_events', (id) => ({ id, type, ref, at: at || new Date().toISOString() }));
}

export async function recordEvent(type, ref, at) {
  if (!ref) return;
  await insert('meeting_events', (id) => ({ id, type, ref, at: at || new Date().toISOString() }));
}

// ---- Reschedules, counted from the Agent's request ----
// The Agent flags a meeting for rescheduling: that is a reschedule. One counts per open request
// (editing the wording doesn't add another), dated by the interview's own (Zoom) date.
export async function recordRescheduleRequest(ref, meetingAt) {
  if (!ref) return;
  const events = await all('meeting_events');
  if (events.some((e) => e.type === 'rescheduled' && e.ref === ref && e.open)) return;
  await insert('meeting_events', (id) => ({ id, type: 'rescheduled', ref, at: meetingAt || new Date().toISOString(), via: 'request', open: true }));
}

// The Agent withdrew the request: it stops counting.
export async function withdrawRescheduleCount(ref) {
  if (!ref) return;
  await removeWhere('meeting_events', (e) => e.type === 'rescheduled' && e.ref === ref && e.open);
}

// The Caller set the new time. If the Agent had asked for it, that request is what was counted, so
// this closes it and returns true (nothing more to count); otherwise the Caller moved it
// unprompted and the caller records that move itself.
export async function settleRescheduleRequest(ref) {
  if (!ref) return false;
  const open = (await all('meeting_events')).filter((e) => e.type === 'rescheduled' && e.ref === ref && e.open);
  for (const e of open) await update('meeting_events', e.id, (x) => void (x.open = false));
  return open.length > 0;
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

// One attendance record per meeting; the latest wins if concurrent requests left two.
export async function attendanceMap() {
  const byRef = new Map();
  for (const r of (await all('attendance')).sort((a, b) => String(a.set_at).localeCompare(String(b.set_at)))) byRef.set(r.ref, r);
  return byRef;
}

// status: 'attended' | 'not_attended' | null (clears it). `at` is when the meeting took place.
export async function setAttendance(ref, status, at, by) {
  if (!ref) return;
  await removeWhere('attendance', (r) => r.ref === ref);
  if (status !== 'attended' && status !== 'not_attended') return;
  await insert('attendance', (id) => ({ id, ref, status, at, set_by: by || null, set_at: new Date().toISOString() }));
}

// What the agent sees for a meeting: his own answer if he gave one, otherwise attended
// if an outcome was logged (that is how it was counted before), otherwise not set.
export function attendanceStatus(rec, outcome) {
  return rec?.status || (outcome ? 'attended' : null);
}

// A deleted meeting stops counting as fixed — unless it was already attended,
// in which case it did happen.
export async function forgetMeeting(ref) {
  if (!ref) return;
  const rec = (await attendanceMap()).get(ref);
  if (rec) {
    await removeWhere('attendance', (r) => r.ref === ref);
    if (rec.status === 'attended') return; // he said it happened: it did
  } else if (await hasEvent('attended', ref)) {
    return;
  }
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

// When each meeting takes place (its Zoom time), by ref. Analytics is about the interview's own
// date — not the day anything was booked, logged or edited — so every count looks the date up here.
// A deal's meeting follows the deal if it is later moved; refs that can't be found (older records)
// fall back to the time their event was recorded.
async function meetingTimes() {
  const t = new Map();
  for (const d of await all('deals')) {
    if (d.scheduled_at) t.set(d.stat_ref || `deal-${d.id}-legacy`, d.scheduled_at);
    (d.past_meetings || []).forEach((h, i) => {
      if (h.stat_ref) t.set(h.stat_ref, h.scheduled_at);
      t.set(`hist-${d.id}-${i}`, h.scheduled_at);
    });
  }
  for (const e of await all('zoom_meeting_log')) {
    const ref = `zoom-${e.zoom_id}`;
    if (!t.has(ref) && e.start_time) t.set(ref, e.start_time);
  }
  return t;
}

// Every outcome the agent currently has logged, dated by the meeting it is about. One per
// meeting, taken from what is logged now (so changing his mind changes the
// record instead of adding one). Sources: a deal's current outcome and the
// outcomes on its earlier meetings, and Zoom-only meetings' outcomes (kept with
// the meeting; older ones that only exist as a notification are picked up from there).
async function outcomeRecords() {
  const out = [];
  const add = (key, at) => {
    if (key in FOLLOWUP_OUTCOMES && at) out.push({ key, at });
  };
  for (const d of await all('deals')) {
    add(d.outcome?.key, d.scheduled_at || d.outcome?.logged_at);
    (d.past_meetings || []).forEach((h) => add(h.outcome?.key, h.scheduled_at || h.outcome?.logged_at));
  }
  // The log can hold duplicates from concurrent requests: one meeting, one record.
  const withOutcome = new Map();
  for (const e of await all('zoom_meeting_log')) {
    if (e.outcome && !withOutcome.has(String(e.zoom_id))) withOutcome.set(String(e.zoom_id), e.outcome);
  }
  const zoomStart = new Map((await all('zoom_meeting_log')).map((e) => [String(e.zoom_id), e.start_time]));
  withOutcome.forEach((o, id) => add(o.key, zoomStart.get(id) || o.logged_at));
  const counted = new Set(withOutcome.keys());
  const legacy = (await all('notifications'))
    .filter((n) => n.type === 'meeting_outcome' && n.meta?.zoom_meeting_id != null)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  for (const n of legacy) {
    const id = String(n.meta.zoom_meeting_id);
    if (counted.has(id)) continue;
    counted.add(id);
    add(n.meta.outcome, n.meta.scheduled_at || n.created_at);
  }
  return out;
}

// "2026-09" for a moment, as seen from the viewer's timezone (`tz` is what the
// browser's getTimezoneOffset() reports: minutes *behind* UTC, so Singapore is -480).
const monthKey = (iso, tz) => {
  const d = new Date(new Date(iso).getTime() - tz * 60000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
export function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// The Analytics page, one month at a time: interviews fixed, attended and
// rescheduled, and how the ones he logged turned out — for the chosen month, the
// month before (to compare), and every month of that year for the overview table.
// Fixed, attended, not attended and the outcomes are counted in the month the interview
// itself takes place (its Zoom date) — not when it was booked, marked or edited. A reschedule
// counts when the Agent flags it, in the month of the interview that was flagged.
export async function monthlyAnalytics({ month, tz = 0 }) {
  const events = await all('meeting_events');
  // fixed / attended are once per meeting (concurrent requests can log one twice):
  // count each in the month it first happened. Reschedules count every time.
  const firstAtByRef = (type) => {
    const first = new Map();
    for (const e of events) if (e.type === type && (!first.has(e.ref) || e.at < first.get(e.ref))) first.set(e.ref, e.at);
    return first;
  };
  // Every count is dated by the interview's own (Zoom) date, whenever it was booked or marked.
  const times = await meetingTimes();
  const onMeetingDate = ([ref, at]) => times.get(ref) || at;
  const fixed = [...firstAtByRef('fixed')].map(onMeetingDate);
  // Attendance: the agent's own answer where he gave one (counted in the month the meeting
  // took place), otherwise the old rule — an outcome logged means he went.
  const answers = await attendanceMap();
  const attended = [...answers.values()]
    .filter((r) => r.status === 'attended')
    .map((r) => times.get(r.ref) || r.at)
    .concat([...firstAtByRef('attended')].filter(([ref]) => !answers.has(ref)).map(onMeetingDate));
  const notAttended = [...answers.values()].filter((r) => r.status === 'not_attended').map((r) => times.get(r.ref) || r.at);
  const rescheduled = events.filter((e) => e.type === 'rescheduled').map((e) => e.at);
  const outcomes = await outcomeRecords();

  const inMonth = (list, key, pick = (x) => x) => list.filter((x) => monthKey(pick(x), tz) === key).length;
  const tally = (key) => ({
    fixed: inMonth(fixed, key),
    attended: inMonth(attended, key),
    not_attended: inMonth(notAttended, key),
    rescheduled: inMonth(rescheduled, key),
    not_interested: inMonth(outcomes.filter((o) => o.key === 'not_interested'), key, (o) => o.at),
    follow_up: inMonth(outcomes.filter((o) => o.key === 'follow_up'), key, (o) => o.at),
  });

  const current = monthKey(new Date().toISOString(), tz);
  // A month that hasn't happened yet (or isn't a month) falls back to this one.
  const asked = /^\d{4}-(0[1-9]|1[0-2])$/.test(month || '') ? month : current;
  const selected = asked > current ? current : asked;
  const t = tally(selected);

  // The overview table is the selected year, January onwards (months still to
  // come are left out); the year picker runs from the first year with anything
  // in it up to this one, newest first, so a new year simply appears.
  const year = selected.slice(0, 4);
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)
    .filter((key) => key <= current)
    .map((key) => ({ month: key, ...tally(key) }));
  const stamps = [...fixed, ...attended, ...notAttended, ...rescheduled, ...outcomes.map((o) => o.at)];
  const firstYear = Math.min(Number(current.slice(0, 4)), ...stamps.map((at) => Number(monthKey(at, tz).slice(0, 4))));
  const years = Array.from({ length: Number(current.slice(0, 4)) - firstYear + 1 }, (_, i) => Number(current.slice(0, 4)) - i);
  if (!years.includes(Number(year))) years.push(Number(year)), years.sort((a, b) => b - a);
  return {
    month: selected,
    current_month: current,
    years,
    fixed: t.fixed,
    attended: t.attended,
    not_attended: t.not_attended,
    rescheduled: t.rescheduled,
    previous: (({ fixed, attended, not_attended, rescheduled }) => ({ fixed, attended, not_attended, rescheduled }))(tally(shiftMonth(selected, -1))),
    outcomes: Object.entries(FOLLOWUP_OUTCOMES).map(([key, v]) => ({ key, label: v.label, count: t[key] })),
    months,
  };
}
