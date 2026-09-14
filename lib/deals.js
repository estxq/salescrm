import { all, insert, find, update, remove } from './db.js';
import { logActivity } from './activities.js';

export const STAGES = ['new', 'contacted', 'meeting_booked', 'proposal', 'won', 'lost'];

export const STAGE_LABELS = {
  new: 'Potential Client',
  contacted: 'Interested',
  meeting_booked: 'Scheduled a Meeting',
  proposal: 'Meeting Went Smooth',
  won: 'Won',
  lost: 'Not Interested',
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

export async function listDeals({ stage, contact_id } = {}) {
  let items = await all('deals');
  if (stage) items = items.filter((d) => d.stage === stage);
  if (contact_id) items = items.filter((d) => d.contact_id === Number(contact_id));
  return items.slice().sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
}

export async function getDeal(id) {
  return find('deals', id);
}

export async function getNextMeeting() {
  const upcoming = (await all('deals'))
    .filter((d) => d.stage === 'meeting_booked' && d.scheduled_at && new Date(d.scheduled_at).getTime() > Date.now())
    .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));
  return upcoming[0] || null;
}

export async function createDeal({ contact_id, title, value, stage, created_by }) {
  const initialStage = STAGES.includes(stage) ? stage : 'new';
  const deal = await insert('deals', (id) => ({
    id,
    contact_id,
    title: title || 'New deal',
    value: Number(value) || 0,
    stage: initialStage,
    owner: created_by || 'unknown',
    zoom_link: '',
    zoom_meeting_id: null,
    scheduled_at: null,
    proposed_at: null,
    proposed_by: null,
    reschedule_requested: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }));
  await logActivity({
    deal_id: deal.id,
    contact_id,
    type: 'stage_change',
    summary: `Deal created by ${deal.owner} (${STAGE_LABELS[initialStage]})`,
    made_by: created_by,
  });
  return deal;
}

export async function moveStage(id, { stage, changed_by, note }) {
  if (!STAGES.includes(stage)) return null;
  let prev;
  const deal = await update('deals', id, (d) => {
    prev = d.stage;
    d.stage = stage;
    touch(d);
  });
  if (!deal) return null;
  await logActivity({
    deal_id: deal.id,
    contact_id: deal.contact_id,
    type: 'stage_change',
    summary: `${changed_by || 'someone'} moved deal from ${STAGE_LABELS[prev]} to ${STAGE_LABELS[stage]}${
      note ? `: ${note}` : ''
    }`,
    made_by: changed_by,
  });
  return deal;
}

// The caller writes down whatever time the client agreed to on the call —
// this doesn't touch Zoom or scheduled_at, it's just a heads-up for the PA,
// who reviews it and actually books the meeting (creating the real Zoom
// link) via scheduleMeeting() below.
export async function proposeTime(id, { proposed_at, proposed_by }) {
  const deal = await update('deals', id, (d) => {
    d.proposed_at = proposed_at;
    d.proposed_by = proposed_by || null;
    touch(d);
  });
  if (!deal) return null;
  await logActivity({
    deal_id: deal.id,
    contact_id: deal.contact_id,
    type: 'note',
    summary: `${proposed_by || 'Caller'} proposed a meeting time: ${new Date(proposed_at).toLocaleString()} — PA to confirm and create the Zoom link.`,
    made_by: proposed_by,
  });
  return deal;
}

export async function scheduleMeeting(id, { zoom_link, zoom_meeting_id, scheduled_at, changed_by }) {
  const deal = await update('deals', id, (d) => {
    d.zoom_link = zoom_link;
    d.zoom_meeting_id = zoom_meeting_id || null;
    d.scheduled_at = scheduled_at;
    d.stage = 'meeting_booked';
    d.reminded_at = null;
    d.reschedule_requested = null;
    d.proposed_at = null; // fulfilled — the proposed time did its job
    d.proposed_by = null;
    touch(d);
  });
  if (!deal) return null;
  await logActivity({
    deal_id: deal.id,
    contact_id: deal.contact_id,
    type: 'meeting',
    summary: `${changed_by || 'PA'} scheduled meeting for ${new Date(scheduled_at).toLocaleString()}`,
    made_by: changed_by,
    meta: { zoom_link, scheduled_at },
  });
  return deal;
}

