// Everything in this app is Singapore time — the team's own timezone — no matter
// where the server or anyone's device happens to be. (The browser half of this
// lives in public/time.js; keep the two in step.)
//
// Notification text is built once, server-side, and stored as a plain string —
// unlike every date the client renders, a date baked into that string is fixed
// forever at whatever timezone the server used the moment it was written. Node's
// default timezone is UTC on Vercel but whatever the machine is set to locally,
// so an unqualified `.toLocaleString()` drifts by the gap between them — 8 hours
// here, quietly wrong only in production. Pinning it makes it the same everywhere.
// Singapore has no daylight saving, so a fixed +8 hours is exact.
export const TEAM_TIMEZONE = 'Asia/Singapore';
export const TEAM_OFFSET_MIN = 480; // UTC+8
export const TEAM_OFFSET_MS = TEAM_OFFSET_MIN * 60000;
// Same offset the way a browser's getTimezoneOffset() reports it (ahead of UTC = negative).
export const TEAM_TZ_PARAM = -TEAM_OFFSET_MIN;

// The Singapore wall-clock reading of an instant, as Zoom's API wants it when a
// timezone is stated: "2026-09-30T13:00:00" plus timezone "Asia/Singapore".
export function sgWallClock(instant) {
  return new Date(new Date(instant).getTime() + TEAM_OFFSET_MS).toISOString().slice(0, 19);
}

export function formatWhen(iso) {
  return new Date(iso).toLocaleString(undefined, { timeZone: TEAM_TIMEZONE });
}

// The real moments a Singapore calendar month starts and ends at: [start, end).
// `year` and `monthIndex` (0-11) are the month as Singapore reads it.
export function sgMonthRange(year, monthIndex) {
  return {
    start: new Date(Date.UTC(year, monthIndex, 1) - TEAM_OFFSET_MS),
    end: new Date(Date.UTC(year, monthIndex + 1, 1) - TEAM_OFFSET_MS),
  };
}

// The Singapore year and month (0-11) it is right now.
export function sgNow() {
  const d = new Date(Date.now() + TEAM_OFFSET_MS);
  return { year: d.getUTCFullYear(), monthIndex: d.getUTCMonth() };
}

// Belt and braces for every request that *sets* a meeting time. The browser sends
// the instant (`scheduled_at`, ISO) and, separately, the wall-clock text the person
// actually typed (`scheduled_local`, "2026-09-25T13:00" = Singapore time). The two
// must describe the same moment, or the request is refused — so a stale open tab,
// a cached old script, or any future bug that converts through the device's zone
// can't quietly store a time different from the one typed. Returns an error
// message, or null if the pair agrees.
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;
export function wallClockProblem(body) {
  const stale = 'The app was updated. Please refresh this page (Ctrl/Cmd + Shift + R) and try again — nothing was changed.';
  const at = body?.scheduled_at;
  if (!at) return null;
  const m = LOCAL_RE.exec(String(body.scheduled_local || ''));
  if (!m) return stale;
  const [, y, mo, d, h, mi] = m.map(Number);
  const typed = Date.UTC(y, mo - 1, d, h, mi) - TEAM_OFFSET_MS;
  const sent = new Date(at).getTime();
  if (Number.isNaN(sent) || Math.abs(sent - typed) >= 60000) {
    return 'That time did not match what was typed, so nothing was saved. Please refresh the page and try again.';
  }
  return null;
}
