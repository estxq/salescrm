import { all, insert } from './db.js';

const DEFAULTS = [
  { name: 'Caller', role: 'caller' },
  { name: 'PA', role: 'pa' },
  { name: 'Agent', role: 'agent' },
];

export function listUsers() {
  let users = all('users');
  if (users.length === 0) {
    users = DEFAULTS.map((u) => insert('users', (id) => ({ id, ...u })));
  }
  return users;
}

export function createUser({ name, role }) {
  if (!name) throw new Error('name required');
  return insert('users', (id) => ({ id, name, role: role || 'member' }));
}
