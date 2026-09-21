import { getRaw, setRaw, delRaw, teamKey } from './db.js';

const CLIENT_ID = process.env.ZOOM_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;
const REDIRECT_URI = process.env.ZOOM_REDIRECT_URI || `http://localhost:${process.env.PORT || 3000}/auth/zoom/callback`;

// One Zoom connection per team — it's the team's agent's own account. Stored
// through the same backend as everything else (local file / Redis), keyed by
// the team in context.
const accountKey = () => teamKey('zoom_account');

export function isConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

async function loadAccount() {
  return getRaw(accountKey());
}

async function saveAccount(data) {
  if (data === null) await delRaw(accountKey());
  else await setRaw(accountKey(), data);
}

export async function isConnected() {
  return isConfigured() && Boolean(await loadAccount());
}

export async function connectedEmail() {
  const account = await loadAccount();
  return account?.email || null;
}

export async function disconnect() {
  await saveAccount(null);
}

export function buildAuthorizeUrl(state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state,
  });
  return `https://zoom.us/oauth/authorize?${params.toString()}`;
}

async function tokenRequest(body) {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
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

async function persistTokens(tokens) {
  const expires_at = Date.now() + tokens.expires_in * 1000;
  const account = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at,
    email: null,
    connected_at: new Date().toISOString(),
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

export async function exchangeCode(code) {
  const tokens = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
  await persistTokens(tokens);
}

async function getValidAccessToken() {
  const account = await loadAccount();
  if (!account) throw new Error('Zoom is not connected');
  if (Date.now() < account.expires_at - 60000) return account.access_token;
  const tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: account.refresh_token });
  await persistTokens(tokens);
  return (await loadAccount()).access_token;
}

export async function createMeeting({ topic, startTime, durationMinutes = 45 }) {
  const meeting = await zoomFetch('/users/me/meetings', {
    method: 'POST',
    body: JSON.stringify({
      topic,
      type: 2, // scheduled meeting
      start_time: new Date(startTime).toISOString(),
      duration: durationMinutes,
      settings: { join_before_host: true, waiting_room: false },
    }),
  });
  return { id: meeting.id, joinUrl: meeting.join_url, startUrl: meeting.start_url };
}

// Zoom keeps the same join_url when you just move the start time — the
// whole point of updating instead of recreating on reschedule.
// Duration is only sent when explicitly given — meetings booked directly in
// Zoom have their own length (an hour-long interview shouldn't silently
// become 45 minutes just because it moved).
export async function updateMeetingTime(meetingId, { startTime, durationMinutes }) {
  const body = { start_time: new Date(startTime).toISOString() };
  if (durationMinutes) body.duration = durationMinutes;
  await zoomFetch(`/meetings/${meetingId}`, { method: 'PATCH', body: JSON.stringify(body) });
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
