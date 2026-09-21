import { all, insert, update, remove, removeWhere } from './db.js';
import { roleOfUser } from './users.js';

// With two roles, a notification triggered by one is for the other. Anything
// without a known actor (reminders, older records) has no audience and goes
// to everyone.
const OTHER_ROLE = { agent: 'caller', caller: 'agent' };

function visibleTo(n, role) {
  return !role || !n.for_role || n.for_role === role;
}

// status: 'new' (not marked done), 'old' (marked done), or omitted for both.
// "Unread" only ever means unread AND not done — a done item is history.
export async function listNotifications({ unreadOnly, role, status } = {}) {
  let items = (await all('notifications')).filter((n) => visibleTo(n, role));
  if (status === 'new') items = items.filter((n) => !n.done_at);
  if (status === 'old') items = items.filter((n) => n.done_at);
  if (unreadOnly) items = items.filter((n) => !n.read_at && !n.done_at);
  return items.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

export async function createNotification({ type, deal_id, contact_id, message, from_name, meta }) {
  const from_role = await roleOfUser(from_name);
  return insert('notifications', (id) => ({
    id,
    type,
    deal_id: deal_id ?? null,
    contact_id: contact_id ?? null,
    message,
    meta: meta || null,
    from_name: from_name || null,
    from_role,
    for_role: OTHER_ROLE[from_role] || null,
    created_at: new Date().toISOString(),
    read_at: null,
  }));
}

export async function markRead(id) {
  return update('notifications', id, (n) => {
    n.read_at = new Date().toISOString();
  });
}

// "Mark as done" moves a notification to the Old tab: it stops counting as
// new (and as unread) but stays around as history.
export async function markDone(id) {
  const now = new Date().toISOString();
  return update('notifications', id, (n) => {
    n.done_at = now;
    if (!n.read_at) n.read_at = now;
  });
}

// The newest notification of `type` about one deal or Zoom meeting that the
// other side hasn't marked done yet — i.e. still open to being edited.
export async function findOpenNotification({ type, deal_id, zoom_meeting_id }) {
  const open = (await all('notifications'))
    .filter((n) => n.type === type && !n.done_at)
    .filter((n) => (deal_id != null ? n.deal_id === Number(deal_id) : String(n.meta?.zoom_meeting_id) === String(zoom_meeting_id)))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return open[0] || null;
}

// Edit a notification in place (a changed request or outcome) and put it back
// at the top of the other person's list as unread.
export async function reviseNotification(id, { message, meta }) {
  return update('notifications', id, (n) => {
    n.message = message;
    if (meta) n.meta = { ...(n.meta || {}), ...meta };
    n.created_at = new Date().toISOString();
    n.read_at = null;
  });
}

// A reschedule request (or logged outcome) on a Zoom-only meeting lives only
// as a notification (there's no deal to flag), so once the caller moves or
// deletes the meeting it's been acted on — file it under Old, which also
// stops the agent editing it.
// Sequential for the same read-modify-write reason as markAllRead().
export async function resolveZoomRescheduleRequests(zoomMeetingId) {
  const open = (await all('notifications')).filter(
    (n) =>
      (n.type === 'reschedule_requested' || n.type === 'meeting_outcome') &&
      !n.done_at &&
      n.meta?.zoom_meeting_id != null &&
      String(n.meta.zoom_meeting_id) === String(zoomMeetingId)
  );
  for (const n of open) await markDone(n.id);
}

// Permanent removal — no button for this in the UI, it's for cleanup.
export async function deleteNotification(id) {
  return remove('notifications', id);
}

export async function markAllRead({ role } = {}) {
  // Sequential — update() does a read-modify-write of the whole collection,
  // so concurrent updates to different notifications would race and
  // overwrite each other, silently leaving some marked unread.
  const unread = await listNotifications({ unreadOnly: true, role });
  for (const n of unread) {
    await markRead(n.id);
  }
}

export async function deleteNotificationsFor({ deal_id, contact_id }) {
  return removeWhere(
    'notifications',
    (n) => (deal_id != null && n.deal_id === Number(deal_id)) || (contact_id != null && n.contact_id === Number(contact_id))
  );
}

export async function unreadCount({ role } = {}) {
  return (await listNotifications({ unreadOnly: true, role })).length;
}
