import { all, insert, update } from './db.js';

export function listNotifications({ unreadOnly } = {}) {
  let items = all('notifications');
  if (unreadOnly) items = items.filter((n) => !n.read_at);
  return items.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

export function createNotification({ type, deal_id, contact_id, message }) {
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

export function markRead(id) {
  return update('notifications', id, (n) => {
    n.read_at = new Date().toISOString();
  });
}

export function markAllRead() {
  listNotifications({ unreadOnly: true }).forEach((n) => markRead(n.id));
}

export function unreadCount() {
  return listNotifications({ unreadOnly: true }).length;
}
