// Runs inside a child process whose device timezone is set by the parent (TZ env).
import fs from 'node:fs';
import vm from 'node:vm';
const ctx = vm.createContext({ Date, Intl });
vm.runInContext(fs.readFileSync(new URL('../public/time.js', import.meta.url), 'utf8') + '\nthis.__t = { sgInputToISO, sgToInput, sgFormat, sgTime, sgDate, sgParts, sgDayKey, sgToday, sgNowMonthKey, deviceTimezoneDiffers, deviceUtcLabel };', ctx);
const t = ctx.__t;
const out = {};
// Christina: the Caller types 1:00 PM meaning Singapore time
out.christinaISO = t.sgInputToISO('2026-09-25T13:00');
out.myraISO = t.sgInputToISO('2026-09-25T15:00');
out.christinaShown = t.sgFormat(out.christinaISO, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
out.christinaTime = t.sgTime(out.christinaISO);
out.parts = t.sgParts(out.christinaISO);
out.roundTrip = t.sgToInput(t.sgInputToISO('2026-09-25T13:00'));
// The classic day-bucket bug: 01:00 on Sep 25 in Singapore is still Sep 24 in UTC and in the Americas
out.lateNightKey = t.sgDayKey('2026-09-24T17:00:00.000Z');
out.midnightEdgeKey = t.sgDayKey('2026-09-24T15:59:59.000Z'); // 23:59:59 on Sep 24 in Singapore
out.newYearKey = t.sgDayKey('2026-12-31T16:00:00.000Z'); // 00:00 on 1 Jan 2027 in Singapore
out.invalid = [t.sgInputToISO(''), t.sgInputToISO('garbage'), t.sgInputToISO(undefined)];
out.withSeconds = t.sgInputToISO('2026-09-25T13:00:30');
out.differs = t.deviceTimezoneDiffers();
out.label = t.deviceUtcLabel();
out.today = t.sgToday();
out.monthKey = t.sgNowMonthKey();
// "today" per Intl directly, as an independent cross-check
const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
out.intlToday = f;
console.log(JSON.stringify(out));
