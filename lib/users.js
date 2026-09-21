import { all, insert, update, remove } from './db.js';

const DEFAULTS = [
  { name: 'Caller', role: 'caller' },
  { name: 'Agent', role: 'agent' },
];

export async function listUsers() {
  let users = await all('users');
  if (users.length === 0) {
    // Sequential, not Promise.all — each insert reads-then-writes the
    // whole collection, so running them concurrently races and gives every
    // seeded user the same id.
    users = [];
    for (const u of DEFAULTS) {
      users.push(await insert('users', (id) => ({ id, ...u })));
    }
  }
  return users;
}

export async function createUser({ name, role }) {
  if (!name) throw new Error('name required');
  return insert('users', (id) => ({ id, name, role: role || 'member' }));
}

export async function updateUser(id, { name, role }) {
  return update('users', id, (u) => {
    if (name !== undefined) u.name = name;
    if (role !== undefined) u.role = role;
  });
}

export async function deleteUser(id) {
  return remove('users', id);
}
