import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function filePath(collection) {
  return path.join(DATA_DIR, `${collection}.json`);
}

async function loadCollection(collection) {
  if (USE_KV) {
    const kv = await getKv();
    const db = await kv.get(collection);
    return db || { items: [], nextId: 1 };
  }
  const fp = filePath(collection);
  if (!existsSync(fp)) return { items: [], nextId: 1 };
  return JSON.parse(readFileSync(fp, 'utf-8'));
}

async function saveCollection(collection, db) {
  if (USE_KV) {
    const kv = await getKv();
    await kv.set(collection, db);
    return;
  }
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(filePath(collection), JSON.stringify(db, null, 2));
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
