import crypto from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTBOX = path.join(__dirname, '..', 'data', 'outbox');

const SMTP_HOST = process.env.SMTP_HOST;
const FROM_EMAIL = process.env.FROM_EMAIL || 'sales@example.com';
const LIVE = Boolean(SMTP_HOST);

if (!LIVE) {
  console.log('[mailer] No SMTP_HOST set — running in MOCK mode, emails saved to data/outbox/ instead of sent.');
}

let transportPromise = null;
async function getTransport() {
  if (!transportPromise) {
    transportPromise = import('nodemailer').then((nodemailer) =>
      nodemailer.default.createTransport({
        host: SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      })
    );
  }
  return transportPromise;
}

export function renderTemplate(str, vars) {
  return (str || '').replace(/{{\s*(\w+)\s*}}/g, (_, key) => vars[key] ?? '');
}

export function newTrackingToken() {
  return crypto.randomBytes(12).toString('hex');
}

export async function sendEmail({ to, subject, html, trackingToken }) {
  const trackedHtml = trackingToken
    ? `${html}<img src="/track/open/${trackingToken}.png" width="1" height="1" style="display:none" alt="" />`
    : html;

  if (!LIVE) {
    if (!existsSync(OUTBOX)) mkdirSync(OUTBOX, { recursive: true });
    const safeTo = (to || 'unknown').replace(/[^a-z0-9@.]/gi, '_');
    const file = path.join(OUTBOX, `${Date.now()}-${safeTo}.html`);
    writeFileSync(file, `<!-- To: ${to} | Subject: ${subject} -->\n${trackedHtml}`);
    console.log(`[mailer:mock] -> ${to}: "${subject}" (saved to ${file})`);
    return { mock: true, file };
  }

  const transport = await getTransport();
  return transport.sendMail({ from: FROM_EMAIL, to, subject, html: trackedHtml });
}

// 1x1 transparent PNG for the open-tracking pixel
export const TRACKING_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);
