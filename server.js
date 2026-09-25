import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Express 4 does NOT catch rejected promises from async route handlers —
// an unhandled rejection just leaves the request hanging forever with no
// response and no error logged. This patches Express so those rejections
// reach the error-handling middleware below instead.
import 'express-async-errors';

import {
  AuthError,
  createTeamAndAccount,
  joinTeamAndAccount,
  createTeamForAccount,
  joinTeamForAccount,
  leaveTeam,
  login,
  deleteAccount,
  getAccount,
  getTeam,
  sessionInfo,
  forEachTeam,
  requestPasswordReset,
  resetPassword,
  setResetNotificationId,
  formatResetCode,
} from './lib/accounts.js';
import { startSession, endSession, sessionAccountId, setOAuthState, takeOAuthState } from './lib/session.js';
import { withTeam } from './lib/context.js';
import crypto from 'node:crypto';
import {
  listContacts,
  getContact,
  findContactByPhone,
  createContact,
  updateContact,
  deleteContact,
  restoreContact,
  purgeContact,
  listDeletedContacts,
} from './lib/contacts.js';
import {
  STAGES,
  STAGE_LABELS,
  FOLLOWUP_OUTCOMES,
  listDeals,
  getDeal,
  getNextMeeting,
  createDeal,
  moveStage,
  scheduleMeeting,
  cancelMeeting,
  rescheduleMeeting,
  requestReschedule,
  logFollowUp,
  withdrawRescheduleRequest,
  updateDealValue,
  addNote,
  deleteDeal,
  hideDealsForContact,
  restoreDealsForContact,
} from './lib/deals.js';
import { listActivities, logActivity, deleteActivitiesFor } from './lib/activities.js';
import { fetchLeads } from './lib/sheets.js';
import {
  notifyScheduled,
  notifyRescheduleConfirmed,
  notifyRescheduleRequested,
  notifyMeetingDeleted,
  notifyOutcome,
  notifyRemark,
} from './lib/notify.js';
import { listNotifications, markRead, markDone, markAllRead, unreadCount, deleteNotificationsFor, deleteNotification, createNotification, resolveZoomRescheduleRequests, findOpenNotification, reviseNotification } from './lib/notifications.js';
import { readZoomLog, syncZoomLog, setZoomOutcome, forgetZoomMeeting } from './lib/zoomlog.js';
import { recordOnce, recordEvent, recordZoomMeetingsSeen, forgetMeeting, backfillDealRefs, monthlyAnalytics } from './lib/stats.js';
import { buildIcs, googleCalendarLink } from './lib/calendar.js';
import { formatWhen, sgMonthRange, sgNow, TEAM_TZ_PARAM, wallClockProblem } from './lib/tz.js';
import { checkAndSendReminders } from './lib/reminders.js';
import * as zoom from './lib/zoom.js';
import * as gcal from './lib/gcal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Best-effort: free up the agent's Zoom account when a deal falls through.
// Awaited on purpose — on Vercel the function can be frozen the moment the
// response goes out, which would silently leave the Zoom meeting behind.
async function cleanupZoomMeeting(dealBefore) {
  if (!dealBefore?.zoom_meeting_id) return;
  try {
    if (await zoom.isConnected()) await zoom.deleteMeeting(dealBefore.zoom_meeting_id);
  } catch (err) {
    console.error('[zoom] cleanup failed', err.message);
  }
}

// Meetings the agent booked directly in Zoom (interviews, etc.) rather than
// through the CRM pipeline — shown read-only alongside CRM meetings so the
// Meetings tab reflects the agent's real calendar, not just sales deals.
async function getZoomOnlyMeetings(linkedZoomMeetingIds) {
  if (!(await zoom.isConnected())) return [];

  // Zoom's list is only what's still upcoming. If it can't be reached, fall back
  // on what we remembered so the calendar doesn't lose its history too.
  let live = null;
  try {
    live = (await zoom.listMeetings()).filter((m) => !linkedZoomMeetingIds.has(m.id));
    await recordZoomMeetingsSeen(live.map((m) => m.id));
  } catch (err) {
    console.error('[zoom] list meetings failed', err.message);
  }
  let log;
  if (live) {
    log = await syncZoomLog(live);
  } else {
    const now = Date.now();
    const entries = await readZoomLog();
    log = { byId: new Map(entries.map((e) => [String(e.zoom_id), e])), past: entries.filter((e) => new Date(e.start_time).getTime() <= now) };
  }

  // With no deal to hang state on, an open request or logged outcome for one
  // of these lives in the notifications — surface it so the agent can edit it.
  const open = await listNotifications({ status: 'new' });
  const latest = (type) => {
    const byMeeting = new Map();
    open.filter((n) => n.type === type && n.meta?.zoom_meeting_id != null).forEach((n) => {
      if (!byMeeting.has(String(n.meta.zoom_meeting_id))) byMeeting.set(String(n.meta.zoom_meeting_id), n); // newest first
    });
    return byMeeting;
  };
  const requests = latest('reschedule_requested');
  const outcomes = latest('meeting_outcome');

  const shape = (zoomId, topic, startTime, joinUrl, isPast) => {
    const req = isPast ? null : requests.get(String(zoomId));
    const openOutcome = outcomes.get(String(zoomId));
    const kept = log.byId.get(String(zoomId))?.outcome;
    const key = kept?.key || openOutcome?.meta?.outcome;
    return {
      id: `zoom-${zoomId}`,
      source: 'zoom',
      title: topic,
      zoom_link: joinUrl,
      scheduled_at: startTime,
      contact: null,
      owner: 'Zoom',
      reschedule_requested: req ? { remark: req.meta.remark, requested_by: req.from_name, requested_at: req.created_at } : null,
      // Kept with the meeting so it still shows once the meeting is over; only
      // editable while the caller hasn't acted on it (their notification is open).
      outcome: key ? { key, label: FOLLOWUP_OUTCOMES[key]?.label || key, note: kept?.note ?? openOutcome?.meta?.note ?? '' } : null,
      outcome_editable: Boolean(openOutcome),
    };
  };

  const liveShaped = (live || []).map((m) => shape(m.id, m.topic, m.start_time, m.join_url, false));
  const pastShaped = log.past
    .filter((e) => !linkedZoomMeetingIds.has(e.zoom_id))
    .map((e) => shape(e.zoom_id, e.topic, e.start_time, '', true));
  return liveShaped.concat(pastShaped);
}