export async function rescheduleMeeting(id, { scheduled_at, zoom_link, changed_by }) {
  let prev;
  const deal = await update('deals', id, (d) => {
    prev = d.scheduled_at;
    d.scheduled_at = scheduled_at;
    if (zoom_link) d.zoom_link = zoom_link; // manual-mode override; Zoom-managed links stay the same
    d.reminded_at = null; // new time means the reminder window resets
    d.reschedule_requested = null; // this fulfills any pending request
    touch(d);
  });
  if (!deal) return null;
  await logActivity({
    deal_id: deal.id,
    contact_id: deal.contact_id,
    type: 'meeting',
    summary: `${changed_by || 'PA'} confirmed new time — ${
      prev ? new Date(prev).toLocaleString() : 'unset'
    } to ${new Date(scheduled_at).toLocaleString()}`,
    made_by: changed_by,
  });
  return deal;
}

export async function markReminded(id) {
  return update('deals', id, (deal) => {
    deal.reminded_at = new Date().toISOString();
  });
}

// The agent flags that a meeting needs to move, with a remark explaining
// why. This does NOT change the time itself — the PA reads the remark and
// picks the actual new slot via rescheduleMeeting().
export async function requestReschedule(id, { remark, requested_by }) {
  const deal = await update('deals', id, (d) => {
    d.reschedule_requested = {
      remark: remark || '',
      requested_by: requested_by || 'agent',
      requested_at: new Date().toISOString(),
    };
    touch(d);
  });
  if (!deal) return null;
  await logActivity({
    deal_id: deal.id,
    contact_id: deal.contact_id,
    type: 'reschedule_request',
    summary: `${requested_by || 'agent'} asked to reschedule${remark ? `: ${remark}` : ''}`,
    made_by: requested_by,
  });
  return deal;
}

export async function logFollowUp(id, { outcome, note, changed_by }) {
  const config = FOLLOWUP_OUTCOMES[outcome];
  if (!config) return null;
  return moveStage(id, { stage: config.stage, changed_by, note: note ? `${config.label} — ${note}` : config.label });
}

export async function updateDealValue(id, { value, changed_by }) {
  const deal = await update('deals', id, (d) => {
    d.value = Number(value) || 0;
    touch(d);
  });
  if (!deal) return null;
  await logActivity({
    deal_id: deal.id,
    contact_id: deal.contact_id,
    type: 'note',
    summary: `${changed_by || 'someone'} set deal value to ${deal.value}`,
    made_by: changed_by,
  });
  return deal;
}

export async function logCall(id, { outcome, notes, made_by }) {
  const deal = await update('deals', id, (d) => touch(d));
  if (!deal) return null;
  await logActivity({
    deal_id: deal.id,
    contact_id: deal.contact_id,
    type: 'call',
    summary: `${made_by || 'someone'} logged a call — ${outcome}${notes ? `: ${notes}` : ''}`,
    made_by,
    meta: { outcome, notes },
  });
  // The call outcome doubles as a stage update — no separate click needed.
  if (outcome === 'booked' && deal.stage === 'new') {
    return moveStage(id, { stage: 'contacted', changed_by: made_by, note: 'meeting scheduled on call' });
  }
  if (outcome === 'not_interested') {
    return moveStage(id, { stage: 'lost', changed_by: made_by, note: notes || 'not interested on call' });
  }
  return deal;
}

export async function deleteDeal(id) {
  return remove('deals', id);
}

export async function addNote(id, { note, changed_by }) {
  const deal = await getDeal(id);
  if (!deal) return null;
  await logActivity({ deal_id: deal.id, contact_id: deal.contact_id, type: 'note', summary: note, made_by: changed_by });
  return deal;
}
