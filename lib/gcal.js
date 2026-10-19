import { getRaw, setRaw, delRaw, teamKey, agentKey } from './db.js';
import { currentTeamId, currentAgentId } from './context.js';
import { firstAgentId } from './accounts.js';

// Link to the agent's Google Calendar (primary calendar). Same shape as
// lib/zoom.js: the agent connects once with their own Google account, the
// tokens live per team, and everything else asks this module for events.
//
// Reads the calendar (so the Caller can see it) and writes ONLY the events this
// app creates for meetings booked in Schedule Hub — it keeps their ids and
// never touches any other event. Scopes: calendar events, plus the account's
// email to show who's connected. A connection made before writing was added
// carries only the read-only scope; it keeps working for reading and reports
// can_write: false until the agent reconnects.

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${process.env.PORT || 3000}/auth/google/callback`;
const SCOPES = 'openid email https://www.googleapis.com/auth/calendar.events';
const WRITE_SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar'];
const EVENT_MINUTES = 45; // same default length as the Zoom meetings

// One Google Calendar connection per Agent (see lib/zoom.js for how a connection made before teams could
// have several Agents is carried over to the first Agent).
const accountKey = () => agentKey('google_account');
const legacyKey = () => teamKey('google_account');
const isLegacyOwner = async () => (await firstAgentId(currentTeamId())) === currentAgentId();

export function isConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

async function loadAccount() {
  const own = await getRaw(accountKey());
  if (own) return own;
  return (await isLegacyOwner()) ? getRaw(legacyKey()) : null;
}

async function saveAccount(data) {
  if (data === null) await delRaw(accountKey());
  else await setRaw(accountKey(), data);
  if (await isLegacyOwner()) await delRaw(legacyKey());
}

// { configured, connected, email, needs_reconnect }. `needs_reconnect` is set
// when Google refused to renew the login (revoked, or a test-mode app's weekly
// expiry) — the record is kept so the UI can say so instead of just going quiet.
export async function status() {
  const account = isConfigured() ? await loadAccount() : null;
  return {
    configured: isConfigured(),
    connected: Boolean(account),
    email: account?.email || null,
    needs_reconnect: Boolean(account?.broken),
    can_write: Boolean(account && !account.broken && account.can_write),
  };
}

export async function disconnect() {
  await saveAccount(null);
  cache.clear();
}

export function buildAuthorizeUrl(state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    access_type: 'offline', // we need a refresh token to keep working after an hour
    prompt: 'consent', // ...and Google only hands one out when asked to consent
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function tokenRequest(body) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...body }),
  });
  if (!res.ok) throw Object.assign(new Error(`Google token request failed (${res.status}): ${await res.text()}`), { status: res.status });
  return res.json();
}

export async function exchangeCode(code) {
  const tokens = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
  if (!tokens.refresh_token) throw new Error('Google did not return a refresh token');
  const account = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
    email: null,
    connected_at: new Date().toISOString(),
    // What Google actually granted (the person can untick permissions on the consent screen).
    can_write: String(tokens.scope || '').split(' ').some((s) => WRITE_SCOPES.includes(s)),
  };
  try {
    const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    if (res.ok) account.email = (await res.json()).email || null;
  } catch {
    // non-fatal — the email is only for display
  }
  await saveAccount(account);
  cache.clear();
}

async function getAccessToken() {
  const account = await loadAccount();
  if (!account || account.broken) throw new Error('Google Calendar is not connected');
  if (Date.now() < account.expires_at - 60000) return account.access_token;
  try {
    const tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: account.refresh_token });
    const updated = { ...account, access_token: tokens.access_token, expires_at: Date.now() + tokens.expires_in * 1000 };
    await saveAccount(updated);
    return updated.access_token;
  } catch (err) {
    // 400/401 = Google won't renew it (revoked, or a test-mode weekly expiry).
    if (err.status === 400 || err.status === 401) await saveAccount({ ...account, broken: true });
    throw err;
  }
}

// Events don't change by the second and the calendar polls often, so answers
// are kept for a minute per team and range.
const cache = new Map();
const CACHE_MS = 60000;

const ZOOM_URL = /zoom\.us\/(?:j|my|w)\/(\d{8,})/gi;
function zoomIdsIn(ev) {
  const text = JSON.stringify([ev.hangoutLink, ev.location, ev.description, ev.conferenceData]);
  return [...text.matchAll(ZOOM_URL)].map((m) => m[1]);
}

function dayAfter(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// One Google event -> one or more calendar items (an all-day event spanning
// several days gets a chip on each day).
function normalize(ev) {
  if (ev.status === 'cancelled') return [];
  if (ev.attendees?.some((a) => a.self && a.responseStatus === 'declined')) return [];
  const base = {
    source: 'google',
    event_id: ev.id,
    title: ev.summary || '(No title)',
    external_url: ev.htmlLink || null,
    transparent: ev.transparency === 'transparent', // "free" — doesn't block time
    zoom_ids: zoomIdsIn(ev),
    contact: null,
    owner: 'Google Calendar',
  };
  if (ev.start?.dateTime) {
    return [{ ...base, id: `gcal-${ev.id}`, scheduled_at: new Date(ev.start.dateTime).toISOString(), end_at: ev.end?.dateTime ? new Date(ev.end.dateTime).toISOString() : null, all_day: false }];
  }
  if (ev.start?.date) {
    const items = [];
    const end = ev.end?.date || dayAfter(ev.start.date, 1); // Google's all-day end date is exclusive
    for (let day = ev.start.date, i = 0; day < end && i < 31; day = dayAfter(day, 1), i++) {
      // Noon UTC keeps the date right in any timezone the browser might be in.
      items.push({ ...base, id: `gcal-${ev.id}-${day}`, scheduled_at: `${day}T12:00:00.000Z`, end_at: null, all_day: true });
    }
    return items;
  }
  return [];
}

// Events between two moments. Never throws: a Google hiccup must not take the
// rest of the calendar down with it. A 401/403 from the events call itself
// (as opposed to the token refresh, already handled in getAccessToken) means
// the token that's stored doesn't actually carry calendar access — almost
// always because it was granted before the "calendar.events.readonly" scope
// was added to the OAuth consent screen, so the connect step "succeeded"
// (the login itself is real) while quietly missing the one permission that
// matters. That's marked broken the same way an expired refresh token is, so
// the UI says "Reconnect" instead of just showing an empty calendar forever.
export async function listEvents({ from, to }) {
  if (!isConfigured()) return [];
  const key = `${currentTeamId()}|${currentAgentId()}|${from.toISOString()}|${to.toISOString()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.events;
  try {
    const account = await loadAccount();
    if (!account) return [];
    const token = await getAccessToken();
    const events = [];
    let pageToken;
    for (let page = 0; page < 4; page++) {
      const params = new URLSearchParams({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '250',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) await saveAccount({ ...account, access_token: token, broken: true });
        throw new Error(`Google Calendar API failed (${res.status}): ${await res.text().catch(() => '')}`);
      }
      const data = await res.json();
      (data.items || []).forEach((ev) => events.push(...normalize(ev)));
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
    cache.set(key, { at: Date.now(), events });
    return events;
  } catch (err) {
    console.error('[gcal] list events failed', err.message);
    return [];
  }
}

// ---------- Writing the meetings this app books ----------
// Every call here can throw; the caller treats a failure as "the meeting is
// booked, but the calendar couldn't be updated" and never lets it undo a booking.
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

async function calendarWrite(method, url, body) {
  const token = await getAccessToken();
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.ok) {
    cache.clear(); // the calendar view must show this straight away
    return res.status === 204 ? null : res.json();
  }
  const text = await res.text().catch(() => '');
  if (res.status === 403 && /insufficient|scope/i.test(text)) {
    const account = await loadAccount();
    if (account) await saveAccount({ ...account, can_write: false }); // reads still work; ask for a reconnect
  }
  throw Object.assign(new Error(`Google Calendar API failed (${res.status}): ${text.slice(0, 200)}`), { status: res.status });
}

