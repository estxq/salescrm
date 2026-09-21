import { roleOfMember } from './accounts.js';
import { currentTeamId } from './context.js';

// Notifications are addressed by role, but callers only know who acted by
// name — this bridges the two, looking the name up among the current team's
// members.
export async function roleOfUser(name) {
  const teamId = currentTeamId();
  if (!name || teamId == null) return null;
  return roleOfMember(teamId, name);
}
