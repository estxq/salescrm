import { all, insert, find, update, remove } from './db.js';

export function listContacts({ q } = {}) {
  let items = all('contacts');
  if (q) {
    const needle = q.toLowerCase();
    items = items.filter(
      (c) =>
        c.name.toLowerCase().includes(needle) ||
        (c.phone || '').includes(needle) ||
        (c.email || '').toLowerCase().includes(needle) ||
        (c.company || '').toLowerCase().includes(needle)
    );
  }
  return items.slice().sort((a, b) => a.name.localeCompare(b.name));
}

export function getContact(id) {
  return find('contacts', id);
}

export function findContactByPhone(phone) {
  if (!phone) return null;
  return all('contacts').find((c) => c.phone && c.phone === phone);
}

export function createContact({ name, phone, email, company, notes, source, created_by }) {
  return insert('contacts', (id) => ({
    id,
    name,
    phone: phone || '',
    email: email || '',
    company: company || '',
    notes: notes || '',
    source: source || 'manual',
    created_by: created_by || 'unknown',
    created_at: new Date().toISOString(),
  }));
}

export function updateContact(id, patch) {
  return update('contacts', id, (c) => {
    for (const key of ['name', 'phone', 'email', 'company', 'notes']) {
      if (patch[key] !== undefined) c[key] = patch[key];
    }
  });
}

export function deleteContact(id) {
  return remove('contacts', id);
}
