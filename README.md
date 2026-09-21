# Schedule Hub

A small in-house CRM for a caller / agent team, inspired by the parts of
HubSpot Sales Hub that were actually going to get used: a contact list, a
deal pipeline, real Zoom meetings, and a reporting dashboard. Everything — scheduling, remarks,
reschedule requests, notifications — happens on this dashboard. There is no
external chat integration; it's a single shared source of truth.

## What's in it

- **Role-based views**: switching "Acting as" between Caller / Agent
  changes which tabs are visible, matching what each role actually does —
  Caller sees Summary, Meetings, Pipeline, Templates, Contacts and handles
  calling, scheduling and emailing; Agent sees Summary, Meetings, Pipeline,
  Analytics, Contacts and just attends the meetings. The "Connect Zoom"
  control only appears for Agent, since it's their own personal account —
  everyone else just sees a read-only connected/not-connected status. This
  is a decluttering convenience, not access control: there's no real auth,
  so the underlying API is open to whichever role is selected.
- **Summary dashboard** (the landing page): a HubSpot-style layout — dark
  sidebar, "Sales | \<you\>" header — with three columns: **Your tasks**
  (high priority count, calls to make, stale
  proposals, meetings today, reschedule requests — each clickable), **Your
  outreach activities** (a live feed across every deal), and **Schedule** (a
  day-by-day view with prev/next navigation, so today's meetings are one
  glance away).
- **Pipeline** (kanban): New Lead → Contacted → Meeting Booked → Proposal →
  Won / Lost. Drag a card between columns, or click it to open full deal
  detail — and a complete timestamped activity timeline, so there's nothing
  to scroll back through.
- **Zoom, on the agent's own account**: connect once ("Connect Zoom" in the
  top bar), and scheduling a meeting automatically creates a real Zoom
  meeting on that account — no copy-pasting links. Rescheduling moves the
  same Zoom meeting's time via the API, so the join link never changes.
  Marking a deal Lost deletes its Zoom meeting to keep the calendar clean.
  Without Zoom connected, scheduling falls back to a manual link field.
- **In-app notifications**: a bell icon in the top bar with an unread count.
  New bookings, reschedule requests, confirmed reschedules, and upcoming-
  meeting reminders all land here — click one to jump straight to the deal.
  Each one is addressed to the other role (the caller's actions go to the
  agent and vice versa) and tagged with who sent it. "Mark as done" moves a
  notification from the **New** tab to the **Old** tab, where it stays as
  history.
- **Scheduling only once they're interested**: a new contact starts as a
  Potential Client; the caller marks them **Interested** (or **Not
  interested**) in the deal modal, and only then does the "Schedule meeting"
  section appear. (Adding a contact with a meeting time in the New contact
  form books it straight away.)
- **Remarks**: a plain "Remarks" box on every deal for anything that doesn't
  fit anywhere else — logged straight to the activity timeline
  with who wrote it and when.
- **Reschedule requests, not silent edits**: the agent can't rebook the
  caller's calendar, so "Agent: ask to reschedule" doesn't change the time
  itself — it flags the deal with a remark and raises a notification for the caller. The
  deal card gets a "⚠ reschedule requested" badge and the Summary tasks
  column counts it, until the caller picks the actual new time via "Caller: confirm
  new time" — which is what notifies the agent of the change.
- **Meeting follow-up** (agent only): once a meeting is booked, the agent's
  deal modal shows a "Meeting follow-up" dropdown — **Ready to proceed** (→ Proposal), **Needs
  another follow-up** (→ back to Contacted), or **Not interested** (→ Lost)
  — plus an optional note.
- **Proactive reminders**: a background check runs every 5 minutes (and
  once at startup) and raises a notification when a scheduled meeting is
  within `REMINDER_WINDOW_MIN` (default 60) minutes out. Each meeting is
  reminded once; rescheduling resets it.
- **Calendar export**: every scheduled meeting also gets a "Add to Google
  Calendar" link and a downloadable `.ics` file, for anyone who wants it in
  their own calendar app too.
- **Templates + email open tracking**: reusable templates with `{{name}}` /
  `{{company}}` / `{{agent}}` placeholders; each sent email embeds a 1x1
  tracking pixel, and the deal timeline shows "(opened)" once it fires.
- **Contacts**: search, add manually, edit, or import leads from a Google
  Sheet (dedupes by phone).
- **Analytics**: contacts, open deals, won-this-month + revenue, win rate,
  email open rate, a deals-by-stage bar chart, and a calls-per-day line
  chart — plain inline SVG, no charting library or external CDN.

