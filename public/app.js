const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// The periodic poll replaces whole sections' innerHTML — without this, it
// would silently wipe out an inline edit form (reschedule, contact edit)
// the moment 20s pass, discarding whatever the user was mid-typing.
let openInlineForms = 0;
function inlineFormOpened() {
  openInlineForms += 1;
}
function inlineFormClosed() {
  openInlineForms = Math.max(0, openInlineForms - 1);
}

function showConnBanner() {
  const b = $('#conn-banner');
  if (b) b.hidden = false;
}
function hideConnBanner() {
  const b = $('#conn-banner');
  if (b) b.hidden = true;
}

async function api(path, opts) {
  let res;
  try {
    res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  } catch (err) {
    showConnBanner(); // couldn't reach the server at all
    throw err;
  }
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    // Session expired or logged out in another tab — back to the login screen.
    location.reload();
    throw Object.assign(new Error('Signed out'), { status: 401 });
  }
  if (res.status >= 500) showConnBanner();
  else hideConnBanner();
  if (res.status === 403 && (await res.clone().json().catch(() => null))?.error === 'no_team') {
    location.reload(); // left the team in another tab — back to the team picker
    throw Object.assign(new Error('Not in a team'), { status: 403 });
  }
  if (!res.ok) {
    // A 4xx is the server answering "no" (e.g. duplicate phone number) — not a
    // connection problem, so hand the caller the details instead.
    const body = await res.json().catch(() => null);
    throw Object.assign(new Error(body?.message || body?.error || `${path} -> ${res.status}`), { status: res.status, body });
  }
  return res.status === 204 ? null : res.json();
}