// Earlier meetings on a deal that were replaced by a newer booking — they
// happened, so they stay on the calendar as history.
async function pastMeetingsOf(deals) {
  const out = [];
  for (const d of deals) {
    const contact = (d.past_meetings || []).length ? await getContact(d.contact_id) : null;
    (d.past_meetings || []).forEach((h, i) =>
      out.push({
        id: `hist-${d.id}-${i}`,
        source: 'history',
        deal_id: d.id,
        scheduled_at: h.scheduled_at,
        zoom_link: '',
        contact,
        owner: d.owner,
        outcome: h.outcome || null,
        reschedule_requested: null,
      })
    );
  }
  return out;
}

// Books a meeting on a deal: creates the real Zoom meeting when Zoom is
// connected (or uses the manual link), stamps the deal, and tells the other
// role. Shared by "schedule" on an existing deal and "add contact + schedule".
// Throws an error carrying an HTTP status so each caller can report it.
async function bookMeeting(deal, contact, { scheduled_at, zoom_link, changed_by }) {
  const previousMeetingId = deal.zoom_meeting_id; // a meeting this deal already had, if any
  let link = zoom_link;
  let meetingId = null;
  if (!link && (await zoom.isConnected())) {
    try {
      const meeting = await zoom.createMeeting({ topic: `Call with ${contact?.name || 'client'}`, startTime: scheduled_at });
      link = meeting.joinUrl;
      meetingId = meeting.id;
    } catch (err) {
      throw Object.assign(new Error(`Zoom meeting creation failed: ${err.message}`), { status: 502 });
    }
  }
  if (!link) throw Object.assign(new Error('zoom_link required (or connect Zoom to auto-generate one)'), { status: 400 });

  const booked = await scheduleMeeting(deal.id, { zoom_link: link, zoom_meeting_id: meetingId, scheduled_at, changed_by });
  // Scheduling again on a deal that already had a Zoom meeting replaces it:
  // delete the old one so only the new meeting is left in the agent's Zoom.
  if (previousMeetingId && previousMeetingId !== meetingId) await cleanupZoomMeeting({ zoom_meeting_id: previousMeetingId });
  await recordOnce('fixed', booked.stat_ref);
  await notifyScheduled(booked, changed_by);
  return booked;
}

// ---------- Accounts & teams ----------
// Public: sign up (start a team, or join one with its invite code) and log in.
// Everything registered after the gate below needs a valid session.
async function respondWithSession(req, res, { account, team }, status = 200) {
  await startSession(req, res, account.id);
  res.status(status).json(await sessionInfo(account, team));
}

app.post('/api/auth/signup', async (req, res) => {
  const body = req.body || {};
  const result = body.mode === 'join' ? await joinTeamAndAccount(body) : await createTeamAndAccount(body);
  await respondWithSession(req, res, result, 201);
});

app.post('/api/auth/login', async (req, res) => {
  await respondWithSession(req, res, await login(req.body || {}));
});

app.post('/api/auth/logout', (req, res) => {
  endSession(req, res);
  res.json({ ok: true });
});

// Forgot password, step 1: no email in this app, so the code goes to whoever
// else is in the account's team as an in-app notification, for them to relay
// out of band. Always answers the same generic way — it never says whether the
// email matched an account, let alone whether that account has a teammate.
app.post('/api/auth/forgot-password', async (req, res) => {
  const result = await requestPasswordReset(req.body?.email);
  if (result.notified) {
    await withTeam(result.teamId, async () => {
      const message = `${result.accountName} forgot their password. Give them this code (valid ${15} minutes): ${formatResetCode(result.code)}`;
      let notif = result.priorNotificationId ? await reviseNotification(result.priorNotificationId, { message }) : null;
      if (!notif) notif = await createNotification({ type: 'password_reset', message, from_name: result.accountName });
      await setResetNotificationId(result.accountId, notif.id);
    });
  }
  res.json({
    ok: true,
    message: "If that email belongs to an account with a teammate already signed in, they now have a code to pass on to you.",
  });
});

// Forgot password, step 2: the code plus a new password.
app.post('/api/auth/reset-password', async (req, res) => {
  const result = await resetPassword(req.body || {});
  if (result.notificationId && result.account.team_id) {
    await withTeam(result.account.team_id, () => markDone(result.notificationId));
  }
  await respondWithSession(req, res, result);
});

// The logged-in account, or a 401. These account routes sit above the gate
// because they must also work for someone who's between teams.
async function sessionAccount(req, res) {
  const accountId = await sessionAccountId(req, res);
  const account = accountId && (await getAccount(accountId));
  if (!account) throw new AuthError('not_logged_in', 401);
  return account;
}

app.get('/api/auth/me', async (req, res) => {
  const account = await sessionAccount(req, res);
  res.json(await sessionInfo(account, account.team_id ? await getTeam(account.team_id) : null));
});

// Someone with a login but no team (they just left one) starts or joins one.
app.post('/api/auth/team', async (req, res) => {
  const account = await sessionAccount(req, res);
  const body = req.body || {};
  const { account: seated, team } =
    body.mode === 'join' ? await joinTeamForAccount(account, body) : await createTeamForAccount(account, body);
  res.status(201).json(await sessionInfo(seated, team));
});

// Leave the team but keep the login.
app.post('/api/auth/leave', async (req, res) => {
  const account = await sessionAccount(req, res);
  const left = await leaveTeam(account);
  await withTeam(left.teamId, () =>
    createNotification({
      type: 'member_left',
      message: `${left.name} (${left.role === 'agent' ? 'Agent' : 'Caller'}) left the team. Share the invite code to fill the seat.`,
    })
  );
  res.json(await sessionInfo(await getAccount(account.id), null));
});

