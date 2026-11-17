// Manual (run from a COPY with an empty data/ dir): an Agent can remove a Caller, and only a Caller, only in their own team.
process.env.PORT = '3824';
await import('./server.js');
const B = 'http://localhost:3824';
const mk = () => { const jar = {}; return async (p, m = 'GET', b) => { const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') }, body: b ? JSON.stringify(b) : undefined }); for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); const v = kv.slice(i + 1); v ? (jar[kv.slice(0, i)] = v) : delete jar[kv.slice(0, i)]; } const t = await r.text(); try { return { s: r.status, j: JSON.parse(t) }; } catch { return { s: r.status, j: t }; } }; };
let bad = 0; const chk = (n, c, d = '') => { console.log(c ? 'ok  ' : 'FAIL', n, c ? '' : String(d).slice(0, 250)); if (!c) bad++; };
const pw = 'passw0rd!x'; const A = mk(), A2 = mk(), C = mk(), O = mk(), OA = mk();
const s = await A('/api/auth/signup', 'POST', { mode: 'create', name: 'Agent One', email: 'a@x.com', password: pw, role: 'agent', team_name: 'T', callers: 1, agents: 2 });
const join = (cl, name, email, role) => cl('/api/auth/signup', 'POST', { mode: 'join', name, email, password: pw, role, invite_code: s.j.invite.code });
await join(C, 'Cal', 'c@x.com', 'caller'); await join(A2, 'Agent Two', 'a2@x.com', 'agent');
const cid = (await C('/api/auth/me')).j.user.id; const a2id = (await A2('/api/auth/me')).j.user.id;
// another team
const o = await O('/api/auth/signup', 'POST', { mode: 'create', name: 'Other Caller', email: 'o@x.com', password: pw, role: 'caller', team_name: 'Other' }); const oid = o.j.user.id;
chk('a Caller cannot remove anyone', (await C(`/api/team/members/${a2id}/remove`, 'POST')).s === 403);
chk('an Agent cannot remove another Agent', (await A(`/api/team/members/${a2id}/remove`, 'POST')).s === 400);
chk("an Agent cannot remove someone from another team", (await A(`/api/team/members/${oid}/remove`, 'POST')).s === 404);
chk("...and that person is untouched", (await O('/api/auth/me')).j.team?.name === 'Other');
const r = await A(`/api/team/members/${cid}/remove`, 'POST');
chk('the Agent removes the Caller', r.s === 200 && !r.j.members.some((m) => m.id === cid) && r.j.invite.open.caller === 1, JSON.stringify(r.j.members));
chk('the removed Caller no longer has a team, but still has a login', (await C('/api/auth/me')).j.team === null);
chk('...and is locked out of the team data', (await C('/api/contacts')).s === 403);
chk('...and the seat can be taken again with the invite code', (await join(mk(), 'New Caller', 'n@x.com', 'caller')).s === 201);
const again = await C('/api/auth/team', 'POST', { mode: 'join', invite_code: s.j.invite.code, role: 'caller', name: 'Cal' });
chk('the removed Caller can rejoin if someone frees the seat, else is refused when full', again.s === 201 || again.s === 400);
chk('a second removal of the same person is refused', (await A(`/api/team/members/${cid}/remove`, 'POST')).s === 404 || (await A(`/api/team/members/${cid}/remove`, 'POST')).s === 400);
console.log(bad ? `${bad} FAILED` : 'ALL PASSED'); process.exit(bad ? 1 : 0);