// Creates the event, or moves/updates it when `eventId` is given. If Google no
// longer has that event (someone deleted it by hand) a fresh one is made instead.
// Returns the event id.
export async function upsertEvent({ eventId, summary, description, startISO, dealId }) {
  const start = new Date(startISO);
  const body = {
    summary,
    description,
    start: { dateTime: start.toISOString(), timeZone: 'Asia/Singapore' },
    end: { dateTime: new Date(start.getTime() + EVENT_MINUTES * 60000).toISOString(), timeZone: 'Asia/Singapore' },
    // Marks it as ours. No attendees on purpose: Google would email the client an invite.
    extendedProperties: { private: { schedule_hub: '1', deal: String(dealId) } },
    reminders: { useDefault: true },
  };
  if (eventId) {
    try {
      return (await calendarWrite('PATCH', `${CAL}/${encodeURIComponent(eventId)}`, { ...body, status: 'confirmed' })).id;
    } catch (err) {
      if (err.status !== 404 && err.status !== 410) throw err;
    }
  }
  return (await calendarWrite('POST', CAL, body)).id;
}

// Removes an event this app created. Already gone counts as done.
export async function deleteEvent(eventId) {
  try {
    await calendarWrite('DELETE', `${CAL}/${encodeURIComponent(eventId)}`);
  } catch (err) {
    if (err.status !== 404 && err.status !== 410) throw err;
  }
}
