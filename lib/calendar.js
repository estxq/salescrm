function icsDate(d) {
  return d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

function escapeIcs(s) {
  return String(s || '').replace(/[\\,;]/g, (m) => '\\' + m).replace(/\n/g, '\\n');
}

// 45-minute default meeting length — this is a sales intro call, not a real
// calendar system, so we don't ask anyone for an end time.
export function buildIcs({ uid, title, description, location, start, durationMinutes = 45 }) {
  const startDate = new Date(start);
  const endDate = new Date(startDate.getTime() + durationMinutes * 60000);
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Schedule Hub//EN',
    'BEGIN:VEVENT',
    `UID:${uid}@schedule-hub`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(startDate)}`,
    `DTEND:${icsDate(endDate)}`,
    `SUMMARY:${escapeIcs(title)}`,
    description ? `DESCRIPTION:${escapeIcs(description)}` : '',
    location ? `LOCATION:${escapeIcs(location)}` : '',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ]
    .filter((line) => line !== '')
    .join('\r\n');
}

export function googleCalendarLink({ title, description, location, start, durationMinutes = 45 }) {
  const startDate = new Date(start);
  const endDate = new Date(startDate.getTime() + durationMinutes * 60000);
  const dates = `${icsDate(startDate)}/${icsDate(endDate)}`;
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates,
    details: description || '',
    location: location || '',
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
