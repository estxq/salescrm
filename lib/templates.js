import { all, insert, find, update, remove } from './db.js';

export async function listTemplates() {
  return all('templates');
}

export async function getTemplate(id) {
  return find('templates', id);
}

export async function createTemplate({ name, subject, body, created_by }) {
  return insert('templates', (id) => ({
    id,
    name,
    subject,
    body,
    created_by: created_by || 'unknown',
    created_at: new Date().toISOString(),
  }));
}

export async function updateTemplate(id, patch) {
  return update('templates', id, (t) => {
    for (const key of ['name', 'subject', 'body']) {
      if (patch[key] !== undefined) t[key] = patch[key];
    }
  });
}

export async function deleteTemplate(id) {
  return remove('templates', id);
}
