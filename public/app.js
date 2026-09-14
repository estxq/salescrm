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
  try {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    hideConnBanner();
    return res.status === 204 ? null : res.json();
  } catch (err) {
    showConnBanner();
    throw err;
  }
}

function fmtWhen(iso) {
  if (!iso) return 'not scheduled yet';
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
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
// dials leads and logs outcomes, the PA schedules meetings and sends
// emails, the agent attends meetings and tracks performance. Everyone still
// hits the same open API underneath — this is a decluttering convenience,
// not access control (there's no real auth in this app).
const ROLE_TABS = {
  caller: ['summary', 'pipeline', 'contacts'],
  pa: ['summary', 'pipeline', 'meetings', 'templates', 'contacts'],
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
}

async function loadUsers() {
  const users = await api('/api/users');
  const sel = $('#current-user');
  sel.innerHTML = users.map((u) => `<option value="${u.name}" data-role="${u.role}">${u.name} (${u.role})</option>`).join('');
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
  const el = $('#zoom-status');
  const canManage = currentRole === 'agent'; // it's the agent's own personal Zoom account
  if (!ZOOM_STATUS.configured) {
    el.innerHTML = '<span class="zoom-pill zoom-off" title="Set ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET in .env to enable">Zoom not connected</span>';
    return;
  }
  if (ZOOM_STATUS.connected) {
    el.innerHTML = `<span class="zoom-pill zoom-on">🎥 ${ZOOM_STATUS.email || 'Zoom connected'}</span>${
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
    const { count } = await api('/api/notifications/unread-count');
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

async function renderNotifDropdown() {
  const notifs = await api('/api/notifications');
  const el = $('#notif-list');
  if (!notifs.length) {
    el.innerHTML = '<div class="empty">No notifications yet.</div>';
    return;
  }
  el.innerHTML = notifs
    .slice(0, 20)
    .map(
      (n) => `
      <div class="notif-item ${n.read_at ? '' : 'unread'}" data-id="${n.id}" data-deal="${n.deal_id || ''}">
        <div class="n-msg">${n.message}</div>
        <div class="n-when">${fmtWhen(n.created_at)}</div>
      </div>`
    )
    .join('');
  $$('#notif-list .notif-item').forEach((item) => {
    item.addEventListener('click', async () => {
      await api(`/api/notifications/${item.dataset.id}/read`, { method: 'POST' });
      $('#notif-dropdown').hidden = true;
      refreshNotifCount();
      if (item.dataset.deal) {
        activateTab('pipeline');
        openDealModal(item.dataset.deal);
      }
    });
  });
}

$('#notif-bell').addEventListener('click', async () => {
  const dd = $('#notif-dropdown');
  dd.hidden = !dd.hidden;
  if (!dd.hidden) await renderNotifDropdown();
});

$('#notif-mark-all').addEventListener('click', async (e) => {
  e.stopPropagation();
  await api('/api/notifications/read-all', { method: 'POST' });
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
        <button class="task-link" data-jump="pipeline"><span>Follow-up emails due</span><span class="count">${t.emails}</span></button>
        <button class="task-link" data-jump="pipeline"><span>Stale proposals (3+ days)</span><span class="count">${t.staleProposals}</span></button>
        <button class="task-link" data-jump="pipeline"><span>Meetings today</span><span class="count">${t.meetingsToday}</span></button>
        <button class="task-link" data-jump="pipeline"><span>Reschedule requests</span><span class="count">${t.rescheduleRequests}</span></button>
      </div>
    `;
    $$('#tasks-body .task-link').forEach((btn) => btn.addEventListener('click', () => activateTab(btn.dataset.jump)));
  });
}

const ACTIVITY_ICONS = {
  call: '📞',
  email: '✉️',
  meeting: '📅',
  reschedule_request: '🔄',
  stage_change: '➡️',
  note: '📝',
};

