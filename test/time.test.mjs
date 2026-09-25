import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const S = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL:', n, x !== undefined ? JSON.stringify(x) : ''); } };

// Where devices really are: Singapore itself, plus the zones that produced (or could
// produce) skew — Brisbane is exactly the +2h gap in the bug report.
const ZONES = ['Asia/Singapore', 'Australia/Brisbane', 'UTC', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Auckland', 'Europe/London'];
const runs = {};
for (const tz of ZONES) {
  const r = spawnSync(process.execPath, [S + '/time-child.mjs'], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
  if (r.status !== 0) { console.log('child failed for', tz, r.stderr); process.exit(1); }
  runs[tz] = JSON.parse(r.stdout);
}
const base = runs['Asia/Singapore'];

for (const tz of ZONES) {
  const o = runs[tz];
  check(`[${tz}] typing 1:00 PM is stored as 05:00 UTC (= 1 PM Singapore)`, o.christinaISO === '2026-09-25T05:00:00.000Z', o.christinaISO);
  check(`[${tz}] typing 3:00 PM is stored as 07:00 UTC`, o.myraISO === '2026-09-25T07:00:00.000Z', o.myraISO);
  check(`[${tz}] that moment is SHOWN as 1:00 PM (not shifted by the device zone)`, /1:00\s?PM/.test(o.christinaShown) && /Sep 25/.test(o.christinaShown), o.christinaShown);
  check(`[${tz}] time-only display is 1:00 PM`, /^1:00\s?PM$/.test(o.christinaTime), o.christinaTime);
  check(`[${tz}] wall-clock fields read 13:00 on the 25th`, o.parts.h === 13 && o.parts.mi === 0 && o.parts.d === 25 && o.parts.m === 9, o.parts);
  check(`[${tz}] type -> store -> refill round-trips exactly`, o.roundTrip === '2026-09-25T13:00', o.roundTrip);
  check(`[${tz}] 01:00 Singapore time lands on the 25th, not the 24th`, o.lateNightKey === '2026-09-25', o.lateNightKey);
  check(`[${tz}] 23:59:59 Singapore time is still the 24th`, o.midnightEdgeKey === '2026-09-24', o.midnightEdgeKey);
  check(`[${tz}] midnight 1 Jan is the new year in Singapore`, o.newYearKey === '2027-01-01', o.newYearKey);
  check(`[${tz}] junk input is rejected, not turned into a wrong time`, o.invalid.every((v) => v === null), o.invalid);
  check(`[${tz}] seconds in the input are tolerated`, o.withSeconds === '2026-09-25T05:00:00.000Z', o.withSeconds);
  check(`[${tz}] "today" and "this month" are Singapore's, per an independent Intl check`, `${o.today.y}-${String(o.today.m).padStart(2, '0')}-${String(o.today.d).padStart(2, '0')}` === o.intlToday && o.monthKey === o.intlToday.slice(0, 7), [o.today, o.intlToday]);
  // The answers must be identical to the Singapore device's, whatever the device
  check(`[${tz}] every answer is identical to a Singapore device's`,
    ['christinaISO', 'myraISO', 'christinaShown', 'christinaTime', 'roundTrip', 'lateNightKey', 'newYearKey'].every((k) => o[k] === base[k]), null);
}
check('a Singapore device is NOT flagged as different', base.differs === false, base.differs);
check('a Brisbane device IS flagged, and labelled UTC+10', runs['Australia/Brisbane'].differs === true && runs['Australia/Brisbane'].label === 'UTC+10', runs['Australia/Brisbane'].label);
check('Kolkata is labelled with its half hour', runs['Asia/Kolkata'].label === 'UTC+5:30', runs['Asia/Kolkata'].label);
check('Los Angeles is labelled UTC-7 (daylight time in September)', runs['America/Los_Angeles'].label === 'UTC-7', runs['America/Los_Angeles'].label);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
