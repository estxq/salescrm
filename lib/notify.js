import { getContact } from './contacts.js';
import { createNotification } from './notifications.js';

// All scheduling/communication now happens on the dashboard itself — these
// create in-app notifications (bell icon, top bar) instead of sending
// anything externally.

export async function notifyScheduled(deal) {
  const contact = getContact(deal.contact_id);
  const when = new Date(deal.scheduled_at).toLocaleString();
  createNotification({
    type: 'scheduled',
    deal_id: deal.id,
    contact_id: deal.contact_id,
    message: `Meeting scheduled with ${contact?.name || 'a client'} for ${when}.`,
  });
}

export async function notifyRescheduleRequested(deal, remark, requestedBy) {
  const contact = getContact(deal.contact_id);
  createNotification({
    type: 'reschedule_requested',
    deal_id: deal.id,
    contact_id: deal.contact_id,
    message: `${requestedBy || 'Someone'} asked to reschedule #${deal.id} ${contact?.name || ''}: "${remark}" — needs a new time.`,
  });
}

export async function notifyRescheduleConfirmed(deal, changedBy) {
  const contact = getContact(deal.contact_id);
  const when = new Date(deal.scheduled_at).toLocaleString();
  createNotification({
    type: 'rescheduled',
    deal_id: deal.id,
    contact_id: deal.contact_id,
    message: `${changedBy || 'PA'} confirmed #${deal.id} ${contact?.name || ''} for ${when}.`,
  });
}

export async function notifyReminder(deal) {
  const contact = getContact(deal.contact_id);
  const when = new Date(deal.scheduled_at).toLocaleString();
  createNotification({
    type: 'reminder',
    deal_id: deal.id,
    contact_id: deal.contact_id,
    message: `Reminder: meeting with ${contact?.name || 'a client'} at ${when}.`,
  });
}
