import { all, insert, update, remove, removeWhere } from './db.js';
import { roleOfUser } from './users.js';

// With two roles, a notification triggered by one is for the other. Anything
// without a known actor (reminders, older records) has no audience and goes
// to everyone.
const OTHER_ROLE = { agent: 'caller', caller: 'agent' };

function visibleTo(n, role) {
  return !role || !n.for_role || n.for_role === role;
}

export async function listNotifications({ unreadOnly, role } = {}) {
  let items = (await all('notifications')).filter((n) => visibleTo(n, role));
  if (unreadOnly) items = items.filter((n) => !n.read_at);
  return items.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

export async function createNotification({ type, deal_id, contact_id, message, from_name }) {
  const from_role = await roleOfUser(from_name);
  return insert('notifications', (id) => ({
    id,
    type,
    deal_id: deal_id ?? null,
    contact_id: contact_id ?? null,
    message,
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

// "Mark as done" — unlike markRead, this removes the notification entirely
// so it doesn't linger in the list at all, not even as a read item.
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
