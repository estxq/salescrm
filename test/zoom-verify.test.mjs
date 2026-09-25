// Zoom must end up with the exact instant the CRM has. This fakes Zoom's API and
// checks a correct booking passes, and one Zoom stores at a different time is refused.
import { withTeam } from '../lib/context.js';
import { setRaw, delRaw, teamKey } from '../lib/db.js';
import * as zoom from '../lib/zoom.js';

let bad = 0;
const check = (n, c, d = '') => { if (!c) { bad++; console.log('FAIL', n, d); } else console.log('ok  ', n); };
const real = globalThis.fetch;
// What real Zoom did with our old requests: a start_time that is not exactly
// "yyyy-MM-ddTHH:mm:ssZ" (e.g. it has .000 milliseconds) had its Z ignored and the digits
// read as wall-clock time in the account's timezone (Singapore). A start_time with no Z is
// wall-clock in the stated timezone. Only the exact-Z form is a true UTC instant.
function zoomReads(start, tz) {
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(start)) return new Date(start);
  const digits = start.replace(/(\.\d+)?Z$/, '');
  const zone = tz || 'Asia/Singapore';
  if (zone !== 'Asia/Singapore') throw new Error('test only models Singapore');
  return new Date(digits + '+08:00');
}
let stored = {}, deleted = [], skew = 0, lastCreate = null;
globalThis.fetch = async (url, o = {}) => {
  const path = String(url).replace('https://api.zoom.us/v2', '');
  const j = (b, s = 200) => new Response(b == null ? null : JSON.stringify(b), { status: s });
  if (path === '/users/me/meetings' && o.method === 'POST') {
    lastCreate = JSON.parse(o.body);
    const st = new Date(zoomReads(lastCreate.start_time, lastCreate.timezone).getTime() + skew).toISOString();
    stored['1'] = st; return j({ id: 1, join_url: 'u', start_url: 's', start_time: st });
  }
  if (path === '/meetings/1' && o.method === 'PATCH') { const b = JSON.parse(o.body); stored['1'] = new Date(zoomReads(b.start_time, b.timezone).getTime() + skew).toISOString(); return j(null, 204); }
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
  check('create sends Singapore wall-clock time with the timezone stated', lastCreate.start_time === '2026-09-25T13:00:00' && lastCreate.timezone === 'Asia/Singapore', JSON.stringify(lastCreate));
  check('Zoom ends up at the intended instant', stored['1'] === at, stored['1']);
  check('the old ms-Z format would have been stored 8h early (the bug seen in production)', zoomReads('2026-09-30T05:00:00.000Z').toISOString() === '2026-09-29T21:00:00.000Z');
  await zoom.updateMeetingTime(1, { startTime: '2026-09-25T07:00:00.000Z' });
  check('update ok', stored['1'] === '2026-09-25T07:00:00.000Z');
  // If Zoom refuses to let us read the meeting back (missing scope), the move still counts.
  const okGet = globalThis.fetch;
  globalThis.fetch = async (url, o = {}) =>
    String(url).endsWith('/meetings/1') && !o.method ? new Response('{"code":4711}', { status: 403 }) : okGet(url, o);
  let readErr = null; try { await zoom.updateMeetingTime(1, { startTime: at }); } catch (e) { readErr = e; }
  check('update still succeeds when the read-back is forbidden', readErr === null, String(readErr));
  globalThis.fetch = okGet;
  skew = 2 * 3600e3;
  let err = null; try { await zoom.updateMeetingTime(1, { startTime: at }); } catch (e) { err = e; }
  check('update with Zoom 2h off is refused', !!err && /instead of/.test(err.message), String(err));
  err = null; try { await zoom.createMeeting({ topic: 't', startTime: at }); } catch (e) { err = e; }
  check('create with Zoom 2h off is refused and cleaned up', !!err && deleted.length === 1, String(err));
  await delRaw(teamKey('zoom_account'));
});
process.exit(bad ? 1 : 0);
