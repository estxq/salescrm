import crypto from 'node:crypto';
import { getRaw, setRaw, delRaw, teamKey } from './db.js';
import { getSecret } from './session.js';
import { TEAM_TIMEZONE, sgWallClock } from './tz.js';

// The site can hold several Zoom apps side by side (a Zoom app only lets accounts inside
// its owner's Zoom account sign in until Zoom publishes it, so different teams may need
// different apps). App "1" is ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET; more are
// ZOOM_CLIENT_ID_2 / ZOOM_CLIENT_SECRET_2 (up to _5), each with an optional
// ZOOM_APP_LABEL[_N] shown in the picker. A team's stored connection remembers which app
// made it, so refreshing its token always uses that app's own credentials.
export function zoomApps(env = process.env) {
  const apps = [];
  for (let n = 1; n <= 5; n++) {
    const sfx = n === 1 ? '' : `_${n}`;
    const id = env[`ZOOM_CLIENT_ID${sfx}`];
    const secret = env[`ZOOM_CLIENT_SECRET${sfx}`];
    if (id && secret) apps.push({ key: String(n), id, secret, label: env[`ZOOM_APP_LABEL${sfx}`] || `Zoom app ${n}` });
  }
  return apps;
}

// A team can also keep its own Zoom app's Client ID and Secret in the app (no redeploy, no
// limit on teams). The Secret is encrypted (AES-256-GCM) before it is stored, with
// ZOOM_CRED_KEY if set, else the site's signing secret; it is never sent back to the browser.
// Set ZOOM_CRED_KEY in Vercel: otherwise the key lives in the same database as the data it
// protects, which only guards against casual reading, not against a database leak.
const customAppKey = () => teamKey('zoom_app');
const sealKey = async () =>
  crypto.createHash('sha256').update(`zoom-app-secret:${process.env.ZOOM_CRED_KEY || (await getSecret())}`).digest();
