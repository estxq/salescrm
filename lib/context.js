import { AsyncLocalStorage } from 'node:async_hooks';

// Which team the current request (or cron job) is acting for. The data layer
// reads this to decide whose contacts/deals/etc. it is touching, so no route
// or lib function has to thread a team id through by hand — and none can
// forget to.
const storage = new AsyncLocalStorage();

export function withTeam(teamId, fn) {
  return storage.run({ teamId: Number(teamId) }, fn);
}

export function currentTeamId() {
  return storage.getStore()?.teamId ?? null;
}
