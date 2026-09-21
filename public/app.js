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
  if (res.status >= 500) showConnBanner();
  else hideConnBanner();
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
function whatsappLink(phone, message) {
  if (!phone) return null;
  const digits = phone.replace(/[^0-9]/g, '');
  if (!digits) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

function confirmMeetingMessage(name, scheduledAt, zoomLink) {
  const when = new Date(scheduledAt).toLocaleString(undefined, {
    weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  return `Hi ${name || 'there'}, just confirming our meeting on ${when}.${zoomLink ? ` Zoom link: ${zoomLink}` : ''}`;
}

function currentUser() {
  const sel = $('#current-user');
  return sel && sel.value ? sel.value : 'someone';
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
  caller: ['summary', 'meetings', 'pipeline', 'contacts'],
  agent: ['summary', 'pipeline', 'meetings', 'analytics', 'contacts'],
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
  // Adding contacts is Caller's job (they're the one bringing in fresh
  // leads) — the Agent only needs to look someone up, not create records.
  $$('.add-contact-control').forEach((el) => {
    el.hidden = role !== 'caller';
  });
  if (role !== 'caller') setContactsView('list');
  // The agent's job is attending meetings, not chasing sales-pipeline tasks
  // (calls to make, stale proposals — those are Caller metrics and
  // always read 0 for him) — so his Summary is just a month-glance calendar
  // instead of the task list + single-day view everyone else gets.
  const isAgentSummary = role === 'agent';
  const tasksCard = $('#tasks-card');
  const scheduleCard = $('#schedule-card');
  const calendarCard = $('#calendar-card');
  if (tasksCard) tasksCard.hidden = isAgentSummary;
  if (scheduleCard) scheduleCard.hidden = isAgentSummary;
  if (calendarCard) calendarCard.hidden = !isAgentSummary;
  if ($('#tab-summary').classList.contains('active')) renderSummaryTab();
  refreshNotifCount(); // the bell only counts what's addressed to this role
}

async function loadUsers() {
  const users = await api('/api/users');
  const sel = $('#current-user');
  sel.innerHTML = users
    .map((u) => `<option value="${u.name}" data-role="${u.role}">${u.name.toLowerCase() === u.role ? u.name : `${u.name} (${u.role})`}</option>`)
    .join('');
  const saved = localStorage.getItem('scheduleHubUser');
  if (saved && users.some((u) => u.name === saved)) sel.value = saved;
  $('#page-user-name').textContent = sel.value;
  applyRoleVisibility(sel.selectedOptions[0]?.dataset.role || 'agent');
  sel.addEventListener('change', () => {
    localStorage.setItem('scheduleHubUser', sel.value);
    $('#page-user-name').textContent = sel.value;
    applyRoleVisibility(sel.selectedOptions[0]?.dataset.role || 'agent');
  });
}

$('#global-search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim();
  activateTab('contacts');
  setContactsView('list');
  $('#contact-search').value = q;
  renderContactsTab(q);
});

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
        activateTab('pipeline');
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
// SUMMARY (HubSpot-style: Your tasks / Your outreach / Schedule)
// =====================================================================
let scheduleDate = new Date();

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

async function renderTasksCard() {
  const el = $('#tasks-body');
  await withRetry(el, async () => {
    const t = await api('/api/summary/tasks');
    el.innerHTML = `
      <div class="task-stats">
        <div class="task-stat"><div class="tval">${t.highPriority}</div><div class="tlabel">High priority</div></div>
        <div class="task-stat"><div class="tval">${t.allTasks}</div><div class="tlabel">All tasks</div></div>
      </div>
      <div class="task-links">
        <button class="task-link" data-jump="pipeline"><span>Calls to make</span><span class="count">${t.calls}</span></button>
        <button class="task-link" data-jump="pipeline"><span>Stale proposals (3+ days)</span><span class="count">${t.staleProposals}</span></button>
        <button class="task-link" data-jump="pipeline"><span>Meetings today</span><span class="count">${t.meetingsToday}</span></button>
        <button class="task-link" data-jump="pipeline"><span>Reschedule requests</span><span class="count">${t.rescheduleRequests}</span></button>
      </div>
    `;
    $$('#tasks-body .task-link').forEach((btn) => btn.addEventListener('click', () => activateTab(btn.dataset.jump)));
  });
}

async function renderScheduleCard() {
  $('#sched-date').textContent = scheduleDate.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const el = $('#schedule-body');
  await withRetry(el, async () => {
    const dateParam = scheduleDate.toISOString().slice(0, 10);
    const deals = await api(`/api/summary/schedule?date=${dateParam}`);
    if (!deals.length) {
      el.innerHTML = '<div class="empty">Nothing scheduled this day.</div>';
      return;
    }
    el.innerHTML = deals
      .map((d) => {
        const isZoomOnly = d.source === 'zoom';
        const name = isZoomOnly ? d.title : d.contact?.name || 'unknown';
        return `
        <div class="schedule-slot" data-id="${d.id}">
          <span class="s-time">${fmtTime(d.scheduled_at)}</span>
          <span class="s-name">${name}${d.reschedule_requested ? ' <span class="badge-warning">Reschedule requested</span>' : ''}</span>
          <span class="s-actions">
            ${
              isZoomOnly
                ? d.zoom_link
                  ? `<a href="${d.zoom_link}" target="_blank" rel="noopener">Join</a>`
                  : ''
                : '<button data-action="view">View</button>'
            }
          </span>
        </div>`;
      })
      .join('');
    $$('#schedule-body .schedule-slot').forEach((slot) => {
      const viewBtn = slot.querySelector('[data-action="view"]');
      if (viewBtn) viewBtn.addEventListener('click', () => openDealModal(slot.dataset.id));
    });
  });
}

$('#sched-prev').addEventListener('click', () => {
  scheduleDate.setDate(scheduleDate.getDate() - 1);
  renderScheduleCard();
});
$('#sched-next').addEventListener('click', () => {
  scheduleDate.setDate(scheduleDate.getDate() + 1);
  renderScheduleCard();
});

// ---------- Month calendar (Agent's Summary view) ----------
let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CAL_MAX_VISIBLE = 3;

function sameDay(a, b) {
  return a.toDateString() === b.toDateString();
}

// Zoom-only meetings have no deal to open a modal for — Join is the only
// thing to do with them, so a click just opens the link instead.
function openCalendarMeeting(meeting) {
  if (meeting.source === 'zoom') {
    if (meeting.zoom_link) window.open(meeting.zoom_link, '_blank', 'noopener');
  } else {
    openDealModal(meeting.id);
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
          ${waLink ? `<a href="${waLink}" target="_blank" rel="noopener" class="u-whatsapp">Text</a>` : ''}
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
      const d = new Date(m.scheduled_at);
      if (d.getMonth() !== calendarMonth.getMonth() || d.getFullYear() !== calendarMonth.getFullYear()) return;
      (byDay[d.getDate()] = byDay[d.getDate()] || []).push(m);
    });
    Object.values(byDay).forEach((list) => list.sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at)));

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
          const name = isZoomOnly ? m.title : m.contact?.name || 'Meeting';
          return `<div class="cal-event" data-day="${day}" data-idx="${i}">${fmtTime(m.scheduled_at)} ${name}</div>`;
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
    await Promise.all([renderTasksCard(), renderScheduleCard()]);
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
      const name = isZoomOnly ? d.title : d.contact?.name ? `Call with ${d.contact.name}` : 'Meeting';
      return `
      <div class="meetings-row" data-id="${d.id}" ${isZoomOnly ? 'data-zoom-only="1"' : ''}>
        <div class="mt-name">${name}</div>
        <div class="mt-join">${
          d.zoom_link
            ? `<a href="${d.zoom_link}" target="_blank" rel="noopener" class="join-btn">Join</a>`
            : '<span class="join-btn join-disabled">Join</span>'
        }</div>
        <div class="mt-date"><div>${fmtDateOnly(d.scheduled_at)}</div><div class="mt-time">${fmtTime(d.scheduled_at)}</div></div>
        <div class="mt-attendee">${isZoomOnly ? '' : avatarHtml(d.contact?.name)}</div>
        <div class="mt-owner">${isZoomOnly ? '<span class="hint">Zoom</span>' : avatarHtml(d.owner)}</div>
        <div class="mt-actions">${
          isZoomOnly
            ? currentRole === 'agent'
              ? `<button class="zoom-resched-request-btn" data-id="${d.id}">Request reschedule</button>
               <button class="zoom-outcome-btn" data-id="${d.id}">Log outcome</button>`
              : `<button class="resched-btn" data-id="${d.id}">Reschedule</button>
               <button class="zoom-delete-btn" data-id="${d.id}">Delete meeting</button>`
            : `${
                d.contact?.phone
                  ? `<a href="${whatsappLink(
                      d.contact.phone,
                      confirmMeetingMessage(d.contact.name, d.scheduled_at, d.zoom_link)
                    )}" target="_blank" rel="noopener" class="mt-whatsapp-btn">Text</a>`
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
      openDealModal(row.dataset.id);
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
      const form = document.createElement('div');
      form.className = 'inline-zoom-action';
      form.innerHTML = `
        <input type="text" class="iza-remark" placeholder="Reason (e.g. running late, need to push)" style="flex:1" />
        <button class="iza-save primary">Send</button>
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
        const remark = form.querySelector('.iza-remark').value.trim();
        if (!remark) return;
        const zoomId = btn.dataset.id.replace('zoom-', '');
        await api(`/api/zoom-meetings/${zoomId}/request-reschedule`, {
          method: 'POST',
          body: JSON.stringify({
            remark,
            requested_by: currentUser(),
            topic: meeting?.title,
            scheduled_at: meeting?.scheduled_at,
          }),
        });
        inlineFormClosed();
        form.remove();
        alert('Sent — whoever manages the calendar will see it in notifications.');
      });
    });
  });
  $$('#meetings-body .zoom-outcome-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const row = btn.closest('.meetings-row');
      if (row.querySelector('.inline-zoom-action')) return;
      const meeting = deals.find((d) => String(d.id) === btn.dataset.id);
      const form = document.createElement('div');
      form.className = 'inline-zoom-action';
      form.innerHTML = `
        <select class="iza-outcome">${FOLLOWUP_OUTCOMES_CACHE.map((o) => `<option value="${o.key}">${o.label}</option>`).join('')}</select>
        <input type="text" class="iza-note" placeholder="Notes (optional)" style="flex:1" />
        <button class="iza-save primary">Save</button>
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
        alert('Logged.');
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

async function openDealModal(id) {
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
      contact.phone && deal.scheduled_at
        ? `<a href="${whatsappLink(
            contact.phone,
            confirmMeetingMessage(contact.name, deal.scheduled_at, deal.zoom_link)
          )}" target="_blank" rel="noopener" class="whatsapp-btn" style="margin-top:8px">Text to confirm</a>`
        : ''
    }

    ${
      deal.reschedule_requested
        ? `<div class="banner-warning">
            <strong>Reschedule requested</strong> by ${deal.reschedule_requested.requested_by} (${fmtWhen(deal.reschedule_requested.requested_at)}):
            <em>"${deal.reschedule_requested.remark}"</em>${isAgent ? ' — waiting for the Caller to set a new time.' : ' — pick a new time below to resolve it.'}
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
      isAgent && deal.stage === 'meeting_booked'
        ? `<div class="section-head"><h2>Request reschedule</h2><span class="hint">Flags it for the Caller, who sets the new time</span></div>
    <div class="mactions">
      <input id="m-resched-remark" placeholder="Reason (e.g. running late, client asked to push)" style="flex:1" />
      <button id="m-request-reschedule">Send request</button>
    </div>`
        : ''
    }

    ${
      isAgent && deal.stage === 'meeting_booked'
        ? `<div class="section-head"><h2>Meeting follow-up</h2></div>
    <div class="mactions">
      <select id="m-followup-outcome">${FOLLOWUP_OUTCOMES_CACHE.map((o) => `<option value="${o.key}">${o.label}</option>`).join('')}</select>
      <input id="m-followup-note" placeholder="Notes (optional)" />
      <button id="m-log-followup" class="primary">Log outcome</button>
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
      closeModal(); refresh();
    });
  }

  if ($('#m-delete-meeting')) {
    $('#m-delete-meeting').addEventListener('click', async () => {
      if (!confirm('Delete this meeting? This cancels the Zoom meeting and removes it from the calendar — the contact and deal stay.')) return;
      await api(`/api/deals/${id}/meeting`, { method: 'DELETE', body: JSON.stringify({ changed_by: currentUser() }) });
      closeModal(); refresh();
    });
  }

  if (deal.stage === 'meeting_booked') {
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
        closeModal(); refresh();
      });
    }
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
function barChartSvg(items, { width = 480, height = 220, color = '#2563eb' } = {}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  const barW = width / items.length;
  const chartH = height - 36;
  const bars = items
    .map((item, i) => {
      const h = (item.value / max) * (chartH - 10);
      const x = i * barW + barW * 0.15;
      const w = barW * 0.7;
      const y = chartH - h;
      return `
        <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="${color}"></rect>
        <text x="${x + w / 2}" y="${chartH + 16}" font-size="10" text-anchor="middle" fill="#6b7280">${item.label}</text>
        <text x="${x + w / 2}" y="${y - 4}" font-size="11" text-anchor="middle" fill="#1b1f24">${item.value}</text>
      `;
    })
    .join('');
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" style="max-width:100%">${bars}</svg>`;
}