function fmtWhen(iso) {
  if (!iso) return 'not scheduled yet';
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

// The team confirms meetings over WhatsApp, not email — this builds a
// click-to-chat link (wa.me) prefilled with a confirmation message so
// whoever's calling the client can send it in one tap instead of typing
// the same thing out every time.
//
// WhatsApp needs the full international number. Local Singapore numbers are
// saved as 8 digits ("93838015"), so add the 65 they're missing — without it
// the link opens a chat with the wrong (invalid) number.
function whatsappLink(phone, message) {
  if (!phone) return null;
  let digits = phone.replace(/[^0-9]/g, '');
  if (digits.startsWith('0065')) digits = digits.slice(2);
  if (digits.length === 8) digits = `65${digits}`;
  if (!digits) return null;
  return `https://wa.me/${digits}${message ? `?text=${encodeURIComponent(message)}` : ''}`;
}

// The Caller sends the meeting details first; the Agent follows up nearer the
// date as a reminder — same link, different wording and button label.
function sendLabel() {
  return currentRole === 'agent' ? 'Send reminder' : 'Send details';
}
function confirmMeetingMessage(name, scheduledAt, zoomLink) {
  const when = new Date(scheduledAt).toLocaleString(undefined, {
    weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const zoom = zoomLink ? ` Zoom link: ${zoomLink}` : '';
  return currentRole === 'agent'
    ? `Hi ${name || 'there'}, a quick reminder about our meeting on ${when}.${zoom}`
    : `Hi ${name || 'there'}, here are the details for our meeting on ${when}.${zoom}`;
}

// Who's logged in — set by startApp() once /api/auth/me answers. The server
// takes the actor's name from the session anyway; this is for display.
let ME = null;
function currentUser() {
  return ME ? ME.user.name : 'someone';
}

// ---------- tabs (sidebar icons + page-head tabs both drive the same state) ----------
function activateTab(tab) {
  $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab}`));
  refresh();
}

$$('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => activateTab(btn.dataset.tab));
});

// Each role's actual job maps to a different subset of the app: the caller
// dials leads, logs outcomes, schedules meetings and sends emails, the agent
// attends meetings and tracks performance. Everyone still
// hits the same open API underneath — this is a decluttering convenience,
// not access control (there's no real auth in this app).
const ROLE_TABS = {
  caller: ['summary', 'meetings', 'contacts', 'pipeline'],
  agent: ['summary', 'meetings', 'contacts', 'analytics'],
};

let currentRole = 'agent';

function applyRoleVisibility(role) {
  currentRole = role;
  const allowed = ROLE_TABS[role] || ROLE_TABS.agent;
  $$('.tab-btn[data-tab]').forEach((btn) => {
    btn.hidden = !allowed.includes(btn.dataset.tab);
  });
  const activeBtn = document.querySelector('.page-head .tab-btn.active');
  if (activeBtn && activeBtn.hidden) activateTab('summary');
  renderZoomStatus(); // Zoom connect/disconnect controls are agent-only
  renderGoogleStatus(); // and so is Google Calendar's
  // Adding contacts is Caller's job (they're the one bringing in fresh
  // leads) — the Agent only needs to look someone up, not create records.
  $$('.add-contact-control').forEach((el) => {
    el.hidden = role !== 'caller';
  });
  if (role !== 'caller') setContactsView('list');
  // Both roles get the month calendar on Summary so they see the same picture
  // of the interview schedule. The Agent gets the next-meeting list on top; the
  // Caller instead gets Arron's reschedule requests beside it — that's the only
  // thing on Summary he needs to act on.
  const isCaller = role === 'caller';
  $('#requests-card').hidden = !isCaller;
  $('#calendar-card').hidden = false;
  $('#calendar-upcoming').hidden = isCaller;
  $('#summary-grid').classList.toggle('caller-summary', isCaller);
  if ($('#tab-summary').classList.contains('active')) renderSummaryTab();
  refreshNotifCount(); // the bell only counts what's addressed to this role
}

$('#global-search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim();
  activateTab('contacts');
  setContactsView('list');
  $('#contact-search').value = q;
  renderContactsTab(q);
});

// ---------- Google Calendar (the agent's own calendar, read-only) ----------
// The agent connects their own calendar once (only its owner can give that
// permission), but the events are shown to the Caller only, on the Summary
// calendar next to the Zoom meetings — the agent's own calendar stays Zoom-only.
let GOOGLE_STATUS = { configured: false, connected: false, email: null, needs_reconnect: false };

async function loadGoogleStatus() {
  GOOGLE_STATUS = await api('/api/google/status');
  renderGoogleStatus();
}

function renderGoogleStatus() {
  const el = $('#gcal-status');
  const isAgent = currentRole === 'agent';
  const g = GOOGLE_STATUS;
  if (!g.configured) {
    el.innerHTML = ''; // nothing to offer until it's set up
  } else if (g.connected && g.needs_reconnect) {
    el.innerHTML = isAgent ? '<a href="/auth/google" class="zoom-pill zoom-connect">Reconnect Google Calendar</a>' : '';
  } else if (g.connected) {
    el.innerHTML = isAgent
      ? `<span class="zoom-pill zoom-on" title="Your Google Calendar is visible to the Caller only. It is not shown on your own calendar.">Shared with Caller · ${escapeHtml(g.email || 'Google')}</span><button id="gcal-disconnect" class="zoom-disconnect">Stop sharing</button>`
      : `<span class="zoom-pill zoom-on" title="The Agent's Google Calendar, shown on the Summary calendar">Google · ${escapeHtml(g.email || 'connected')}</span>`;
    $('#gcal-disconnect')?.addEventListener('click', async () => {
      if (!confirm('Stop sharing your Google Calendar with the Caller? Its events will disappear from their calendar until you connect it again.')) return;
      await api('/api/google/disconnect', { method: 'POST' });
      await loadGoogleStatus();
    });
  } else {
    el.innerHTML = isAgent
      ? '<a href="/auth/google" class="zoom-pill zoom-connect" title="Lets your Caller see your Google Calendar. It will not appear on your own calendar.">Share Google Calendar with Caller</a>'
      : '';
  }
}

// ---------- Zoom (the agent's own personal account) ----------
let ZOOM_STATUS = { configured: false, connected: false, email: null };

async function loadZoomStatus() {
  ZOOM_STATUS = await api('/api/zoom/status');
  renderZoomStatus();
}

function renderZoomStatus() {
  const wantsManualLink = !ZOOM_STATUS.connected;
  const scheduling = !!$('#contact-form [name=scheduled_at]').value;
  $('#cf-zoom-row').hidden = !(wantsManualLink && scheduling);
  $('#cf-zoom-hint').hidden = !(ZOOM_STATUS.connected && scheduling);
  const el = $('#zoom-status');
  const canManage = currentRole === 'agent'; // it's the agent's own personal Zoom account
  if (!ZOOM_STATUS.configured) {
    el.innerHTML = '<span class="zoom-pill zoom-off" title="Set ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET in .env to enable">Zoom not connected</span>';
    return;
  }
  if (ZOOM_STATUS.connected) {
    el.innerHTML = `<span class="zoom-pill zoom-on">${ZOOM_STATUS.email || 'Zoom connected'}</span>${
      canManage ? '<button id="zoom-disconnect" class="zoom-disconnect">Disconnect</button>' : ''
    }`;
    if (canManage) {
      $('#zoom-disconnect').addEventListener('click', async () => {
        if (!confirm('Disconnect Zoom? New meetings will need a manual link until you reconnect.')) return;
        await api('/api/zoom/disconnect', { method: 'POST' });
        await loadZoomStatus();
      });
    }
  } else if (canManage) {
    el.innerHTML = '<a href="/auth/zoom" class="zoom-pill zoom-connect">Connect Zoom</a>';
  } else {
    el.innerHTML = '<span class="zoom-pill zoom-off">Zoom not connected (ask the agent)</span>';
  }
}

// ---------- Notifications (replaces the old WhatsApp pings) ----------
async function refreshNotifCount() {
  try {
    const { count } = await api(`/api/notifications/unread-count?role=${currentRole}`);
    const badge = $('#notif-count');
    if (count > 0) {
      badge.textContent = count > 9 ? '9+' : count;
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  } catch (err) {
    console.error(err);
  }
}

// "New" is everything not yet marked done; "Old" is what's been marked done.
let notifTab = 'new';

async function renderNotifDropdown() {
  $$('.notif-tab').forEach((t) => t.classList.toggle('active', t.dataset.notifTab === notifTab));
  $('#notif-mark-all').hidden = notifTab !== 'new';
  const notifs = await api(`/api/notifications?role=${currentRole}&status=${notifTab}`);
  const el = $('#notif-list');
  if (!notifs.length) {
    el.innerHTML = `<div class="empty">${
      notifTab === 'new' ? 'No new notifications.' : 'Nothing here yet. Notifications you mark as done show up here.'
    }</div>`;
    return;
  }
  el.innerHTML = notifs
    .slice(0, 20)
    .map(
      (n) => `
      <div class="notif-item ${n.read_at ? '' : 'unread'}${n.done_at ? ' is-old' : ''}${n.from_role ? ` from-${n.from_role}` : ''}" data-id="${n.id}" data-deal="${n.deal_id || ''}" data-type="${n.type}">
        ${n.from_name ? `<span class="n-from">From ${n.from_name}</span>` : ''}
        <div class="n-msg">${n.message}</div>
        <div class="n-row-bottom">
          <div class="n-when">${fmtWhen(n.created_at)}</div>
          ${n.done_at ? '<span class="n-done-label">Done</span>' : `<button class="notif-done-btn" data-id="${n.id}">Mark as done</button>`}
        </div>
      </div>`
    )
    .join('');
  $$('#notif-list .notif-item').forEach((item) => {
    item.addEventListener('click', async (e) => {
      if (e.target.closest('.notif-done-btn')) return;
      await api(`/api/notifications/${item.dataset.id}/read`, { method: 'POST' });
      $('#notif-dropdown').hidden = true;
      refreshNotifCount();
      if (item.dataset.deal) {
        activateTab(currentRole === 'agent' ? 'meetings' : 'pipeline'); // the Agent has no Pipeline tab
        openDealModal(item.dataset.deal);
      } else if (item.dataset.type === 'reschedule_requested') {
        activateTab('meetings'); // Zoom-only meeting: no deal to open, the Reschedule button lives here
      }
    });
  });
  // Marking done doesn't delete it — it moves to the Old tab as history.
  $$('#notif-list .notif-done-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api(`/api/notifications/${btn.dataset.id}/done`, { method: 'POST' });
      refreshNotifCount();
      renderNotifDropdown();
    });
  });
}

$$('.notif-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    notifTab = tab.dataset.notifTab;
    renderNotifDropdown();
  });
});

$('#notif-bell').addEventListener('click', async () => {
  const dd = $('#notif-dropdown');
  dd.hidden = !dd.hidden;
  if (!dd.hidden) {
    notifTab = 'new'; // always open on what needs attention
    await renderNotifDropdown();
  }
});

$('#notif-mark-all').addEventListener('click', async (e) => {
  e.stopPropagation();
  await api('/api/notifications/read-all', { method: 'POST', body: JSON.stringify({ role: currentRole }) });
  renderNotifDropdown();
  refreshNotifCount();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.notif-wrap')) $('#notif-dropdown').hidden = true;
});

// =====================================================================
// SUMMARY (Agent: month calendar + next meetings. Caller: reschedule requests + month calendar)
// =====================================================================
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// One card's fetch failing (or the server being mid-restart) must never
// leave the others stuck on "Loading..." forever — each card fails on its
// own and offers a manual retry instead of the whole tab hanging.
function withRetry(el, fn) {
  return fn().catch((err) => {
    console.error(err);
    el.innerHTML = '<div class="empty">Couldn\'t load this — <a href="#" data-retry>retry</a>.</div>';
    el.querySelector('[data-retry]')?.addEventListener('click', (e) => {
      e.preventDefault();
      el.innerHTML = 'Loading…';
      withRetry(el, fn);
    });
  });
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Caller's Summary: what Arron has asked to move and why. Deal meetings open
// the deal to pick a new time; Zoom-only ones live in the Meetings tab.
async function renderRequestsCard() {
  const el = $('#requests-body');
  await withRetry(el, async () => {
    const items = await api('/api/summary/reschedule-requests');
    if (!items.length) {
      el.innerHTML = '<div class="empty">No reschedule requests from Arron.</div>';
      return;
    }
    el.innerHTML = items
      .map(
        (r, i) => `
      <div class="request-item" data-idx="${i}">
        <div class="request-top">
          <span class="request-name">${escapeHtml(r.name)}</span>
          <span class="request-when">${r.scheduled_at ? fmtWhen(r.scheduled_at) : ''}</span>
        </div>
        <div class="request-remark">${r.remark ? `“${escapeHtml(r.remark)}”` : '<em>No reason given</em>'}</div>
        <div class="request-foot">
          <span class="request-by">${escapeHtml(r.requested_by || 'Arron')} · ${fmtWhen(r.requested_at)}</span>
          <span class="request-actions">
            ${
              r.kind === 'deal'
                ? '<button class="request-open primary">Reschedule</button>'
                : '<button class="request-meetings">Open in Meetings</button><button class="request-done">Mark as done</button>'
            }
          </span>
        </div>
      </div>`
      )
      .join('');
    $$('#requests-body .request-item').forEach((row) => {
      const r = items[Number(row.dataset.idx)];
      row.querySelector('.request-open')?.addEventListener('click', () => openDealModal(r.deal_id));
      row.querySelector('.request-meetings')?.addEventListener('click', () => activateTab('meetings'));
      row.querySelector('.request-done')?.addEventListener('click', async () => {
        await api(`/api/notifications/${r.notification_id}/done`, { method: 'POST' });
        renderRequestsCard();
        refreshNotifCount();
      });
    });
  });
}

// ---------- Month calendar (Summary, both roles) ----------
let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CAL_MAX_VISIBLE = 3;

function sameDay(a, b) {
  return a.toDateString() === b.toDateString();
}

// Zoom-only meetings have no deal to open a modal for — Join is the only
// thing to do with them, so a click just opens the link instead.
function openCalendarMeeting(meeting) {
  if (meeting.source === 'google') {
    if (meeting.external_url) window.open(meeting.external_url, '_blank', 'noopener');
    return;
  }
  if (meeting.source === 'zoom') {
    if (meeting.zoom_link) window.open(meeting.zoom_link, '_blank', 'noopener');
  } else {
    openDealModal(meeting.deal_id || meeting.id); // earlier meetings open their deal
  }
}

async function renderCalendarUpcoming() {
  const el = $('#calendar-upcoming-list');
  const heading = $('#calendar-upcoming-heading');
  await withRetry(el, async () => {
    const all = await api('/api/meetings?when=upcoming');
    if (!all.length) {
      heading.textContent = 'Upcoming';
      el.innerHTML = '<div class="empty">Nothing coming up.</div>';
      return;
    }
    // Just the nearest upcoming date's meetings — one meeting there shows
    // one, two shows two, rather than padding out to a fixed count.
    const nearestDay = new Date(all[0].scheduled_at).toDateString();
    const upcoming = all.filter((m) => new Date(m.scheduled_at).toDateString() === nearestDay);
    heading.textContent = `Upcoming — ${new Date(all[0].scheduled_at).toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    })}`;
    el.innerHTML = upcoming
      .map((m) => {
        const isZoomOnly = m.source === 'zoom';
        const name = isZoomOnly ? m.title : m.contact?.name ? `Call with ${m.contact.name}` : 'Meeting';
        const waLink =
          !isZoomOnly && m.contact?.phone
            ? whatsappLink(m.contact.phone, confirmMeetingMessage(m.contact.name, m.scheduled_at, m.zoom_link))
            : null;
        return `
        <div class="upcoming-item" data-idx="${upcoming.indexOf(m)}">
          <span class="u-when">${fmtTime(m.scheduled_at)}</span>
          <span class="u-name">${name}</span>
          ${waLink ? `<a href="${waLink}" target="_blank" rel="noopener" class="u-whatsapp">${sendLabel()}</a>` : ''}
          ${m.zoom_link ? `<a href="${m.zoom_link}" target="_blank" rel="noopener" class="u-join">Join</a>` : ''}
        </div>`;
      })
      .join('');
    $$('#calendar-upcoming-list .upcoming-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.u-join') || e.target.closest('.u-whatsapp')) return;
        openCalendarMeeting(upcoming[Number(item.dataset.idx)]);
      });
    });
  });
}

async function renderCalendarCard() {
  const grid = $('#calendar-grid');
  $('#calendar-month-label').textContent = calendarMonth.toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
  await withRetry(grid, async () => {
    const monthParam = `${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth() + 1).padStart(2, '0')}`;
    const meetings = await api(`/api/summary/month?month=${monthParam}`);
    const byDay = {};
    meetings.forEach((m) => {
      // An all-day event is a date, stored as noon UTC; read the date back in UTC so it
      // lands on the right day whatever timezone this browser is in.
      const d = m.all_day ? new Date(new Date(m.scheduled_at).getUTCFullYear(), new Date(m.scheduled_at).getUTCMonth(), new Date(m.scheduled_at).getUTCDate()) : new Date(m.scheduled_at);
      if (d.getMonth() !== calendarMonth.getMonth() || d.getFullYear() !== calendarMonth.getFullYear()) return;
      (byDay[d.getDate()] = byDay[d.getDate()] || []).push(m);
    });
    Object.values(byDay).forEach((list) =>
      list.sort((a, b) => (b.all_day ? 1 : 0) - (a.all_day ? 1 : 0) || new Date(a.scheduled_at) - new Date(b.scheduled_at))
    );

    const firstOfMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
    const daysInMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate();
    const leadingBlanks = firstOfMonth.getDay();
    const today = new Date();

    let cells = WEEKDAY_LABELS.map((w) => `<div class="cal-weekday">${w}</div>`).join('');
    for (let i = 0; i < leadingBlanks; i++) cells += '<div class="cal-day empty"></div>';
    for (let day = 1; day <= daysInMonth; day++) {
      const cellDate = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), day);
      const dayMeetings = byDay[day] || [];
      const visible = dayMeetings.slice(0, CAL_MAX_VISIBLE);
      const overflow = dayMeetings.length - visible.length;
      const classes = ['cal-day'];
      if (sameDay(cellDate, today)) classes.push('today');
      const eventsHtml = visible
        .map((m, i) => {
          const isZoomOnly = m.source === 'zoom';
          const isGoogle = m.source === 'google';
          const name = isZoomOnly || isGoogle ? m.title : m.contact?.name || 'Meeting';
          const past = new Date(m.scheduled_at).getTime() <= Date.now();
          const tip = m.outcome ? ` title="${escapeHtml(m.outcome.label)}"` : '';
          const cls = ['cal-event', past ? 'past' : '', isGoogle ? 'google' : ''].filter(Boolean).join(' ');
          const time = m.all_day ? '' : `${fmtTime(m.scheduled_at)} `;
          return `<div class="${cls}" data-day="${day}" data-idx="${i}"${tip}>${time}${escapeHtml(name)}</div>`;
        })
        .join('');
      cells += `
        <div class="${classes.join(' ')}">
          <span class="cal-day-num">${day}</span>
          <div class="cal-day-events">
            ${eventsHtml}
            ${overflow > 0 ? `<div class="cal-more">+${overflow} more</div>` : ''}
          </div>
        </div>`;
    }
    grid.innerHTML = cells;
    const legend = $('#calendar-legend');
    const showLegend = currentRole === 'caller' && GOOGLE_STATUS.connected && !GOOGLE_STATUS.needs_reconnect;
    legend.hidden = !showLegend;
    if (showLegend) {
      legend.innerHTML = '<span><i class="lg lg-zoom"></i>Zoom &amp; CRM meetings</span><span><i class="lg lg-google"></i>Google Calendar</span>';
    }

    $$('#calendar-grid .cal-event').forEach((chip) => {
      const meeting = (byDay[Number(chip.dataset.day)] || [])[Number(chip.dataset.idx)];
      if (!meeting) return;
      chip.addEventListener('click', () => openCalendarMeeting(meeting));
    });
  });
}

$('#cal-prev').addEventListener('click', () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
  renderCalendarCard();
});
$('#cal-next').addEventListener('click', () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
  renderCalendarCard();
});
$('#cal-today').addEventListener('click', () => {
  calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  renderCalendarCard();
});

async function renderSummaryTab() {
  if (currentRole === 'agent') {
    await Promise.all([renderCalendarUpcoming(), renderCalendarCard()]);
  } else {
    await Promise.all([renderRequestsCard(), renderCalendarCard()]);
  }
}

// =====================================================================
// MEETINGS (every scheduled deal, independent of pipeline stage)
// =====================================================================
let meetingsWhen = 'all';
let meetingsSortAsc = true;

const AVATAR_COLORS = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2'];

function initials(name) {
  const parts = (name || '?').trim().split(/\s+/);
  return parts.slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('') || '?';
}

function avatarColor(name) {
  let hash = 0;
  for (const ch of name || '') hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function avatarHtml(name) {
  return `<span class="avatar" style="background:${avatarColor(name || '')}" title="${name || 'Unassigned'}">${initials(name)}</span>`;
}

function fmtDateOnly(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

async function renderMeetingsTab() {
  const deals = await api(`/api/meetings?when=${meetingsWhen}`);
  if (!meetingsSortAsc) deals.reverse();
  const hasZoomOnly = deals.some((d) => d.source === 'zoom');
  if (hasZoomOnly) await ensureFollowupOutcomes();
  const body = $('#meetings-body');
  if (!deals.length) {
    body.innerHTML = '<div class="empty" style="padding:16px">No meetings here.</div>';
    return;
  }
  body.innerHTML = deals
    .map((d) => {
      const isZoomOnly = d.source === 'zoom';
      const isHistory = d.source === 'history'; // an earlier meeting on a deal, replaced by a newer booking
      const isPast = new Date(d.scheduled_at).getTime() <= Date.now();
      const name = isZoomOnly ? d.title : d.contact?.name ? `Call with ${d.contact.name}` : 'Meeting';
      const flags =
        (d.reschedule_requested
          ? `<span class="badge-warning" title="${escapeHtml(d.reschedule_requested.remark)}">Reschedule requested</span>`
          : '') + (d.outcome ? `<span class="badge-outcome">${escapeHtml(d.outcome.label)}</span>` : '');
      return `
      <div class="meetings-row${isPast ? ' is-past' : ''}" data-id="${d.id}" ${isHistory ? `data-deal-id="${d.deal_id}"` : ''} ${isZoomOnly ? 'data-zoom-only="1"' : ''}>
        <div class="mt-name">${name}${flags ? `<div class="mt-flags">${flags}</div>` : ''}</div>
        <div class="mt-join">${
          isHistory
            ? ''
            : d.zoom_link
            ? `<a href="${d.zoom_link}" target="_blank" rel="noopener" class="join-btn">Join</a>`
            : '<span class="join-btn join-disabled">Join</span>'
        }</div>
        <div class="mt-date"><div>${fmtDateOnly(d.scheduled_at)}</div><div class="mt-time">${fmtTime(d.scheduled_at)}</div></div>
        <div class="mt-attendee">${isZoomOnly ? '' : avatarHtml(d.contact?.name)}</div>
        <div class="mt-owner">${isZoomOnly ? '<span class="hint">Zoom</span>' : avatarHtml(d.owner)}</div>
        <div class="mt-actions">${
          isHistory
            ? ''
            : isZoomOnly
            ? currentRole === 'agent'
              ? // Once a Zoom meeting is over there's nothing left to move, but the outcome can still be logged.
                `${
                  isPast
                    ? ''
                    : `<button class="zoom-resched-request-btn" data-id="${d.id}">${d.reschedule_requested ? 'Edit request' : 'Request reschedule'}</button>`
                }${
                  d.outcome && !d.outcome_editable
                    ? ''
                    : `<button class="zoom-outcome-btn" data-id="${d.id}">${d.outcome ? 'Edit outcome' : 'Log outcome'}</button>`
                }`
              : isPast
              ? ''
              : `<button class="resched-btn" data-id="${d.id}">Reschedule</button>
               <button class="zoom-delete-btn" data-id="${d.id}">Delete meeting</button>`
            : `${
                d.contact?.phone
                  ? `<a href="${whatsappLink(
                      d.contact.phone,
                      confirmMeetingMessage(d.contact.name, d.scheduled_at, d.zoom_link)
                    )}" target="_blank" rel="noopener" class="mt-whatsapp-btn">${sendLabel()}</a>`
                  : ''
              }${
                currentRole === 'agent'
                  ? ''
                  : `<button class="resched-btn" data-id="${d.id}">Reschedule</button>
               <button class="crm-delete-btn" data-id="${d.id}">Delete meeting</button>`
              }`
        }</div>
      </div>`;
    })
    .join('');
  $$('#meetings-body .meetings-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (row.dataset.zoomOnly) return; // no linked deal to open
      if (
        e.target.closest('.join-btn') ||
        e.target.closest('.resched-btn') ||
        e.target.closest('.inline-resched') ||
        e.target.closest('.mt-whatsapp-btn') ||
        e.target.closest('.crm-delete-btn')
      )
        return;
      openDealModal(row.dataset.dealId || row.dataset.id);
    });
  });
  // Zoom-only meetings (booked directly in Zoom, not via the CRM pipeline)
  // have no deal to attach state to — both actions just raise a
  // notification instead of changing anything server-side for the meeting.
  $$('#meetings-body .zoom-resched-request-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const row = btn.closest('.meetings-row');
      if (row.querySelector('.inline-zoom-action')) return;
      const meeting = deals.find((d) => String(d.id) === btn.dataset.id);
      const existing = meeting?.reschedule_requested;
      const zoomId = btn.dataset.id.replace('zoom-', '');
      const form = document.createElement('div');
      form.className = 'inline-zoom-action';
      form.innerHTML = `
        <input type="text" class="iza-remark" placeholder="Reason (e.g. running late, need to push)" style="flex:1" value="${escapeHtml(existing?.remark || '')}" />
        <button class="iza-save primary">${existing ? 'Update' : 'Send'}</button>
        ${existing ? '<button class="iza-withdraw danger">Withdraw</button>' : ''}
        <button class="iza-cancel">Cancel</button>
      `;
      row.appendChild(form);
      inlineFormOpened();
      const close = () => {
        inlineFormClosed();
        form.remove();
      };
      form.querySelector('.iza-cancel').addEventListener('click', (ev) => {
        ev.stopPropagation();
        close();
      });
      form.querySelector('.iza-withdraw')?.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        await api(`/api/zoom-meetings/${zoomId}/request-reschedule`, {
          method: 'DELETE',
          body: JSON.stringify({ topic: meeting?.title }),
        });
        close();
        renderMeetingsTab();
      });
      form.querySelector('.iza-save').addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const remark = form.querySelector('.iza-remark').value.trim();
        if (!remark) return;
        await api(`/api/zoom-meetings/${zoomId}/request-reschedule`, {
          method: 'POST',
          body: JSON.stringify({
            remark,
            requested_by: currentUser(),
            topic: meeting?.title,
            scheduled_at: meeting?.scheduled_at,
          }),
        });
        close();
        renderMeetingsTab();
      });
    });
  });
  $$('#meetings-body .zoom-outcome-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const row = btn.closest('.meetings-row');
      if (row.querySelector('.inline-zoom-action')) return;
      const meeting = deals.find((d) => String(d.id) === btn.dataset.id);
      const existing = meeting?.outcome;
      const form = document.createElement('div');
      form.className = 'inline-zoom-action';
      form.innerHTML = `
        <select class="iza-outcome">${FOLLOWUP_OUTCOMES_CACHE.map(
          (o) => `<option value="${o.key}"${existing?.key === o.key ? ' selected' : ''}>${o.label}</option>`
        ).join('')}</select>
        <input type="text" class="iza-note" placeholder="Notes (optional)" style="flex:1" value="${escapeHtml(existing?.note || '')}" />
        <button class="iza-save primary">${existing ? 'Update' : 'Save'}</button>
        <button class="iza-cancel">Cancel</button>
      `;
      row.appendChild(form);
      inlineFormOpened();
      form.querySelector('.iza-cancel').addEventListener('click', (ev) => {
        ev.stopPropagation();
        inlineFormClosed();
        form.remove();
      });
      form.querySelector('.iza-save').addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const outcome = form.querySelector('.iza-outcome').value;
        const note = form.querySelector('.iza-note').value.trim();
        const zoomId = btn.dataset.id.replace('zoom-', '');
        await api(`/api/zoom-meetings/${zoomId}/outcome`, {
          method: 'POST',
          body: JSON.stringify({
            outcome,
            note,
            made_by: currentUser(),
            topic: meeting?.title,
            scheduled_at: meeting?.scheduled_at,
          }),
        });
        inlineFormClosed();
        form.remove();
        renderMeetingsTab();
      });
    });
  });
  $$('#meetings-body .crm-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const meeting = deals.find((d) => String(d.id) === btn.dataset.id);
      if (!confirm(`Delete the meeting with ${meeting?.contact?.name || 'this contact'}? This cancels the Zoom meeting and removes it from the calendar. The contact stays.`)) return;
      await api(`/api/deals/${btn.dataset.id}/meeting`, { method: 'DELETE', body: JSON.stringify({ changed_by: currentUser() }) });
      renderMeetingsTab();
    });
  });
  $$('#meetings-body .zoom-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const meeting = deals.find((d) => String(d.id) === btn.dataset.id);
      if (!confirm(`Delete "${meeting?.title || 'this meeting'}"? This cancels it in Zoom for everyone invited.`)) return;
      const zoomId = btn.dataset.id.replace('zoom-', '');
      await api(`/api/zoom-meetings/${zoomId}`, {
        method: 'DELETE',
        body: JSON.stringify({ deleted_by: currentUser(), topic: meeting?.title, scheduled_at: meeting?.scheduled_at }),
      });
      renderMeetingsTab();
    });
  });
  // A real <input type="datetime-local"> instead of window.prompt() — prompt()
  // isn't available in every embedding context (confirmed failing in some),
  // so this quick action can't depend on it.
  $$('#meetings-body .resched-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const row = btn.closest('.meetings-row');
      if (row.querySelector('.inline-resched')) return;
      const form = document.createElement('div');
      form.className = 'inline-resched';
      form.innerHTML = `
        <input type="datetime-local" class="ir-time" />
        <button class="ir-save primary">Save</button>
        <button class="ir-cancel">Cancel</button>
      `;
      row.appendChild(form);
      inlineFormOpened();
      form.querySelector('.ir-cancel').addEventListener('click', (ev) => {
        ev.stopPropagation();
        inlineFormClosed();
        form.remove();
      });
      form.querySelector('.ir-save').addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const val = form.querySelector('.ir-time').value;
        if (!val) return;
        const zoomOnly = String(btn.dataset.id).startsWith('zoom-');
        const meeting = zoomOnly ? deals.find((d) => String(d.id) === btn.dataset.id) : null;
        await api(
          zoomOnly
            ? `/api/zoom-meetings/${btn.dataset.id.replace('zoom-', '')}/reschedule`
            : `/api/deals/${btn.dataset.id}/reschedule`,
          {
            method: 'POST',
            body: JSON.stringify({
              scheduled_at: new Date(val).toISOString(),
              changed_by: currentUser(),
              topic: meeting?.title,
            }),
          }
        );
        inlineFormClosed();
        renderMeetingsTab();
      });
    });
  });
}