function fmtCompact(iso) {
  const d = new Date(iso);
  const isToday = d.toDateString() === new Date().toDateString();
  return isToday
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function truncate(str, n) {
  return str && str.length > n ? `${str.slice(0, n - 1)}…` : str || '';
}

async function renderActivitiesCard() {
  const el = $('#activities-body');
  await withRetry(el, async () => {
    const activities = await api('/api/summary/activities?limit=12');
    if (!activities.length) {
      el.innerHTML = '<div class="empty">No activity yet.</div>';
      return;
    }
    el.innerHTML = `<div class="activity-feed">${activities
      .map(
        (a) => `
        <div class="activity-item">
          <div class="activity-icon">${ACTIVITY_ICONS[a.type] || '•'}</div>
          <div class="activity-body">
            <div class="activity-top">
              <span class="activity-name">${a.contact ? a.contact.name : 'System'}</span>
              <span class="a-when">${fmtCompact(a.at)}</span>
            </div>
            <div class="activity-text" title="${(a.summary || '').replace(/"/g, '&quot;')}">${truncate(a.summary, 64)}</div>
          </div>
        </div>`
      )
      .join('')}</div>`;
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
      .map(
        (d) => `
        <div class="schedule-slot" data-id="${d.id}">
          <span class="s-time">${fmtTime(d.scheduled_at)}</span>
          <span class="s-name">${d.contact?.name || 'unknown'}${d.reschedule_requested ? ' <span class="badge-warning">⚠ reschedule</span>' : ''}</span>
          <span class="s-actions">
            <button data-action="view">View</button>
          </span>
        </div>`
      )
      .join('');
    $$('#schedule-body .schedule-slot').forEach((slot) => {
      slot.querySelector('[data-action="view"]').addEventListener('click', () => openDealModal(slot.dataset.id));
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

async function renderSummaryTab() {
  await Promise.all([renderTasksCard(), renderActivitiesCard(), renderScheduleCard()]);
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
  const body = $('#meetings-body');
  if (!deals.length) {
    body.innerHTML = '<div class="empty" style="padding:16px">No meetings here.</div>';
    return;
  }
  body.innerHTML = deals
    .map(
      (d) => `
      <div class="meetings-row" data-id="${d.id}">
        <div class="mt-name">${d.contact?.name ? `Call with ${d.contact.name}` : 'Meeting'}</div>
        <div class="mt-join">${
          d.zoom_link
            ? `<a href="${d.zoom_link}" target="_blank" rel="noopener" class="join-btn">Join</a>`
            : '<span class="join-btn join-disabled">Join</span>'
        }</div>
        <div class="mt-date"><div>${fmtDateOnly(d.scheduled_at)}</div><div class="mt-time">${fmtTime(d.scheduled_at)}</div></div>
        <div class="mt-attendee">${avatarHtml(d.contact?.name)}</div>
        <div class="mt-owner">${avatarHtml(d.owner)}</div>
        <div class="mt-actions"><button class="resched-btn" data-id="${d.id}">Reschedule</button></div>
      </div>`
    )
    .join('');
  $$('#meetings-body .meetings-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.join-btn') || e.target.closest('.resched-btn') || e.target.closest('.inline-resched')) return;
      openDealModal(row.dataset.id);
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
        await api(`/api/deals/${btn.dataset.id}/reschedule`, {
          method: 'POST',
          body: JSON.stringify({ scheduled_at: new Date(val).toISOString(), changed_by: currentUser() }),
        });
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
    ? `<strong>Next up:</strong> #${next.id} ${next.contact?.name || ''} — ${fmtWhen(next.scheduled_at)}<br/>${
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

const CALL_OUTCOME_LABELS = {
  booked: 'Booked',
  connected: 'Connected',
  voicemail: 'Voicemail',
  no_answer: 'No answer',
};

function dealCard(deal) {
  const card = document.createElement('div');
  card.className = 'deal-card';
  card.draggable = true;
  card.dataset.id = deal.id;
  card.innerHTML = `
    <div class="dname">#${deal.id} ${deal.contact?.name || 'unknown'}</div>
    ${deal.value ? `<div class="dvalue">$${deal.value}</div>` : ''}
    <div class="dwhen">${deal.stage === 'meeting_booked' ? fmtWhen(deal.scheduled_at) : ''}</div>
    ${deal.last_call_outcome ? `<div class="badge-call">📞 ${CALL_OUTCOME_LABELS[deal.last_call_outcome] || deal.last_call_outcome}</div>` : ''}
    ${deal.reschedule_requested ? '<div class="badge-warning">⚠ reschedule requested</div>' : ''}
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

async function openDealModal(id) {
  const deal = await api(`/api/deals/${id}`);
  const templates = await api('/api/templates');
  if (!FOLLOWUP_OUTCOMES_CACHE.length) FOLLOWUP_OUTCOMES_CACHE = await api('/api/followup-outcomes');
  await loadZoomStatus();
  const contact = deal.contact || {};

  const timelineHtml = deal.activities.length
    ? deal.activities
        .map(
          (a) => `
        <div class="timeline-item">
          <div class="timeline-icon">${ACTIVITY_ICONS[a.type] || '•'}</div>
          <div class="timeline-body">
            <div class="t-when">${fmtWhen(a.at)}</div>
            <div class="t-text">${a.summary}${a.type === 'email' && a.meta?.opened_at ? ' <strong>(opened)</strong>' : ''}</div>
          </div>
        </div>`
        )
        .join('')
    : '<div class="empty">No activity yet.</div>';

  const templateOptions = templates.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');

  const calendarLinks = deal.scheduled_at
    ? await api(`/api/deals/${id}/calendar-link`).catch(() => null)
    : null;

  const body = `
    <h2>#${deal.id} ${contact.name || ''}</h2>
    <div class="mnotes">${contact.phone || ''} ${contact.email ? '· ' + contact.email : ''} ${contact.company ? '· ' + contact.company : ''}</div>
    <div class="mnotes">${contact.notes || ''}</div>
    ${deal.last_call_outcome ? `<div class="badge-call" style="margin-top:6px">📞 Last call: ${CALL_OUTCOME_LABELS[deal.last_call_outcome] || deal.last_call_outcome}</div>` : ''}

    <div class="mactions" style="margin-top:12px">
      <label>Value $ <input id="m-value" type="number" value="${deal.value || 0}" style="width:90px" /></label>
      <button id="m-save-value">Save</button>
    </div>

    <div class="section-head"><h2>Call progress</h2></div>
    <div class="mactions">
      <select id="m-call-outcome">
        <option value="booked">Booked — meeting agreed</option>
        <option value="connected">Connected, no booking yet</option>
        <option value="voicemail">Voicemail left</option>
        <option value="no_answer">No answer</option>
      </select>
      <input id="m-call-notes" placeholder="Notes" />
      <button id="m-log-call" class="primary">Log call</button>
    </div>

    ${
      deal.stage === 'new' || deal.stage === 'contacted'
        ? `<div class="section-head"><h2>Update progress</h2></div>
    <div class="mactions">
      ${deal.stage === 'new' ? '<button id="m-mark-interested" class="primary">Interested</button>' : ''}
      <button id="m-mark-not-interested" class="danger">Not interested</button>
    </div>`
        : ''
    }

    <div class="section-head"><h2>Remarks</h2></div>
    <div class="mactions">
      <input id="m-remark" placeholder="Write a remark…" style="flex:1" />
      <button id="m-add-remark">Save remark</button>
    </div>

    ${
      deal.reschedule_requested
        ? `<div class="banner-warning">
            <strong>Reschedule requested</strong> by ${deal.reschedule_requested.requested_by} (${fmtWhen(deal.reschedule_requested.requested_at)}):
            <em>"${deal.reschedule_requested.remark}"</em> — pick a new time below to resolve it.
          </div>`
        : ''
    }

    <div class="section-head"><h2>${deal.stage === 'meeting_booked' ? 'Reschedule' : 'Schedule meeting'}</h2></div>
    ${deal.zoom_link ? `<div class="mnotes">Current Zoom link: <a href="${deal.zoom_link}" target="_blank" rel="noopener">${deal.zoom_link}</a></div>` : ''}
    <div class="mactions">
      <input id="m-time" type="datetime-local" />
      ${ZOOM_STATUS.connected ? '' : `<input id="m-zoom" placeholder="Zoom link" value="${deal.zoom_link || ''}" />`}
      <button id="m-schedule" class="primary">${deal.stage === 'meeting_booked' ? 'Reschedule' : 'Schedule'}</button>
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
    }

    ${
      deal.stage === 'meeting_booked'
        ? `<div class="section-head"><h2>Request reschedule</h2><span class="hint">Flags it for whoever manages the calendar, without changing the time yourself</span></div>
    <div class="mactions">
      <input id="m-resched-remark" placeholder="Reason (e.g. running late, client asked to push)" style="flex:1" />
      <button id="m-request-reschedule">Send request</button>
    </div>`
        : ''
    }

    <div class="section-head"><h2>Send email</h2></div>
    <div class="mactions">
      <select id="m-template">${templateOptions || '<option value="">No templates yet</option>'}</select>
      <button id="m-send-email" class="primary" ${templates.length ? '' : 'disabled'}>Send</button>
    </div>
    ${contact.email ? '' : '<div class="hint">Contact has no email address — add one in Contacts to send.</div>'}

    ${
      deal.stage === 'meeting_booked'
        ? `<div class="section-head"><h2>Meeting follow-up</h2></div>
    <div class="mactions">
      <select id="m-followup-outcome">${FOLLOWUP_OUTCOMES_CACHE.map((o) => `<option value="${o.key}">${o.label}</option>`).join('')}</select>
      <input id="m-followup-note" placeholder="Notes (optional)" />
      <button id="m-log-followup" class="primary">Log outcome</button>
    </div>`
        : ''
    }

    <div class="section-head"><h2>Stage</h2></div>
    <div class="mactions">
      <button id="m-won" class="primary">Mark won</button>
      <button id="m-lost" class="danger">Mark lost</button>
    </div>

    <div class="section-head"><h2>Activity timeline</h2></div>
    <div class="timeline">${timelineHtml}</div>
  `;

  $('#modal-body').innerHTML = body;
  $('#modal-overlay').hidden = false;

  $('#m-save-value').addEventListener('click', async () => {
    await api(`/api/deals/${id}/value`, {
      method: 'POST',
      body: JSON.stringify({ value: Number($('#m-value').value), changed_by: currentUser() }),
    });
    closeModal(); refresh();
  });

  $('#m-log-call').addEventListener('click', async () => {
    await api(`/api/deals/${id}/call`, {
      method: 'POST',
      body: JSON.stringify({ outcome: $('#m-call-outcome').value, notes: $('#m-call-notes').value, made_by: currentUser() }),
    });
    openDealModal(id); refresh();
  });

  if (deal.stage === 'new') {
    $('#m-mark-interested').addEventListener('click', async () => {
      await api(`/api/deals/${id}/stage`, {
        method: 'POST',
        body: JSON.stringify({ stage: 'contacted', changed_by: currentUser() }),
      });
      closeModal(); refresh();
    });
  }
  if (deal.stage === 'new' || deal.stage === 'contacted') {
    $('#m-mark-not-interested').addEventListener('click', async () => {
      await api(`/api/deals/${id}/stage`, {
        method: 'POST',
        body: JSON.stringify({ stage: 'lost', changed_by: currentUser() }),
      });
      closeModal(); refresh();
    });
  }

  $('#m-add-remark').addEventListener('click', async () => {
    const note = $('#m-remark').value.trim();
    if (!note) return;
    await api(`/api/deals/${id}/note`, {
      method: 'POST',
      body: JSON.stringify({ note, changed_by: currentUser() }),
    });
    openDealModal(id);
  });

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

  if (deal.stage === 'meeting_booked') {
    $('#m-request-reschedule').addEventListener('click', async () => {
      const remark = $('#m-resched-remark').value.trim();
      if (!remark) return alert('Add a short reason for the PA.');
      await api(`/api/deals/${id}/request-reschedule`, {
        method: 'POST',
        body: JSON.stringify({ remark, requested_by: currentUser() }),
      });
      openDealModal(id); refresh();
    });

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

  $('#m-send-email').addEventListener('click', async () => {
    if (!contact.email) return alert('Contact has no email address.');
    await api(`/api/deals/${id}/email`, {
      method: 'POST',
      body: JSON.stringify({ template_id: $('#m-template').value, made_by: currentUser() }),
    });
    openDealModal(id);
  });

  $('#m-won').addEventListener('click', async () => {
    await api(`/api/deals/${id}/stage`, { method: 'POST', body: JSON.stringify({ stage: 'won', changed_by: currentUser() }) });
    closeModal(); refresh();
  });

  $('#m-lost').addEventListener('click', async () => {
    await api(`/api/deals/${id}/stage`, { method: 'POST', body: JSON.stringify({ stage: 'lost', changed_by: currentUser() }) });
    closeModal(); refresh();
  });
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
      <strong>${c.name}</strong> ${c.company ? `— ${c.company}` : ''}
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
        <input class="ie-company" placeholder="Company" value="${c.company || ''}" />
        <button class="ie-save primary">Save</button>
        <button class="ie-cancel">Cancel</button>
      `;
      card.appendChild(form);
      inlineFormOpened();
      form.querySelector('.ie-cancel').addEventListener('click', () => {
        inlineFormClosed();
        form.remove();
      });
      form.querySelector('.ie-save').addEventListener('click', async () => {
        await api(`/api/contacts/${c.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            phone: form.querySelector('.ie-phone').value,
            email: form.querySelector('.ie-email').value,
            company: form.querySelector('.ie-company').value,
          }),
        });
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

$('#contact-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  await api('/api/contacts', {
    method: 'POST',
    body: JSON.stringify({
      name: form.name.value,
      phone: form.phone.value,
      email: form.email.value,
      company: form.company.value,
      notes: form.notes.value,
      created_by: currentUser(),
    }),
  });
  form.reset();
  renderContactsTab();
});

