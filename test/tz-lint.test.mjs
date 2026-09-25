// Guards the "everything is Singapore time" rule. A meeting is one moment; nothing
// the viewer's device timezone says may change how it is typed, shown or bucketed.
// This fails if someone reintroduces a call that quietly reads the device's zone.
import fs from 'node:fs';

const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
const app = read('../public/app.js');
const server = [read('../server.js'), ...fs.readdirSync(new URL('../lib/', import.meta.url))
  .filter((f) => f.endsWith('.js') && f !== 'tz.js')
  .map((f) => read('../lib/' + f))].join('\n');

let bad = 0;
const check = (name, ok, detail = '') => {
  if (!ok) { bad++; console.log('FAIL', name, detail); } else console.log('ok  ', name);
};
const lines = (src, re) => src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => re.test(l) && !/^\s*\/\//.test(l));

// Browser: instants must be formatted through the sg* helpers, never the device zone.
check('app.js: no toLocaleString / toLocaleTimeString',
  lines(app, /\.toLocale(Time)?String\(/).length === 0, JSON.stringify(lines(app, /\.toLocale(Time)?String\(/)));
check('app.js: toLocaleDateString only on abstract calendar dates (no scheduled_at)',
  lines(app, /toLocaleDateString\(/).every(([, l]) => !/scheduled_at|new Date\(\w*(iso|at)\w*\)/i.test(l)));
check('app.js: no getTimezoneOffset (lives in time.js only)', !/getTimezoneOffset/.test(app));
check('app.js: no new Date(<input value>).toISOString()',
  lines(app, /new Date\((val|time|when|v)\)\.toISOString\(\)/).length === 0);
check('app.js: no reading hours/minutes off a device Date', !/\.getHours\(|\.getMinutes\(/.test(app));
check('app.js: analytics sends the Singapore offset', /tz:\s*String\(TEAM_TZ_PARAM\)/.test(app));
check('app.js: scheduling inputs go through sgInputToISO', (app.match(/sgInputToISO\(/g) || []).length >= 3);

// Server: dates baked into stored text must use formatWhen; months are Singapore's.
check('server/lib: no unpinned toLocaleString', lines(server, /\.toLocale(Date|Time)?String\(/).length === 0,
  JSON.stringify(lines(server, /\.toLocale(Date|Time)?String\(/)));
check('server: no now.getMonth()/getFullYear() (server zone)', !/now\.getMonth\(\)|now\.getFullYear\(\)/.test(read('../server.js')));
check('server: analytics does not trust a client tz', !/req\.query\.tz/.test(read('../server.js')));

process.exit(bad ? 1 : 0);