$$('.meet-subtab').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.meet-subtab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    meetingsWhen = btn.dataset.when;
    renderMeetingsTab();
  });
});

$('#meetings-sort').addEventListener('click', () => {
  meetingsSortAsc = !meetingsSortAsc;
  $('#meetings-sort').textContent = meetingsSortAsc ? '↑ Oldest first' : '↓ Newest first';
  renderMeetingsTab();
});

// =====================================================================
// PIPELINE
// =====================================================================
let STAGES_CACHE = [];

async function renderPipelineTab() {
  if (!STAGES_CACHE.length) STAGES_CACHE = await api('/api/stages');

  const next = await api('/api/deals/next');
  const nextCard = $('#next-card');
  nextCard.innerHTML = next
    ? `<strong>Next up:</strong> ${next.contact?.name || ''} — ${fmtWhen(next.scheduled_at)}<br/>${
        next.zoom_link ? `Zoom: ${next.zoom_link}` : ''
      }`
    : 'No upcoming scheduled meetings.';

  const deals = await api('/api/deals');
  const board = $('#board');
  board.innerHTML = '';

  STAGES_CACHE.forEach((stage) => {
    const col = document.createElement('div');
    col.className = 'board-col';
    col.dataset.stage = stage.key;
    const inStage = deals.filter((d) => d.stage === stage.key);
    col.innerHTML = `<div class="board-col-head"><span>${stage.label}</span><span>${inStage.length}</span></div>`;

    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const dealId = e.dataTransfer.getData('text/plain');
      if (!dealId) return;
      await api(`/api/deals/${dealId}/stage`, {
        method: 'POST',
        body: JSON.stringify({ stage: stage.key, changed_by: currentUser() }),
      });
      refresh();
    });

    inStage.forEach((deal) => col.appendChild(dealCard(deal)));
    board.appendChild(col);
  });
}