// Delete the login itself (asks for the password again).
app.delete('/api/auth/account', async (req, res) => {
  const account = await sessionAccount(req, res);
  const left = await deleteAccount(account, req.body?.password);
  if (left) {
    await withTeam(left.teamId, () =>
      createNotification({
        type: 'member_left',
        message: `${left.name} (${left.role === 'agent' ? 'Agent' : 'Caller'}) deleted their account and left the team. Share the invite code to fill the seat.`,
      })
    );
  }
  endSession(req, res);
  res.json({ ok: true });
});

// ---------- Reminders ----------
// Locally, a setInterval keeps checking in the background (see below).
// On Vercel there's no persistent process to run a timer in, so this same
// check is instead triggered by Vercel Cron hitting this route (configured
// in vercel.json). Protected by CRON_SECRET so randoms can't spam it. It has
// no user behind it, so it runs the check for every team in turn.
app.get('/api/cron/reminders', async (req, res) => {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  await checkAllTeamsReminders();
  res.json({ ok: true });
});

async function checkAllTeamsReminders() {
  await forEachTeam(async () => {
    await checkAndSendReminders();
    // Note any Zoom-only interviews before they pass and drop out of Zoom's list.
    try {
      const linked = new Set((await listDeals()).filter((d) => d.zoom_meeting_id).map((d) => d.zoom_meeting_id));
      await getZoomOnlyMeetings(linked);
    } catch (err) {
      console.error('[stats] zoom sync failed', err.message);
    }
  });
}

// ---------- The gate ----------
// From here down every request must carry a valid session. It also puts the
// request "inside" the caller's team, which is what keeps one team's contacts,
// deals and Zoom link invisible to another.
app.use(async (req, res, next) => {
  const accountId = await sessionAccountId(req, res);
  const account = accountId && (await getAccount(accountId));
  if (!account) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'not_logged_in' });
    return res.redirect('/');
  }
  if (!account.team_id) {
    // Logged in but not in a team (just left one): nothing here to show them.
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'no_team' });
    return res.redirect('/');
  }
  req.user = account;
  // Who did something is whoever is logged in — never a name the browser sent.
  if (req.body && typeof req.body === 'object') {
    for (const key of ['changed_by', 'requested_by', 'made_by', 'deleted_by', 'created_by']) {
      if (key in req.body) req.body[key] = account.name;
    }
  }
  withTeam(account.team_id, next);
});

// Server-side role check for the routes each role's page is built around, so
// hiding a tab is not the only thing stopping the other role.
function requireRole(role) {
  return (req, res, next) => {
    if (req.user.role !== role) {
      return res.status(403).json({ error: `Only the ${role === 'agent' ? 'Agent' : 'Caller'} can do this.` });
    }
    next();
  };
}
const callerOnly = requireRole('caller');
const agentOnly = requireRole('agent');

app.get('/api/leads', async (req, res) => res.json(await fetchLeads()));

app.post('/api/leads/import', callerOnly, async (req, res) => {
  const created_by = req.body?.created_by || 'caller';
  const leads = await fetchLeads();
  const created = [];
  for (const lead of leads) {
    if (!lead.phone || (await findContactByPhone(lead.phone))) continue;
    const contact = await createContact({
      name: lead.name,
      phone: lead.phone,
      notes: lead.notes,
      source: 'google_sheet',
      created_by,
    });
    const deal = await createDeal({ contact_id: contact.id, title: `${contact.name} — new lead`, created_by });
    created.push({ contact, deal });
  }
  res.json({ imported: created.length, created });
});

// ---------- Contacts ----------
app.get('/api/contacts', async (req, res) => res.json(await listContacts({ q: req.query.q })));

// Lets the form warn about a duplicate number while it's still being typed.
app.get('/api/contacts/duplicate', async (req, res) => {
  const existing = await findContactByPhone(req.query.phone, { excludeId: req.query.exclude });
  res.json({ existing: existing ? { id: existing.id, name: existing.name, phone: existing.phone } : null });
});

function duplicatePhoneResponse(res, existing) {
  return res.status(409).json({
    error: 'duplicate_phone',
    message: `${existing.name} already has this number (${existing.phone}).`,
    existing: { id: existing.id, name: existing.name, phone: existing.phone },
  });
}

// Refuses any time-setting request whose typed wall-clock and stored instant disagree
// (see wallClockProblem in lib/tz.js).
const timeChecked = (req, res, next) => {
  const problem = wallClockProblem(req.body);
  if (problem) return res.status(409).json({ error: problem });
  next();
};

app.post('/api/contacts', callerOnly, timeChecked, async (req, res) => {
  const { name, phone, email, company, notes, created_by, scheduled_at, zoom_link } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const duplicate = await findContactByPhone(phone);
  if (duplicate) return duplicatePhoneResponse(res, duplicate);
  const contact = await createContact({ name, phone, email, company, notes, created_by });
  let deal = await createDeal({ contact_id: contact.id, title: `${contact.name}`, created_by });
  // Optional: book the meeting in the same step. If Zoom refuses, the contact
  // is still saved (nothing to roll back) and the error is handed back so the
  // caller can retry the booking from the deal.
  let meeting_error = null;
  if (scheduled_at) {
    try {
      deal = await bookMeeting(deal, contact, { scheduled_at, zoom_link, changed_by: created_by });
    } catch (err) {
      meeting_error = err.message;
    }
  }
  res.status(201).json({ contact, deal, meeting_error });
});

// Must be registered before '/api/contacts/:id' below, or Express would match
// "deleted" as an :id and this route would never be reached.
app.get('/api/contacts/deleted', async (req, res) => res.json(await listDeletedContacts()));

app.get('/api/contacts/:id', async (req, res) => {
  const contact = await getContact(req.params.id);
  if (!contact) return res.status(404).json({ error: 'not found' });
  res.json(contact);
});

app.patch('/api/contacts/:id', async (req, res) => {
  if (req.body?.phone) {
    const duplicate = await findContactByPhone(req.body.phone, { excludeId: req.params.id });
    if (duplicate) return duplicatePhoneResponse(res, duplicate);
  }
  const contact = await updateContact(req.params.id, req.body || {});
  if (!contact) return res.status(404).json({ error: 'not found' });
  res.json(contact);
});

