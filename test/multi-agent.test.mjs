// Manual: run from a COPY of the project with an empty data/ dir (it signs people up and books meetings):
//   cp -r schedule-hub /tmp/x && cd /tmp/x && rm -rf data && mkdir data && cp test/multi-agent.test.mjs t.mjs && node t.mjs
// One team with 2 Callers and 3 Agent seats, each Agent with their own fake Zoom account and Google Calendar.
process.env.PORT = '3820'; process.env.ZOOM_CLIENT_ID = 'cid'; process.env.ZOOM_CLIENT_SECRET = 'sec';
process.env.GOOGLE_CLIENT_ID = 'gid'; process.env.GOOGLE_CLIENT_SECRET = 'gsec';
const zoomAcct = {}; // token -> { meetings }
const gcalAcct = {}; // token -> { events }
let nextZoom = 7000, nextEv = 1;
const real = globalThis.fetch;
globalThis.fetch = async (url, o = {}) => {
  const u = String(url); const j = (b, s = 200) => new Response(b == null ? null : JSON.stringify(b), { status: s });
  const tok = (o.headers?.Authorization || '').replace('Bearer ', '');
  if (u.startsWith('https://api.zoom.us/v2')) {
    const path = u.replace('https://api.zoom.us/v2', ''); const acct = zoomAcct[tok];
    if (!acct) return j({ message: 'bad token' }, 401);
    if (path === '/users/me/meetings' && o.method === 'POST') { const b = JSON.parse(o.body); const id = nextZoom++; const st = new Date(b.start_time + '+08:00').toISOString(); acct.meetings[id] = { id, topic: b.topic, start_time: st, duration: 45, join_url: `https://zoom.us/j/${id}` }; return j({ id, join_url: `https://zoom.us/j/${id}`, start_url: 's', start_time: st }); }
    if (path.startsWith('/users/me/meetings')) return j({ meetings: Object.values(acct.meetings) });
    if (path === '/users/me') return j({ email: tok + '@zoom.test' });
    const m = path.match(/^\/meetings\/(\d+)$/);
    if (m) { const id = Number(m[1]); if (!acct.meetings[id]) return j({ message: 'not found' }, 404);
      if (o.method === 'DELETE') { delete acct.meetings[id]; return j(null, 204); }
      if (o.method === 'PATCH') { acct.meetings[id].start_time = new Date(JSON.parse(o.body).start_time + '+08:00').toISOString(); return j(null, 204); }
      return j(acct.meetings[id]); }
    return j({}, 404);
  }
  if (u.startsWith('https://www.googleapis.com/calendar/v3/calendars/primary/events')) {
    const acct = gcalAcct[tok]; if (!acct) return j({}, 401);
    const m = o.method || 'GET'; const id = u.split('/events/')[1]?.split('?')[0];
    if (m === 'POST') { const e = { id: 'ev' + nextEv++, ...JSON.parse(o.body) }; acct.events[e.id] = e; return j(e); }
    if (m === 'PATCH') { if (!acct.events[id]) return j({}, 404); acct.events[id] = { ...acct.events[id], ...JSON.parse(o.body) }; return j(acct.events[id]); }
    if (m === 'DELETE') { if (!acct.events[id]) return j({}, 404); delete acct.events[id]; return j(null, 204); }
    return j({ items: Object.values(acct.events).map((e) => ({ id: e.id, summary: e.summary, start: e.start, end: e.end })).concat(acct.personal || []) });
  }
  return real(url, o);
};
await import('./server.js');
const { withTeam, withAgent } = await import('./lib/context.js'); const { setRaw, getRaw, agentKey, all, update } = await import('./lib/db.js');
const B = 'http://localhost:3820';
const mk = () => { const jar = {}; return async (p, m = 'GET', b) => { const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') }, body: b ? JSON.stringify(b) : undefined }); for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); const v = kv.slice(i + 1); v ? (jar[kv.slice(0, i)] = v) : delete jar[kv.slice(0, i)]; } const t = await r.text(); try { return { s: r.status, j: JSON.parse(t) }; } catch { return { s: r.status, j: t }; } }; };
let bad = 0; const chk = (n, c, d = '') => { console.log(c ? 'ok  ' : 'FAIL', n, c ? '' : d); if (!c) bad++; };
const pw = 'passw0rd!x'; const C1 = mk(), C2 = mk(), A = mk(), Bq = mk(), Cc = mk(), X = mk();

// ---- creating a team with its own size ----
let r = await X('/api/auth/signup', 'POST', { mode: 'create', name: 'Bad', email: 'bad@x.com', password: pw, role: 'caller', team_name: 'Bad', callers: 9, agents: 1 });
chk('too many callers refused', r.s === 400, JSON.stringify(r));
r = await X('/api/auth/signup', 'POST', { mode: 'create', name: 'Bad', email: 'bad@x.com', password: pw, role: 'caller', team_name: 'Bad', callers: 1, agents: 0 });
chk('zero agents refused', r.s === 400);
const s1 = await C1('/api/auth/signup', 'POST', { mode: 'create', name: 'Cal One', email: 'c1@x.com', password: pw, role: 'caller', team_name: 'Big', callers: 2, agents: 3 });
chk('team created with 2 callers + 3 agents', s1.s === 201 && s1.j.team.seats.caller === 2 && s1.j.team.seats.agent === 3, JSON.stringify(s1.j.team));
chk('open seats reported', s1.j.invite.open.caller === 1 && s1.j.invite.open.agent === 3, JSON.stringify(s1.j.invite));
const code = s1.j.invite.code; const tid = s1.j.team.id;
const join = (cl, name, email, role) => cl('/api/auth/signup', 'POST', { mode: 'join', name, email, password: pw, role, invite_code: code });
chk('caller 2 joins', (await join(C2, 'Cal Two', 'c2@x.com', 'caller')).s === 201);
const third = await join(mk(), 'Cal Three', 'c3@x.com', 'caller'); chk('third caller refused with a clear message', third.s === 400 && /Callers seats are all taken/.test(third.j.error), JSON.stringify(third));
const ja = await join(A, 'Agent Alpha', 'a@x.com', 'agent'); const jb = await join(Bq, 'Agent Bravo', 'b@x.com', 'agent'); const jc = await join(Cc, 'Agent Charlie', 'cc@x.com', 'agent');
chk('three agents join', ja.s === 201 && jb.s === 201 && jc.s === 201, JSON.stringify([ja.s, jb.s, jc.s]));
const fourth = await join(mk(), 'Agent Delta', 'd@x.com', 'agent'); chk('a fourth agent is refused', fourth.s === 400 && /Agents seats are all taken/.test(fourth.j.error), JSON.stringify(fourth));
const me = async (cl) => (await cl('/api/auth/me')).j; const idA = (await me(A)).user.id, idB = (await me(Bq)).user.id, idC = (await me(Cc)).user.id;
chk('members list shows everyone with ids', (await me(C1)).members.length === 5);
// resizing
r = await C1('/api/team/seats', 'PUT', { callers: 1, agents: 3 }); chk("can't shrink below who is already in", r.s === 400, JSON.stringify(r));
r = await C1('/api/team/seats', 'PUT', { callers: 2, agents: 4 }); chk('can grow the team', r.s === 200 && r.j.team.seats.agent === 4);
chk('agents cannot resize the team', (await A('/api/team/seats', 'PUT', { callers: 2, agents: 5 })).s === 403);
await C1('/api/team/seats', 'PUT', { callers: 2, agents: 3 });

// ---- every Agent has their own Zoom and Google ----
const far = Date.now() + 3600e3;
const connect = (id, token) => { zoomAcct[token] = { meetings: {} }; gcalAcct[token] = { events: {}, personal: [] }; return withTeam(tid, async () => { await withAgent(id, () => setRaw(agentKey('zoom_account'), { access_token: token, refresh_token: 'r', expires_at: far, email: token + '@zoom.test', app: '1' })); await withAgent(id, () => setRaw(agentKey('google_account'), { access_token: token, refresh_token: 'r', expires_at: far, email: token + '@g.test', can_write: true })); }); };
await connect(idA, 'tokA'); await connect(idB, 'tokB'); // Charlie never connects
gcalAcct.tokA.personal.push({ id: 'pA', summary: 'A dentist', start: { dateTime: '2026-11-10T09:00:00+08:00' }, end: { dateTime: '2026-11-10T10:00:00+08:00' } });
gcalAcct.tokB.personal.push({ id: 'pB', summary: 'B gym', start: { dateTime: '2026-11-10T18:00:00+08:00' }, end: { dateTime: '2026-11-10T19:00:00+08:00' } });
const zs = (await C1('/api/zoom/status')).j;
chk('caller sees each agent Zoom status', zs.agents.length === 3 && zs.agents.find((x) => x.id === idA).connected && !zs.agents.find((x) => x.id === idC).connected, JSON.stringify(zs));
chk('agent sees only their own status', (await A('/api/zoom/status')).j.email === 'tokA@zoom.test' && (await Bq('/api/zoom/status')).j.email === 'tokB@zoom.test');

// ---- booking with a chosen agent ----
const contact = (name, phone, iso, extra = {}) => ({ name, phone, created_by: 'x', scheduled_at: iso, scheduled_local: new Date(new Date(iso).getTime() + 8 * 3600e3).toISOString().slice(0, 16), ...extra });
const future = (d, h = 6) => new Date(Date.UTC(2026, 10, d, h)).toISOString(); // Nov 2026 (after "today")
r = await C1('/api/contacts', 'POST', contact('NoChoice', '91000000', future(12)));
chk('several agents and no choice is refused, nothing saved', r.s === 400 && /Choose which Agent/.test(r.j.error) && (await C1('/api/contacts')).j.length === 0, JSON.stringify(r));
r = await C1('/api/contacts', 'POST', contact('Client A', '91000001', future(12), { agent_id: idA }));
const dealA = r.j.deal; chk('booked with Agent Alpha', r.s === 201 && dealA.agent_id === idA && !r.j.meeting_error, JSON.stringify(r.j).slice(0, 250));
r = await C2('/api/contacts', 'POST', contact('Client B', '91000002', future(13), { agent_id: idB }));
const dealB = r.j.deal; chk('booked (by the other caller) with Agent Bravo', r.s === 201 && dealB.agent_id === idB && !r.j.meeting_error, JSON.stringify(r.j).slice(0, 250));
chk("A's Zoom meeting was created on A's account only", !!zoomAcct.tokA.meetings[dealA.zoom_meeting_id] && !zoomAcct.tokB.meetings[dealA.zoom_meeting_id]);
chk("B's Zoom meeting was created on B's account only", !!zoomAcct.tokB.meetings[dealB.zoom_meeting_id] && !zoomAcct.tokA.meetings[dealB.zoom_meeting_id]);
chk("each got a Google Calendar event on their own calendar", Object.values(gcalAcct.tokA.events).some((e) => e.summary === 'Call with Client A') && Object.values(gcalAcct.tokB.events).some((e) => e.summary === 'Call with Client B') && !Object.values(gcalAcct.tokA.events).some((e) => e.summary === 'Call with Client B'));
r = await C1('/api/contacts', 'POST', contact('Client C', '91000003', future(14), { agent_id: idC }));
chk("Charlie hasn't connected Zoom: clear error, contact kept", r.s === 201 && /Charlie has not connected Zoom/.test(r.j.meeting_error || ''), JSON.stringify(r.j).slice(0, 250));
const dealC0 = r.j.deal;
r = await C1(`/api/deals/${dealC0.id}/schedule`, 'POST', { scheduled_at: future(14), scheduled_local: new Date(new Date(future(14)).getTime() + 8 * 3600e3).toISOString().slice(0, 16), agent_id: idC, zoom_link: 'https://zoom.us/j/55555555' });
chk('...a pasted link works for an agent without Zoom', r.s === 200 && r.j.agent_id === idC, JSON.stringify(r).slice(0, 200));
chk('a made-up agent id is refused', (await C1('/api/contacts', 'POST', contact('Nope', '91000009', future(15), { agent_id: 99999 }))).s === 400);

// ---- agents see only their own ----
const mt = async (cl) => (await cl('/api/meetings?when=all')).j.map((m) => m.contact?.name || m.title);
let aSees = await mt(A), bSees = await mt(Bq), cSees = await mt(Cc);
chk('Agent Alpha sees only their own meeting', aSees.length === 1 && aSees[0] === 'Client A', JSON.stringify(aSees));
chk('Agent Bravo sees only theirs', bSees.length === 1 && bSees[0] === 'Client B', JSON.stringify(bSees));
chk('Agent Charlie sees only theirs', cSees.length === 1 && cSees[0] === 'Client C', JSON.stringify(cSees));
const cMeet = (await C1('/api/meetings?when=all')).j;
chk('a caller sees all three, each labelled with its agent', cMeet.length === 3 && cMeet.find((m) => m.contact.name === 'Client B').agent_name === 'Agent Bravo', JSON.stringify(cMeet.map((m) => [m.contact?.name, m.agent_name])));
chk("narrowing a caller's view to Alpha shows just Alpha's", (await C1(`/api/meetings?when=all&agents=${idA}`)).j.length === 1);
chk("narrowing to Alpha + Bravo shows two", (await C1(`/api/meetings?when=all&agents=${idA},${idB}`)).j.length === 2);
chk("narrowing to nobody shows none", (await C1('/api/meetings?when=all&agents=')).j.length === 0);
chk('Alpha cannot open Bravo\'s deal', (await A(`/api/deals/${dealB.id}`)).s === 404);
chk('...or reschedule-request it', (await A(`/api/deals/${dealB.id}/request-reschedule`, 'POST', { remark: 'x' })).s === 404);
chk('...or mark its attendance', (await A('/api/attendance', 'POST', { kind: 'deal', deal_id: dealB.id, status: 'attended' })).s === 404);
chk('contacts: Alpha sees only Client A', (await A('/api/contacts')).j.map((c) => c.name).join() === 'Client A', JSON.stringify((await A('/api/contacts')).j.map((c) => c.name)));
chk("...and can't open Bravo's contact", (await A(`/api/contacts/${dealB.contact_id}`)).s === 404);
chk('a caller sees every contact', (await C1('/api/contacts')).j.length === 3);

// ---- notifications go to the right agent ----
const notes = async (cl) => (await cl('/api/notifications')).j.map((n) => n.message);
const nA = await notes(A), nB = await notes(Bq);
chk("Alpha's notifications mention only Client A", nA.length >= 1 && nA.every((m) => !/Client B|Client C/.test(m)) && nA.some((m) => /Client A/.test(m)), JSON.stringify(nA));
chk("Bravo's mention only Client B", nB.length >= 1 && nB.every((m) => !/Client A|Client C/.test(m)), JSON.stringify(nB));
chk('unread counts are per agent', (await A('/api/notifications/unread-count')).j.count === nA.length && (await Bq('/api/notifications/unread-count')).j.count === nB.length);
const aNotes = (await A('/api/notifications')).j; const bNote = (await Bq('/api/notifications')).j[0];
chk("Alpha can't touch Bravo's notification", (await A(`/api/notifications/${bNote.id}/read`, 'POST')).s === 404);

// ---- rescheduling moves the meeting on the right Zoom ----
r = await C1(`/api/deals/${dealB.id}/reschedule`, 'POST', { scheduled_at: future(20, 7), scheduled_local: new Date(new Date(future(20, 7)).getTime() + 8 * 3600e3).toISOString().slice(0, 16), changed_by: 'x' });
chk("reschedule moves Bravo's Zoom meeting", r.s === 200 && zoomAcct.tokB.meetings[dealB.zoom_meeting_id].start_time === future(20, 7), JSON.stringify(r).slice(0, 200));
chk("...and Alpha's is untouched", zoomAcct.tokA.meetings[dealA.zoom_meeting_id].start_time === future(12));
chk("...and Bravo's calendar event moved", Object.values(gcalAcct.tokB.events).some((e) => e.start.dateTime === future(20, 7)));

// ---- the caller's calendar: any mix of agents, Zoom + Google ----
const month = async (cl, agents) => (await cl(`/api/summary/month?month=2026-11${agents === undefined ? '' : '&agents=' + agents}`)).j;
let all3 = await month(C1);
const gNames = (items) => items.filter((m) => m.source === 'google').map((m) => m.title).sort();
chk('both agents Google calendars show together by default', JSON.stringify(gNames(all3)) === JSON.stringify(['A dentist', 'B gym']), JSON.stringify(gNames(all3)));
chk("...with the agent named on each", all3.find((m) => m.title === 'A dentist').agent_name === 'Agent Alpha' && all3.find((m) => m.title === 'B gym').agent_name === 'Agent Bravo');
chk('only Alpha selected: only Alpha Google + meetings', JSON.stringify(gNames(await month(C1, idA))) === JSON.stringify(['A dentist']) && (await month(C1, idA)).filter((m) => m.contact?.name === 'Client B').length === 0);
chk('only Bravo selected', JSON.stringify(gNames(await month(C1, idB))) === JSON.stringify(['B gym']));
chk("the app's own calendar events are not shown twice", !all3.some((m) => m.source === 'google' && /Call with/.test(m.title)));
chk("an agent's calendar never includes Google, or other agents", (await month(A)).every((m) => m.source !== 'google') && (await month(A)).every((m) => m.contact?.name !== 'Client B'));

// ---- meetings booked straight in each agent's Zoom ----
zoomAcct.tokA.meetings[9001] = { id: 9001, topic: 'A interview', start_time: future(16, 3), duration: 60, join_url: 'https://zoom.us/j/9001' };
zoomAcct.tokB.meetings[9002] = { id: 9002, topic: 'B interview', start_time: future(17, 3), duration: 60, join_url: 'https://zoom.us/j/9002' };
const zoomOnly = (rows) => rows.filter((m) => m.source === 'zoom').map((m) => `${m.title}:${m.agent_name}`).sort();
chk("Alpha sees only their own Zoom interview", JSON.stringify(zoomOnly((await A('/api/meetings?when=all')).j)) === JSON.stringify(['A interview:Agent Alpha']));
chk("a caller sees both, named", JSON.stringify(zoomOnly((await C1('/api/meetings?when=all')).j)) === JSON.stringify(['A interview:Agent Alpha', 'B interview:Agent Bravo']));
r = await C1('/api/zoom-meetings/9002/reschedule', 'POST', { scheduled_at: future(18, 3), scheduled_local: new Date(new Date(future(18, 3)).getTime() + 8 * 3600e3).toISOString().slice(0, 16), changed_by: 'x', topic: 'B interview' });
chk("caller moves a Zoom-only meeting: found on Bravo's account (no agent given)", r.s === 200 && zoomAcct.tokB.meetings[9002].start_time === future(18, 3), JSON.stringify(r));
chk('...and nothing else moved', zoomAcct.tokA.meetings[9001].start_time === future(16, 3));
chk("...and only Bravo is told", (await Bq('/api/notifications')).j.some((n) => /B interview/.test(n.message)) && !(await A('/api/notifications')).j.some((n) => /B interview/.test(n.message)));
chk("Alpha cannot attend-mark Bravo's Zoom meeting", (await A('/api/attendance', 'POST', { kind: 'zoom', zoom_id: '9002', status: 'attended' })).s === 404);
r = await C1('/api/zoom-meetings/9001', 'DELETE', { deleted_by: 'x', topic: 'A interview', agent_id: idB });
chk("caller can't make Bravo's Zoom delete Alpha's meeting", r.s === 502 && !!zoomAcct.tokA.meetings[9001], JSON.stringify(r));
r = await C1('/api/zoom-meetings/9001', 'DELETE', { deleted_by: 'x', topic: 'A interview', agent_id: idA });
chk("deleting with the right agent works", r.s === 200 && !zoomAcct.tokA.meetings[9001]);

// ---- analytics: each agent's own ----
for (const [deal, who] of [[dealA, A], [dealB, Bq]]) await withTeam(tid, () => update('deals', deal.id, (d) => { d.scheduled_at = '2026-10-10T05:00:00.000Z'; d.stat_ref = d.stat_ref; }));
await A('/api/attendance', 'POST', { kind: 'deal', deal_id: dealA.id, status: 'attended' });
await Bq('/api/attendance', 'POST', { kind: 'deal', deal_id: dealB.id, status: 'not_attended' });
const an = async (cl) => (await cl('/api/analytics?month=2026-10')).j;
const aa = await an(A), ab = await an(Bq), ac = await an(Cc);
chk("Alpha's analytics count Alpha's interview as attended", aa.attended === 1 && aa.fixed >= 1, JSON.stringify([aa.fixed, aa.attended]));
chk("Bravo's don't include Alpha's attended", ab.attended === 0, JSON.stringify([ab.fixed, ab.attended]));
chk("Charlie's counts nothing of theirs", ac.attended === 0 && ac.fixed <= 1, JSON.stringify([ac.fixed, ac.attended]));
chk('callers have no analytics', (await C1('/api/analytics')).s === 403);

// ---- changing the agent on a deal: Zoom + calendar move with it ----
r = await C1('/api/contacts', 'POST', contact('Mover', '91000010', future(22), { agent_id: idA }));
const mover = r.j.deal; const zOld = mover.zoom_meeting_id;
await C1(`/api/deals/${mover.id}/meeting`, 'DELETE', { changed_by: 'x' });
chk("deleting removes it from Alpha's Zoom", !zoomAcct.tokA.meetings[zOld]);
r = await C1(`/api/deals/${mover.id}/schedule`, 'POST', { scheduled_at: future(22), scheduled_local: new Date(new Date(future(22)).getTime() + 8 * 3600e3).toISOString().slice(0, 16), agent_id: idB });
chk("rebooking with Bravo creates the meeting on Bravo's Zoom", r.s === 200 && r.j.agent_id === idB && !!zoomAcct.tokB.meetings[r.j.zoom_meeting_id], JSON.stringify(r).slice(0, 200));
chk("...and Alpha no longer has it", !Object.values(zoomAcct.tokA.meetings).some((m) => m.topic === 'Call with Mover'));
chk("...and Alpha's agent view no longer lists it", !(await mt(A)).includes('Mover') && (await mt(Bq)).includes('Mover'));

// ---- leaving takes the agent's connections with them ----
r = await Cc('/api/auth/leave', 'POST'); chk('agent leaves', r.s === 200);
chk("a seat opens", (await me(C1)).invite.open.agent === 1);
const gone = await withTeam(tid, () => withAgent(idC, () => getRaw(agentKey('zoom_account'))));
chk("Charlie's Zoom connection record is gone", gone === null);
const rejoin = await join(mk(), 'Agent Echo', 'e@x.com', 'agent'); chk('the freed seat can be taken', rejoin.s === 201);
console.log(bad ? `${bad} FAILED` : 'ALL PASSED'); process.exit(bad ? 1 : 0);
