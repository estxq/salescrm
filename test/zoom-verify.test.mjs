// Zoom must end up with the exact instant the CRM has. This fakes Zoom's API and
// checks a correct booking passes, and one Zoom stores at a different time is refused.
import { withTeam } from '../lib/context.js';
import { setRaw, delRaw, teamKey } from '../lib/db.js';
import * as zoom from '../lib/zoom.js';

let bad = 0;
const check = (n, c, d = '') => { if (!c) { bad++; console.log('FAIL', n, d); } else console.log('ok  ', n); };
const real = globalThis.fetch;
let stored = {}, deleted = [], skew = 0, lastCreate = null;
globalThis.fetch = async (url, o = {}) => {
  const path = String(url).replace('https://api.zoom.us/v2', '');
  const j = (b, s = 200) => new Response(b == null ? null : JSON.stringify(b), { status: s });
  if (path === '/users/me/meetings' && o.method === 'POST') {
    lastCreate = JSON.parse(o.body);
    // Real Zoom: if a timezone is supplied, start_time is read as wall-clock time in that zone (the Z is ignored).
    const zoneShift = lastCreate.timezone === 'Asia/Singapore' ? -8 * 3600e3 : 0;
    const st = new Date(new Date(lastCreate.start_time).getTime() + skew + zoneShift).toISOString();
    stored['1'] = st; return j({ id: 1, join_url: 'u', start_url: 's', start_time: st });
  }
  if (path === '/meetings/1' && o.method === 'PATCH') { stored['1'] = new Date(new Date(JSON.parse(o.body).start_time).getTime() + skew).toISOString(); return j(null, 204); }
  if (path === '/meetings/1' && o.method === 'DELETE') { deleted.push(1); return j(null, 204); }
  if (path === '/meetings/1') return j({ id: 1, start_time: stored['1'] });
  return real(url, o);
};

// A throwaway team id, removed at the end, so no real dev data is touched.
await withTeam(987654, async () => {
  await setRaw(teamKey('zoom_account'), { access_token: 'x', refresh_token: 'y', expires_at: Date.now() + 3600e3 });
  const at = '2026-09-25T05:00:00.000Z';
  const m = await zoom.createMeeting({ topic: 't', startTime: at });
  check('create ok', m.id === 1);
  check('create sends no timezone field (Zoom would reinterpret start_time)', lastCreate.timezone === undefined);
  await zoom.updateMeetingTime(1, { startTime: '2026-09-25T07:00:00.000Z' });
  check('update ok', stored['1'] === '2026-09-25T07:00:00.000Z');
  skew = 2 * 3600e3;
  let err = null; try { await zoom.updateMeetingTime(1, { startTime: at }); } catch (e) { err = e; }
  check('update with Zoom 2h off is refused', !!err && /instead of/.test(err.message), String(err));
  err = null; try { await zoom.createMeeting({ topic: 't', startTime: at }); } catch (e) { err = e; }
  check('create with Zoom 2h off is refused and cleaned up', !!err && deleted.length === 1, String(err));
  await delRaw(teamKey('zoom_account'));
});
process.exit(bad ? 1 : 0);
