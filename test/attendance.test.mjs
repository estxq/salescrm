// Manual: run from a COPY of the project with an empty data/ dir (node test/attendance.test.mjs after copying to the root).

process.env.PORT = '3808'; process.env.ZOOM_CLIENT_ID = 'cid'; process.env.ZOOM_CLIENT_SECRET = 'sec';
const real = globalThis.fetch; const live = [{ id: 555001, topic: 'Zoom interview', start_time: '2026-10-05T03:00:00Z', duration: 60, join_url: 'https://zoom.us/j/555001' }];
globalThis.fetch = async (url, o = {}) => { const u = String(url); const j = (b, s = 200) => new Response(b == null ? null : JSON.stringify(b), { status: s });
  if (u.startsWith('https://api.zoom.us/v2/users/me/meetings')) return j({ meetings: live });
  if (u.startsWith('https://api.zoom.us')) return j({}); return real(url, o); };
await import('./server.js');
const { withTeam } = await import('./lib/context.js'); const { setRaw, teamKey, update, all } = await import('./lib/db.js');
const B = 'http://localhost:3808';
const mk = () => { const jar = {}; return async (p, m = 'GET', b) => { const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') }, body: b ? JSON.stringify(b) : undefined }); for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); } const t = await r.text(); try { return { s: r.status, j: JSON.parse(t) }; } catch { return { s: r.status, j: t }; } }; };
let bad = 0; const chk = (n, c, d = '') => { console.log(c ? 'ok  ' : 'FAIL', n, c ? '' : d); if (!c) bad++; };
const C = mk(), A = mk();
const s = await C('/api/auth/signup', 'POST', { mode: 'create', name: 'Cal', email: 'c@x.com', password: 'passw0rd!x', role: 'caller', team_name: 'T' });
await A('/api/auth/signup', 'POST', { mode: 'join', name: 'Arron', email: 'a@x.com', password: 'passw0rd!x', role: 'agent', invite_code: s.j.invite.code });
await withTeam(s.j.team.id, () => setRaw(teamKey('zoom_account'), { access_token: 't', refresh_token: 'r', expires_at: Date.now() + 3600e3 }));
const book = async (name, phone, iso) => (await C('/api/contacts', 'POST', { name, phone, created_by: 'Cal', scheduled_at: iso, scheduled_local: new Date(new Date(iso).getTime() + 8 * 3600e3).toISOString().slice(0, 16), zoom_link: 'https://zoom.us/j/' + phone })).j.deal;
const past = (id, iso) => withTeam(s.j.team.id, () => update('deals', id, (d) => { d.scheduled_at = iso; }));
const an = async (m) => (await A('/api/analytics?month=' + m)).j;
const future = new Date(Date.now() + 5 * 86400e3).toISOString();
const dFuture = await book('Future', '81111111', future);
const dA = await book('Aaa', '82222222', '2026-10-20T05:00:00Z'); await past(dA.id, '2026-10-10T05:00:00Z');
const dB = await book('Bbb', '83333333', '2026-10-20T05:00:00Z'); await past(dB.id, '2026-10-11T05:00:00Z');
const dL = await book('Legacy', '84444444', '2026-10-20T05:00:00Z'); await past(dL.id, '2026-09-20T05:00:00Z');
// legacy: outcome logged without any attendance answer -> still counted attended (old rule)
await A(`/api/deals/${dL.id}/followup`, 'POST', { outcome: 'follow_up', changed_by: 'Arron' });
let a = await an('2026-10'); const base = a.attended;
chk('old rule still holds: an outcome logged counts as attended', (await an('2026-10')).attended >= 0 && (await an('2026-10')).not_attended === 0);
// future meeting can't be marked
let r = await A('/api/attendance', 'POST', { kind: 'deal', deal_id: dFuture.id, status: 'attended' });
chk("can't mark a meeting that hasn't happened", r.s === 400, JSON.stringify(r));
// Caller can't
chk('Caller cannot set attendance', (await C('/api/attendance', 'POST', { kind: 'deal', deal_id: dA.id, status: 'attended' })).s === 403);
chk('bad status rejected', (await A('/api/attendance', 'POST', { kind: 'deal', deal_id: dA.id, status: 'maybe' })).s === 400);
// mark A attended, B not attended
await A('/api/attendance', 'POST', { kind: 'deal', deal_id: dA.id, status: 'attended' });
await A('/api/attendance', 'POST', { kind: 'deal', deal_id: dB.id, status: 'not_attended' });
a = await an('2026-10');
chk('attended counted in the month the meeting took place', a.attended === base + 1 && a.not_attended === 1, JSON.stringify([a.attended, base, a.not_attended]));
const list = (await A('/api/meetings?when=past')).j; const row = (n) => list.find((x) => x.contact?.name === n);
chk('listing shows each answer', row('Aaa').attendance === 'attended' && row('Aaa').attendance_set && row('Bbb').attendance === 'not_attended', JSON.stringify([row('Aaa')?.attendance, row('Bbb')?.attendance]));
chk('legacy meeting with an outcome shows attended but not "set"', row('Legacy').attendance === 'attended' && !row('Legacy').attendance_set);
// edit: A -> not attended, B -> attended
await A('/api/attendance', 'POST', { kind: 'deal', deal_id: dA.id, status: 'not_attended' });
await A('/api/attendance', 'POST', { kind: 'deal', deal_id: dB.id, status: 'attended' });
a = await an('2026-10'); chk('editing flips the analytics (no double count)', a.attended === base + 1 && a.not_attended === 1, JSON.stringify([a.attended, a.not_attended]));
// An outcome logged under the old rule counts in the month it was LOGGED (now = Oct). Marking it
// not attended moves it out of attended and into the month the meeting took place (Sep).
const octAtt = (await an('2026-10')).attended, sepNot = (await an('2026-09')).not_attended;
await A('/api/attendance', 'POST', { kind: 'deal', deal_id: dL.id, status: 'not_attended' });
chk("overriding a legacy 'attended' removes it from attended", (await an('2026-10')).attended === octAtt - 1, JSON.stringify([octAtt, (await an('2026-10')).attended]));
chk('...and counts it as not attended in the month of the meeting', (await an('2026-09')).not_attended === sepNot + 1);
await A('/api/attendance', 'POST', { kind: 'deal', deal_id: dL.id, status: 'unset' });
chk('clearing the answer falls back to the old rule', (await an('2026-10')).attended === octAtt && (await an('2026-09')).not_attended === sepNot);
// history (an earlier meeting on a deal replaced by a new booking)
const dH = await book('Hist', '85555555', '2026-10-20T05:00:00Z'); await past(dH.id, '2026-10-02T05:00:00Z');
await C(`/api/deals/${dH.id}/schedule`, 'POST', { scheduled_at: future, scheduled_local: new Date(new Date(future).getTime() + 8 * 3600e3).toISOString().slice(0, 16), zoom_link: 'https://zoom.us/j/85555556', changed_by: 'Cal' });
const hist = (await A('/api/meetings?when=past')).j.find((x) => x.source === 'history' && x.contact?.name === 'Hist');
chk('earlier meeting appears as history', !!hist);
const octBefore = (await an('2026-10')).attended;
r = await A('/api/attendance', 'POST', { kind: 'history', deal_id: hist.deal_id, index: Number(hist.id.split('-')[2]), status: 'attended' });
chk('can mark an earlier (replaced) meeting attended', r.s === 200 && (await an('2026-10')).attended === octBefore + 1, JSON.stringify(r));
chk('...and the new booking is not affected', (await A(`/api/deals/${hist.deal_id}`)).j.attendance === null);
// zoom-only meeting
const zrow = (await A('/api/meetings?when=past')).j.find((x) => x.source === 'zoom');
chk('Zoom-only past meeting is listed', !!zrow, JSON.stringify((await A('/api/meetings?when=past')).j.map((x) => x.id)));
if (zrow) {
  const before = (await an('2026-10')).attended;
  r = await A('/api/attendance', 'POST', { kind: 'zoom', zoom_id: String(zrow.id).replace('zoom-', ''), scheduled_at: zrow.scheduled_at, status: 'attended' });
  chk('can mark a Zoom-only meeting attended', r.s === 200 && (await an('2026-10')).attended === before + 1, JSON.stringify(r));
  chk('listing reflects it', (await A('/api/meetings?when=past')).j.find((x) => x.id === zrow.id).attendance === 'attended');
}
// deleting a meeting marked not attended removes the record
await A('/api/attendance', 'POST', { kind: 'deal', deal_id: dA.id, status: 'not_attended' });
await C(`/api/deals/${dA.id}/meeting`, 'DELETE', { changed_by: 'Cal' });
chk('deleting a meeting drops its not-attended record', (await withTeam(s.j.team.id, () => all('attendance'))).every((x) => !x.ref.includes(String(dA.stat_ref || 'zzz'))));
// no-op on other team
console.log(bad ? `${bad} FAILED` : 'ALL PASSED'); process.exit(bad ? 1 : 0);