$('#import-leads-btn').addEventListener('click', async () => {
  const res = await api('/api/leads/import', { method: 'POST', body: JSON.stringify({ created_by: currentUser() }) });
  alert(`Imported ${res.imported} new lead(s) as contacts + deals.`);
  renderContactsTab();
  refresh();
});

// =====================================================================
// TEMPLATES
// =====================================================================
async function renderTemplatesTab() {
  const templates = await api('/api/templates');
  const el = $('#templates-list');
  el.innerHTML = '';
  if (!templates.length) el.innerHTML = '<div class="empty">No templates yet.</div>';
  templates.forEach((t) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <strong>${t.name}</strong>
      <div class="mnotes"><em>${t.subject}</em></div>
      <div class="mnotes">${t.body}</div>
    `;
    const actions = document.createElement('div');
    actions.className = 'mactions';
    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.className = 'danger';
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Delete template "${t.name}"?`)) return;
      await api(`/api/templates/${t.id}`, { method: 'DELETE' });
      renderTemplatesTab();
    });
    actions.appendChild(delBtn);
    card.appendChild(actions);
    el.appendChild(card);
  });
}

$('#template-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  await api('/api/templates', {
    method: 'POST',
    body: JSON.stringify({
      name: form.name.value,
      subject: form.subject.value,
      body: form.body.value,
      created_by: currentUser(),
    }),
  });
  form.reset();
  renderTemplatesTab();
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