// Deletes a contact — softly. It disappears from the Contacts list, Pipeline
// and Meetings along with its deals, and any real Zoom meetings those deals
// held are cancelled right away (that part can't be undone — Arron's actual
// calendar has to reflect it immediately). Everything else (the contact
// record, its deals, notes and activity history) stays and can be brought
// back from Contacts → Deleted. Open to both roles, same as it always was —
// removing a bad record isn't Caller-only the way adding one is.
app.delete('/api/contacts/:id', async (req, res) => {
  const contact = await getContact(req.params.id);
  if (!contact) return res.status(404).json({ error: 'not found' });
  const deals = await listDeals({ contact_id: contact.id });
  for (const deal of deals) {
    await cleanupZoomMeeting(deal);
    await forgetMeeting(deal.stat_ref);
  }
  await hideDealsForContact(contact.id);
  await deleteContact(contact.id, req.body?.deleted_by);
  // Only worth a heads-up if it wiped out meetings on someone's calendar. Sent
  // after the cascade, with no deal/contact ids, so the cascade can't eat it.
  const cancelled = deals.filter((d) => d.scheduled_at).length;
  if (cancelled) {
    const by = req.body?.deleted_by;
    await createNotification({
      type: 'contact_deleted',
      deal_id: null,
      contact_id: null,
      message: `${by || 'Someone'} deleted ${contact.name}, which cancelled ${cancelled} booked meeting${cancelled > 1 ? 's' : ''}. Restorable from Contacts → Deleted.`,
      from_name: by,
    });
  }
  res.json({ deleted: true, contact_id: contact.id, deals_removed: deals.length });
});

// The Deleted view and its two actions: bring a contact back, or remove it
// (and its deals/activities/notifications) for good. Open to both roles,
// matching the delete route itself.
app.post('/api/contacts/:id/restore', async (req, res) => {
  const contact = await getContact(req.params.id);
  if (!contact?.deleted_at) return res.status(404).json({ error: 'not found' });
  const restoredDeals = await restoreDealsForContact(contact.id);
  const restored = await restoreContact(contact.id);
  res.json({ ...restored, deals_restored: restoredDeals });
});

app.delete('/api/contacts/:id/forever', async (req, res) => {
  const contact = await getContact(req.params.id);
  if (!contact?.deleted_at) return res.status(404).json({ error: 'Only an already-deleted contact can be removed for good.' });
  const deals = await listDeals({ contact_id: contact.id, includeDeleted: true });
  for (const deal of deals) {
    await deleteDeal(deal.id);
    await deleteActivitiesFor({ deal_id: deal.id });
    await deleteNotificationsFor({ deal_id: deal.id });
  }
  await deleteActivitiesFor({ contact_id: contact.id });
  await deleteNotificationsFor({ contact_id: contact.id });
  await purgeContact(contact.id);
  res.json({ purged: true, contact_id: contact.id });
});

// ---------- Deals / pipeline ----------
app.get('/api/deals', async (req, res) => {
  const deals = await listDeals({ stage: req.query.stage, contact_id: req.query.contact_id });
  const withExtras = await Promise.all(
    deals.map(async (d) => ({
      ...d,
      contact: await getContact(d.contact_id),
    }))
  );
  res.json(withExtras);
});
app.get('/api/deals/next', async (req, res) => {
  const deal = await getNextMeeting();
  res.json(deal ? { ...deal, contact: await getContact(deal.contact_id) } : null);
});
app.get('/api/stages', (req, res) => res.json(STAGES.map((s) => ({ key: s, label: STAGE_LABELS[s] }))));

// Any deal with a scheduled time, regardless of pipeline stage — a
// dedicated "Meetings" view instead of hunting through kanban columns.
app.get('/api/meetings', async (req, res) => {
  const when = req.query.when || 'all';
  const now = Date.now();
  const inRange = (m) => {
    const t = new Date(m.scheduled_at).getTime();
    return when === 'upcoming' ? t > now : when === 'past' ? t <= now : true;
  };
  const allDeals = (await listDeals()).filter((d) => d.scheduled_at);
  const withContacts = await Promise.all(
    allDeals
      .filter(inRange)
      // A lost deal's real Zoom meeting is already cancelled — there's nothing
      // left to attend, even if its stored time technically hasn't passed yet.
      .filter((d) => when !== 'upcoming' || d.stage !== 'lost')
      .map(async (d) => ({ ...d, contact: await getContact(d.contact_id) }))
  );
  const linkedIds = new Set(allDeals.filter((d) => d.zoom_meeting_id).map((d) => d.zoom_meeting_id));
  const zoomOnly = (await getZoomOnlyMeetings(linkedIds)).filter(inRange);
  const history = (await pastMeetingsOf(await listDeals())).filter(inRange);
  const combined = withContacts.concat(zoomOnly, history);
  combined.sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));
  res.json(combined);
});

app.get('/api/deals/:id', async (req, res) => {
  const deal = await getDeal(req.params.id);
  if (!deal) return res.status(404).json({ error: 'not found' });
  res.json({
    ...deal,
    contact: await getContact(deal.contact_id),
    activities: await listActivities({ deal_id: deal.id }),
  });
});

app.post('/api/deals/:id/stage', async (req, res) => {
  const before = await getDeal(req.params.id);
  const deal = await moveStage(req.params.id, req.body || {});
  if (!deal) return res.status(404).json({ error: 'invalid deal or stage' });
  if (deal.stage === 'lost') await cleanupZoomMeeting(before);
  res.json(deal);
});

