import { getContact } from './contacts.js';
import { createNotification } from './notifications.js';

// All scheduling/communication now happens on the dashboard itself — these
// create in-app notifications (bell icon, top bar) instead of sending
// anything externally.

export async function notifyScheduled(deal, changedBy) {
  const contact = await getContact(deal.contact_id);
  const when = new Date(deal.scheduled_at).toLocaleString();
  await createNotification({
    type: 'scheduled',
    deal_id: deal.id,
    contact_id: deal.contact_id,
    message: `Meeting scheduled with ${contact?.name || 'a client'} for ${when}.`,
    from_name: changedBy,
  });
}

export async function notifyRescheduleRequested(deal, remark, requestedBy) {
  const contact = await getContact(deal.contact_id);
  await createNotification({
    type: 'reschedule_requested',
    deal_id: deal.id,
    contact_id: deal.contact_id,
    message: `${requestedBy || 'Someone'} asked to reschedule #${deal.id} ${contact?.name || ''}: "${remark}" — needs a new time.`,
    from_name: requestedBy,
  });
}

export async function notifyRescheduleConfirmed(deal, changedBy) {
  const contact = await getContact(deal.contact_id);
  const when = new Date(deal.scheduled_at).toLocaleString();
  await createNotification({
    type: 'rescheduled',
    deal_id: deal.id,
    contact_id: deal.contact_id,
    message: `${changedBy || 'Caller'} confirmed #${deal.id} ${contact?.name || ''} for ${when}.`,
    from_name: changedBy,
  });
}

export async function notifyReminder(deal) {
  const contact = await getContact(deal.contact_id);
  const when = new Date(deal.scheduled_at).toLocaleString();
  await createNotification({
    type: 'reminder',
    deal_id: deal.id,
    contact_id: deal.contact_id,
    message: `Reminder: meeting with ${contact?.name || 'a client'} at ${when}.`,
  });
}