function dealCard(deal) {
  const card = document.createElement('div');
  card.className = 'deal-card';
  card.draggable = true;
  card.dataset.id = deal.id;
  card.innerHTML = `
    <div class="dname">${deal.contact?.name || 'unknown'}</div>
    <div class="dwhen">${deal.stage === 'meeting_booked' ? fmtWhen(deal.scheduled_at) : ''}</div>
    ${deal.reschedule_requested ? '<div class="badge-warning">Reschedule requested</div>' : ''}
  `;
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', deal.id);
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
  card.addEventListener('click', () => openDealModal(deal.id));
  return card;
}

let FOLLOWUP_OUTCOMES_CACHE = [];
async function ensureFollowupOutcomes() {
  if (!FOLLOWUP_OUTCOMES_CACHE.length) FOLLOWUP_OUTCOMES_CACHE = await api('/api/followup-outcomes');
  return FOLLOWUP_OUTCOMES_CACHE;
}

async function openDealModal(id, opts = {}) {
  const deal = await api(`/api/deals/${id}`);
  await ensureFollowupOutcomes();
  await loadZoomStatus();
  const contact = deal.contact || {};

  const calendarLinks = deal.scheduled_at
    ? await api(`/api/deals/${id}/calendar-link`).catch(() => null)
    : null;

  // The agent's job is to attend the meeting, not manage the pipeline —
  // give them the essentials (who/how to reach them, the join link) plus a
  // way to flag a reschedule, and leave calling/scheduling/emailing to
  // the caller, who owns those.
  const isAgent = currentRole === 'agent';

  const body = `
    <h2>${contact.name || ''}</h2>
    <div class="mnotes">${contact.phone || ''} ${contact.email ? '· ' + contact.email : ''}</div>
    ${deal.zoom_link ? `<div class="mnotes" style="margin-top:6px">Zoom link: <a href="${deal.zoom_link}" target="_blank" rel="noopener">${deal.zoom_link}</a></div>` : ''}
    ${
      opts.justBooked
        ? `<div class="banner-success">Meeting saved.${
            contact.phone ? ` Send ${escapeHtml(contact.name || 'the client')} the details:` : ' There is no phone number on file to text them.'
          }</div>`
        : ''
    }
    ${
      contact.phone && deal.scheduled_at
        ? `<a href="${whatsappLink(
            contact.phone,
            confirmMeetingMessage(contact.name, deal.scheduled_at, deal.zoom_link)
          )}" target="_blank" rel="noopener" class="whatsapp-btn" style="margin-top:8px">${sendLabel()} to client</a>`
        : ''
    }
    ${
      (deal.past_meetings || []).length
        ? `<div class="mnotes" style="margin-top:8px">Earlier meetings: ${deal.past_meetings
            .map((h) => `${fmtWhen(h.scheduled_at)}${h.outcome ? ` (${escapeHtml(h.outcome.label)})` : ''}`)
            .join(' · ')}</div>`
        : ''
    }
    ${
      deal.outcome
        ? `<div class="mnotes" style="margin-top:8px">Outcome: <strong>${escapeHtml(deal.outcome.label)}</strong>${
            deal.outcome.note ? ` — ${escapeHtml(deal.outcome.note)}` : ''
          } <span class="hint">(${escapeHtml(deal.outcome.logged_by)}, ${fmtWhen(deal.outcome.logged_at)})</span></div>`
        : ''
    }

    ${
      deal.reschedule_requested
        ? `<div class="banner-warning">
            <strong>Reschedule requested</strong> by ${escapeHtml(deal.reschedule_requested.requested_by)} (${fmtWhen(deal.reschedule_requested.requested_at)}):
            <em>"${escapeHtml(deal.reschedule_requested.remark)}"</em>${isAgent ? ' — waiting for the Caller to set a new time.' : ' — pick a new time below to resolve it.'}
          </div>`
        : ''
    }

    ${
      isAgent
        ? ''
        : ['won', 'lost'].includes(deal.stage)
        ? ''
        : `<div class="section-head"><h2>${deal.stage === 'meeting_booked' ? 'Reschedule' : 'Schedule meeting'}</h2></div>
    <div class="mactions">
      <input id="m-time" type="datetime-local" />
      ${ZOOM_STATUS.connected ? '' : `<input id="m-zoom" placeholder="Zoom link" value="${deal.zoom_link || ''}" />`}
      <button id="m-schedule" class="primary">${deal.stage === 'meeting_booked' ? 'Reschedule' : 'Schedule'}</button>
      ${deal.stage === 'meeting_booked' ? '<button id="m-delete-meeting" class="danger">Delete meeting</button>' : ''}
    </div>
    ${
      ZOOM_STATUS.connected
        ? `<div class="hint">${
            deal.zoom_meeting_id
              ? 'The Zoom meeting will be moved to the new time — same join link.'
              : 'A Zoom meeting will be created automatically on your connected account.'
          }</div>`
        : ''
    }
    ${
      calendarLinks
        ? `<div class="mnotes"><a href="${calendarLinks.googleCalendarUrl}" target="_blank" rel="noopener">Add to Google Calendar</a> · <a href="${calendarLinks.icsUrl}">Download .ics</a></div>`
        : ''
    }`
    }

    ${
      isAgent
        ? ''
        : `<div class="section-head"><h2>Remarks</h2></div>
    <div class="mactions">
      <input id="m-remark" placeholder="Write a remark…" style="flex:1" />
      <button id="m-add-remark">Save remark</button>
    </div>`
    }

    ${
      !isAgent || !(deal.stage === 'meeting_booked' || deal.reschedule_requested)
        ? ''
        : deal.reschedule_requested
        ? `<div class="section-head"><h2>Reschedule request</h2><span class="hint">You can change or withdraw it until the Caller sets a new time</span></div>
    <div class="mactions">
      <input id="m-resched-remark" value="${escapeHtml(deal.reschedule_requested.remark)}" style="flex:1" />
      <button id="m-request-reschedule">Update request</button>
      <button id="m-withdraw-request" class="danger">Withdraw</button>
    </div>`
        : `<div class="section-head"><h2>Request reschedule</h2><span class="hint">Flags it for the Caller, who sets the new time</span></div>
    <div class="mactions">
      <input id="m-resched-remark" placeholder="Reason (e.g. running late, client asked to push)" style="flex:1" />
      <button id="m-request-reschedule">Send request</button>
    </div>`
    }

    ${
      isAgent && (deal.stage === 'meeting_booked' || deal.outcome)
        ? `<div class="section-head"><h2>${deal.outcome ? 'Meeting outcome' : 'Meeting follow-up'}</h2>${
            deal.outcome ? '<span class="hint">You can change it until the Caller acts on it</span>' : ''
          }</div>
    <div class="mactions">
      <select id="m-followup-outcome">${FOLLOWUP_OUTCOMES_CACHE.map(
        (o) => `<option value="${o.key}"${deal.outcome?.key === o.key ? ' selected' : ''}>${o.label}</option>`
      ).join('')}</select>
      <input id="m-followup-note" placeholder="Notes (optional)" value="${escapeHtml(deal.outcome?.note || '')}" />
      <button id="m-log-followup" class="primary">${deal.outcome ? 'Update outcome' : 'Log outcome'}</button>
    </div>`
        : ''
    }

  `;

  $('#modal-body').innerHTML = body;
  $('#modal-overlay').hidden = false;

  if ($('#m-add-remark')) {
    $('#m-add-remark').addEventListener('click', async () => {
      const note = $('#m-remark').value.trim();
      if (!note) return;
      await api(`/api/deals/${id}/note`, {
        method: 'POST',
        body: JSON.stringify({ note, changed_by: currentUser() }),
      });
      openDealModal(id);
    });
  }

  if ($('#m-schedule')) {
    $('#m-schedule').addEventListener('click', async () => {
      const time = $('#m-time').value;
      if (!time) return alert('Pick a time.');
      const zoomInput = $('#m-zoom');
      const zoomLink = zoomInput ? zoomInput.value.trim() : '';
      if (!ZOOM_STATUS.connected && !zoomLink) return alert('Need a Zoom link (or connect Zoom in the top bar to auto-generate one).');
      const endpoint = deal.stage === 'meeting_booked' ? 'reschedule' : 'schedule';
      const payload = { scheduled_at: new Date(time).toISOString(), changed_by: currentUser() };
      if (zoomLink) payload.zoom_link = zoomLink;
      await api(`/api/deals/${id}/${endpoint}`, { method: 'POST', body: JSON.stringify(payload) });
      refresh();
      openDealModal(id, { justBooked: true }); // straight on to sending the client the details
    });
  }

  if ($('#m-delete-meeting')) {
    $('#m-delete-meeting').addEventListener('click', async () => {
      if (!confirm('Delete this meeting? This cancels the Zoom meeting and removes it from the calendar — the contact and deal stay.')) return;
      await api(`/api/deals/${id}/meeting`, { method: 'DELETE', body: JSON.stringify({ changed_by: currentUser() }) });
      closeModal(); refresh();
    });
  }

  if ($('#m-request-reschedule')) {
    $('#m-request-reschedule').addEventListener('click', async () => {
      const remark = $('#m-resched-remark').value.trim();
      if (!remark) return alert('Add a short reason.');
      await api(`/api/deals/${id}/request-reschedule`, {
        method: 'POST',
        body: JSON.stringify({ remark, requested_by: currentUser() }),
      });
      openDealModal(id); refresh();
    });
  }

  if ($('#m-withdraw-request')) {
    $('#m-withdraw-request').addEventListener('click', async () => {
      await api(`/api/deals/${id}/request-reschedule`, { method: 'DELETE' });
      openDealModal(id); refresh();
    });
  }

  if ($('#m-log-followup')) {
    $('#m-log-followup').addEventListener('click', async () => {
      await api(`/api/deals/${id}/followup`, {
        method: 'POST',
        body: JSON.stringify({
          outcome: $('#m-followup-outcome').value,
          note: $('#m-followup-note').value,
          changed_by: currentUser(),
        }),
      });
      openDealModal(id); refresh();
    });
  }

}

function closeModal() {
  $('#modal-overlay').hidden = true;
  $('#modal-body').innerHTML = '';
}
$('#modal-close').addEventListener('click', closeModal);
$('#modal-overlay').addEventListener('click', (e) => { if (e.target.id === 'modal-overlay') closeModal(); });

// =====================================================================
// CONTACTS
// =====================================================================
async function renderContactsTab(q) {
  const contacts = await api(`/api/contacts${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  const el = $('#contacts-list');
  el.innerHTML = '';
  if (!contacts.length) el.innerHTML = '<div class="empty">No contacts yet.</div>';
  contacts.forEach((c) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <strong>${c.name}</strong>${c.duplicate_phone ? '<span class="dup-tag">Duplicate number</span>' : ''}
      <div class="mnotes">${[c.phone, c.email].filter(Boolean).join(' · ') || '<em>no phone/email on file</em>'}</div>
      <div class="mnotes">${c.notes || ''}</div>
    `;
    const actions = document.createElement('div');
    actions.className = 'mactions';
    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit contact info';
    editBtn.addEventListener('click', () => {
      if (card.querySelector('.inline-edit')) return;
      const form = document.createElement('div');
      form.className = 'inline-edit';
      form.innerHTML = `
        <input class="ie-phone" placeholder="Phone" value="${c.phone || ''}" />
        <input class="ie-email" placeholder="Email" value="${c.email || ''}" />
        <button class="ie-save primary">Save</button>
        <button class="ie-cancel">Cancel</button>
        <button class="ie-delete danger">Delete contact</button>
      `;
      card.appendChild(form);
      inlineFormOpened();
      form.querySelector('.ie-cancel').addEventListener('click', () => {
        inlineFormClosed();
        form.remove();
      });
      form.querySelector('.ie-save').addEventListener('click', async () => {
        try {
          await api(`/api/contacts/${c.id}`, {
            method: 'PATCH',
            body: JSON.stringify({
              phone: form.querySelector('.ie-phone').value,
              email: form.querySelector('.ie-email').value,
            }),
          });
        } catch (err) {
          if (err.status === 409) return alert(err.message); // number already belongs to another contact
          throw err;
        }
        inlineFormClosed();
        renderContactsTab($('#contact-search').value);
      });
      // Available to all three roles — unlike adding a contact (Caller's
      // job), removing a bad record is something anyone should be able to do.
      form.querySelector('.ie-delete').addEventListener('click', async () => {
        if (
          !confirm(
            `Delete ${c.name}? This removes the contact and their deal history, and cancels any real Zoom meeting they have booked. This can't be undone.`
          )
        )
          return;
        await api(`/api/contacts/${c.id}`, { method: 'DELETE', body: JSON.stringify({ deleted_by: currentUser() }) });
        inlineFormClosed();
        renderContactsTab($('#contact-search').value);
      });
    });
    const chatLink = whatsappLink(c.phone);
    if (chatLink) {
      const textBtn = document.createElement('a');
      textBtn.className = 'contact-text-btn';
      textBtn.textContent = 'Text';
      textBtn.href = chatLink;
      textBtn.target = '_blank';
      textBtn.rel = 'noopener';
      actions.appendChild(textBtn);
    }
    actions.appendChild(editBtn);

    card.appendChild(actions);
    el.appendChild(card);
  });
}

