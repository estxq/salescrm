import { all, insert } from './db.js';

const DEFAULTS = [
  { name: 'Caller', role: 'caller' },
  { name: 'PA', role: 'pa' },
  { name: 'Agent', role: 'agent' },
];

export async function listUsers() {
  let users = await all('users');
  if (users.length === 0) {
    users = await Promise.all(DEFAULTS.map((u) => insert('users', (id) => ({ id, ...u }))));
  }
  return users;
}

export async function createUser({ name, role }) {
  if (!name) throw new Error('name required');
  return insert('users', (id) => ({ id, name, role: role || 'member' }));
}
