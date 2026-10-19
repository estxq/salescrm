import { AsyncLocalStorage } from 'node:async_hooks';

// Which team — and, where it matters, which Agent — the current request (or cron job) is acting for.
// The data layer reads this to decide whose contacts/deals/etc. it is touching, so no route or lib
// function has to thread ids through by hand — and none can forget to.
//
// `agentId` picks whose personal connections (Zoom, Google Calendar) a call uses. A signed-in Agent
// always acts as themself; a Caller acts on a chosen Agent's behalf with withAgent(), e.g. to
// create the Zoom meeting on that Agent's own account.
const storage = new AsyncLocalStorage();

export function withTeam(teamId, fn) {
  return storage.run({ teamId: Number(teamId), agentId: null, cache: new Map() }, fn);
}

// Runs fn as the given Agent (null = nobody) within the current team.
export function withAgent(agentId, fn) {
  const store = storage.getStore() || {};
  return storage.run({ ...store, agentId: agentId == null ? null : Number(agentId) }, fn);
}

export function currentTeamId() {
  return storage.getStore()?.teamId ?? null;
}

export function currentAgentId() {
  return storage.getStore()?.agentId ?? null;
}

// A small per-request memo (shared by withAgent children), for things looked up many times in one
// request, like who the team's Agents are.
export function requestCache() {
  return storage.getStore()?.cache ?? null;
}
