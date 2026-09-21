import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentTeamId } from './context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

// Local dev: plain JSON files on disk, zero config. Deployed to Vercel:
// serverless functions can't write to disk reliably, so we switch to
// Upstash Redis automatically when its env vars are present (added by
// connecting a Redis store to the project via the Vercel Marketplace).
// Vercel's "Upstash for Redis" integration actually injects the legacy
// KV_REST_API_* names (kept for backward compat with the old Vercel KV
// product), not the UPSTASH_REDIS_REST_* names @upstash/redis's own
// Redis.fromEnv() expects — so we check both and build the client by hand.
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_KV = Boolean(REDIS_URL && REDIS_TOKEN);

let kvPromise = null;
function getKv() {
  if (!kvPromise) kvPromise = import('@upstash/redis').then((m) => new m.Redis({ url: REDIS_URL, token: REDIS_TOKEN }));
  return kvPromise;
}

// ---------- Raw key/value storage (both backends) ----------
function filePath(key) {
  return path.join(DATA_DIR, `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

export async function getRaw(key) {
  if (USE_KV) {
    const kv = await getKv();
    return (await kv.get(key)) ?? null;
  }
  const fp = filePath(key);
  if (!existsSync(fp)) return null;
  const raw = readFileSync(fp, 'utf-8').trim();
  return raw ? JSON.parse(raw) : null;
}

export async function setRaw(key, value) {
  if (USE_KV) {
    const kv = await getKv();
    await kv.set(key, value);
    return;
  }
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(filePath(key), JSON.stringify(value, null, 2));
}

export async function delRaw(key) {
  if (USE_KV) {
    const kv = await getKv();
    await kv.del(key);
    return;
  }
  const fp = filePath(key);
  if (existsSync(fp)) unlinkSync(fp);
}

// ---------- Team scoping ----------
// Accounts and teams are shared by everyone. Everything else (contacts, deals,
// notifications, the Zoom connection...) belongs to one team and lives under
// its own key. Scoped-by-default on purpose: a new collection is private to a
// team unless it is listed here, and touching one with no team in context
// throws instead of quietly reading somebody else's data.
const GLOBAL_COLLECTIONS = new Set(['accounts', 'teams']);

export function teamKey(name, teamId = currentTeamId()) {
  if (teamId == null) throw new Error(`No team in context for "${name}" — request is not authenticated`);
  return `t${teamId}:${name}`;
}

function keyFor(collection) {
  return GLOBAL_COLLECTIONS.has(collection) ? collection : teamKey(collection);
}

// Data from before teams existed lives under the bare collection names. The
// first team created takes it over, once (see lib/accounts.js). The Zoom
// token is moved rather than copied so it doesn't linger in two places.
const LEGACY_COLLECTIONS = ['contacts', 'deals', 'activities', 'notifications'];
export async function adoptLegacyData(teamId) {
  for (const name of LEGACY_COLLECTIONS) {
    const legacy = await getRaw(name);
    if (legacy && legacy.items?.length) await setRaw(teamKey(name, teamId), legacy);
  }
  const zoomAccount = await getRaw('zoom_account');
  if (zoomAccount) {
    await setRaw(teamKey('zoom_account', teamId), zoomAccount);
    await delRaw('zoom_account');
  }
}

async function loadCollection(collection) {
  return (await getRaw(keyFor(collection))) || { items: [], nextId: 1 };
}

async function saveCollection(collection, db) {
  await setRaw(keyFor(collection), db);
}

export async function all(collection) {
  return (await loadCollection(collection)).items;
}

export async function find(collection, id) {
  return (await all(collection)).find((i) => i.id === Number(id));
}

export async function insert(collection, factory) {
  const db = await loadCollection(collection);
  const item = factory(db.nextId);
  db.items.push(item);
  db.nextId += 1;
  await saveCollection(collection, db);
  return item;
}

export async function update(collection, id, mutator) {
  const db = await loadCollection(collection);
  const item = db.items.find((i) => i.id === Number(id));
  if (!item) return null;
  mutator(item);
  await saveCollection(collection, db);
  return item;
}

export async function remove(collection, id) {
  const db = await loadCollection(collection);
  const idx = db.items.findIndex((i) => i.id === Number(id));
  if (idx === -1) return false;
  db.items.splice(idx, 1);
  await saveCollection(collection, db);
  return true;
}

export async function removeWhere(collection, predicate) {
  const db = await loadCollection(collection);
  const before = db.items.length;
  db.items = db.items.filter((i) => !predicate(i));
  await saveCollection(collection, db);
  return before - db.items.length;
}
