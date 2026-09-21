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

// Seats an account in a team. An account can exist without a team (right after
// someone leaves one), so signing up and leaving/joining share this. It
// re-checks the roles afterwards: two people taking the last seat at the same
// instant could both see it free (storage is a read-modify-write of the whole
// list), so the later one backs out.
async function seatInTeam(account, team, role, name) {
  const others = (await teamMembers(team.id)).filter((m) => m.id !== account.id);
  const label = role === 'agent' ? 'an Agent' : 'a Caller';
  if (others.some((m) => m.role === role)) {
    throw new AuthError(`This team already has ${label}. ${
      others.length >= ROLES.length ? 'It is full.' : `Join as the ${role === 'agent' ? 'Caller' : 'Agent'} instead.`
    }`);
  }
  if (others.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
    throw new AuthError('Your teammate already uses that name — pick a different one so notifications are clear.');
  }
  await update('accounts', account.id, (a) => {
    a.team_id = team.id;
    a.role = role;
    a.name = name;
  });
  const seated = (await teamMembers(team.id)).filter((m) => m.role === role);
  if (seated.length > 1 && seated[0].id !== account.id) {
    await update('accounts', account.id, (a) => {
      a.team_id = null;
      a.role = null;
    });
    throw new AuthError(`This team already has ${label}.`);
  }
  return getAccount(account.id);
}

async function assertEmailFree(email) {
  if ((await all('accounts')).some((a) => a.email === email)) {
    throw new AuthError('An account with this email already exists — log in instead.', 409);
  }
}

async function newAccount({ name, email, password }) {
  const password_hash = await hashPassword(password);
  return insert('accounts', (id) => ({
    id,
    name,
    email,
    password_hash,
    team_id: null,
    role: null,
    failed_logins: 0,
    locked_until: null,
    created_at: new Date().toISOString(),
  }));
}

// Start a new team with this (team-less) account in it. Everything that existed
// before teams did (the original single-tenant data) is handed to the very
// first team, once.
async function startTeam(account, { team_name, role, name }) {
  const teamName = cleanName(team_name);
  if (!teamName) throw new AuthError('Give your team a name.');
  if (!ROLES.includes(role)) throw new AuthError('Choose whether you are the Caller or the Agent.');
  const team = await insert('teams', (id) => ({
    id,
    name: teamName,
    invite_code: newInviteCode(),
    created_at: new Date().toISOString(),
  }));
  let seated;
  try {
    seated = await seatInTeam(account, team, role, cleanName(name) || account.name);
  } catch (err) {
    await remove('teams', team.id);
    throw err;
  }
  if (!(await getRaw('legacy_claimed'))) {
    await setRaw('legacy_claimed', { team_id: team.id, at: new Date().toISOString() });
    await adoptLegacyData(team.id);
  }
  return { account: seated, team };
}

async function enterTeam(account, { invite_code, role, name }) {
  if (!ROLES.includes(role)) throw new AuthError('Choose whether you are the Caller or the Agent.');
  const code = cleanCode(invite_code);
  const team = code && (await all('teams')).find((t) => t.invite_code === code);
  if (!team) throw new AuthError("That invite code doesn't match any team. Check it with your teammate.");
  const seated = await seatInTeam(account, team, role, cleanName(name) || account.name);
  return { account: seated, team };
}

// Sign up: make the account, then put it in a team — undoing the account if the
// team step is refused (bad code, seat taken...) so a retry isn't blocked by
// "email already exists".
async function signUpThen(input, joinTeam) {
  const name = cleanName(input.name);
  const email = cleanEmail(input.email);
  validateCommon({ name, email, password: input.password });
  await assertEmailFree(email);
  const account = await newAccount({ name, email, password: input.password });
  try {
    return await joinTeam(account);
  } catch (err) {
    await remove('accounts', account.id);
    throw err;
  }
}

export const createTeamAndAccount = (input) => signUpThen(input, (account) => startTeam(account, input));
export const joinTeamAndAccount = (input) => signUpThen(input, (account) => enterTeam(account, input));

// A logged-in account with no team picks one.
export async function createTeamForAccount(account, input) {
  if (account.team_id) throw new AuthError('Leave your current team first.', 409);
  return startTeam(account, input);
}
export async function joinTeamForAccount(account, input) {
  if (account.team_id) throw new AuthError('Leave your current team first.', 409);
  return enterTeam(account, input);
}

// Leaving keeps the login but drops the seat. The team — its contacts,
// meetings, Zoom connection and invite code — stays, so the seat can be
// filled again by whoever holds the code, and the person can join or start
// another team.
export async function leaveTeam(account) {
  if (!account.team_id) throw new AuthError('You are not in a team.', 409);
  const teamId = account.team_id;
  await update('accounts', account.id, (a) => {
    a.team_id = null;
    a.role = null;
  });
  return { teamId, name: account.name, role: account.role };
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
  return { account, team: account.team_id ? await getTeam(account.team_id) : null };
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
  if (!team) return { user: publicAccount(account), team: null, members: [], invite: null };
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
