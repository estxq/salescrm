// Every time in this app is Singapore time (SGT), whatever timezone the device
// looking at it happens to be set to.
//
// Why: a meeting is stored as one real moment (a UTC timestamp), but people
// type and read it as a wall-clock time. If that conversion used each device's
// own timezone, a Caller whose computer is set 2 hours ahead of Singapore would
// type "1:00 PM", store 11:00 AM Singapore time, and the Agent would see 11:00 —
// and the same meeting would read differently on every screen. So all the
// conversions live here and none of them ever ask the device what timezone it
// is. Singapore has no daylight saving, so a fixed +8 hours is exact.
//
// No DOM in this file on purpose: it's loaded as a plain script by the page and
// loaded straight into Node by the tests, which run it under several device
// timezones and check the answers never change.

const TEAM_TZ = 'Asia/Singapore';
const TEAM_OFFSET_MIN = 480; // UTC+8
const TEAM_OFFSET_MS = TEAM_OFFSET_MIN * 60000;
// The same offset the way the server's analytics expects it (what a browser's
// getTimezoneOffset() reports: minutes *behind* UTC, so ahead of UTC is negative).
const TEAM_TZ_PARAM = -TEAM_OFFSET_MIN;

// An instant, shifted so its UTC fields read as Singapore wall-clock fields.
function sgShift(iso) {
  return new Date(new Date(iso).getTime() + TEAM_OFFSET_MS);
}

// ---- Showing a time (locale still follows the viewer's browser; only the zone is pinned)
function sgFormat(iso, opts) {
  return new Date(iso).toLocaleString(undefined, { ...opts, timeZone: TEAM_TZ });
}
function sgTime(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: TEAM_TZ });
}
function sgDate(iso, opts) {
  return new Date(iso).toLocaleDateString(undefined, { ...opts, timeZone: TEAM_TZ });
}

// ---- Which Singapore calendar day / month an instant falls on
function sgParts(iso) {
  const d = sgShift(iso);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay() };
}
function sgDayKey(iso) {
  return sgShift(iso).toISOString().slice(0, 10); // "2026-09-25"
}
function sgToday() {
  const p = sgParts(Date.now());
  return { y: p.y, m: p.m, d: p.d };
}
function sgNowMonthKey() {
  const t = sgToday();
  return `${t.y}-${String(t.m).padStart(2, '0')}`;
}

// ---- Typing a time. A <input type="datetime-local"> hands back "2026-09-25T13:00"
// with no zone at all; this reads it as Singapore time.
function sgInputToISO(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(str || ''));
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) - TEAM_OFFSET_MS).toISOString();
}
// ...and the reverse, for filling such an input from a stored moment.
function sgToInput(iso) {
  return sgShift(iso).toISOString().slice(0, 16);
}

// True when this device's clock isn't on Singapore time — the situation this whole
// file exists to make harmless, but worth telling the person about.
function deviceTimezoneDiffers(now = new Date()) {
  return now.getTimezoneOffset() !== TEAM_TZ_PARAM;
}
// "UTC+10" / "UTC-5:30" for that notice.
function deviceUtcLabel(now = new Date()) {
  const min = -now.getTimezoneOffset();
  const sign = min < 0 ? '-' : '+';
  const abs = Math.abs(min);
  const h = Math.floor(abs / 60);
  const rest = abs % 60;
  return `UTC${sign}${h}${rest ? `:${String(rest).padStart(2, '0')}` : ''}`;
}