async function seal(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', await sealKey(), iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
async function unseal(sealed) {
  const [iv, tag, enc] = sealed.split('.').map((p) => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', await sealKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export const CUSTOM_APP = 'team';

async function appFor(key) {
  const k = String(key || '1');
  if (k === CUSTOM_APP) {
    const rec = await getRaw(customAppKey());
    if (!rec) return null;
    try {
      return { key: CUSTOM_APP, id: rec.id, secret: await unseal(rec.secret), label: rec.label };
    } catch {
      return null; // the encryption key changed since it was saved — the team must re-enter it
    }
  }
  return zoomApps().find((a) => a.key === k) || null;
}

// What the picker offers this team: the site's shared apps, plus its own if it saved one.
export async function appChoices() {
  const choices = zoomApps().map(({ key, label }) => ({ key, label }));
  const custom = await getRaw(customAppKey());
  if (custom) choices.push({ key: CUSTOM_APP, label: custom.label || 'Your own Zoom app' });
  return choices;
}

// Never includes the Secret.
export async function customAppInfo() {
  const rec = await getRaw(customAppKey());
  return rec ? { client_id: rec.id, label: rec.label || 'Your own Zoom app' } : null;
}

export async function saveCustomApp({ clientId, clientSecret, label }) {
  const account = await loadAccount();
  if (account?.app === CUSTOM_APP) await saveAccount(null); // tokens from the old credentials no longer apply
  await setRaw(customAppKey(), {
    id: clientId,
    secret: await seal(clientSecret),
    label: label || 'Your own Zoom app',
    saved_at: new Date().toISOString(),
  });
}

export async function removeCustomApp() {
  const account = await loadAccount();
  if (account?.app === CUSTOM_APP) await saveAccount(null);
  await delRaw(customAppKey());
}

export const redirectUri = () => REDIRECT_URI;
const REDIRECT_URI = process.env.ZOOM_REDIRECT_URI || `http://localhost:${process.env.PORT || 3000}/auth/zoom/callback`;

// One Zoom connection per team — it's the team's agent's own account. Stored
// through the same backend as everything else (local file / Redis), keyed by
// the team in context.
const accountKey = () => teamKey('zoom_account');

export async function isConfigured() {
  return zoomApps().length > 0 || Boolean(await getRaw(customAppKey()));
}

async function loadAccount() {
  return getRaw(accountKey());
}

async function saveAccount(data) {
  if (data === null) await delRaw(accountKey());
  else await setRaw(accountKey(), data);
}

export async function isConnected() {
  const account = await loadAccount();
  return Boolean(account) && Boolean(await appFor(account.app));
}

export async function connectedEmail() {
  const account = await loadAccount();
  return account?.email || null;
}

export async function disconnect() {
  await saveAccount(null);
}

export async function buildAuthorizeUrl(state, appKey) {
  const app = await appFor(appKey);
  if (!app) throw new Error('That Zoom app is not configured');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: app.id,
    redirect_uri: REDIRECT_URI,
    state,
  });
  return `https://zoom.us/oauth/authorize?${params.toString()}`;
}

async function tokenRequest(body, appKey) {
  const app = await appFor(appKey);
  if (!app) throw new Error('This team is connected through a Zoom app that is no longer configured — reconnect Zoom');
  const basic = Buffer.from(`${app.id}:${app.secret}`).toString('base64');
  const res = await fetch('https://zoom.us/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new Error(`Zoom token request failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function zoomFetch(urlPath, options = {}) {
  const token = await getValidAccessToken();
  const res = await fetch(`https://api.zoom.us/v2${urlPath}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Zoom API ${urlPath} failed (${res.status}): ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function persistTokens(tokens, appKey) {
  const expires_at = Date.now() + tokens.expires_in * 1000;
  const account = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at,
    email: null,
    connected_at: new Date().toISOString(),
    app: String(appKey || '1'), // which Zoom app issued these tokens
  };
  await saveAccount(account);
  try {
    const res = await fetch('https://api.zoom.us/v2/users/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (res.ok) {
      account.email = (await res.json()).email;
      await saveAccount(account);
    }
  } catch {
    // non-fatal — email is just for display
  }
}

export async function exchangeCode(code, appKey) {
  const tokens = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }, appKey);
  await persistTokens(tokens, appKey);
}

async function getValidAccessToken() {
  const account = await loadAccount();
  if (!account) throw new Error('Zoom is not connected');
  if (Date.now() < account.expires_at - 60000) return account.access_token;
  // A connection made before several apps were supported has no `app` and belongs to app 1.
  const tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: account.refresh_token }, account.app);
  await persistTokens(tokens, account.app);
  return (await loadAccount()).access_token;
}

// How the start time is sent. Zoom read "2026-09-30T05:00:00.000Z" as 05:00 in the
// account's own timezone (Singapore) and ignored the Z, storing the meeting 8 hours
// early. So don't depend on how Zoom parses a Z: state the Singapore wall-clock time
// and the timezone outright, which means the same thing however Zoom reads it.
function zoomStart(instant) {
  return { start_time: sgWallClock(instant), timezone: TEAM_TIMEZONE };
}

export async function createMeeting({ topic, startTime, durationMinutes = 45 }) {
  const meeting = await zoomFetch('/users/me/meetings', {
    method: 'POST',
    body: JSON.stringify({
      topic,
      type: 2, // scheduled meeting
      ...zoomStart(startTime),
      duration: durationMinutes,
      settings: { join_before_host: true, waiting_room: false },
    }),
  });
  await assertSameMoment(meeting.start_time, startTime, async () => {
    await zoomFetch(`/meetings/${meeting.id}`, { method: 'DELETE' }).catch(() => {});
  });
  return { id: meeting.id, joinUrl: meeting.join_url, startUrl: meeting.start_url };
}

// Zoom keeps the same join_url when you just move the start time — the
// whole point of updating instead of recreating on reschedule.
// Duration is only sent when explicitly given — meetings booked directly in
// Zoom have their own length (an hour-long interview shouldn't silently
// become 45 minutes just because it moved).
export async function updateMeetingTime(meetingId, { startTime, durationMinutes }) {
  const body = zoomStart(startTime);
  if (durationMinutes) body.duration = durationMinutes;
  await zoomFetch(`/meetings/${meetingId}`, { method: 'PATCH', body: JSON.stringify(body) });
  // Zoom answers a PATCH with nothing, so read the meeting back and confirm it
  // now really starts when we said — the Zoom account must never disagree with the CRM.
  // The read-back is a safety net, never a reason to fail a move that succeeded: if the
  // app's Zoom permissions don't allow reading a single meeting (or Zoom is briefly
  // unavailable), skip the check instead of reporting an error for a change Zoom accepted.
  let after = null;
  try {
    after = await zoomFetch(`/meetings/${meetingId}`);
  } catch (err) {
    console.warn('[zoom] could not read meeting back to verify its time:', err.message);
  }
  await assertSameMoment(after?.start_time, startTime);
}

// Zoom reports start_time as a UTC instant. If it isn't the instant we asked
// for, fail loudly rather than leave the two systems disagreeing.
async function assertSameMoment(zoomStart, wanted, cleanup) {
  if (!zoomStart) return; // nothing to compare (e.g. a recurring meeting)
  if (Math.abs(new Date(zoomStart).getTime() - new Date(wanted).getTime()) < 60000) return;
  if (cleanup) await cleanup();
  throw new Error(`Zoom stored ${zoomStart} instead of ${new Date(wanted).toISOString()} — nothing was saved.`);
}

export async function deleteMeeting(meetingId) {
  await zoomFetch(`/meetings/${meetingId}`, { method: 'DELETE' });
}

// Meetings scheduled directly in Zoom (not through this app) — used to
// surface the agent's real calendar alongside CRM-created meetings.
export async function listMeetings() {
  const data = await zoomFetch('/users/me/meetings?type=upcoming&page_size=300');
  return (data.meetings || []).map((m) => ({
    id: m.id,
    topic: m.topic,
    start_time: m.start_time,
    duration: m.duration,
    join_url: m.join_url,
  }));
}