function lineChartSvg(items, { width = 480, height = 220, color = '#16a34a' } = {}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  const chartH = height - 36;
  const stepX = width / Math.max(1, items.length - 1);
  const points = items.map((item, i) => {
    const x = i * stepX;
    const y = chartH - (item.value / max) * (chartH - 10);
    return [x, y];
  });
  const path = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join(' ');
  const dots = points
    .map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="3" fill="${color}"><title>${items[i].label}: ${items[i].value}</title></circle>`)
    .join('');
  const labels = items
    .map((item, i) => (i % 2 === 0 ? `<text x="${i * stepX}" y="${chartH + 16}" font-size="9" text-anchor="middle" fill="#6b7280">${item.label}</text>` : ''))
    .join('');
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" style="max-width:100%">
    <path d="${path}" fill="none" stroke="${color}" stroke-width="2"></path>
    ${dots}${labels}
  </svg>`;
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
  $('#calls-chart').innerHTML = lineChartSvg(a.callsPerDay.map((d) => ({ label: d.day.slice(5), value: d.count })));
}

// =====================================================================
async function refresh() {
  const active = $('.tab-panel.active').id;
  try {
    if (active === 'tab-summary') await renderSummaryTab();
    if (active === 'tab-pipeline') await renderPipelineTab();
    if (active === 'tab-meetings') await renderMeetingsTab();
    if (active === 'tab-contacts') await renderContactsTab($('#contact-search').value);
    if (active === 'tab-templates') await renderTemplatesTab();
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