$('#contact-search').addEventListener('input', (e) => renderContactsTab(e.target.value));

// ---------- Contacts: "All contacts" and "New contact" are separate views ----------
function setContactsView(view) {
  $$('.contacts-subtab').forEach((b) => b.classList.toggle('active', b.dataset.contactsView === view));
  $('#contacts-view-list').hidden = view !== 'list';
  $('#contacts-view-new').hidden = view !== 'new';
}
$$('.contacts-subtab').forEach((b) => b.addEventListener('click', () => setContactsView(b.dataset.contactsView)));

// Warn about a duplicate phone number as it's typed (the server enforces it too).
function showPhoneWarning(existing) {
  const box = $('#cf-phone-warning');
  $('#cf-submit').disabled = Boolean(existing);
  if (!existing) {
    box.hidden = true;
    return;
  }
  box.innerHTML = `<strong>${existing.name}</strong> already has this number (${existing.phone}). <a href="#" id="cf-view-existing">View contact</a>`;
  box.hidden = false;
  $('#cf-view-existing').addEventListener('click', (e) => {
    e.preventDefault();
    $('#contact-search').value = existing.phone;
    setContactsView('list');
    renderContactsTab(existing.phone);
  });
}
let phoneCheckTimer;
$('#contact-form [name=phone]').addEventListener('input', (e) => {
  clearTimeout(phoneCheckTimer);
  const phone = e.target.value.trim();
  if (!phone) return showPhoneWarning(null);
  phoneCheckTimer = setTimeout(async () => {
    try {
      const { existing } = await api(`/api/contacts/duplicate?phone=${encodeURIComponent(phone)}`);
      if (e.target.value.trim() === phone) showPhoneWarning(existing); // ignore stale answers
    } catch (err) {
      console.error(err);
    }
  }, 300);
});

