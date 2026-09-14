import { all, insert, update, remove, removeWhere } from './db.js';

export async function listNotifications({ unreadOnly } = {}) {
  let items = await all('notifications');
  if (unreadOnly) items = items.filter((n) => !n.read_at);
  return items.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

export async function createNotification({ type, deal_id, contact_id, message }) {
  return insert('notifications', (id) => ({
    id,
    type,
    deal_id: deal_id ?? null,
    contact_id: contact_id ?? null,
    message,
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

export async function markAllRead() {
  // Sequential — update() does a read-modify-write of the whole collection,
  // so concurrent updates to different notifications would race and
  // overwrite each other, silently leaving some marked unread.
  const unread = await listNotifications({ unreadOnly: true });
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

export async function unreadCount() {
  return (await listNotifications({ unreadOnly: true })).length;
}
