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

// ---------- Password reset (no email in this app) ----------
// The code goes to whoever else is in the account's team, as an in-app
// notification — they relay it out of band (WhatsApp, in person), the same
// trust everything else here already runs on. There's no path for someone
// with no teammate (or a teammate who is also locked out) to self-serve —
// they need whoever manages the deployment.
const RESET_CODE_TTL_MIN = 15;
const MAX_RESET_ATTEMPTS = 6;
const RESET_COOLDOWN_MS = 30000; // stops a request from silently invalidating a code someone is mid-typing

function newResetCode() {
  return String(crypto.randomInt(1000000)).padStart(6, '0');
}
export const formatResetCode = (code) => `${code.slice(0, 3)} ${code.slice(3)}`;

// Step 1: generate and store a code if (and only if) the email matches an
// account that has a teammate to notify. The caller (server.js) raises the
// actual notification and always answers the same way regardless of what
// came back here, so this never reveals whether an email is registered.
export async function requestPasswordReset(email) {
  const account = (await all('accounts')).find((a) => a.email === cleanEmail(email));
  if (!account?.team_id) return { notified: false };
  const teammate = (await teamMembers(account.team_id)).find((m) => m.id !== account.id);
  if (!teammate) return { notified: false };
  // The cooldown only protects a code that's still usable — once one is spent
  // (locked out from wrong tries, or expired) there's nothing left to protect,
  // so a fresh one is issued right away instead of making the person wait.
  const stillActive =
    account.reset_code_hash &&
    account.reset_expires &&
    new Date(account.reset_expires).getTime() > Date.now() &&
    (account.reset_attempts || 0) < MAX_RESET_ATTEMPTS;
  if (stillActive && account.reset_requested_at && Date.now() - new Date(account.reset_requested_at).getTime() < RESET_COOLDOWN_MS) {
    return { notified: false }; // still shows the existing code's notification; nothing new to raise
  }

  const code = newResetCode();
  const reset_code_hash = await hashPassword(code);
  await update('accounts', account.id, (a) => {
    a.reset_code_hash = reset_code_hash;
    a.reset_expires = new Date(Date.now() + RESET_CODE_TTL_MIN * 60000).toISOString();
    a.reset_attempts = 0;
    a.reset_requested_at = new Date().toISOString();
  });
  return {
    notified: true,
    accountId: account.id,
    teamId: account.team_id,
    accountName: account.name,
    code,
    priorNotificationId: account.reset_notification_id || null,
  };
}

// The server calls this once it has raised (or revised) the notification, so a
// second request while the first is still unused edits the same one instead of
// piling up more.
export async function setResetNotificationId(accountId, notificationId) {
  await update('accounts', accountId, (a) => {
    a.reset_notification_id = notificationId;
  });
}

// Step 2: the code plus a new password. Errors are deliberately generic and
// identical for "no such email", "no code was ever requested", "expired" and
// "too many wrong tries" — nothing here should help anyone find a working
// email/code pair by trial and error.
export async function resetPassword({ email, code, new_password }) {
  const bad = new AuthError('That code is invalid or expired — ask your teammate for a fresh one.', 400);
  const account = (await all('accounts')).find((a) => a.email === cleanEmail(email));
  if (!account?.reset_code_hash || !account.reset_expires) throw bad;
  if (new Date(account.reset_expires).getTime() < Date.now()) throw bad;
  if ((account.reset_attempts || 0) >= MAX_RESET_ATTEMPTS) throw bad;

  const ok = await verifyPassword(String(code || '').replace(/\D/g, ''), account.reset_code_hash);
  if (!ok) {
    await update('accounts', account.id, (a) => {
      a.reset_attempts = (a.reset_attempts || 0) + 1;
    });
    throw bad;
  }
  if (String(new_password || '').length < 8) throw new AuthError('Password must be at least 8 characters.');

  const password_hash = await hashPassword(new_password);
  const notificationId = account.reset_notification_id || null;
  await update('accounts', account.id, (a) => {
    a.password_hash = password_hash;
    a.reset_code_hash = null;
    a.reset_expires = null;
    a.reset_attempts = 0;
    a.reset_requested_at = null;
    a.reset_notification_id = null; // spent — a later request starts a fresh notification, not a revive of this one
    a.failed_logins = 0;
    a.locked_until = null;
  });
  const fresh = await getAccount(account.id);
  return { account: fresh, team: fresh.team_id ? await getTeam(fresh.team_id) : null, notificationId };
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

// Removes the login. The team — its contacts, meetings, Zoom connection and
// invite code — stays, so the seat can be taken again by whoever holds the code
// (deleting an account shouldn't wipe out the team's work). This also counts as
// leaving: if the account was in a team, the caller notifies the teammate the
// same way an explicit "Leave team" would, so they know the seat is open.
export async function deleteAccount(account, password) {
  if (!(await verifyPassword(String(password || ''), account.password_hash))) {
    throw new AuthError('That password is not right.', 403);
  }
  await remove('accounts', account.id);
  return account.team_id ? { teamId: account.team_id, name: account.name, role: account.role } : null;
}

// Everything the UI needs to know about who's signed in. The invite code is
// only worth showing while there's still an empty seat.
export async function sessionInfo(account, team) {
  if (!team) return { user: publicAccount(account), team: null, members: [], invite: null };
  const members = await teamMembers(team.id);
  const open_role = ROLES.find((r) => !members.some((m) => m.role === r)) || null;
  // The code itself never expires or changes — always send it, so the account
  // menu can show it whether or not a seat happens to be open right now.
  return {
    user: publicAccount(account),
    team: { id: team.id, name: team.name },
    members: members.map((m) => ({ name: m.name, role: m.role })),
    invite: { code: formatCode(team.invite_code), role: open_role },
  };
}

// The reminders job has no request behind it, so it walks every team itself.
export async function forEachTeam(fn) {
  for (const team of await all('teams')) await withTeam(team.id, () => fn(team));
}
