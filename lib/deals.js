import { all, insert, find, update } from './db.js';
import { logActivity } from './activities.js';

export const STAGES = ['new', 'contacted', 'meeting_booked', 'proposal', 'won', 'lost'];

export const STAGE_LABELS = {
  new: 'New Lead',
  contacted: 'Contacted',
  meeting_booked: 'Meeting Booked',
  proposal: 'Proposal',
  won: 'Won',
  lost: 'Lost',
};

// Options the agent picks from right after a meeting happens — plain
// outcomes instead of raw stage names, each mapped to a pipeline stage.
export const FOLLOWUP_OUTCOMES = {
  proceed: { label: 'Ready to proceed', stage: 'proposal' },
  follow_up: { label: 'Needs another follow-up', stage: 'contacted' },
  not_interested: { label: 'Not interested', stage: 'lost' },
};

function touch(deal) {
  deal.updated_at = new Date().toISOString();
}

export function listDeals({ stage, contact_id } = {}) {
  let items = all('deals');
  if (stage) items = items.filter((d) => d.stage === stage);
  if (contact_id) items = items.filter((d) => d.contact_id === Number(contact_id));
  return items.slice().sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
}

export function getDeal(id) {
  return find('deals', id);
}

export function getNextMeeting() {
  const upcoming = all('deals')
    .filter((d) => d.stage === 'meeting_booked' && d.scheduled_at && new Date(d.scheduled_at).getTime() > Date.now())
    .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));
  return upcoming[0] || null;
}

export function createDeal({ contact_id, title, value, stage, created_by }) {
  const initialStage = STAGES.includes(stage) ? stage : 'new';
  const deal = insert('deals', (id) => ({
    id,
    contact_id,
    title: title || 'New deal',
    value: Number(value) || 0,
    stage: initialStage,
    owner: created_by || 'unknown',
    zoom_link: '',
    zoom_meeting_id: null,
    scheduled_at: null,
    reschedule_requested: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }));
  logActivity({
    deal_id: deal.id,
    contact_id,
    type: 'stage_change',
    summary: `Deal created by ${deal.owner} (${STAGE_LABELS[initialStage]})`,
    made_by: created_by,
  });
  return deal;
}

export function moveStage(id, { stage, changed_by, note }) {
  if (!STAGES.includes(stage)) return null;
  return update('deals', id, (deal) => {
    const prev = deal.stage;
    deal.stage = stage;
    touch(deal);
    logActivity({
      deal_id: deal.id,
      contact_id: deal.contact_id,
      type: 'stage_change',
      summary: `${changed_by || 'someone'} moved deal from ${STAGE_LABELS[prev]} to ${STAGE_LABELS[stage]}${
        note ? `: ${note}` : ''
      }`,
      made_by: changed_by,
    });
  });
}

export function scheduleMeeting(id, { zoom_link, zoom_meeting_id, scheduled_at, changed_by }) {
  return update('deals', id, (deal) => {
    deal.zoom_link = zoom_link;
    deal.zoom_meeting_id = zoom_meeting_id || null;
    deal.scheduled_at = scheduled_at;
    deal.stage = 'meeting_booked';
    deal.reminded_at = null;
    deal.reschedule_requested = null;
    touch(deal);
    logActivity({
      deal_id: deal.id,
      contact_id: deal.contact_id,
      type: 'meeting',
      summary: `${changed_by || 'PA'} scheduled meeting for ${new Date(scheduled_at).toLocaleString()}`,
      made_by: changed_by,
      meta: { zoom_link, scheduled_at },
    });
  });
}

export function rescheduleMeeting(id, { scheduled_at, zoom_link, changed_by }) {
  return update('deals', id, (deal) => {
    const prev = deal.scheduled_at;
    deal.scheduled_at = scheduled_at;
    if (zoom_link) deal.zoom_link = zoom_link; // manual-mode override; Zoom-managed links stay the same
    deal.reminded_at = null; // new time means the reminder window resets
    deal.reschedule_requested = null; // this fulfills any pending request
    touch(deal);
    logActivity({
      deal_id: deal.id,
      contact_id: deal.contact_id,
      type: 'meeting',
      summary: `${changed_by || 'PA'} confirmed new time — ${
        prev ? new Date(prev).toLocaleString() : 'unset'
      } to ${new Date(scheduled_at).toLocaleString()}`,
      made_by: changed_by,
    });
  });
}

export function markReminded(id) {
  return update('deals', id, (deal) => {
    deal.reminded_at = new Date().toISOString();
  });
}

// The agent flags that a meeting needs to move, with a remark explaining
// why. This does NOT change the time itself — the PA reads the remark and
// picks the actual new slot via rescheduleMeeting().
export function requestReschedule(id, { remark, requested_by }) {
  return update('deals', id, (deal) => {
    deal.reschedule_requested = {
      remark: remark || '',
      requested_by: requested_by || 'agent',
      requested_at: new Date().toISOString(),
    };
    touch(deal);
    logActivity({
      deal_id: deal.id,
      contact_id: deal.contact_id,
      type: 'reschedule_request',
      summary: `${requested_by || 'agent'} asked to reschedule${remark ? `: ${remark}` : ''}`,
      made_by: requested_by,
    });
  });
}

export function logFollowUp(id, { outcome, note, changed_by }) {
  const config = FOLLOWUP_OUTCOMES[outcome];
  if (!config) return null;
  return moveStage(id, { stage: config.stage, changed_by, note: note ? `${config.label} — ${note}` : config.label });
}

export function updateDealValue(id, { value, changed_by }) {
  return update('deals', id, (deal) => {
    deal.value = Number(value) || 0;
    touch(deal);
    logActivity({
      deal_id: deal.id,
      contact_id: deal.contact_id,
      type: 'note',
      summary: `${changed_by || 'someone'} set deal value to ${deal.value}`,
      made_by: changed_by,
    });
  });
}

export function logCall(id, { outcome, notes, made_by }) {
  const deal = update('deals', id, (d) => touch(d));
  if (!deal) return null;
  logActivity({
    deal_id: deal.id,
    contact_id: deal.contact_id,
    type: 'call',
    summary: `${made_by || 'someone'} logged a call — ${outcome}${notes ? `: ${notes}` : ''}`,
    made_by,
    meta: { outcome, notes },
  });
  // A positive outcome naturally advances a fresh lead to "awaiting scheduling"
  if (outcome === 'booked' && deal.stage === 'new') {
    return moveStage(id, { stage: 'contacted', changed_by: made_by, note: 'call booked' });
  }
  return deal;
}

export function addNote(id, { note, changed_by }) {
  const deal = getDeal(id);
  if (!deal) return null;
  logActivity({ deal_id: deal.id, contact_id: deal.contact_id, type: 'note', summary: note, made_by: changed_by });
  return deal;
}
