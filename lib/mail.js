// Sends email through Resend (https://resend.com) with a plain HTTPS call, so there is nothing to install.
// Set RESEND_API_KEY and EMAIL_FROM (a sender Resend has verified for you, e.g. "Schedule Hub <no-reply@yourdomain.com>").
// With either missing, email is simply off and the app falls back to showing reset codes in teammates' bells.
const API_KEY = () => process.env.RESEND_API_KEY || '';
const FROM = () => process.env.EMAIL_FROM || '';

export function emailConfigured() {
  return Boolean(API_KEY() && FROM());
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Resolves to true when the provider accepted the message, false otherwise. Never throws: a mail outage must not turn
// into a broken page, and the caller has a fallback.
export async function sendEmail({ to, subject, text, html }) {
  if (!emailConfigured()) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM(), to: [to], subject, text, html }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.error('[mail] provider refused the message', res.status, (await res.text().catch(() => '')).slice(0, 200));
      return false;
    }
    return true;
  } catch (err) {
    console.error('[mail] send failed', err.message);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function resetCodeEmail({ name, code, minutes }) {
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
  return {
    subject: `Your Schedule Hub password reset code: ${spaced}`,
    text: `Hi ${name},\n\nYour Schedule Hub password reset code is ${spaced}.\nIt works for ${minutes} minutes. Enter it on the "Forgot password?" screen and choose a new password.\n\nIf you didn't ask for this, you can ignore this email. Your password has not changed.\n`,
    html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1f2937"><p>Hi ${esc(name)},</p><p>Your Schedule Hub password reset code is:</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px;margin:12px 0">${esc(spaced)}</p><p>It works for ${minutes} minutes. Enter it on the &ldquo;Forgot password?&rdquo; screen and choose a new password.</p><p style="color:#6b7280">If you didn't ask for this, you can ignore this email. Your password has not changed.</p></div>`,
  };
}
