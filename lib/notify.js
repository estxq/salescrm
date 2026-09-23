import { formatWhen } from './tz.js';
import { getContact } from './contacts.js';
import { createNotification } from './notifications.js';

// All scheduling/communication now happens on the dashboard itself — these
// create in-app notifications (bell icon, top bar) instead of sending
// anything externally.

export async function notifyScheduled(deal, changedBy) {
  const contact = await getContact(deal.contact_id);
  const when = formatWhen(deal.scheduled_at);
  await createNotification({
    type: 'scheduled',
    deal_id: deal.id,
    contact_id: deal.contact_id,
    message: `${changedBy || 'Someone'} scheduled a meeting with ${contact?.name || 'a client'} for ${when}.`,
    from_name: changedBy,
  });
}

export async function notifyRescheduleRequested(deal, remark, requestedBy) {
  const contact = await getContact(deal.contact_id);
  await createNotification({
    type: 'reschedule_requested',
    deal_id: deal.id,
    contact_id: deal.contact_id,
    message: `${requestedBy || 'Someone'} asked to reschedule the meeting with ${contact?.name || 'a client'}: "${remark}". Needs a new time.`,
    from_name: requestedBy,
  });
}

export async function notifyRescheduleConfirmed(deal, changedBy) {
  const contact = await getContact(deal.contact_id);
  const when = formatWhen(deal.scheduled_at);
  await createNotification({
    type: 'rescheduled',
    deal_id: deal.id,
    contact_id: deal.contact_id,
    message: `${changedBy || 'Someone'} moved the meeting with ${contact?.name || 'a client'} to ${when}.`,
    from_name: changedBy,
  });
}

export async function notifyMeetingDeleted(dealBefore, deletedBy) {
  const contact = await getContact(dealBefore.contact_id);
  const when = formatWhen(dealBefore.scheduled_at);
  await createNotification({
    type: 'meeting_deleted',
    deal_id: dealBefore.id,
    contact_id: dealBefore.contact_id,
    message: `${deletedBy || 'Someone'} deleted the meeting with ${contact?.name || 'a client'} (${when}).`,
    from_name: deletedBy,
  });
}

export async function notifyOutcome(deal, outcomeLabel, note, loggedBy) {
  const contact = await getContact(deal.contact_id);
  await createNotification({
    type: 'meeting_outcome',
    deal_id: deal.id,
    contact_id: deal.contact_id,
    message: `${loggedBy || 'Someone'} logged the meeting with ${contact?.name || 'a client'} as: ${outcomeLabel}.${
      note ? ` Notes: ${note}` : ''
    }`,
    from_name: loggedBy,
  });
}

export async function notifyRemark(deal, note, writtenBy) {
  const contact = await getContact(deal.contact_id);
  await createNotification({
    type: 'remark',
    deal_id: deal.id,
    contact_id: deal.contact_id,
    message: `${writtenBy || 'Someone'} left a remark on ${contact?.name || 'a client'}: "${note}"`,
    from_name: writtenBy,
  });
}

export async function notifyReminder(deal) {
  const contact = await getContact(deal.contact_id);
  const when = formatWhen(deal.scheduled_at);
  await createNotification({
    type: 'reminder',
    deal_id: deal.id,
    contact_id: deal.contact_id,
    message: `Reminder: meeting with ${contact?.name || 'a client'} at ${when}.`,
  });
}
