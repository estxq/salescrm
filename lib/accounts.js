import crypto from 'node:crypto';
import { all, find, insert, update, remove, getRaw, setRaw, adoptLegacyData } from './db.js';
import { withTeam } from './context.js';
import { hashPassword, verifyPassword } from './session.js';

export const ROLES = ['caller', 'agent'];
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

// Unambiguous characters only (no 0/O, 1/I/L) — the code gets read out and retyped.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newInviteCode() {
  let code = '';
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}
const cleanCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const formatCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;

const cleanEmail = (email) => String(email || '').trim().toLowerCase();
const cleanName = (name) => String(name || '').trim().replace(/\s+/g, ' ');

export class AuthError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// What the browser is allowed to know about an account — never the hash.
export function publicAccount(a) {
  return { id: a.id, name: a.name, email: a.email, role: a.role, team_id: a.team_id };
}

export async function getAccount(id) {
  return find('accounts', id);
}

export async function getTeam(id) {
  return find('teams', id);
}

export async function teamMembers(teamId) {
  return (await all('accounts')).filter((a) => a.team_id === Number(teamId));
}

// Notifications are addressed by role but callers only know who acted by
// name — this bridges the two, within the team in context.
export async function roleOfMember(teamId, name) {
  if (!name) return null;
  return (await teamMembers(teamId)).find((a) => a.name === name)?.role || null;
}

function validateCommon({ name, email, password }) {
  if (!name) throw new AuthError('Enter your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError('Enter a valid email address.');
  if (String(password || '').length < 8) throw new AuthError('Password must be at least 8 characters.');
}

// Creates the account row, then re-checks the team's roles: two people joining
// at the same instant could both see the seat as free (storage is a
// read-modify-write of the whole list), so the later one backs out.
async function addMember(team, { name, email, password, role }) {
  const members = await teamMembers(team.id);
  if (members.some((m) => m.role === role)) {
    throw new AuthError(`This team already has ${role === 'agent' ? 'an Agent' : 'a Caller'}. ${
      members.length >= ROLES.length ? 'It is full.' : `Join as the ${role === 'agent' ? 'Caller' : 'Agent'} instead.`
    }`);
  }
  if (members.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
    throw new AuthError('Your teammate already uses that name — pick a different one so notifications are clear.');
  }
  const password_hash = await hashPassword(password);
  const account = await insert('accounts', (id) => ({
    id,
    name,
    email,
    password_hash,
    team_id: team.id,
    role,
    failed_logins: 0,
    locked_until: null,
    created_at: new Date().toISOString(),
  }));
  const after = (await teamMembers(team.id)).filter((m) => m.role === role);
  if (after.length > 1 && after[0].id !== account.id) {
    await remove('accounts', account.id);
    throw new AuthError(`This team already has ${role === 'agent' ? 'an Agent' : 'a Caller'}.`);
  }
  return account;
}

async function assertEmailFree(email) {
  if ((await all('accounts')).some((a) => a.email === email)) {
    throw new AuthError('An account with this email already exists — log in instead.', 409);
  }
}

// Start a new team. Everything that existed before teams did (the original
// single-tenant data) is handed to the very first team, once.
export async function createTeamAndAccount(input) {
  const name = cleanName(input.name);
  const email = cleanEmail(input.email);
  const teamName = cleanName(input.team_name);
  const role = input.role;
  validateCommon({ name, email, password: input.password });
  if (!teamName) throw new AuthError('Give your team a name.');
  if (!ROLES.includes(role)) throw new AuthError('Choose whether you are the Caller or the Agent.');
  await assertEmailFree(email);

  const team = await insert('teams', (id) => ({
    id,
    name: teamName,
    invite_code: newInviteCode(),
    created_at: new Date().toISOString(),
  }));
  let account;
  try {
    account = await addMember(team, { name, email, password: input.password, role });
  } catch (err) {
    await remove('teams', team.id);
    throw err;
  }

  if (!(await getRaw('legacy_claimed'))) {
    await setRaw('legacy_claimed', { team_id: team.id, at: new Date().toISOString() });
    await adoptLegacyData(team.id);
  }
  return { account, team };
}

export async function joinTeamAndAccount(input) {
  const name = cleanName(input.name);
  const email = cleanEmail(input.email);
  const role = input.role;
  validateCommon({ name, email, password: input.password });
  if (!ROLES.includes(role)) throw new AuthError('Choose whether you are the Caller or the Agent.');
  const code = cleanCode(input.invite_code);
  const team = code && (await all('teams')).find((t) => t.invite_code === code);
  if (!team) throw new AuthError("That invite code doesn't match any team. Check it with your teammate.");
  await assertEmailFree(email);
  const account = await addMember(team, { name, email, password: input.password, role });
  return { account, team };
}

export async function login({ email, password }) {
  const cleaned = cleanEmail(email);
  const account = (await all('accounts')).find((a) => a.email === cleaned);
  const bad = new AuthError('Incorrect email or password.', 401);
  if (account?.locked_until && new Date(account.locked_until) > new Date()) {
    throw new AuthError('Too many wrong passwords — try again in a few minutes.', 429);
  }
  const ok = await verifyPassword(String(password || ''), account?.password_hash);
  if (!account || !ok) {
    if (account) {
      await update('accounts', account.id, (a) => {
        a.failed_logins = (a.failed_logins || 0) + 1;
        if (a.failed_logins >= MAX_FAILED_LOGINS) {
          a.locked_until = new Date(Date.now() + LOCK_MINUTES * 60000).toISOString();
          a.failed_logins = 0;
        }
      });
    }
    throw bad;
  }
  if (account.failed_logins || account.locked_until) {
    await update('accounts', account.id, (a) => {
      a.failed_logins = 0;
      a.locked_until = null;
    });
  }
  return { account, team: await getTeam(account.team_id) };
}

// Removes just the login. The team — its contacts, meetings, Zoom connection
// and invite code — stays, so the seat can be taken again by whoever holds the
// code (a teammate leaving shouldn't wipe out the team's work).
export async function deleteAccount(account, password) {
  if (!(await verifyPassword(String(password || ''), account.password_hash))) {
    throw new AuthError('That password is not right.', 403);
  }
  await remove('accounts', account.id);
}

// Everything the UI needs to know about who's signed in. The invite code is
// only worth showing while there's still an empty seat.
export async function sessionInfo(account, team) {
  const members = await teamMembers(team.id);
  const open_role = ROLES.find((r) => !members.some((m) => m.role === r)) || null;
  return {
    user: publicAccount(account),
    team: { id: team.id, name: team.name },
    members: members.map((m) => ({ name: m.name, role: m.role })),
    invite: open_role ? { code: formatCode(team.invite_code), role: open_role } : null,
  };
}

// The reminders job has no request behind it, so it walks every team itself.
export async function forEachTeam(fn) {
  for (const team of await all('teams')) await withTeam(team.id, () => fn(team));
}