// The Zoom link / hint / button label only matter once a meeting time is picked.
$('#contact-form [name=scheduled_at]').addEventListener('input', (e) => {
  $('#cf-submit').textContent = e.target.value ? 'Add contact & schedule meeting' : 'Add contact';
  renderZoomStatus();
});

$('#cf-result-done').addEventListener('click', () => {
  $('#cf-result').hidden = true;
  $('#contact-search').value = '';
  setContactsView('list');
  renderContactsTab();
});

$('#contact-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const when = form.scheduled_at.value;
  const zoomLink = form.zoom_link.value.trim();
  if (when && !ZOOM_STATUS.connected && !zoomLink) return alert('Paste a Zoom link for this meeting (Zoom is not connected to create one automatically).');
  let res;
  try {
    res = await api('/api/contacts', {
      method: 'POST',
      body: JSON.stringify({
        name: form.name.value,
        phone: form.phone.value,
        email: form.email.value,
        notes: form.notes.value,
        created_by: currentUser(),
        scheduled_at: when ? new Date(when).toISOString() : undefined,
        zoom_link: zoomLink || undefined,
      }),
    });
  } catch (err) {
    if (err.status === 409) return showPhoneWarning(err.body.existing); // someone else already has this number
    throw err;
  }
  form.reset();
  showPhoneWarning(null);
  $('#cf-submit').textContent = 'Add contact';
  renderZoomStatus();
  if (res.meeting_error) alert(`Contact added, but the meeting wasn't booked: ${res.meeting_error}\nOpen them from the Pipeline to try scheduling again.`);
  // A meeting was booked with the contact: the Caller sends the client the
  // details first, so offer that now instead of jumping away.
  if (res.deal?.scheduled_at && !res.meeting_error) {
    const send = $('#cf-result-send');
    $('#cf-result-text').textContent = `${res.contact.name} was added and the meeting is booked.`;
    if (res.contact.phone) {
      send.href = whatsappLink(res.contact.phone, confirmMeetingMessage(res.contact.name, res.deal.scheduled_at, res.deal.zoom_link));
      send.textContent = `${sendLabel()} to ${res.contact.name}`;
      send.hidden = false;
    } else {
      send.hidden = true;
      $('#cf-result-text').textContent += ' There is no phone number on file to text them.';
    }
    $('#cf-result').hidden = false;
    return;
  }
  // Back to the list so the new contact is right there (clear any search that would hide it).
  $('#contact-search').value = '';
  setContactsView('list');
  renderContactsTab();
});

