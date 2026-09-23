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

// Deleting a contact is the one truly hard-to-recover action in this app, so
// it's soft: listContacts hides anything with deleted_at set (restorable from
// the Deleted view) instead of removing it. { includeDeleted: true } is only
// for that Deleted view and the restore/purge flow — everywhere else should
// keep using the default.
export async function listContacts({ q, includeDeleted = false } = {}) {
  const everyone = (await all('contacts')).filter((c) => includeDeleted || !c.deleted_at);

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
  return (
    (await all('contacts')).find((c) => c.id !== Number(excludeId) && !c.deleted_at && normalizePhone(c.phone) === n) || null
  );
}

// The Deleted view: everything soft-deleted, newest first.
export async function listDeletedContacts() {
  return (await all('contacts'))
    .filter((c) => c.deleted_at)
    .sort((a, b) => new Date(b.deleted_at) - new Date(a.deleted_at));
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

// Soft delete: hides the contact (see listContacts above) instead of erasing
// it, so it can be undone. The caller (server.js) still cancels any real
// Zoom meetings right away — that part genuinely can't be undone, only the
// CRM record can.
export async function deleteContact(id, deletedBy) {
  return update('contacts', id, (c) => {
    c.deleted_at = new Date().toISOString();
    c.deleted_by = deletedBy || null;
  });
}

export async function restoreContact(id) {
  return update('contacts', id, (c) => {
    c.deleted_at = null;
    c.deleted_by = null;
  });
}

// Permanent, for the rare case someone really wants it gone — only reachable
// from the Deleted view, as a second, explicit step after the (undoable)
// delete.
export async function purgeContact(id) {
  return remove('contacts', id);
}
