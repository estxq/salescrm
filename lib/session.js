import crypto from 'node:crypto';
import { getRaw, setRaw } from './db.js';

// ---------- Signing secret ----------
// Use SESSION_SECRET when it's set; otherwise make one once and keep it in the
// same store as everything else, so a serverless deploy works with no setup.
let secretPromise = null;
export function getSecret() {
  if (!secretPromise) {
    secretPromise = (async () => {
      if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
      let stored = await getRaw('auth_secret');
      if (!stored) {
        await setRaw('auth_secret', crypto.randomBytes(32).toString('hex'));
        stored = await getRaw('auth_secret'); // re-read: if two cold starts raced, both use whichever won
      }
      return stored;
    })().catch((err) => {
      secretPromise = null;
      throw err;
    });
  }
  return secretPromise;
}

// ---------- Passwords (scrypt, per-password salt) ----------
const scrypt = (password, salt) =>
  new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key)))
  );

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

// Always does the same work whether or not the account exists, so response
// time doesn't reveal which emails are registered.
const DUMMY_HASH = `scrypt$${'00'.repeat(16)}$${'00'.repeat(64)}`;
export async function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = (stored || DUMMY_HASH).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'));
  return stored ? crypto.timingSafeEqual(actual, expected) : false;
}

// ---------- Session cookie ----------
export const COOKIE_NAME = 'sh_session';
const SESSION_DAYS = 30;
const b64 = (buf) => Buffer.from(buf).toString('base64url');

async function sign(payload) {
  const body = b64(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', await getSecret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

async function verify(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', await getSecret()).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

export function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

const isHttps = (req) => req.secure || req.headers['x-forwarded-proto'] === 'https';

function setCookie(res, req, name, value, maxAgeSec) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (isHttps(req)) parts.push('Secure');
  const existing = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [].concat(existing || [], parts.join('; ')));
}

export async function startSession(req, res, accountId) {
  const token = await sign({ uid: accountId, exp: Date.now() + SESSION_DAYS * 86400000 });
  setCookie(res, req, COOKIE_NAME, token, SESSION_DAYS * 86400);
}

export function endSession(req, res) {
  setCookie(res, req, COOKIE_NAME, '', 0);
}

export async function sessionAccountId(req) {
  const payload = await verify(readCookie(req, COOKIE_NAME));
  return payload?.uid ?? null;
}

// Short-lived random value for the Zoom OAuth round trip, so the callback can
// prove it's the same browser that started it.
export function setOAuthState(req, res, state) {
  setCookie(res, req, 'sh_zoom_state', state, 600);
}
export function takeOAuthState(req, res) {
  const state = readCookie(req, 'sh_zoom_state');
  setCookie(res, req, 'sh_zoom_state', '', 0);
  return state;
}