$('#import-leads-btn').addEventListener('click', async () => {
  const res = await api('/api/leads/import', { method: 'POST', body: JSON.stringify({ created_by: currentUser() }) });
  alert(`Imported ${res.imported} new lead(s) as contacts + deals.`);
  renderContactsTab();
  refresh();
});

// =====================================================================
// ANALYTICS (dependency-free inline SVG charts)
// =====================================================================
// Short forms of the stage labels for the chart's x-axis, where full
// phrases like "Scheduled a Meeting" would crowd narrow bars.
// One colour per pipeline stage, running cool to warm as a deal progresses.
// Bar colours for the two outcomes the agent can log.
const OUTCOME_COLORS = { not_interested: '#f87171', follow_up: '#6366f1' };

// The Agent's numbers, one month at a time: interviews put in the diary, ones he
// actually went to, how many were moved, and how the ones he logged turned out
// (lib/stats.js). Everything is counted in the month it happened.
let analyticsMonth = null; // 'YYYY-MM'; null = this month

const monthName = (key, opts = { month: 'long', year: 'numeric' }) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, opts);
};
const thisMonthKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const shiftMonthKey = (key, delta) => {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

async function renderAnalyticsTab() {
  const params = new URLSearchParams({ tz: String(new Date().getTimezoneOffset()) });
  if (analyticsMonth) params.set('month', analyticsMonth);
  const a = await api(`/api/analytics?${params}`);
  analyticsMonth = a.month;
  const [selYear, selMonth] = a.month.split('-').map(Number);
  const [curYear, curMonth] = a.current_month.split('-').map(Number);

  $('#analytics-month-label').textContent = monthName(a.month);
  $('#an-today').hidden = a.month === a.current_month;

  // Year and month pickers. The year list grows by itself as years go by; months
  // that haven't happened yet in the current year can't be picked.
  $('#an-year').innerHTML = a.years.map((y) => `<option value="${y}"${y === selYear ? ' selected' : ''}>${y}</option>`).join('');
  $('#an-month').innerHTML = Array.from({ length: 12 }, (_, i) => {
    const label = new Date(2000, i, 1).toLocaleDateString(undefined, { month: 'long' });
    const future = selYear === curYear && i + 1 > curMonth;
    return `<option value="${i + 1}"${i + 1 === selMonth ? ' selected' : ''}${future ? ' disabled' : ''}>${label}</option>`;
  }).join('');

  const prevName = monthName(shiftMonthKey(a.month, -1), { month: 'short' });
  const versus = (now, before) =>
    now === before ? `Same as ${prevName}` : `${now > before ? '▲' : '▼'} ${Math.abs(now - before)} vs ${prevName}`;
  const card = (label, detail, now, before) => `
    <div class="stat-card">
      <div class="sval">${now}</div>
      <div class="slabel">${label}</div>
      <div class="sdetail">${detail}</div>
      <div class="ssub">${versus(now, before)}</div>
    </div>`;
  $('#stat-cards').innerHTML =
    card('Interviews fixed', 'Put in the diary', a.fixed, a.previous.fixed) +
    card('Interviews attended', 'Ones you went for and logged an outcome on', a.attended, a.previous.attended) +
    card('Reschedules made', 'Times a meeting was moved to a new time', a.rescheduled, a.previous.rescheduled);

  const max = Math.max(1, ...a.outcomes.map((o) => o.count));
  $('#stage-chart').innerHTML = `<div class="stage-bars">${a.outcomes
    .map(
      (o) => `
      <div class="stage-row">
        <div class="stage-label">${o.label}</div>
        <div class="stage-track"><div class="stage-fill" style="width:${(o.count / max) * 100}%;background:${OUTCOME_COLORS[o.key] || '#94a3b8'}"></div></div>
        <div class="stage-count${o.count ? '' : ' zero'}">${o.count}</div>
      </div>`
    )
    .join('')}</div>`;

  // Every month of the chosen year, with a total; click a row to open that month.
  const num = (n) => `<td class="${n ? '' : 'zero'}">${n}</td>`;
  const sum = (key) => a.months.reduce((total, m) => total + m[key], 0);
  $('#months-title').textContent = `Monthly ${selYear}`;
  $('#months-table').innerHTML =
    `<thead><tr><th>Month</th><th>Fixed</th><th>Attended</th><th>Rescheduled</th><th>Not interested</th><th>Another meeting</th></tr></thead><tbody>${a.months
      .map(
        (m) =>
          `<tr data-month="${m.month}" class="${m.month === a.month ? 'selected' : ''}"><th>${monthName(m.month, { month: 'long' })}</th>${num(m.fixed)}${num(m.attended)}${num(m.rescheduled)}${num(m.not_interested)}${num(m.follow_up)}</tr>`
      )
      .join('')}</tbody><tfoot><tr><th>${selYear} total</th>${num(sum('fixed'))}${num(sum('attended'))}${num(sum('rescheduled'))}${num(sum('not_interested'))}${num(sum('follow_up'))}</tr></tfoot>`;
  $$('#months-table tbody tr').forEach((row) =>
    row.addEventListener('click', () => {
      analyticsMonth = row.dataset.month;
      renderAnalyticsTab();
    })
  );
}

// Picking a year or month: keep the other one, but never land on a month that hasn't happened.
function pickAnalyticsMonth() {
  const year = Number($('#an-year').value);
  let month = Number($('#an-month').value);
  const [curYear, curMonth] = thisMonthKey().split('-').map(Number);
  if (year === curYear && month > curMonth) month = curMonth;
  analyticsMonth = `${year}-${String(month).padStart(2, '0')}`;
  renderAnalyticsTab();
}
$('#an-month').addEventListener('change', pickAnalyticsMonth);
$('#an-year').addEventListener('change', pickAnalyticsMonth);
$('#an-today').addEventListener('click', () => {
  analyticsMonth = null;
  renderAnalyticsTab();
});

// =====================================================================
async function refresh() {
  const active = $('.tab-panel.active').id;
  try {
    if (active === 'tab-summary') await renderSummaryTab();
    if (active === 'tab-pipeline') await renderPipelineTab();
    if (active === 'tab-meetings') await renderMeetingsTab();
    if (active === 'tab-contacts') await renderContactsTab($('#contact-search').value);
    if (active === 'tab-analytics') await renderAnalyticsTab();
  } catch (err) {
    console.error(err);
  }
}

$('#conn-retry').addEventListener('click', () => {
  hideConnBanner();
  refresh();
  refreshNotifCount();
});

// =====================================================================
// LOGIN / TEAMS
// =====================================================================
const AUTH_MODES = {
  login: {
    blurb: 'Log in to your team.',
    submit: 'Log in',
    fields: ['email', 'password'],
  },
  create: {
    blurb: 'Start a team for you and your teammate. A team is one Caller and one Agent — your data stays private to it.',
    submit: 'Create team',
    fields: ['name', 'team_name', 'role', 'email', 'password'],
  },
  join: {
    blurb: 'Your teammate already made the team? Enter the invite code they sent you.',
    submit: 'Join team',
    fields: ['name', 'invite_code', 'role', 'email', 'password'],
  },
};
let authMode = 'login';
// Set when someone is logged in but between teams (they just left one): the
// same screen then only asks which team, not who they are.
let teamlessUser = null;

function setAuthMode(mode) {
  authMode = mode;
  const cfg = AUTH_MODES[mode];
  $$('.auth-tab').forEach((t) => t.classList.toggle('active', t.dataset.authMode === mode));
  const fields = teamlessUser ? cfg.fields.filter((f) => f !== 'email' && f !== 'password') : cfg.fields;
  $$('#auth-form [data-auth-field]').forEach((el) => {
    el.hidden = !fields.includes(el.dataset.authField);
  });
  $('.auth-tab[data-auth-mode=login]').hidden = Boolean(teamlessUser);
  $('#auth-who').hidden = !teamlessUser;
  if (teamlessUser) {
    $('#auth-who-text').textContent = `Signed in as ${teamlessUser.name} (${teamlessUser.email}) — not in a team.`;
    $('#auth-form [name=name]').value = $('#auth-form [name=name]').value || teamlessUser.name;
  }
  $('#auth-blurb').textContent = cfg.blurb;
  $('#auth-submit').textContent = cfg.submit;
  $('#auth-form [name=password]').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#auth-error').hidden = true;
}

function showAuthScreen() {
  $('#app-shell').hidden = true;
  $('#auth-screen').hidden = false;
  setAuthMode('login');
}

function showTeamPicker(info) {
  teamlessUser = info.user;
  $('#app-shell').hidden = true;
  $('#auth-screen').hidden = false;
  setAuthMode('join');
}
$('#auth-logout').addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } finally {
    location.reload();
  }
});

