// Manual (run from a COPY with an empty data/ dir): a team made before teams could have several Agents —
// one Caller, one Agent, no seats field, no agent_id on deals, Zoom/Google/own-app records stored under the team —
// must keep working untouched, with everything belonging to the one Agent.
process.env.PORT = '3821'; process.env.ZOOM_CLIENT_ID = 'cid'; process.env.ZOOM_CLIENT_SECRET = 'sec'; process.env.GOOGLE_CLIENT_ID = 'g'; process.env.GOOGLE_CLIENT_SECRET = 'gs';
const zoomMeetings = {}; let nz = 100; const real = globalThis.fetch;
globalThis.fetch = async (url, o = {}) => { const u = String(url); const j = (b, s = 200) => new Response(b == null ? null : JSON.stringify(b), { status: s });
  if (u.startsWith('https://api.zoom.us/v2')) { const path = u.replace('https://api.zoom.us/v2', '');
    if (path === '/users/me/meetings' && o.method === 'POST') { const b = JSON.parse(o.body); const id = nz++; const st = new Date(b.start_time + '+08:00').toISOString(); zoomMeetings[id] = { id, topic: b.topic, start_time: st, duration: 45, join_url: 'https://zoom.us/j/' + id }; return j({ id, join_url: 'https://zoom.us/j/' + id, start_time: st }); }
    if (path.startsWith('/users/me/meetings')) return j({ meetings: Object.values(zoomMeetings) }); if (path === '/users/me') return j({ email: 'old@zoom.test' }); return j({}); }
  return real(url, o); };
await import('./server.js');
const { withTeam, withAgent } = await import('./lib/context.js'); const { setRaw, getRaw, teamKey, agentKey, update: upd, all } = await import('./lib/db.js');
const B = 'http://localhost:3821';
const mk = () => { const jar = {}; return async (p, m = 'GET', b) => { const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') }, body: b ? JSON.stringify(b) : undefined }); for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); const v = kv.slice(i + 1); v ? (jar[kv.slice(0, i)] = v) : delete jar[kv.slice(0, i)]; } const t = await r.text(); try { return { s: r.status, j: JSON.parse(t) }; } catch { return { s: r.status, j: t }; } }; };
let bad = 0; const chk = (n, c, d = '') => { console.log(c ? 'ok  ' : 'FAIL', n, c ? '' : d); if (!c) bad++; };
const pw = 'passw0rd!x'; const C = mk(), A = mk();
const s = await C('/api/auth/signup', 'POST', { mode: 'create', name: 'Cal', email: 'c@x.com', password: pw, role: 'caller', team_name: 'Old' });
await A('/api/auth/signup', 'POST', { mode: 'join', name: 'Arron', email: 'a@x.com', password: pw, role: 'agent', invite_code: s.j.invite.code });
const tid = s.j.team.id; const aid = (await A('/api/auth/me')).j.user.id;
// make it look like a pre-seats team
await upd('teams', tid, (t) => { delete t.seats; });
chk('team without a seats field counts as 1 caller + 1 agent', (await C('/api/auth/me')).j.team.seats.caller === 1 && (await C('/api/auth/me')).j.team.seats.agent === 1);
chk('...and is full', (await mk()('/api/auth/signup', 'POST', { mode: 'join', name: 'X', email: 'x@x.com', password: pw, role: 'agent', invite_code: s.j.invite.code })).s === 400);
// legacy records under the team key
const far = Date.now() + 3600e3;
await withTeam(tid, () => setRaw(teamKey('zoom_account'), { access_token: 'oldtok', refresh_token: 'r', expires_at: far, email: 'old@zoom.test', app: '1' }));
let zs = (await A('/api/zoom/status')).j;
chk("the Agent's pre-existing Zoom connection is still connected", zs.connected && zs.email === 'old@zoom.test', JSON.stringify(zs));
const czs = (await C('/api/zoom/status')).j; chk('a Caller sees it as the one Agent connected (no pasted link needed)', czs.connected === true && czs.agents.length === 1, JSON.stringify(czs));
// booking with no agent chosen -> the only agent, Zoom created automatically
const w = new Date(Date.UTC(2026, 10, 12, 5)).toISOString();
let r = await C('/api/contacts', 'POST', { name: 'Old Client', phone: '90001111', created_by: 'x', scheduled_at: w, scheduled_local: '2026-11-12T13:00' });
chk('booking with the only Agent needs no choice, and creates the Zoom meeting', r.s === 201 && r.j.deal.agent_id === aid && r.j.deal.zoom_meeting_id >= 100 && !r.j.meeting_error, JSON.stringify(r.j).slice(0, 300));
// an old deal (no agent_id at all) is still the Agent's
const oldId = (await withTeam(tid, () => all('deals')))[0].id;
await withTeam(tid, () => upd('deals', oldId, (d) => { delete d.agent_id; }));
chk("a deal with no agent_id belongs to the only Agent", (await A('/api/meetings?when=all')).j.length === 1 && (await A(`/api/deals/${oldId}`)).s === 200);
// the first save moves the connection to the Agent's own key
await A('/api/zoom/disconnect', 'POST');
chk('disconnect removes the legacy record too', (await withTeam(tid, () => getRaw(teamKey('zoom_account')))) === null && !(await A('/api/zoom/status')).j.connected);
// own Zoom app saved the old (team-level) way keeps working
await A('/api/zoom/app', 'PUT', { client_id: 'ownClientId123', client_secret: 'ownSecretValue1' });
const rec = await withTeam(tid, () => withAgent(aid, () => getRaw(agentKey('zoom_app'))));
await withTeam(tid, async () => { await setRaw(teamKey('zoom_app'), rec); await withAgent(aid, async () => { const { delRaw } = await import('./lib/db.js'); await delRaw(agentKey('zoom_app')); }); });
zs = (await A('/api/zoom/status')).j;
chk('an own Zoom app saved the old way is still found', zs.custom?.client_id === 'ownClientId123' && zs.apps.some((a) => a.key === 'team'), JSON.stringify(zs).slice(0, 300));
console.log(bad ? `${bad} FAILED` : 'ALL PASSED'); process.exit(bad ? 1 : 0);