app.post('/api/deals/:id/schedule', callerOnly, timeChecked, async (req, res) => {
  const { zoom_link, scheduled_at, changed_by } = req.body;
  if (!scheduled_at) return res.status(400).json({ error: 'scheduled_at required' });
  const existing = await getDeal(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  try {
    res.json(await bookMeeting(existing, await getContact(existing.contact_id), { scheduled_at, zoom_link, changed_by }));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Deletes the meeting (cancels the real Zoom meeting first) but keeps the
// contact/deal — distinct from deleting the contact entirely.
app.delete('/api/deals/:id/meeting', callerOnly, async (req, res) => {
  const before = await getDeal(req.params.id);
  if (!before) return res.status(404).json({ error: 'not found' });
  await cleanupZoomMeeting(before);
  await forgetMeeting(before.stat_ref);
  const deal = await cancelMeeting(req.params.id, { changed_by: req.body?.changed_by });
  if (before.scheduled_at) await notifyMeetingDeleted(before, req.body?.changed_by);
  res.json(deal);
});

app.post('/api/deals/:id/reschedule', callerOnly, timeChecked, async (req, res) => {
  const { scheduled_at, zoom_link, changed_by } = req.body;
  if (!scheduled_at) return res.status(400).json({ error: 'scheduled_at required' });
  const existing = await getDeal(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  // If this meeting's Zoom event is ours to manage, just move its time —
  // the join link stays exactly the same, nothing to re-share.
  if (!zoom_link && (await zoom.isConnected()) && existing.zoom_meeting_id) {
    try {
      await zoom.updateMeetingTime(existing.zoom_meeting_id, { startTime: scheduled_at });
    } catch (err) {
      return res.status(502).json({ error: `Zoom meeting update failed: ${err.message}` });
    }
  }

  // Switching to a link typed in by hand: the Zoom meeting we made is no longer
  // the one in use, so remove it rather than leave it in the agent's Zoom.
  if (zoom_link && existing.zoom_meeting_id) await cleanupZoomMeeting(existing);

  await backfillDealRefs([existing]);
  const deal = await rescheduleMeeting(req.params.id, { scheduled_at, zoom_link, changed_by });
  await recordEvent('rescheduled', (await getDeal(deal.id)).stat_ref);
  await notifyRescheduleConfirmed(deal, changed_by);
  res.json(deal);
});

// The agent flags a problem with a remark; the caller is the one who
// actually picks the new time via the /reschedule route above.
app.post('/api/deals/:id/request-reschedule', agentOnly, async (req, res) => {
  const { remark, requested_by } = req.body;
  if (!remark) return res.status(400).json({ error: 'remark required' });
  const before = await getDeal(req.params.id);
  if (!before) return res.status(404).json({ error: 'not found' });
  const isEdit = Boolean(before.reschedule_requested);
  const deal = await requestReschedule(req.params.id, { remark, requested_by });
  // Sending again while the caller hasn't acted just changes the wording of the
  // request they already have, instead of piling up a second one.
  const open = isEdit ? await findOpenNotification({ type: 'reschedule_requested', deal_id: deal.id }) : null;
  if (open) {
    const contact = await getContact(deal.contact_id);
    await reviseNotification(open.id, {
      message: `${requested_by} changed the reschedule request for ${contact?.name || 'a client'}: "${remark}". Needs a new time.`,
    });
  } else {
    await notifyRescheduleRequested(deal, remark, requested_by);
  }
  res.json(deal);
});

// The agent changed their mind before the caller picked a new time.
app.delete('/api/deals/:id/request-reschedule', agentOnly, async (req, res) => {
  const before = await getDeal(req.params.id);
  if (!before?.reschedule_requested) return res.status(404).json({ error: 'There is no open reschedule request.' });
  const by = req.user.name;
  const deal = await withdrawRescheduleRequest(req.params.id, { by });
  const open = await findOpenNotification({ type: 'reschedule_requested', deal_id: deal.id });
  if (open) await markDone(open.id);
  const contact = await getContact(deal.contact_id);
  await createNotification({
    type: 'reschedule_withdrawn',
    deal_id: deal.id,
    contact_id: deal.contact_id,
    message: `${by} withdrew the reschedule request for ${contact?.name || 'a client'} — the meeting stays as booked.`,
    from_name: by,
  });
  res.json(deal);
});

// Meetings booked directly in Zoom have no deal to attach a reschedule flag
// to, so this just raises a notification for whoever manages the calendar —
// they'll need to move it in Zoom itself, this app has no reach into it.
app.post('/api/zoom-meetings/:meetingId/request-reschedule', agentOnly, async (req, res) => {
  const { remark, requested_by, topic, scheduled_at } = req.body;
  if (!remark) return res.status(400).json({ error: 'remark required' });
  const when = scheduled_at ? formatWhen(scheduled_at) : 'the scheduled time';
  const meta = { zoom_meeting_id: req.params.meetingId, topic: topic || null, scheduled_at: scheduled_at || null, remark };
  const open = await findOpenNotification({ type: 'reschedule_requested', zoom_meeting_id: req.params.meetingId });
  if (open) {
    await reviseNotification(open.id, {
      message: `${requested_by} changed the reschedule request for "${topic || 'a Zoom meeting'}" (${when}): "${remark}". Needs a new time.`,
      meta,
    });
  } else {
    await createNotification({
      type: 'reschedule_requested',
      deal_id: null,
      contact_id: null,
      message: `${requested_by || 'Someone'} asked to reschedule "${topic || 'a Zoom meeting'}" (${when}): "${remark}". Needs a new time.`,
      from_name: requested_by,
      meta,
    });
  }
  res.json({ ok: true });
});

app.delete('/api/zoom-meetings/:meetingId/request-reschedule', agentOnly, async (req, res) => {
  const open = await findOpenNotification({ type: 'reschedule_requested', zoom_meeting_id: req.params.meetingId });
  if (!open) return res.status(404).json({ error: 'There is no open reschedule request.' });
  await markDone(open.id);
  const by = req.user.name;
  await createNotification({
    type: 'reschedule_withdrawn',
    deal_id: null,
    contact_id: null,
    message: `${by} withdrew the reschedule request for "${req.body?.topic || open.meta?.topic || 'a Zoom meeting'}" — the meeting stays as booked.`,
    from_name: by,
  });
  res.json({ ok: true });
});

app.get('/api/followup-outcomes', (req, res) => {
  res.json(Object.entries(FOLLOWUP_OUTCOMES).map(([key, v]) => ({ key, label: v.label })));
});

// Same idea as a deal's meeting follow-up, but for a Zoom-only meeting with
// no deal to update the stage on — this just records how it went.
app.post('/api/zoom-meetings/:meetingId/outcome', agentOnly, async (req, res) => {
  const { outcome, note, made_by, topic, scheduled_at } = req.body;
  const config = FOLLOWUP_OUTCOMES[outcome];
  if (!config) return res.status(400).json({ error: 'invalid outcome' });
  const when = scheduled_at ? formatWhen(scheduled_at) : 'the scheduled time';
  const meta = { zoom_meeting_id: req.params.meetingId, outcome, note: note || '', topic: topic || null, scheduled_at: scheduled_at || null };
  const noteText = note ? ` Notes: ${note}` : '';
  // Logging again while the caller hasn't acted on it replaces the earlier entry.
  const open = await findOpenNotification({ type: 'meeting_outcome', zoom_meeting_id: req.params.meetingId });
  if (open) {
    await reviseNotification(open.id, {
      message: `${made_by} changed the outcome of "${topic || 'a Zoom meeting'}" (${when}) to: ${config.label}.${noteText}`,
      meta,
    });
  } else {
    await createNotification({
      type: 'meeting_outcome',
      deal_id: null,
      contact_id: null,
      message: `${made_by || 'Someone'} logged "${topic || 'a Zoom meeting'}" (${when}) as: ${config.label}.${noteText}`,
      from_name: made_by,
      meta,
    });
  }
  await setZoomOutcome(req.params.meetingId, { topic, start_time: scheduled_at }, { key: outcome, note: note || '', logged_at: new Date().toISOString() });
  await recordOnce('attended', `zoom-${req.params.meetingId}`);
  res.json({ ok: true });
});

app.post('/api/zoom-meetings/:meetingId/reschedule', callerOnly, timeChecked, async (req, res) => {
  const { scheduled_at, changed_by, topic } = req.body || {};
  if (!scheduled_at) return res.status(400).json({ error: 'scheduled_at required' });
  if (!(await zoom.isConnected())) return res.status(400).json({ error: 'Zoom not connected' });
  try {
    await zoom.updateMeetingTime(req.params.meetingId, { startTime: scheduled_at });
  } catch (err) {
    return res.status(502).json({ error: `Zoom reschedule failed: ${err.message}` });
  }
  await createNotification({
    type: 'rescheduled',
    deal_id: null,
    contact_id: null,
    message: `${changed_by || 'Someone'} moved "${topic || 'a Zoom meeting'}" to ${formatWhen(scheduled_at)}.`,
    from_name: changed_by,
  });
  await resolveZoomRescheduleRequests(req.params.meetingId);
  await recordOnce('fixed', `zoom-${req.params.meetingId}`);
  await recordEvent('rescheduled', `zoom-${req.params.meetingId}`);
  res.json({ ok: true });
});

app.delete('/api/zoom-meetings/:meetingId', callerOnly, async (req, res) => {
  if (!(await zoom.isConnected())) return res.status(400).json({ error: 'Zoom not connected' });
  try {
    await zoom.deleteMeeting(req.params.meetingId);
  } catch (err) {
    return res.status(502).json({ error: `Zoom delete failed: ${err.message}` });
  }
  const { deleted_by, topic, scheduled_at } = req.body || {};
  await createNotification({
    type: 'meeting_deleted',
    deal_id: null,
    contact_id: null,
    message: `${deleted_by || 'Someone'} deleted "${topic || 'a Zoom meeting'}"${
      scheduled_at ? ` (${formatWhen(scheduled_at)})` : ''
    } from Zoom.`,
    from_name: deleted_by,
  });
  await resolveZoomRescheduleRequests(req.params.meetingId);
  await forgetMeeting(`zoom-${req.params.meetingId}`);
  await forgetZoomMeeting(req.params.meetingId); // deleted on purpose: not history
  res.json({ ok: true });
});

app.post('/api/deals/:id/followup', agentOnly, async (req, res) => {
  const { outcome, note, changed_by } = req.body;
  const before = await getDeal(req.params.id);
  if (!before) return res.status(404).json({ error: 'not found' });
  // Only while there's a meeting to log, or an earlier outcome to change (the
  // caller booking, moving or deleting the meeting clears it — then it's locked).
  if (before.stage !== 'meeting_booked' && !before.outcome) {
    return res.status(400).json({ error: 'There is no meeting to log an outcome for.' });
  }
  const isEdit = Boolean(before.outcome);
  const deal = await logFollowUp(req.params.id, { outcome, note, changed_by });
  if (!deal) return res.status(400).json({ error: 'invalid deal or outcome' });
  if (deal.stage === 'lost') await cleanupZoomMeeting(before);
  await backfillDealRefs([before]);
  await recordOnce('attended', (await getDeal(deal.id)).stat_ref);
  const label = FOLLOWUP_OUTCOMES[outcome].label;
  const open = isEdit ? await findOpenNotification({ type: 'meeting_outcome', deal_id: deal.id }) : null;
  if (open) {
    const contact = await getContact(deal.contact_id);
    await reviseNotification(open.id, {
      message: `${changed_by} changed the outcome of the meeting with ${contact?.name || 'a client'} to: ${label}.${note ? ` Notes: ${note}` : ''}`,
    });
  } else {
    await notifyOutcome(deal, label, note, changed_by);
  }
  res.json(deal);
});

app.post('/api/deals/:id/value', async (req, res) => {
  const deal = await updateDealValue(req.params.id, req.body || {});
  if (!deal) return res.status(404).json({ error: 'not found' });
  res.json(deal);
});


app.post('/api/deals/:id/note', async (req, res) => {
  const deal = await addNote(req.params.id, req.body || {});
  if (!deal) return res.status(404).json({ error: 'not found' });
  if (req.body?.note) await notifyRemark(deal, req.body.note, req.body.changed_by);
  res.json(deal);
});

app.get('/api/deals/:id/activities', async (req, res) => res.json(await listActivities({ deal_id: req.params.id })));

// ---------- Calendar export ----------
app.get('/api/deals/:id/calendar.ics', async (req, res) => {
  const deal = await getDeal(req.params.id);
  if (!deal || !deal.scheduled_at) return res.status(404).send('No scheduled meeting for this deal.');
  const contact = await getContact(deal.contact_id);
  const ics = buildIcs({
    uid: `deal-${deal.id}`,
    title: `Call with ${contact?.name || 'client'}`,
    description: deal.zoom_link ? `Zoom: ${deal.zoom_link}` : '',
    location: deal.zoom_link,
    start: deal.scheduled_at,
  });
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="deal-${deal.id}.ics"`);
  res.send(ics);
});

app.get('/api/deals/:id/calendar-link', async (req, res) => {
  const deal = await getDeal(req.params.id);
  if (!deal || !deal.scheduled_at) return res.status(404).json({ error: 'no scheduled meeting' });
  const contact = await getContact(deal.contact_id);
  res.json({
    googleCalendarUrl: googleCalendarLink({
      title: `Call with ${contact?.name || 'client'}`,
      description: deal.zoom_link ? `Zoom: ${deal.zoom_link}` : '',
      location: deal.zoom_link,
      start: deal.scheduled_at,
    }),
    icsUrl: `/api/deals/${deal.id}/calendar.ics`,
  });
});

// ---------- Summary: reschedule requests (Caller's Summary) ----------
// What the agent has asked to move, and why. Deal-based requests come from the
// deals themselves (they clear as soon as the Caller picks a new time);
// requests on Zoom-only meetings exist only as notifications, so those are
// read from the still-open ones.
app.get('/api/summary/reschedule-requests', async (req, res) => {
  const deals = (await listDeals()).filter((d) => d.reschedule_requested);
  const items = await Promise.all(
    deals.map(async (d) => ({
      kind: 'deal',
      deal_id: d.id,
      name: (await getContact(d.contact_id))?.name || 'unknown',
      scheduled_at: d.scheduled_at,
      remark: d.reschedule_requested.remark,
      requested_by: d.reschedule_requested.requested_by,
      requested_at: d.reschedule_requested.requested_at,
    }))
  );
  const zoomRequests = (await listNotifications({ role: 'caller', status: 'new' })).filter(
    (n) => n.type === 'reschedule_requested' && n.meta?.zoom_meeting_id != null
  );
  zoomRequests.forEach((n) =>
    items.push({
      kind: 'zoom',
      notification_id: n.id,
      zoom_meeting_id: n.meta.zoom_meeting_id,
      name: n.meta.topic || 'Zoom meeting',
      scheduled_at: n.meta.scheduled_at,
      remark: n.meta.remark,
      requested_by: n.from_name,
      requested_at: n.created_at,
    })
  );
  items.sort((a, b) => new Date(b.requested_at) - new Date(a.requested_at));
  res.json(items);
});

app.get('/api/summary/activities', async (req, res) => {
  const limit = Number(req.query.limit) || 12;
  const activities = (await listActivities()).slice(0, limit);
  const withContacts = await Promise.all(
    activities.map(async (a) => ({ ...a, contact: a.contact_id ? await getContact(a.contact_id) : null }))
  );
  res.json(withContacts);
});

// Every meeting in a month, so the Summary calendar (both roles) can show
// which days have meetings without one request per day.
// The agent's Google Calendar events for a stretch of time, ready to sit next to
// the Zoom meetings. Anything that is really one of the Zoom meetings already
// listed (a Google event with a Zoom link, e.g. from Zoom's Calendar add-on) is
// dropped so it isn't shown twice. Only the caller gets these: the agent wants a
// clean calendar of Zoom meetings, so nothing from Google is ever sent to him.
async function googleCalendarItems({ from, to, knownZoomIds }) {
  const events = await gcal.listEvents({ from, to });
  return events
    .filter((e) => !e.zoom_ids.some((id) => knownZoomIds.has(id)))
    .map(({ zoom_ids, transparent, ...e }) => e);
}

const ZOOM_ID_IN_LINK = /zoom\.us\/(?:j|my|w)\/(\d{8,})/i;

app.get('/api/summary/month', async (req, res) => {
  const [y, m] = (req.query.month || '').split('-').map(Number);
  // The month as Singapore reads it, not as this server's clock does — on Vercel
  // that's UTC, which would put a meeting at 1am on the 1st in the wrong month.
  const now = sgNow();
  const year = y || now.year;
  const monthIndex = m ? m - 1 : now.monthIndex;
  const { start: monthStart, end: monthEnd } = sgMonthRange(year, monthIndex);
  const inMonth = (meeting) => {
    const t = new Date(meeting.scheduled_at).getTime();
    return t >= monthStart.getTime() && t < monthEnd.getTime();
  };

  // Every deal with a meeting on it, whatever stage it's in now — logging an
  // outcome moves the deal on, but the meeting still happened and stays put.
  const everyDeal = await listDeals();
  const allDeals = everyDeal.filter((d) => d.scheduled_at);
  const withContacts = await Promise.all(allDeals.filter(inMonth).map(async (d) => ({ ...d, contact: await getContact(d.contact_id) })));

  const linkedIds = new Set(allDeals.filter((d) => d.zoom_meeting_id).map((d) => d.zoom_meeting_id));
  const zoomAll = await getZoomOnlyMeetings(linkedIds);
  const zoomOnly = zoomAll.filter(inMonth);
  const history = (await pastMeetingsOf(everyDeal)).filter(inMonth);

  // Padded a day each side; the browser only draws the days of the month it's showing.
  const knownZoomIds = new Set(
    [...linkedIds].map(String).concat(
      zoomAll.map((m) => m.id.replace('zoom-', '')),
      everyDeal.map((d) => (d.zoom_link || '').match(ZOOM_ID_IN_LINK)?.[1]).filter(Boolean)
    )
  );
  const google =
    req.user.role === 'caller'
      ? await googleCalendarItems({
          from: new Date(monthStart.getTime() - 86400000),
          to: new Date(monthEnd.getTime() + 86400000),
          knownZoomIds,
        })
      : [];

  const combined = withContacts.concat(zoomOnly, history, google);
  combined.sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));
  res.json(combined);
});

// The Agent's Analytics page, one month at a time: interviews fixed, attended and
// rescheduled, and how the ones he logged turned out (see lib/stats.js). `tz` is
// the browser's timezone offset so a month starts and ends where the viewer thinks it does.
app.get('/api/analytics', agentOnly, async (req, res) => {
  const deals = await listDeals();
  await backfillDealRefs(deals);
  // Pick up any interviews booked straight in Zoom that we haven't counted yet.
  await getZoomOnlyMeetings(new Set(deals.filter((d) => d.zoom_meeting_id).map((d) => d.zoom_meeting_id)));
  // Always Singapore's months. (A browser used to send its own offset here, which
  // let a device on another timezone see different month totals.)
  res.json(await monthlyAnalytics({ month: req.query.month, tz: TEAM_TZ_PARAM }));
});

// ---------- In-app notifications (replaces the old WhatsApp pings) ----------
app.get('/api/notifications', async (req, res) =>
  res.json(await listNotifications({ unreadOnly: req.query.unread === 'true', role: req.user.role, status: req.query.status }))
);
app.get('/api/notifications/unread-count', async (req, res) => res.json({ count: await unreadCount({ role: req.user.role }) }));
app.post('/api/notifications/:id/read', async (req, res) => {
  const n = await markRead(req.params.id);
  if (!n) return res.status(404).json({ error: 'not found' });
  res.json(n);
});
app.post('/api/notifications/:id/done', async (req, res) => {
  const n = await markDone(req.params.id);
  if (!n) return res.status(404).json({ error: 'not found' });
  res.json(n);
});
app.delete('/api/notifications/:id', async (req, res) => {
  const removed = await deleteNotification(req.params.id);
  if (!removed) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});
app.post('/api/notifications/read-all', async (req, res) => {
  await markAllRead({ role: req.user.role });
  res.json({ ok: true });
});

// ---------- Zoom (the agent's own personal account) ----------
app.get('/auth/zoom', agentOnly, (req, res) => {
  if (!zoom.isConfigured()) return res.status(400).send('Zoom not configured — set ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET in .env.');
  const state = crypto.randomBytes(16).toString('hex');
  setOAuthState(req, res, state);
  res.redirect(zoom.buildAuthorizeUrl(state));
});

// Sends the browser home with the reason an OAuth connection failed, so the alert can say
// why instead of "check the server logs". Only ever shown to the signed-in Agent.
function oauthFailed(res, service, reason) {
  const clean = String(reason || 'unknown error').replace(/\s+/g, ' ').slice(0, 300);
  res.redirect(`/?${service}=error&reason=${encodeURIComponent(clean)}`);
}
function oauthReturnProblem({ code, error, error_description, state }, expected) {
  if (error) return `${error}${error_description ? ` — ${error_description}` : ''}`;
  if (!code) return 'the provider did not send back an authorisation code';
  if (!state || !expected) return 'the sign-in session expired or the browser blocked cookies — try again in the same tab';
  if (state !== expected) return 'the sign-in did not match this browser session — try again';
  return null;
}

app.get('/auth/zoom/callback', agentOnly, async (req, res) => {
  const { code } = req.query;
  const expected = takeOAuthState(req, res);
  const problem = oauthReturnProblem(req.query, expected);
  if (problem) return oauthFailed(res, 'zoom', problem);
  try {
    await zoom.exchangeCode(code);
    res.redirect('/?zoom=connected');
  } catch (err) {
    console.error('[zoom] oauth callback failed', err);
    oauthFailed(res, 'zoom', err.message);
  }
});

app.get('/api/zoom/status', async (req, res) => {
  res.json({ configured: zoom.isConfigured(), connected: await zoom.isConnected(), email: await zoom.connectedEmail() });
});

app.post('/api/zoom/disconnect', agentOnly, async (req, res) => {
  await zoom.disconnect();
  res.json({ ok: true });
});

// ---------- Google Calendar (the agent's own calendar, read-only) ----------
app.get('/auth/google', agentOnly, (req, res) => {
  if (!gcal.isConfigured()) return res.status(400).send('Google Calendar is not set up — set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.');
  const state = crypto.randomBytes(16).toString('hex');
  setOAuthState(req, res, state, 'google');
  res.redirect(gcal.buildAuthorizeUrl(state));
});

app.get('/auth/google/callback', agentOnly, async (req, res) => {
  const { code } = req.query;
  const expected = takeOAuthState(req, res, 'google');
  const problem = oauthReturnProblem(req.query, expected);
  if (problem) return oauthFailed(res, 'google', problem);
  try {
    await gcal.exchangeCode(code);
    res.redirect('/?google=connected');
  } catch (err) {
    console.error('[gcal] oauth callback failed', err);
    oauthFailed(res, 'google', err.message);
  }
});

app.get('/api/google/status', async (req, res) => res.json(await gcal.status()));

app.post('/api/google/disconnect', agentOnly, async (req, res) => {
  await gcal.disconnect();
  res.json({ ok: true });
});

// Catches anything that reaches here — a failed Redis call, a bad Zoom
// response, whatever — and returns a clean error instead of hanging.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof AuthError) return res.status(err.status).json({ error: err.message }); // expected: wrong password, full team...
  console.error('[unhandled]', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`schedule-hub listening on http://localhost:${PORT}`);
  });

  // Proactive reminders: check every 5 minutes for meetings coming up within
  // the reminder window (default 60 min) and raise a notification once per
  // meeting. Only makes sense with a long-running process, hence the guard.
  const REMINDER_CHECK_MS = 5 * 60 * 1000;
  checkAllTeamsReminders().catch((err) => console.error('[reminders] startup check failed', err));
  setInterval(() => {
    checkAllTeamsReminders().catch((err) => console.error('[reminders] check failed', err));
  }, REMINDER_CHECK_MS);
}

export default app;