$$('.auth-tab').forEach((tab) => tab.addEventListener('click', () => setAuthMode(tab.dataset.authMode)));

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = $('#auth-error');
  const submit = $('#auth-submit');
  const form = new FormData(e.target);
  errorEl.hidden = true;
  submit.disabled = true;
  try {
    const payload = Object.fromEntries(form.entries());
    const info = teamlessUser
      ? await api('/api/auth/team', { method: 'POST', body: JSON.stringify({ ...payload, mode: authMode }) })
      : authMode === 'login'
      ? await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: payload.email, password: payload.password }) })
      : await api('/api/auth/signup', { method: 'POST', body: JSON.stringify({ ...payload, mode: authMode }) });
    if (!info.team) {
      // Logged in, but their account isn't in a team (they left it earlier).
      e.target.reset();
      return showTeamPicker(info);
    }
    // Offer the browser's password manager the credentials (Chrome/Edge; other
    // browsers pick the form up on their own from the autocomplete attributes).
    // The password itself is never stored by this app — only by the browser.
    if (!teamlessUser && window.PasswordCredential && navigator.credentials?.store) {
      try {
        await navigator.credentials.store(new PasswordCredential({ id: payload.email, password: payload.password, name: info.user.name }));
      } catch {
        // not allowed in this context — the form autofill route still works
      }
    }
    e.target.reset();
    teamlessUser = null;
    await startApp(info);
  } catch (err) {
    errorEl.textContent = err.status === 401 || err.status === 400 || err.status === 409 || err.status === 429 ? err.message : 'Something went wrong — try again.';
    errorEl.hidden = false;
  } finally {
    submit.disabled = false;
  }
});

const ROLE_LABEL = { caller: 'Caller', agent: 'Agent' };

function copyText(text, btn) {
  const done = () => {
    const original = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = original), 1500);
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, done);
  else done();
}

function renderAccount() {
  const { user, team, invite } = ME;
  $('#page-user-name').textContent = user.name;
  $('#account-label').textContent = `${user.name} · ${ROLE_LABEL[user.role]}`;
  $('#am-name').textContent = `${user.name} (${ROLE_LABEL[user.role]})`;
  $('#am-email').textContent = user.email;
  $('#am-team').textContent = team.name;
  $('#am-invite').hidden = !invite;
  const showBanner = Boolean(invite) && sessionStorage.getItem('inviteBannerDismissed') !== '1';
  $('#invite-banner').hidden = !showBanner;
  if (invite) {
    $('#am-invite-role').textContent = ROLE_LABEL[invite.role];
    $('#am-invite-code').textContent = invite.code;
    $('#ib-role').textContent = ROLE_LABEL[invite.role];
    $('#ib-code').textContent = invite.code;
  }
}

$('#account-btn').addEventListener('click', () => {
  const menu = $('#account-menu');
  menu.hidden = !menu.hidden;
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.account-wrap')) $('#account-menu').hidden = true;
});
$('#am-copy').addEventListener('click', (e) => copyText($('#am-invite-code').textContent, e.target));
$('#ib-copy').addEventListener('click', (e) => copyText($('#ib-code').textContent, e.target));
$('#ib-dismiss').addEventListener('click', () => {
  sessionStorage.setItem('inviteBannerDismissed', '1');
  $('#invite-banner').hidden = true;
});
// Leaving the team: keeps the login, drops the seat. Reloading lands on the
// "pick a team" screen.
$('#am-leave-open').addEventListener('click', () => {
  $('#am-leave-open').hidden = true;
  $('#am-leave-form').hidden = false;
});
$('#am-leave-cancel').addEventListener('click', () => {
  $('#am-leave-form').hidden = true;
  $('#am-leave-open').hidden = false;
});
$('#am-leave-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/api/auth/leave', { method: 'POST' });
  location.reload();
});

// Deleting your own account: asks for the password again, removes only the
// login (the team's data stays), then reloads to the login screen.
$('#am-delete-open').addEventListener('click', () => {
  $('#am-delete-open').hidden = true;
  $('#am-delete-form').hidden = false;
  $('#am-delete-password').focus();
});
$('#am-delete-cancel').addEventListener('click', () => {
  $('#am-delete-form').hidden = true;
  $('#am-delete-open').hidden = false;
  $('#am-delete-password').value = '';
  $('#am-delete-error').hidden = true;
});
$('#am-delete-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = $('#am-delete-error');
  errorEl.hidden = true;
  try {
    await api('/api/auth/account', { method: 'DELETE', body: JSON.stringify({ password: $('#am-delete-password').value }) });
    location.reload();
  } catch (err) {
    errorEl.textContent = err.status === 403 ? err.message : 'Something went wrong — try again.';
    errorEl.hidden = false;
  }
});
$('#logout-btn').addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } finally {
    location.reload(); // wipes every bit of the previous person's screen state
  }
});

// Picks up a teammate joining (the invite code stops being needed) without a reload.
async function refreshMe() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.status === 401) return location.reload();
    if (res.ok) {
      ME = await res.json();
      if (!ME.team) return location.reload(); // removed from the team elsewhere
      renderAccount();
    }
  } catch (err) {
    console.error(err);
  }
}

let pollTimer = null;
async function startApp(info) {
  ME = info;
  $('#auth-screen').hidden = true;
  $('#app-shell').hidden = false;
  renderAccount();
  applyRoleVisibility(info.user.role);
  await loadZoomStatus();
  await loadGoogleStatus();
  await refreshNotifCount();
  await refresh();
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      if (openInlineForms === 0) refresh(); // don't stomp on an in-progress edit
      refreshNotifCount();
      refreshMe();
      loadGoogleStatus().catch(() => {});
    }, 20000);
  }
}

(async function init() {
  const params = new URLSearchParams(location.search);
  const zoomResult = params.get('zoom');
  const googleResult = params.get('google');
  if (zoomResult || googleResult) history.replaceState({}, '', location.pathname);

  let res;
  try {
    res = await fetch('/api/auth/me');
  } catch (err) {
    showConnBanner();
    $('#app-shell').hidden = false;
    return;
  }
  if (!res.ok) return showAuthScreen();
  const info = await res.json();
  if (!info.team) return showTeamPicker(info);
  await startApp(info);
  if (zoomResult === 'connected') alert('Zoom connected.');
  else if (zoomResult === 'error') alert('Zoom connection failed — check the server logs.');
  if (googleResult === 'connected') alert('Google Calendar connected. Your Caller can now see it — it will not appear on your own calendar.');
  else if (googleResult === 'error') alert('Google Calendar connection failed — check the server logs.');
})();
