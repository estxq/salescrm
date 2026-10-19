import fs from 'node:fs';
// A fake Zoom + Google that keeps its state in a file, so two different versions of the app (run one after
// the other on the same data) see the same "remote" accounts.
const FILE = '/private/tmp/mig/remote.json';
const load = () => (fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : { zoom: { meetings: {}, next: 500 }, google: { events: {}, next: 1, personal: [] } });
const save = (s) => fs.writeFileSync(FILE, JSON.stringify(s));
export const remote = { load, save };
export function install() {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, o = {}) => {
    const u = String(url); const j = (b, s = 200) => new Response(b == null ? null : JSON.stringify(b), { status: s });
    const tok = (o.headers?.Authorization || '').replace('Bearer ', '');
    const st = load();
    if (u.startsWith('https://api.zoom.us/v2')) {
      const path = u.replace('https://api.zoom.us/v2', '');
      if (tok !== 'legacy-zoom-token') return j({ message: 'bad token ' + tok }, 401);
      const Z = st.zoom;
      if (path === '/users/me/meetings' && o.method === 'POST') { const b = JSON.parse(o.body); const id = Z.next++; const s2 = new Date(b.start_time + '+08:00').toISOString(); Z.meetings[id] = { id, topic: b.topic, start_time: s2, duration: 45, join_url: 'https://zoom.us/j/' + id }; save(st); return j({ id, join_url: Z.meetings[id].join_url, start_url: 's', start_time: s2 }); }
      if (path.startsWith('/users/me/meetings')) return j({ meetings: Object.values(Z.meetings) });
      if (path === '/users/me') return j({ email: 'aaron@zoom.test' });
      const m = path.match(/^\/meetings\/(\d+)$/);
      if (m) { const id = Number(m[1]); if (!Z.meetings[id]) return j({ message: 'nf' }, 404);
        if (o.method === 'DELETE') { delete Z.meetings[id]; save(st); return j(null, 204); }
        if (o.method === 'PATCH') { Z.meetings[id].start_time = new Date(JSON.parse(o.body).start_time + '+08:00').toISOString(); save(st); return j(null, 204); }
        return j(Z.meetings[id]); }
      return j({}, 404);
    }
    if (u.startsWith('https://www.googleapis.com/calendar/v3/calendars/primary/events')) {
      if (tok !== 'legacy-google-token') return j({}, 401);
      const G = st.google; const m = o.method || 'GET'; const id = u.split('/events/')[1]?.split('?')[0];
      if (m === 'POST') { const e = { id: 'ev' + G.next++, ...JSON.parse(o.body) }; G.events[e.id] = e; save(st); return j(e); }
      if (m === 'PATCH') { if (!G.events[id]) return j({}, 404); G.events[id] = { ...G.events[id], ...JSON.parse(o.body) }; save(st); return j(G.events[id]); }
      if (m === 'DELETE') { if (!G.events[id]) return j({}, 404); delete G.events[id]; save(st); return j(null, 204); }
      return j({ items: Object.values(G.events).map((e) => ({ id: e.id, summary: e.summary, start: e.start, end: e.end })).concat(G.personal) });
    }
    return real(url, o);
  };
}
