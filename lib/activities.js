import { all, insert, update } from './db.js';

export function listActivities({ deal_id, contact_id } = {}) {
  let items = all('activities');
  if (deal_id) items = items.filter((a) => a.deal_id === Number(deal_id));
  if (contact_id) items = items.filter((a) => a.contact_id === Number(contact_id));
  return items.slice().sort((a, b) => new Date(b.at) - new Date(a.at));
}

export function logActivity({ deal_id, contact_id, type, summary, made_by, meta }) {
  return insert('activities', (id) => ({
    id,
    deal_id: deal_id ?? null,
    contact_id: contact_id ?? null,
    type, // 'call' | 'email' | 'meeting' | 'note' | 'stage_change'
    summary,
    made_by: made_by || 'unknown',
    at: new Date().toISOString(),
    meta: meta || {},
  }));
}

export function markEmailOpened(token) {
  const activity = all('activities').find((a) => a.meta && a.meta.token === token);
  if (!activity) return null;
  return update('activities', activity.id, (a) => {
    if (!a.meta.opened_at) a.meta.opened_at = new Date().toISOString();
  });
}
