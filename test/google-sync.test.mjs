process.env.PORT = '3807'; process.env.GOOGLE_CLIENT_ID = 'gid'; process.env.GOOGLE_CLIENT_SECRET = 'gsec';
// Manual: node test/google-sync.test.mjs from a COPY of the project with an empty data/ dir (it signs up
// users and books meetings). Fakes Google Calendar and checks book/move/delete mirror correctly.
const events = {}; let nid = 1; const calls = []; let denyWrite = false; const real = globalThis.fetch;
globalThis.fetch = async (url, o = {}) => {
  const u = String(url); const j = (b, s = 200) => new Response(b == null ? null : JSON.stringify(b), { status: s });
  if (!u.startsWith('https://www.googleapis.com/calendar/v3/calendars/primary/events')) return real(url, o);
  const m = (o.method || 'GET'); const id = u.split('/events/')[1]?.split('?')[0];
  calls.push(`${m} ${id || ''}`);
  if (m !== 'GET' && denyWrite) return j({ error: { message: 'Request had insufficient authentication scopes.' } }, 403);
  if (m === 'POST') { const b = JSON.parse(o.body); const e = { id: 'ev' + nid++, ...b }; events[e.id] = e; return j(e); }
  if (m === 'PATCH') { if (!events[id]) return j({}, 404); events[id] = { ...events[id], ...JSON.parse(o.body) }; return j(events[id]); }
  if (m === 'DELETE') { if (!events[id]) return j({}, 404); delete events[id]; return j(null, 204); }
  return j({ items: Object.values(events).map((e) => ({ id: e.id, summary: e.summary, description: e.description, start: e.start, end: e.end })).concat([{ id: 'personal1', summary: 'Dentist', start: { dateTime: '2026-10-20T09:00:00+08:00' }, end: { dateTime: '2026-10-20T10:00:00+08:00' } }]) });
};
await import('./server.js');
const { withTeam, withAgent } = await import('./lib/context.js'); const { setRaw, getRaw, teamKey, agentKey } = await import('./lib/db.js');
const B = 'http://localhost:3807';
const mk = () => { const jar = {}; return async (p, m = 'GET', b) => { const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') }, body: b ? JSON.stringify(b) : undefined }); for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); } const t = await r.text(); try { return { s: r.status, j: JSON.parse(t) }; } catch { return { s: r.status, j: t }; } }; };
let bad = 0; const chk = (n, c, d = '') => { console.log(c ? 'ok  ' : 'FAIL', n, c ? '' : d); if (!c) bad++; };
const C = mk(), A = mk();
const s = await C('/api/auth/signup', 'POST', { mode: 'create', name: 'Cal', email: 'c@x.com', password: 'passw0rd!x', role: 'caller', team_name: 'T' });
await A('/api/auth/signup', 'POST', { mode: 'join', name: 'Arron', email: 'a@x.com', password: 'passw0rd!x', role: 'agent', invite_code: s.j.invite.code });
const tid = s.j.team.id; const far = Date.now() + 3600e3;
const agentId = (await A('/api/auth/me')).j.user.id; // the connection is Arron's own
const setAcct = (extra) => withTeam(tid, () => withAgent(agentId, () => setRaw(agentKey('google_account'), { access_token: 't', refresh_token: 'r', expires_at: far, email: 'ag@x.com', ...extra })));
const booking = (name, phone, iso, local) => ({ name, phone, created_by: 'Cal', scheduled_at: iso, scheduled_local: local, zoom_link: 'https://zoom.us/j/123456789' });
// 0) not connected: booking works, no warning
let r = await C('/api/contacts', 'POST', booking('NoCal', '90000000', '2026-10-15T05:00:00.000Z', '2026-10-15T13:00'));
chk('not connected: booking works silently', r.s === 201 && !r.j.deal.calendar_warning && !Object.keys(events).length, JSON.stringify(r.j).slice(0, 150));
// 1) read-only connection
await setAcct({ can_write: false });
r = await C('/api/contacts', 'POST', booking('ReadOnly', '90000001', '2026-10-16T05:00:00.000Z', '2026-10-16T13:00'));
chk('read-only: still booked, with a clear warning', r.s === 201 && r.j.deal.scheduled_at && /read-only/.test(r.j.deal.calendar_warning || ''), JSON.stringify(r.j.deal).slice(0, 200));
chk('read-only: nothing written to Google', !calls.some((c) => c.startsWith('POST')));
chk('agent status says it cannot write', (await A('/api/google/status')).j.can_write === false);
// 2) full connection
await setAcct({ can_write: true });
r = await C('/api/contacts', 'POST', booking('Christina', '91234567', '2026-10-22T05:00:00.000Z', '2026-10-22T13:00'));
const deal = r.j.deal; const ev = events[deal.google_event_id];
chk('booking creates a Google event', !!ev && !r.j.deal.calendar_warning, JSON.stringify(r.j.deal).slice(0, 200));
chk('event has the right title, start and zoom link', ev?.summary === 'Call with Christina' && ev.start.dateTime === '2026-10-22T05:00:00.000Z' && ev.description.includes('zoom.us/j/123456789') && ev.description.includes('91234567'), JSON.stringify(ev));
chk('event is 45 min long and has no attendees (client is not emailed)', ev && new Date(ev.end.dateTime) - new Date(ev.start.dateTime) === 45 * 60000 && !ev.attendees);
// reschedule
const id1 = deal.google_event_id;
r = await C(`/api/deals/${deal.id}/reschedule`, 'POST', { scheduled_at: '2026-10-23T07:00:00.000Z', scheduled_local: '2026-10-23T15:00', changed_by: 'Cal' });
chk('reschedule moves the SAME event', r.s === 200 && r.j.google_event_id === id1 && events[id1].start.dateTime === '2026-10-23T07:00:00.000Z' && Object.keys(events).length === 1, JSON.stringify(Object.keys(events)));
// someone deleted the event by hand in Google -> reschedule recreates it
delete events[id1];
r = await C(`/api/deals/${deal.id}/reschedule`, 'POST', { scheduled_at: '2026-10-24T07:00:00.000Z', scheduled_local: '2026-10-24T15:00', changed_by: 'Cal' });
chk('event deleted by hand in Google is recreated on reschedule', r.s === 200 && events[r.j.google_event_id]?.start.dateTime === '2026-10-24T07:00:00.000Z', JSON.stringify(r.j).slice(0, 150));
// calendar shows no duplicate for it, but still shows personal events
const cal = await C('/api/summary/month?month=2026-10'); const items = Array.isArray(cal.j) ? cal.j : [];
const titles = items.map((x) => x.title || x.contact?.name);
chk("Caller's calendar shows the meeting once and their other Google events", titles.filter((t) => /Christina|Call with Christina/.test(t)).length === 1 && titles.includes('Dentist'), JSON.stringify(titles));
const ag = await A('/api/summary/month?month=2026-10');
chk('Agent calendar never gets Google items', !(ag.j || []).some((x) => x.source === 'google'));
// google failure does not break booking
denyWrite = true;
r = await C('/api/contacts', 'POST', booking('Fail', '90000002', '2026-10-25T05:00:00.000Z', '2026-10-25T13:00'));
chk('Google refusing writes: still booked, with a warning', r.s === 201 && r.j.deal.scheduled_at && !!r.j.deal.calendar_warning, JSON.stringify(r.j.deal).slice(0, 200));
chk('...and the app now knows it cannot write', (await A('/api/google/status')).j.can_write === false);
denyWrite = false; await setAcct({ can_write: true });
// delete meeting
const eid = (await C(`/api/deals/${deal.id}`)).j.google_event_id || r.j.deal.google_event_id;
const before = Object.keys(events).length;
const cur = (await C(`/api/deals/${deal.id}`)).j; const curEv = cur.google_event_id;
r = await C(`/api/deals/${deal.id}/meeting`, 'DELETE', { changed_by: 'Cal' });
chk('deleting the meeting removes the Google event', r.s === 200 && !events[curEv] && Object.keys(events).length === before - 1, JSON.stringify(Object.keys(events)));
// lost outcome removes event; book another first
r = await C('/api/contacts', 'POST', booking('Myra', '93333333', '2026-10-26T07:00:00.000Z', '2026-10-26T15:00'));
const myra = r.j.deal; chk('Myra event created', !!events[myra.google_event_id]);
await A(`/api/deals/${myra.id}/outcome`, 'POST', { outcome: 'not_interested', made_by: 'Arron' }).catch(() => {});
const fu = await A(`/api/deals/${myra.id}/followup`, 'POST', { outcome: 'not_interested', changed_by: 'Arron' });
chk("Agent's 'Not interested' removes the event", !events[myra.google_event_id], JSON.stringify([fu.s, Object.keys(events)]));
// deleting a contact removes its event
r = await C('/api/contacts', 'POST', booking('Gone', '94444444', '2026-10-27T07:00:00.000Z', '2026-10-27T15:00'));
const gone = r.j.deal; chk('Gone event created', !!events[gone.google_event_id]);
await C(`/api/contacts/${r.j.contact.id}`, 'DELETE', { deleted_by: 'Cal' });
chk('deleting a contact removes the event', !events[gone.google_event_id]);
// held meeting kept as history, rebooking creates a new event
r = await C('/api/contacts', 'POST', booking('Again', '95555555', '2026-10-28T07:00:00.000Z', '2026-10-28T15:00'));
const ag1 = r.j.deal; const firstEv = ag1.google_event_id;
await withTeam(tid, async () => { const { update } = await import('./lib/db.js'); await update('deals', ag1.id, (d) => { d.scheduled_at = '2026-09-01T05:00:00.000Z'; }); });
r = await C(`/api/deals/${ag1.id}/schedule`, 'POST', { scheduled_at: '2026-10-30T05:00:00.000Z', scheduled_local: '2026-10-30T13:00', zoom_link: 'https://zoom.us/j/987654321', changed_by: 'Cal' });
chk('re-booking after a past meeting makes a NEW event and keeps the old one', r.s === 200 && r.j.google_event_id !== firstEv && !!events[firstEv] && !!events[r.j.google_event_id], JSON.stringify(r.j).slice(0, 200));
console.log(bad ? `${bad} FAILED` : 'ALL PASSED'); process.exit(bad ? 1 : 0);
