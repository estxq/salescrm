import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listUsers, createUser } from './lib/users.js';
import { listContacts, getContact, findContactByPhone, createContact, updateContact } from './lib/contacts.js';
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
  rescheduleMeeting,
  requestReschedule,
  logFollowUp,
  updateDealValue,
  logCall,
  addNote,
} from './lib/deals.js';
import { listActivities, logActivity, markEmailOpened } from './lib/activities.js';
import { listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate } from './lib/templates.js';
import { renderTemplate, newTrackingToken, sendEmail, TRACKING_PIXEL } from './lib/mailer.js';
import { fetchLeads } from './lib/sheets.js';
import { notifyScheduled, notifyRescheduleConfirmed, notifyRescheduleRequested } from './lib/notify.js';
import { listNotifications, markRead, markAllRead, unreadCount } from './lib/notifications.js';
import { buildIcs, googleCalendarLink } from './lib/calendar.js';
import { checkAndSendReminders } from './lib/reminders.js';
import * as zoom from './lib/zoom.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Best-effort: free up the agent's Zoom account when a deal falls through.
async function cleanupZoomMeeting(dealBefore) {
  if ((await zoom.isConnected()) && dealBefore?.zoom_meeting_id) {
    zoom.deleteMeeting(dealBefore.zoom_meeting_id).catch((err) => console.error('[zoom] cleanup failed', err.message));
  }
}

async function lastCallOutcome(dealId) {
  const lastCall = (await listActivities({ deal_id: dealId })).find((a) => a.type === 'call');
  return lastCall?.meta?.outcome || null;
}

