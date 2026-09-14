import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

function filePath(collection) {
  return path.join(DATA_DIR, `${collection}.json`);
}

function loadCollection(collection) {
  const fp = filePath(collection);
  if (!existsSync(fp)) return { items: [], nextId: 1 };
  return JSON.parse(readFileSync(fp, 'utf-8'));
}

function saveCollection(collection, db) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(filePath(collection), JSON.stringify(db, null, 2));
}

export function all(collection) {
  return loadCollection(collection).items;
}

export function find(collection, id) {
  return all(collection).find((i) => i.id === Number(id));
}

export function insert(collection, factory) {
  const db = loadCollection(collection);
  const item = factory(db.nextId);
  db.items.push(item);
  db.nextId += 1;
  saveCollection(collection, db);
  return item;
}

export function update(collection, id, mutator) {
  const db = loadCollection(collection);
  const item = db.items.find((i) => i.id === Number(id));
  if (!item) return null;
  mutator(item);
  saveCollection(collection, db);
  return item;
}

export function remove(collection, id) {
  const db = loadCollection(collection);
  const idx = db.items.findIndex((i) => i.id === Number(id));
  if (idx === -1) return false;
  db.items.splice(idx, 1);
  saveCollection(collection, db);
  return true;
}
