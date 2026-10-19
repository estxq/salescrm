// RUN WITH THE PREVIOUS VERSION AGAIN (a rollback), on data the new version has since written to.
import fs from 'node:fs';
import { install } from '/private/tmp/mig/fake.mjs';
process.env.PORT = '3832'; process.env.ZOOM_CLIENT_ID = 'cid'; process.env.ZOOM_CLIENT_SECRET = 'sec'; process.env.GOOGLE_CLIENT_ID = 'gid'; process.env.GOOGLE_CLIENT_SECRET = 'gsec';
install(); await import('./server.js');
const snap = JSON.parse(fs.readFileSync('/private/tmp/mig/snap.json', 'utf8'));
const B = 'http://localhost:3832';
const mk = (jar) => async (p, m = 'GET', b) => { const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); try { return { s: r.status, j: JSON.parse(t) }; } catch { return { s: r.status, j: t }; } };
const C = mk(snap.jars.caller), A = mk(snap.jars.agent);
let bad = 0; const chk = (n, c, d = '') => { console.log(c ? 'ok  ' : 'FAIL', n, c ? '' : String(d).slice(0, 300)); if (!c) bad++; };
const m = (await C('/api/meetings?when=all')).j; chk('rolled back: the Caller still sees the meetings (incl. ones made by the new version)', m.some((x) => x.contact?.name === 'Brand New') && m.length >= 5, JSON.stringify(m.map((x) => x.contact?.name || x.title)));
chk("rolled back: the Agent's Zoom is still connected", (await A('/api/zoom/status')).j.connected === true);
chk("rolled back: the Agent's Google is still connected", (await A('/api/google/status')).j.connected === true);
chk('rolled back: analytics still load', (await A('/api/analytics')).s === 200);
console.log(bad ? `${bad} FAILED` : 'ALL PASSED'); process.exit(bad ? 1 : 0);
