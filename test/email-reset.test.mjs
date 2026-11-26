// Manual (run from a COPY with an empty data/ dir). A fake Resend stands in for the real mail provider.
process.env.PORT = '3830'; process.env.RESEND_API_KEY = 're_test_key'; process.env.EMAIL_FROM = 'Schedule Hub <no-reply@example.com>';
const sent = []; let mailMode = 'ok'; const real = globalThis.fetch;
globalThis.fetch = async (url, o = {}) => {
  if (String(url) === 'https://api.resend.com/emails') {
    const b = JSON.parse(o.body); sent.push({ auth: o.headers.Authorization, ...b });
    return mailMode === 'ok' ? new Response('{"id":"1"}', { status: 200 }) : new Response('{"message":"domain not verified"}', { status: 403 });
  }
  return real(url, o);
};
await import('./server.js');
const B = 'http://localhost:3830';
const mk = () => { const jar = {}; return async (p, m = 'GET', b) => { const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') }, body: b ? JSON.stringify(b) : undefined }); for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); const v = kv.slice(i + 1); v ? (jar[kv.slice(0, i)] = v) : delete jar[kv.slice(0, i)]; } const t = await r.text(); try { return { s: r.status, j: JSON.parse(t) }; } catch { return { s: r.status, j: t }; } }; };
let bad = 0; const chk = (n, c, d = '') => { console.log(c ? 'ok  ' : 'FAIL', n, c ? '' : String(d).slice(0, 300)); if (!c) bad++; };
const pw = 'passw0rd!x'; const solo = mk(), a = mk(), b = mk(), anon = mk();
const codeOf = (m) => m.text.match(/(\d{3} \d{3})/)[1];
chk('the login screen is told email reset is on', (await anon('/api/auth/config')).j.email_reset === true);
// ---- a person alone in their team (no teammate) can now recover by email
await solo('/api/auth/signup', 'POST', { mode: 'create', name: 'Solo <b>Sam</b>', email: 'solo@x.com', password: pw, role: 'agent', team_name: 'Alone' });
let r = await anon('/api/auth/forgot-password', 'POST', { email: 'solo@x.com' });
chk('forgot password for someone with no teammate sends an email', r.s === 200 && sent.length === 1 && sent[0].to[0] === 'solo@x.com', JSON.stringify(sent));
chk('...with the provider key and configured sender', sent[0].auth === 'Bearer re_test_key' && sent[0].from === 'Schedule Hub <no-reply@example.com>');
chk("...the name is HTML-escaped in the email's HTML part", !sent[0].html.includes('<b>Sam</b>') && sent[0].html.includes('&lt;b&gt;'));
chk('the code is NOT in the HTTP response', !JSON.stringify(r.j).match(/\d{3} \d{3}/));
// the emailed code actually resets the password
const res = await anon('/api/auth/reset-password', 'POST', { email: 'solo@x.com', code: codeOf(sent[0]), new_password: 'freshPass#77' });
chk('the emailed code resets the password and logs in', res.s === 200 && (await mk()('/api/auth/login', 'POST', { email: 'solo@x.com', password: 'freshPass#77' })).s === 200, JSON.stringify(res));
// ---- same answer for an unknown address, and nothing is sent to it
const before = sent.length; const r2 = await anon('/api/auth/forgot-password', 'POST', { email: 'nobody@x.com' });
chk('an unknown email gets the identical response and no mail', r2.s === 200 && r2.j.message === r.j.message && sent.length === before);
// ---- team: email goes to the person, no bell card for teammates
const s = await a('/api/auth/signup', 'POST', { mode: 'create', name: 'Agent A', email: 'a@x.com', password: pw, role: 'agent', team_name: 'T', callers: 1, agents: 2 });
await b('/api/auth/signup', 'POST', { mode: 'join', name: 'Agent B', email: 'b@x.com', password: pw, role: 'agent', invite_code: s.j.invite.code });
const n0 = sent.length; await anon('/api/auth/forgot-password', 'POST', { email: 'b@x.com' });
chk('a teammate-having user is emailed too', sent.length === n0 + 1 && sent[n0].to[0] === 'b@x.com');
chk('...and no code card is put in the teammate\'s bell', !(await a('/api/notifications')).j.some((n) => n.type === 'password_reset'));
// ---- email failure falls back to the bell
mailMode = 'fail';
await new Promise((r) => setTimeout(r, 0));
const bAcct = mk(); // expire cooldown by using a different person
await bAcct('/api/auth/signup', 'POST', { mode: 'join', name: 'Agent C', email: 'c@x.com', password: pw, role: 'agent', invite_code: s.j.invite.code }).catch(() => {});
const rf = await anon('/api/auth/forgot-password', 'POST', { email: 'a@x.com' });
chk('when the mail provider refuses, the response is still the same normal one', rf.s === 200 && rf.j.ok === true);
chk('...and the code falls back to the teammate\'s bell', (await b('/api/notifications')).j.some((n) => n.type === 'password_reset' && /Agent A forgot/.test(n.message)));
console.log(bad ? `${bad} FAILED` : 'ALL PASSED'); process.exit(bad ? 1 : 0);