## Running it

```bash
npm install
npm start
```

Then open http://localhost:3000 (or whatever `PORT` is set to). It works
immediately with zero config: leads come from `data/leads.sample.json`,
outbound emails are saved as `.html` files under `data/outbox/` instead of
actually sent, and scheduling falls back to a manual Zoom-link field until
you connect a real Zoom account.

## Going live

Copy `.env.example` to `.env` and fill in:

- **Zoom**: create an OAuth app at marketplace.zoom.us (Develop → Build App
  → General App), set its redirect URL to match `ZOOM_REDIRECT_URI`, and
  grant it meeting read/write/update/delete + user-read scopes. Put the
  Client ID/Secret in `.env`, restart, then open `/auth/zoom` in the app and
  sign in with **the agent's own Zoom account** to connect it. See the
  comments in `.env.example` for exact scope names.
- **Email**: any SMTP account (Gmail app password, SendGrid, Postmark, etc)
  — set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `FROM_EMAIL`.
- **Google Sheets**: make the leads sheet "anyone with the link can view",
  enable the Sheets API on a Google Cloud project, create an API key, set
  `GOOGLE_SHEETS_ID` + `GOOGLE_SHEETS_API_KEY`. Expected columns: Name,
  Phone, Notes, Status.
- **Reminders / calendar links**: set `BASE_URL` to your real public URL
  once this isn't running on localhost, and `REMINDER_WINDOW_MIN` to change
  how far ahead the reminder notification fires (default 60 minutes).

## If something looks stuck on "Loading…"

Every API call surfaces failures with a red banner at the top of the page
("Connection issue — retrying in the background") instead of failing
silently — if you see a card stuck loading with no banner, that's a real
bug worth reporting, not just the server being temporarily restarted. Each
Summary card also fails independently with its own "retry" link, so one
slow or broken endpoint can't freeze the other two.

## Deploying to Vercel

The app auto-detects Vercel and switches its data layer accordingly — no
code changes needed, just a couple of things to set up in the Vercel
dashboard once:

1. **Push this repo to GitHub** (if not already) and import it as a new
   Vercel project — it's a standard Express app under `api/index.js` +
   `vercel.json`, Vercel's Node runtime handles the rest.
2. **Add a Redis store**: Project → Storage → Marketplace → search
   "Upstash" (or "Redis") → create + connect it to this project. Vercel
   injects `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`
   automatically — the moment those exist, `lib/db.js` and `lib/zoom.js`
   switch from local JSON files to Redis on their own. Without this step,
   every write on Vercel would silently fail to persist between requests.
3. **Set environment variables** in Project → Settings → Environment
   Variables: same ones as `.env.example` (`ZOOM_CLIENT_ID/SECRET`,
   `ZOOM_REDIRECT_URI` pointed at your real `https://your-app.vercel.app/auth/zoom/callback`,
   `BASE_URL`, `SMTP_*`, `GOOGLE_SHEETS_*`, `REMINDER_WINDOW_MIN`, and a
   random `CRON_SECRET`).
4. **Reminders on the Hobby plan**: `vercel.json` schedules
   `/api/cron/reminders` once a day (`0 0 * * *`) — that's the finest
   granularity Vercel's free tier allows for Cron. A once-daily check
   against a 60-minute reminder window will miss most meetings. Two ways
   around it: upgrade to Vercel Pro (cron can run every minute), or point a
   free external pinger (e.g. cron-job.org, or a scheduled GitHub Action in
   your own repo) at `https://your-app.vercel.app/api/cron/reminders` every
   5–10 minutes instead — send `Authorization: Bearer <CRON_SECRET>` and
   it'll work exactly the same way.

Locally, none of this matters: `npm start` keeps using JSON files on disk
and an in-process 5-minute timer, exactly as before.

## Data model

Plain JSON files under `data/` (`contacts.json`, `deals.json`,
`activities.json`, `templates.json`, `users.json`, `notifications.json`,
`zoom_account.json`) via `lib/db.js`'s tiny generic collection store when
running locally — good enough for one small team testing on a laptop. On
Vercel the same collections live in Upstash Redis instead (see above),
since serverless functions can't reliably write to disk.

There's no login/password system — "Acting as" in the top bar is just a
named identity picker (persisted in your browser) used to attribute calls,
notes, and emails to a person. Add real auth before putting this on the
open internet. The connected Zoom account is a single shared credential for
the whole team (it's the agent's own account, not per-user).
