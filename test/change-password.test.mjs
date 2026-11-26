// Manual (run from a COPY with an empty data/ dir).
process.env.PORT = '3828';
await import('./server.js');
const B = 'http://localhost:3828';
const mk = () => { const jar = {}; return async (p, m = 'GET', b) => { const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') }, body: b ? JSON.stringify(b) : undefined }); for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); const v = kv.slice(i + 1); v ? (jar[kv.slice(0, i)] = v) : delete jar[kv.slice(0, i)]; } const t = await r.text(); try { return { s: r.status, j: JSON.parse(t) }; } catch { return { s: r.status, j: t }; } }; };
let bad = 0; const chk = (n, c, d = '') => { console.log(c ? 'ok  ' : 'FAIL', n, c ? '' : String(d).slice(0, 250)); if (!c) bad++; };
const old = 'passw0rd!x', neu = 'brandNew#99'; const A = mk(), anon = mk();
await A('/api/auth/signup', 'POST', { mode: 'create', name: 'Agent', email: 'a@x.com', password: old, role: 'agent', team_name: 'T' });
chk('not logged in: refused', (await anon('/api/auth/change-password', 'POST', { current_password: old, new_password: neu })).s === 401);
chk('wrong current password refused', (await A('/api/auth/change-password', 'POST', { current_password: 'nope', new_password: neu })).s === 403);
chk('too-short new password refused', (await A('/api/auth/change-password', 'POST', { current_password: old, new_password: 'short' })).s === 400);
chk('same password refused', (await A('/api/auth/change-password', 'POST', { current_password: old, new_password: old })).s === 400);
chk('correct change works', (await A('/api/auth/change-password', 'POST', { current_password: old, new_password: neu })).s === 200);
chk('old password no longer logs in', (await anon('/api/auth/login', 'POST', { email: 'a@x.com', password: old })).s === 401);
chk('new password logs in', (await mk()('/api/auth/login', 'POST', { email: 'a@x.com', password: neu })).s === 200);
chk('still logged in here after changing', (await A('/api/auth/me')).s === 200);
for (let i = 0; i < 5; i++) await A('/api/auth/change-password', 'POST', { current_password: 'wrong' + i, new_password: 'whatever123' });
chk('five wrong guesses lock the account (like logging in)', (await A('/api/auth/change-password', 'POST', { current_password: neu, new_password: 'another#123' })).s === 429);
console.log(bad ? `${bad} FAILED` : 'ALL PASSED'); process.exit(bad ? 1 : 0);
