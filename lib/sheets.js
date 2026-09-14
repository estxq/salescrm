import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PATH = path.join(__dirname, '..', 'data', 'leads.sample.json');

const API_KEY = process.env.GOOGLE_SHEETS_API_KEY;
const SHEET_ID = process.env.GOOGLE_SHEETS_ID;
const RANGE = process.env.GOOGLE_SHEETS_RANGE || 'Leads!A2:D';

export async function fetchLeads() {
  if (!API_KEY || !SHEET_ID) {
    console.log('[sheets] No GOOGLE_SHEETS_API_KEY / GOOGLE_SHEETS_ID set — using data/leads.sample.json');
    if (!existsSync(SAMPLE_PATH)) return [];
    return JSON.parse(readFileSync(SAMPLE_PATH, 'utf-8'));
  }
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(
    RANGE
  )}?key=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`[sheets] fetch failed (${res.status})`);
    return [];
  }
  const data = await res.json();
  const rows = data.values || [];
  return rows.map((row, i) => ({
    row: i + 2,
    name: row[0] || '',
    phone: row[1] || '',
    notes: row[2] || '',
    status: row[3] || 'new',
  }));
}