// ---------- Users (lightweight identity, no auth) ----------
app.get('/api/users', async (req, res) => res.json(await listUsers()));
app.post('/api/users', async (req, res) => {
  try {
    res.status(201).json(await createUser(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Leads (Google Sheet) ----------
app.get('/api/leads', async (req, res) => res.json(await fetchLeads()));

app.post('/api/leads/import', async (req, res) => {
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

app.post('/api/contacts', async (req, res) => {
  const { name, phone, email, company, notes, created_by } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const contact = await createContact({ name, phone, email, company, notes, created_by });
  const deal = await createDeal({ contact_id: contact.id, title: `${contact.name}`, created_by });
  res.status(201).json({ contact, deal });
});

app.get('/api/contacts/:id', async (req, res) => {
  const contact = await getContact(req.params.id);
  if (!contact) return res.status(404).json({ error: 'not found' });
  res.json(contact);
});

app.patch('/api/contacts/:id', async (req, res) => {
  const contact = await updateContact(req.params.id, req.body || {});
  if (!contact) return res.status(404).json({ error: 'not found' });
  res.json(contact);
});

// ---------- Deals / pipeline ----------
app.get('/api/deals', async (req, res) => {
  const deals = await listDeals({ stage: req.query.stage, contact_id: req.query.contact_id });
  const withExtras = await Promise.all(
    deals.map(async (d) => ({
      ...d,
      contact: await getContact(d.contact_id),
      last_call_outcome: await lastCallOutcome(d.id),
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
  let deals = (await listDeals()).filter((d) => d.scheduled_at);
  if (when === 'upcoming') deals = deals.filter((d) => new Date(d.scheduled_at).getTime() > now);
  if (when === 'past') deals = deals.filter((d) => new Date(d.scheduled_at).getTime() <= now);
  const withContacts = await Promise.all(deals.map(async (d) => ({ ...d, contact: await getContact(d.contact_id) })));
  withContacts.sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));
  res.json(withContacts);
});

app.get('/api/deals/:id', async (req, res) => {
  const deal = await getDeal(req.params.id);
  if (!deal) return res.status(404).json({ error: 'not found' });
  res.json({
    ...deal,
    contact: await getContact(deal.contact_id),
    activities: await listActivities({ deal_id: deal.id }),
    last_call_outcome: await lastCallOutcome(deal.id),
  });
});

app.post('/api/deals/:id/stage', async (req, res) => {
  const before = await getDeal(req.params.id);
  const deal = await moveStage(req.params.id, req.body || {});
  if (!deal) return res.status(404).json({ error: 'invalid deal or stage' });
  if (deal.stage === 'lost') await cleanupZoomMeeting(before);
  res.json(deal);
});

app.post('/api/deals/:id/schedule', async (req, res) => {
  const { zoom_link, scheduled_at, changed_by } = req.body;
  if (!scheduled_at) return res.status(400).json({ error: 'scheduled_at required' });
  const existing = await getDeal(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const contact = await getContact(existing.contact_id);

  let link = zoom_link;
  let meetingId = null;
  if (!link && (await zoom.isConnected())) {
    try {
      const meeting = await zoom.createMeeting({ topic: `Call with ${contact?.name || 'client'}`, startTime: scheduled_at });
      link = meeting.joinUrl;
      meetingId = meeting.id;
    } catch (err) {
      return res.status(502).json({ error: `Zoom meeting creation failed: ${err.message}` });
    }
  }
  if (!link) return res.status(400).json({ error: 'zoom_link required (or connect Zoom to auto-generate one)' });

  const deal = await scheduleMeeting(req.params.id, { zoom_link: link, zoom_meeting_id: meetingId, scheduled_at, changed_by });
  await notifyScheduled(deal);
  res.json(deal);
});

app.post('/api/deals/:id/reschedule', async (req, res) => {
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

  const deal = await rescheduleMeeting(req.params.id, { scheduled_at, zoom_link, changed_by });
  await notifyRescheduleConfirmed(deal, changed_by);
  res.json(deal);
});

// The agent flags a problem with a remark; the PA is the one who actually
// picks the new time via the /reschedule route above.
app.post('/api/deals/:id/request-reschedule', async (req, res) => {
  const { remark, requested_by } = req.body;
  if (!remark) return res.status(400).json({ error: 'remark required' });
  const deal = await requestReschedule(req.params.id, { remark, requested_by });
  if (!deal) return res.status(404).json({ error: 'not found' });
  await notifyRescheduleRequested(deal, remark, requested_by);
  res.json(deal);
});

app.get('/api/followup-outcomes', (req, res) => {
  res.json(Object.entries(FOLLOWUP_OUTCOMES).map(([key, v]) => ({ key, label: v.label })));
});

app.post('/api/deals/:id/followup', async (req, res) => {
  const { outcome, note, changed_by } = req.body;
  const before = await getDeal(req.params.id);
  const deal = await logFollowUp(req.params.id, { outcome, note, changed_by });
  if (!deal) return res.status(400).json({ error: 'invalid deal or outcome' });
  if (deal.stage === 'lost') await cleanupZoomMeeting(before);
  res.json(deal);
});

app.post('/api/deals/:id/value', async (req, res) => {
  const deal = await updateDealValue(req.params.id, req.body || {});
  if (!deal) return res.status(404).json({ error: 'not found' });
  res.json(deal);
});

app.post('/api/deals/:id/call', async (req, res) => {
  const { outcome, notes, made_by } = req.body;
  if (!outcome) return res.status(400).json({ error: 'outcome required' });
  const deal = await logCall(req.params.id, { outcome, notes, made_by });
  if (!deal) return res.status(404).json({ error: 'not found' });
  res.json(deal);
});

app.post('/api/deals/:id/note', async (req, res) => {
  const deal = await addNote(req.params.id, req.body || {});
  if (!deal) return res.status(404).json({ error: 'not found' });
  res.json(deal);
});

app.post('/api/deals/:id/email', async (req, res) => {
  const { template_id, made_by } = req.body;
  const deal = await getDeal(req.params.id);
  if (!deal) return res.status(404).json({ error: 'deal not found' });
  const contact = await getContact(deal.contact_id);
  if (!contact?.email) return res.status(400).json({ error: 'contact has no email address' });
  const template = await getTemplate(template_id);
  if (!template) return res.status(404).json({ error: 'template not found' });

  const vars = { name: contact.name, company: contact.company, agent: made_by || 'the team' };
  const subject = renderTemplate(template.subject, vars);
  const html = renderTemplate(template.body, vars);
  const token = newTrackingToken();

  await sendEmail({ to: contact.email, subject, html, trackingToken: token });

  const activity = await logActivity({
    deal_id: deal.id,
    contact_id: contact.id,
    type: 'email',
    summary: `${made_by || 'someone'} sent "${subject}" to ${contact.email}`,
    made_by,
    meta: { token, template_id: template.id, subject },
  });
  res.status(201).json(activity);
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

// ---------- Summary dashboard (HubSpot-style "Your tasks / Outreach / Schedule") ----------
app.get('/api/summary/tasks', async (req, res) => {
  const deals = await listDeals();
  const today = new Date().toDateString();

  const callsDue = deals.filter((d) => d.stage === 'new');
  const emailsDueChecks = await Promise.all(
    deals
      .filter((d) => ['contacted', 'meeting_booked'].includes(d.stage))
      .map(async (d) => ({ d, hasEmail: (await listActivities({ deal_id: d.id })).some((a) => a.type === 'email') }))
  );
  const emailsDue = emailsDueChecks.filter((c) => !c.hasEmail).map((c) => c.d);
  const staleProposals = deals.filter((d) => {
    if (d.stage !== 'proposal') return false;
    const days = (Date.now() - new Date(d.updated_at).getTime()) / 86400000;
    return days >= 3;
  });
  const meetingsToday = deals.filter((d) => d.stage === 'meeting_booked' && d.scheduled_at && new Date(d.scheduled_at).toDateString() === today);
  const rescheduleRequests = deals.filter((d) => d.reschedule_requested);

  res.json({
    highPriority: meetingsToday.length + staleProposals.length + rescheduleRequests.length,
    allTasks: callsDue.length + emailsDue.length + staleProposals.length + meetingsToday.length + rescheduleRequests.length,
    calls: callsDue.length,
    emails: emailsDue.length,
    staleProposals: staleProposals.length,
    meetingsToday: meetingsToday.length,
    rescheduleRequests: rescheduleRequests.length,
  });
});

app.get('/api/summary/activities', async (req, res) => {
  const limit = Number(req.query.limit) || 12;
  const activities = (await listActivities()).slice(0, limit);
  const withContacts = await Promise.all(
    activities.map(async (a) => ({ ...a, contact: a.contact_id ? await getContact(a.contact_id) : null }))
  );
  res.json(withContacts);
});

app.get('/api/summary/schedule', async (req, res) => {
  const date = req.query.date ? new Date(req.query.date) : new Date();
  const dayStr = date.toDateString();
  const deals = (await listDeals({ stage: 'meeting_booked' })).filter(
    (d) => d.scheduled_at && new Date(d.scheduled_at).toDateString() === dayStr
  );
  const withContacts = await Promise.all(deals.map(async (d) => ({ ...d, contact: await getContact(d.contact_id) })));
  withContacts.sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));
  res.json(withContacts);
});

// ---------- Templates ----------
app.get('/api/templates', async (req, res) => res.json(await listTemplates()));
app.post('/api/templates', async (req, res) => res.status(201).json(await createTemplate(req.body || {})));
app.patch('/api/templates/:id', async (req, res) => {
  const t = await updateTemplate(req.params.id, req.body || {});
  if (!t) return res.status(404).json({ error: 'not found' });
  res.json(t);
});
app.delete('/api/templates/:id', async (req, res) => {
  await deleteTemplate(req.params.id);
  res.sendStatus(204);
});

// ---------- Email open tracking pixel ----------
app.get('/track/open/:token.png', async (req, res) => {
  await markEmailOpened(req.params.token);
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'no-store');
  res.send(TRACKING_PIXEL);
});

// ---------- Analytics ----------
app.get('/api/analytics', async (req, res) => {
  const deals = await listDeals();
  const activities = await listActivities();

  const dealsByStage = STAGES.map((stage) => ({
    stage,
    label: STAGE_LABELS[stage],
    count: deals.filter((d) => d.stage === stage).length,
  }));

  const won = deals.filter((d) => d.stage === 'won');
  const lost = deals.filter((d) => d.stage === 'lost');
  const winRate = won.length + lost.length ? Math.round((won.length / (won.length + lost.length)) * 100) : 0;

  const now = new Date();
  const wonThisMonth = won.filter((d) => {
    const u = new Date(d.updated_at);
    return u.getMonth() === now.getMonth() && u.getFullYear() === now.getFullYear();
  });
  const revenueThisMonth = wonThisMonth.reduce((sum, d) => sum + (d.value || 0), 0);

  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const callsPerDay = days.map((day) => ({
    day,
    count: activities.filter((a) => a.type === 'call' && a.at.slice(0, 10) === day).length,
  }));

  const emailActivities = activities.filter((a) => a.type === 'email');
  const opened = emailActivities.filter((a) => a.meta?.opened_at);
  const emailOpenRate = emailActivities.length ? Math.round((opened.length / emailActivities.length) * 100) : 0;

  res.json({
    totalContacts: (await listContacts()).length,
    openDeals: deals.filter((d) => !['won', 'lost'].includes(d.stage)).length,
    wonThisMonth: wonThisMonth.length,
    revenueThisMonth,
    winRate,
    dealsByStage,
    callsPerDay,
    emailsSent: emailActivities.length,
    emailOpenRate,
  });
});

// ---------- In-app notifications (replaces the old WhatsApp pings) ----------
app.get('/api/notifications', async (req, res) => res.json(await listNotifications({ unreadOnly: req.query.unread === 'true' })));
app.get('/api/notifications/unread-count', async (req, res) => res.json({ count: await unreadCount() }));
app.post('/api/notifications/:id/read', async (req, res) => {
  const n = await markRead(req.params.id);
  if (!n) return res.status(404).json({ error: 'not found' });
  res.json(n);
});
app.post('/api/notifications/read-all', async (req, res) => {
  await markAllRead();
  res.json({ ok: true });
});

// ---------- Zoom (the agent's own personal account) ----------
app.get('/auth/zoom', (req, res) => {
  if (!zoom.isConfigured()) return res.status(400).send('Zoom not configured — set ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET in .env.');
  res.redirect(zoom.buildAuthorizeUrl());
});

app.get('/auth/zoom/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/?zoom=error');
  try {
    await zoom.exchangeCode(code);
    res.redirect('/?zoom=connected');
  } catch (err) {
    console.error('[zoom] oauth callback failed', err);
    res.redirect('/?zoom=error');
  }
});

app.get('/api/zoom/status', async (req, res) => {
  res.json({ configured: zoom.isConfigured(), connected: await zoom.isConnected(), email: await zoom.connectedEmail() });
});

app.post('/api/zoom/disconnect', async (req, res) => {
  await zoom.disconnect();
  res.json({ ok: true });
});

// ---------- Reminders ----------
// Locally, a setInterval keeps checking in the background (see below).
// On Vercel there's no persistent process to run a timer in, so this same
// check is instead triggered by Vercel Cron hitting this route (configured
// in vercel.json). Protected by CRON_SECRET so randoms can't spam it.
app.get('/api/cron/reminders', async (req, res) => {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  await checkAndSendReminders();
  res.json({ ok: true });
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
  checkAndSendReminders().catch((err) => console.error('[reminders] startup check failed', err));
  setInterval(() => {
    checkAndSendReminders().catch((err) => console.error('[reminders] check failed', err));
  }, REMINDER_CHECK_MS);
}

export default app;
