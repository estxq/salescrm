import { all, insert, find, update, remove } from './db.js';

// Numbers get typed every which way ("91234567", "6591234567", "+65 9123 4567",
// "9123-4567"). Reduce them to one canonical form so those all count as the
// same number: digits only, and a Singapore country code (65 / 0065) dropped
// from an 8-digit local number.
export function normalizePhone(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('0065')) d = d.slice(2);
  if (d.length === 10 && d.startsWith('65')) d = d.slice(2);
  return d;
}

export async function listContacts({ q } = {}) {
  const everyone = await all('contacts');

  // Flag contacts that share a number with someone else, whatever the search.
  const seen = {};
  everyone.forEach((c) => {
    const n = normalizePhone(c.phone);
    if (n) seen[n] = (seen[n] || 0) + 1;
  });
  let items = everyone.map((c) => {
    const n = normalizePhone(c.phone);
    return { ...c, duplicate_phone: Boolean(n && seen[n] > 1) };
  });

  const needle = String(q || '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (needle) {
    const qDigits = String(q).replace(/\D/g, '');
    const qNormalized = normalizePhone(q);
    items = items.filter((c) => {
      if (
        c.name.toLowerCase().includes(needle) ||
        (c.email || '').toLowerCase().includes(needle) ||
        (c.company || '').toLowerCase().includes(needle)
      )
        return true;
      if (!qDigits) return false; // a text search must never match every phone via ''.includes('')
      const rawDigits = String(c.phone || '').replace(/\D/g, '');
      return rawDigits.includes(qDigits) || normalizePhone(c.phone).includes(qNormalized);
    });
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getContact(id) {
  return find('contacts', id);
}

// Who already has this number? Pass excludeId when editing, so a contact
// isn't reported as a duplicate of itself.
export async function findContactByPhone(phone, { excludeId } = {}) {
  const n = normalizePhone(phone);
  if (!n) return null;
  return (await all('contacts')).find((c) => c.id !== Number(excludeId) && normalizePhone(c.phone) === n) || null;
}

export async function createContact({ name, phone, email, company, notes, source, created_by }) {
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

export async function updateContact(id, patch) {
  return update('contacts', id, (c) => {
    for (const key of ['name', 'phone', 'email', 'company', 'notes']) {
      if (patch[key] !== undefined) c[key] = patch[key];
    }
  });
}

export async function deleteContact(id) {
  return remove('contacts', id);
}
