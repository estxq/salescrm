// Notification text is built once, server-side, and stored as a plain string —
// unlike every date the client renders (always in the viewer's own browser, so
// it's automatically correct), a date baked into that string is fixed forever
// at whatever timezone the server used at the moment it was written. Node's
// default timezone is UTC on Vercel but whatever the machine is set to
// locally, so an unqualified `.toLocaleString()` drifts by the gap between
// them — in this team's case, 8 hours, quietly wrong only in production. This
// pins it to the team's own timezone so it's the same everywhere.
const TEAM_TIMEZONE = 'Asia/Singapore';

export function formatWhen(iso) {
  return new Date(iso).toLocaleString(undefined, { timeZone: TEAM_TIMEZONE });
}
