// RUN WITH THE PREVIOUS VERSION OF THE APP: builds a realistic team and records what each user sees.
import fs from 'node:fs';
import { install, remote } from '/private/tmp/mig/fake.mjs';
process.env.PORT = '3830'; process.env.ZOOM_CLIENT_ID = 'cid'; process.env.ZOOM_CLIENT_SECRET = 'sec'; process.env.GOOGLE_CLIENT_ID = 'gid'; process.env.GOOGLE_CLIENT_SECRET = 'gsec';
fs.rmSync('/private/tmp/mig/remote.json', { force: true });
for (const f of fs.readdirSync('/private/tmp/mig/data')) fs.rmSync('/private/tmp/mig/data/' + f);
install();
await import('./server.js');
const { withTeam } = await import('./lib/context.js'); const { setRaw, teamKey, update } = await import('./lib/db.js');
const B = 'http://localhost:3830';
const mk = () => { const jar = {}; const f = async (p, m = 'GET', b) => { const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') }, body: b ? JSON.stringify(b) : undefined }); for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); const v = kv.slice(i + 1); v ? (jar[kv.slice(0, i)] = v) : delete jar[kv.slice(0, i)]; } const t = await r.text(); try { return { s: r.status, j: JSON.parse(t) }; } catch { return { s: r.status, j: t }; } }; f.jar = jar; return f; };
const C = mk(), A = mk(); const pw = 'passw0rd!x';
const s = await C('/api/auth/signup', 'POST', { mode: 'create', name: 'Caller Cal', email: 'cal@x.com', password: pw, role: 'caller', team_name: 'Prod Team' });
await A('/api/auth/signup', 'POST', { mode: 'join', name: 'Arron Yeap', email: 'arron@x.com', password: pw, role: 'agent', invite_code: s.j.invite.code });
const tid = s.j.team.id; const far = Date.now() + 3600e3;
// the connections exactly as the previous version stores them: under the team
await withTeam(tid, async () => {
  await setRaw(teamKey('zoom_account'), { access_token: 'legacy-zoom-token', refresh_token: 'r', expires_at: far, email: 'aaron@zoom.test', connected_at: new Date().toISOString(), app: '1' });
  await setRaw(teamKey('google_account'), { access_token: 'legacy-google-token', refresh_token: 'r', expires_at: far, email: 'aaron@gmail.test', connected_at: new Date().toISOString(), can_write: true });
});
const st = remote.load(); st.google.personal.push({ id: 'p1', summary: 'Dentist', start: { dateTime: new Date(Date.now() + 5 * 86400e3).toISOString() }, end: { dateTime: new Date(Date.now() + 5 * 86400e3 + 3600e3).toISOString() } });
st.zoom.meetings[9001] = { id: 9001, topic: 'Zoom-only interview', start_time: new Date(Date.now() + 6 * 86400e3).toISOString(), duration: 60, join_url: 'https://zoom.us/j/9001' };
st.zoom.meetings[9002] = { id: 9002, topic: 'Zoom-only later', start_time: new Date(Date.now() + 9 * 86400e3).toISOString(), duration: 60, join_url: 'https://zoom.us/j/9002' }; remote.save(st);
const at = (d, h = 5) => { const t = new Date(Date.now() + d * 86400e3); t.setUTCHours(h, 0, 0, 0); return { scheduled_at: t.toISOString(), scheduled_local: new Date(t.getTime() + 8 * 3600e3).toISOString().slice(0, 16) }; };
const contact = (name, phone, w) => C('/api/contacts', 'POST', { name, phone, created_by: 'x', ...(w || {}) });
const christina = (await contact('Christina Tan', '91110001', at(3, 5))).j; const myra = (await contact('Myra Keh', '91110002', at(4, 7))).j;
const past = (await contact('Past Client', '91110003', at(2, 4))).j; const unbooked = (await contact('Not Booked Yet', '91110004')).j;
const gone = (await contact('Deleted Guy', '91110005', at(8, 3))).j;
await withTeam(tid, () => update('deals', past.deal.id, (d) => { d.scheduled_at = new Date(Date.now() - 3 * 86400e3).toISOString(); }));
await A(`/api/deals/${past.deal.id}/followup`, 'POST', { outcome: 'follow_up', note: 'keen', changed_by: 'x' });
await A('/api/attendance', 'POST', { kind: 'deal', deal_id: past.deal.id, status: 'attended' });
await A(`/api/deals/${myra.deal.id}/request-reschedule`, 'POST', { remark: 'client travelling', requested_by: 'x' });
await A('/api/zoom-meetings/9001/request-reschedule', 'POST', { remark: 'conflict', requested_by: 'x', topic: 'Zoom-only interview', scheduled_at: st.zoom.meetings[9001].start_time });
await C(`/api/contacts/${gone.contact.id}`, 'DELETE', { deleted_by: 'x' });
await A('/api/notifications/read-all', 'POST'); // some read, some not
await C(`/api/deals/${christina.deal.id}/note`, 'POST', { note: 'prefers WhatsApp', changed_by: 'x' });
// what each user sees right now
const month = (d) => { const t = new Date(Date.now() + d * 30 * 86400e3); return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`; };
const calls = {
  caller: ['/api/meetings?when=all', '/api/meetings?when=upcoming', '/api/contacts', '/api/contacts/deleted', '/api/deals', '/api/summary/reschedule-requests', `/api/summary/month?month=${month(0)}`, `/api/summary/month?month=${month(1)}`, '/api/notifications', '/api/notifications/unread-count', `/api/deals/${christina.deal.id}`],
  agent: ['/api/meetings?when=all', '/api/meetings?when=past', '/api/contacts', '/api/contacts/deleted', '/api/deals', `/api/summary/month?month=${month(0)}`, '/api/notifications', '/api/notifications/unread-count', `/api/analytics?month=${month(0)}`, `/api/analytics?month=${month(-1)}`, `/api/deals/${past.deal.id}`, '/api/deals/next'],
};
const snap = { ids: { christina: christina.deal.id, myra: myra.deal.id, past: past.deal.id, unbooked: unbooked.deal.id }, calls, caller: {}, agent: {} };
for (const [who, cl] of [['caller', C], ['agent', A]]) for (const p of calls[who]) { const r = await cl(p); snap[who][p] = { s: r.s, j: r.j }; }
snap.jars = { caller: C.jar, agent: A.jar };
snap.statuses = { agentZoom: (await A('/api/zoom/status')).j, agentGoogle: (await A('/api/google/status')).j, callerZoom: (await C('/api/zoom/status')).j };
fs.writeFileSync('/private/tmp/mig/snap.json', JSON.stringify(snap, null, 1));
console.log('phase 1 done: previous version built the data;', Object.values(snap.caller).filter((x) => x.s !== 200).length + Object.values(snap.agent).filter((x) => x.s !== 200).length, 'non-200 responses in snapshot');
console.log('meetings the Caller sees:', snap.caller['/api/meetings?when=all'].j.map((m) => m.contact?.name || m.title).join(', '));
process.exit(0);
