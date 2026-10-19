// RUN WITH THE NEW VERSION, on the data the previous version just wrote, using the SAME login cookies.
import fs from 'node:fs';
import { install, remote } from '/private/tmp/mig/fake.mjs';
process.env.PORT = '3831'; process.env.ZOOM_CLIENT_ID = 'cid'; process.env.ZOOM_CLIENT_SECRET = 'sec'; process.env.GOOGLE_CLIENT_ID = 'gid'; process.env.GOOGLE_CLIENT_SECRET = 'gsec';
install();
await import('./server.js');
const snap = JSON.parse(fs.readFileSync('/private/tmp/mig/snap.json', 'utf8'));
const B = 'http://localhost:3831';
const mk = (jar) => async (p, m = 'GET', b) => { const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); try { return { s: r.status, j: JSON.parse(t) }; } catch { return { s: r.status, j: t }; } };
const C = mk(snap.jars.caller), A = mk(snap.jars.agent);
let bad = 0; const chk = (n, c, d = '') => { console.log(c ? 'ok  ' : 'FAIL', n, c ? '' : String(d).slice(0, 400)); if (!c) bad++; };
// every value the previous version showed must still be there, unchanged (extra new fields are fine)
const diff = (a, b, path = '') => {
  if (a === null || typeof a !== 'object') return a === b ? null : `${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`;
  if (b === null || typeof b !== 'object') return `${path}: object -> ${JSON.stringify(b)}`;
  if (Array.isArray(a)) { if (!Array.isArray(b) || a.length !== b.length) return `${path}: array length ${a.length} -> ${b?.length}`; for (let i = 0; i < a.length; i++) { const d = diff(a[i], b[i], `${path}[${i}]`); if (d) return d; } return null; }
  for (const k of Object.keys(a)) { const d = diff(a[k], b[k], `${path}.${k}`); if (d) return d; }
  return null;
};
// 1. still logged in with the old cookies
const me = await C('/api/auth/me'); chk('the Caller is still logged in with their old session', me.s === 200 && me.j.user.role === 'caller', JSON.stringify(me));
chk('the Agent is still logged in with their old session', (await A('/api/auth/me')).j.user.role === 'agent');
// 2. everything each user saw before is unchanged
const skipCaller = new Set(['/api/zoom/status']); // reshaped for Callers (checked separately below)
for (const [who, cl] of [['caller', C], ['agent', A]]) for (const p of snap.calls[who]) {
  const r = await cl(p); const d = r.s === snap[who][p].s ? diff(snap[who][p].j, r.j) : `status ${snap[who][p].s} -> ${r.s}`;
  chk(`${who} ${p.replace(/\?month=.*/, '?month=…')} is unchanged`, d === null, d);
}
// 3. connections
const az = (await A('/api/zoom/status')).j, ag = (await A('/api/google/status')).j, cz = (await C('/api/zoom/status')).j;
chk("the Agent's Zoom is still connected, same email", az.connected && az.email === 'aaron@zoom.test' && az.configured, JSON.stringify(az));
chk("the Agent's Google is still connected with write access", ag.connected && ag.can_write && ag.email === 'aaron@gmail.test', JSON.stringify(ag));
chk('the Caller sees the Agent as connected (so no link needs pasting)', cz.agents.length === 1 && cz.agents[0].connected === true && cz.agents[0].email === 'aaron@zoom.test', JSON.stringify(cz));
// 4. things people do next, on the old data
const ids = snap.ids; const iso = (d, h = 5) => { const t = new Date(Date.now() + d * 86400e3); t.setUTCHours(h, 0, 0, 0); return { scheduled_at: t.toISOString(), scheduled_local: new Date(t.getTime() + 8 * 3600e3).toISOString().slice(0, 16) }; };
const rem0 = remote.load();
let r = await C(`/api/deals/${ids.christina}/reschedule`, 'POST', { ...iso(10, 6), changed_by: 'x' });
const christinaZoom = r.j.zoom_meeting_id; const rem1 = remote.load();
chk("Caller reschedules an OLD meeting: it moves on the real (old) Zoom connection, same link", r.s === 200 && rem1.zoom.meetings[christinaZoom].start_time === iso(10, 6).scheduled_at, JSON.stringify(r).slice(0, 250));
chk("...and its Google Calendar event follows", Object.values(rem1.google.events).some((e) => e.start.dateTime === iso(10, 6).scheduled_at) || Object.keys(rem0.google.events).length === 0, JSON.stringify(rem1.google.events).slice(0, 200));
r = await C('/api/contacts', 'POST', { name: 'Brand New', phone: '91119999', created_by: 'x', ...iso(11, 5) });
chk('Caller books a new contact with a meeting: no Agent to choose, Zoom created automatically on the old connection', r.s === 201 && r.j.deal.zoom_meeting_id >= 500 && !r.j.meeting_error && !!r.j.deal.agent_id, JSON.stringify(r.j).slice(0, 300));
const newDeal = r.j.deal.id;
chk("...and the Agent sees it", (await A('/api/meetings?when=all')).j.some((m) => m.contact?.name === 'Brand New'));
// the Agent's own actions on old deals
r = await A(`/api/deals/${ids.christina}/request-reschedule`, 'POST', { remark: 'client busy', requested_by: 'x' }); chk('Agent flags a reschedule on an old meeting', r.s === 200, JSON.stringify(r));
r = await A(`/api/deals/${ids.christina}/request-reschedule`, 'DELETE'); chk('...and withdraws it', r.s === 200);
r = await A(`/api/deals/${ids.myra}/followup`, 'POST', { outcome: 'not_interested', changed_by: 'x' }); chk('Agent logs an outcome on an old meeting', r.s === 200 && r.j.stage === 'lost', JSON.stringify(r));
chk("...which cancels it in their Zoom", !remote.load().zoom.meetings[(await A(`/api/deals/${ids.myra}`)).j.zoom_meeting_id]);
r = await A('/api/attendance', 'POST', { kind: 'deal', deal_id: ids.past, status: 'not_attended' }); chk("Agent changes an old interview's attendance", r.s === 200);
const an = (await A(`/api/analytics?month=${snap.calls.agent.find((p) => p.startsWith('/api/analytics')).split('=')[1]}`)).j;
chk('analytics still work and count the old data', an.fixed >= 3 && typeof an.attended === 'number', JSON.stringify(an).slice(0, 200));
// Zoom-only meetings keep working (Caller moves one, Agent sees the notice)
r = await C('/api/zoom-meetings/9002/reschedule', 'POST', { ...iso(12, 3), changed_by: 'x', topic: 'Zoom-only later' });
chk('Caller moves a Zoom-only meeting (no Agent to name)', r.s === 200 && remote.load().zoom.meetings[9002].start_time === iso(12, 3).scheduled_at, JSON.stringify(r));
chk('...and the Agent is told', (await A('/api/notifications')).j.some((n) => /Zoom-only later/.test(n.message)));
// undo deleted contact
const del = (await C('/api/contacts/deleted')).j[0]; r = await C(`/api/contacts/${del.id}/restore`, 'POST'); chk('Caller restores the contact deleted before the update', r.s === 200);
// logging in afresh with the old passwords
const fresh = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'arron@x.com', password: 'passw0rd!x' }) });
chk('a fresh login with the old password works', fresh.status === 200);
// a team of one Caller + one Agent stays that size
const meNow = (await C('/api/auth/me')).j; chk('the team is still 1 Caller + 1 Agent, and full', meNow.team.seats.caller === 1 && meNow.team.seats.agent === 1 && meNow.invite.open.caller === 0 && meNow.invite.open.agent === 0, JSON.stringify(meNow.team));
console.log(bad ? `${bad} FAILED` : 'ALL PASSED'); process.exit(bad ? 1 : 0);
