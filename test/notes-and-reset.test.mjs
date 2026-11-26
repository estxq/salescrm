// Manual (run from a COPY with an empty data/ dir). Covers: notes/remarks reaching the Agent, contacts that are not given to
// an Agent, and a password-reset code reaching the other Agents of the team (not only the Callers).
process.env.PORT = '3826';
await import('./server.js');
const B = 'http://localhost:3826';
const mk = () => { const jar = {}; return async (p, m = 'GET', b) => { const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') }, body: b ? JSON.stringify(b) : undefined }); for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); const v = kv.slice(i + 1); v ? (jar[kv.slice(0, i)] = v) : delete jar[kv.slice(0, i)]; } const t = await r.text(); try { return { s: r.status, j: JSON.parse(t) }; } catch { return { s: r.status, j: t }; } }; };
let bad = 0; const chk = (n, c, d = '') => { console.log(c ? 'ok  ' : 'FAIL', n, c ? '' : String(d).slice(0, 300)); if (!c) bad++; };
const pw = 'passw0rd!x'; const C = mk(), Y = mk(), R = mk(), R2 = mk();
const s = await C('/api/auth/signup', 'POST', { mode: 'create', name: 'Cal', email: 'c@x.com', password: pw, role: 'caller', team_name: 'T', callers: 1, agents: 2 });
const join = (cl, name, email) => cl('/api/auth/signup', 'POST', { mode: 'join', name, email, password: pw, role: 'agent', invite_code: s.j.invite.code });
await join(Y, 'Yvonne', 'y@x.com'); await join(R, 'Rachelle', 'r@x.com');
const yid = (await Y('/api/auth/me')).j.user.id; const rid = (await R('/api/auth/me')).j.user.id;
const when = new Date(Date.now() + 3 * 86400e3); when.setUTCHours(5, 0, 0, 0);
const sched = { scheduled_at: when.toISOString(), scheduled_local: new Date(when.getTime() + 8 * 3600e3).toISOString().slice(0, 16), zoom_link: 'https://zoom.us/j/12345678' };

// ---- a contact must be given to an Agent
let r = await C('/api/contacts', 'POST', { name: 'NoAgent', phone: '91000001', created_by: 'x' });
chk('with several Agents a contact without an Agent is refused (even with no meeting)', r.s === 400 && /Choose which Agent/.test(r.j.error), JSON.stringify(r));
r = await C('/api/contacts', 'POST', { name: 'Client Y', phone: '91000002', notes: 'Prefers evenings. Spouse also attends.', email: 'cy@x.com', created_by: 'x', agent_id: yid, ...sched });
const deal = r.j.deal;
chk('contact booked with Yvonne', r.s === 201 && deal.agent_id === yid && !r.j.meeting_error, JSON.stringify(r.j).slice(0, 200));

// ---- the Agent sees the Caller's notes
const yc = (await Y('/api/contacts')).j;
chk("Yvonne's contact list carries the Caller's notes", yc.length === 1 && yc[0].notes === 'Prefers evenings. Spouse also attends.', JSON.stringify(yc));
chk("Rachelle (another Agent) doesn't see this contact", (await R('/api/contacts')).j.length === 0);
// ---- remarks
await C(`/api/deals/${deal.id}/note`, 'POST', { note: 'Client asked for the agenda beforehand', changed_by: 'x' });
const yc2 = (await Y('/api/contacts')).j[0];
chk('a remark left by the Caller shows on the Agent\'s contact', yc2.remarks.length === 1 && yc2.remarks[0].text === 'Client asked for the agenda beforehand' && yc2.remarks[0].by === 'Cal', JSON.stringify(yc2.remarks));
const dd = (await Y(`/api/deals/${deal.id}`)).j;
chk('...and in the meeting window data (activities marked as remarks)', dd.activities.some((a) => a.type === 'note' && a.meta?.remark && a.summary.startsWith('Client asked')), JSON.stringify(dd.activities.map((a) => [a.type, a.summary])));
// system notes are not remarks
await C(`/api/deals/${deal.id}/meeting`, 'DELETE', { changed_by: 'x' });
const yc3 = (await Y('/api/contacts')).j[0];
chk('"deleted the meeting" is not shown as a remark', yc3.remarks.every((x) => !/deleted the meeting/.test(x.text)), JSON.stringify(yc3.remarks));
// ---- editing notes
r = await C(`/api/contacts/${yc[0].id}`, 'PATCH', { notes: 'Updated: now prefers mornings' });
chk('the Caller can edit notes later and the Agent sees the new text', r.s === 200 && (await Y('/api/contacts')).j[0].notes === 'Updated: now prefers mornings');
// ---- unassigned + assign
r = await C('/api/contacts', 'POST', { name: 'Client R', phone: '91000003', created_by: 'x', agent_id: rid });
const unassignedDeal = await (async () => { const all = (await C('/api/contacts')).j; return all.find((c) => c.name === 'Client R'); })();
chk('a contact with an Agent shows who it is with (to the Caller)', unassignedDeal.agent_id === rid && unassignedDeal.agent_name === 'Rachelle');
r = await C(`/api/deals/${deal.id}/assign`, 'POST', { agent_id: rid });
chk('a contact with no meeting can be given to another Agent', r.s === 200 && (await R('/api/contacts')).j.some((c) => c.name === 'Client Y') && (await Y('/api/contacts')).j.length === 0, JSON.stringify(r));
chk('an unbooked contact can be moved again', (await C(`/api/deals/${unassignedDeal.deal_id}/assign`, 'POST', { agent_id: yid })).s === 200);
r = await C('/api/contacts', 'POST', { name: 'Booked', phone: '91000004', created_by: 'x', agent_id: yid, ...sched }); 
chk('a booked deal refuses reassignment', (await C(`/api/deals/${r.j.deal.id}/assign`, 'POST', { agent_id: rid })).s === 409);
chk('an Agent cannot assign', [403, 404].includes((await Y(`/api/deals/${deal.id}/assign`, 'POST', { agent_id: yid })).s));
// ---- a contact's notes are escaped by the client; the API just returns text
r = await C('/api/contacts', 'POST', { name: 'Script', phone: '91000005', notes: '<img src=x onerror=alert(1)>', created_by: 'x', agent_id: yid });
chk('hostile text is stored as plain text', (await Y('/api/contacts')).j.some((c) => c.notes.includes('<img')));

// ---- password reset reaches the other Agents too
await R2('/api/auth/forgot-password', 'POST', { email: 'r@x.com' });
const seenBy = async (cl) => (await cl('/api/notifications')).j.some((n) => n.type === 'password_reset');
chk("Rachelle's reset code reaches Yvonne (another Agent)", await seenBy(Y));
chk('...and the Caller', await seenBy(C));
chk("...and Rachelle herself doesn't need it, but a different team never gets it", (await (async () => { const O = mk(); await O('/api/auth/signup', 'POST', { mode: 'create', name: 'O', email: 'o@x.com', password: pw, role: 'caller', team_name: 'Other' }); return seenBy(O); })()) === false);
console.log(bad ? `${bad} FAILED` : 'ALL PASSED'); process.exit(bad ? 1 : 0);