// Short forms of the stage labels for the chart's x-axis, where full
// phrases like "Scheduled a Meeting" would crowd narrow bars.
const STAGE_CHART_LABELS = {
  new: 'Potential',
  contacted: 'Interested',
  meeting_booked: 'Meeting',
  proposal: 'Post-meeting',
  won: 'Won',
  lost: 'Not interested',
};

async function renderAnalyticsTab() {
  const a = await api('/api/analytics');

  $('#stat-cards').innerHTML = `
    <div class="stat-card"><div class="sval">${a.totalContacts}</div><div class="slabel">Total contacts</div></div>
    <div class="stat-card"><div class="sval">${a.openDeals}</div><div class="slabel">Open deals</div></div>
    <div class="stat-card"><div class="sval">${a.wonThisMonth}</div><div class="slabel">Won this month</div></div>
    <div class="stat-card"><div class="sval">${a.winRate}%</div><div class="slabel">Win rate</div></div>
  `;

  $('#stage-chart').innerHTML = barChartSvg(
    a.dealsByStage.map((s) => ({ label: STAGE_CHART_LABELS[s.stage] || s.label, value: s.count }))
  );
}

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

(async function init() {
  const params = new URLSearchParams(location.search);
  if (params.get('zoom') === 'connected') {
    history.replaceState({}, '', location.pathname);
    alert('Zoom connected.');
  } else if (params.get('zoom') === 'error') {
    history.replaceState({}, '', location.pathname);
    alert('Zoom connection failed — check the server logs.');
  }

  await loadUsers();
  await loadZoomStatus();
  await refreshNotifCount();
  await refresh();
  setInterval(() => {
    if (openInlineForms === 0) refresh(); // don't stomp on an in-progress edit
    refreshNotifCount();
  }, 20000);
})();
