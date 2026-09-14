import { listDeals, markReminded } from './deals.js';
import { notifyReminder } from './notify.js';

const REMINDER_WINDOW_MIN = Number(process.env.REMINDER_WINDOW_MIN || 60);

export async function checkAndSendReminders() {
  const now = Date.now();
  const upcoming = listDeals({ stage: 'meeting_booked' }).filter((d) => d.scheduled_at);
  for (const deal of upcoming) {
    const minsUntil = (new Date(deal.scheduled_at).getTime() - now) / 60000;
    if (minsUntil > 0 && minsUntil <= REMINDER_WINDOW_MIN && !deal.reminded_at) {
      await notifyReminder(deal);
      markReminded(deal.id);
    }
  }
}
