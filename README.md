# Schedule Hub

A small in-house CRM for a caller / agent team, inspired by the parts of
HubSpot Sales Hub that were actually going to get used: a contact list, a
deal pipeline, real Zoom meetings, and a reporting dashboard. Everything — scheduling, remarks,
reschedule requests, notifications — happens on this dashboard. There is no
external chat integration; it's a single shared source of truth.

## What's in it

- **Accounts and teams**: nothing loads until you log in. Someone
  **creates a team** (email, password, and whether they're the Caller or the
  Agent) and gets an **invite code**; their teammate chooses **Join a team**,
  enters the code and takes the other seat. A team is one Caller and one
  Agent — a third person can't join, and anyone else who wants to use the app
  makes their own team. Teams are fully separate: contacts, deals,
  notifications and the Zoom connection are stored per team, and the data
  layer refuses to read them without a team, so one team can't see another's.
- **Role-based views**: your role is fixed by your account, and it's enforced
  on the server, not just by hiding tabs. Caller sees Summary, Meetings,
  Contacts, Pipeline and handles calling and scheduling (adding contacts,
  scheduling, rescheduling, deleting meetings); Agent sees Summary, Meetings,
  Contacts, Analytics (no Pipeline) and just attends the meetings (requesting
  reschedules, logging follow-ups, connecting Zoom). Calling the other role's
  endpoints returns 403. Names on notes, bookings and notifications come from
  the logged-in account, never from what the browser sends.
- **Summary** (the landing page): both roles get the same month calendar of
  meetings (CRM meetings plus Zoom-only ones like interviews). The **Agent**
  also gets an "Upcoming" list of the next day's meetings above it. The
  **Caller** gets no upcoming list — instead a **Reschedule requests** card
  beside the calendar showing only what Arron has asked to move and his
  reason. A request on a CRM meeting opens the deal to pick the new time; a
  request on a Zoom-only meeting has a "Mark as done" (it also clears itself
  once the Caller moves or deletes that Zoom meeting in Meetings).
- **Google Calendar for the caller** (optional): the agent connects their own
  Google account once ("Share Google Calendar with Caller", top bar — only the
  calendar's owner can grant that), and their events then appear in green on the
  **caller's** Summary calendar next to the Zoom meetings. The agent's own
  calendar stays a clean calendar of Zoom meetings: the server never sends him
  the Google events, and he can stop sharing at any time. It's read-only — the
  app can't create, change or delete anything in Google. Only the primary
  calendar is read; cancelled and declined events are skipped; a Google event
  that is really one of the Zoom meetings (e.g. made by Zoom's Calendar add-on)
  isn't shown twice. Needs `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — setup
  steps in `.env.example`. If Google stops renewing the login the agent's top bar
  shows "Reconnect Google Calendar" and the rest of the calendar carries on.
- **Meetings that have happened stay on the calendar** (greyed out, and in
  Meetings → Past) instead of disappearing. That covers a meeting whose deal
  moved on after an outcome was logged, an earlier meeting replaced when another
  one was booked for the same contact (kept on the deal as history), and
  Zoom-only interviews — Zoom stops listing those the moment they end, so the app
  remembers each one it sees (`lib/zoomlog.js`). The agent can still log or
  change an outcome on one that's over. A Zoom meeting deleted before it happened
  isn't kept, and a meeting that came and went without the app ever seeing it (or
  the daily job) can't be recovered.
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
- **Scheduling moves the deal along**: a new contact starts as a Potential
  Client and the caller books a meeting when they're interested, either in
  the deal modal or straight from the New contact form. Booking moves the
  deal to Scheduled a Meeting; other stage changes happen by dragging cards
  on the Pipeline board, or via the agent's meeting follow-up.
- **Remarks**: a plain "Remarks" box on every deal for anything that doesn't
  fit anywhere else — logged straight to the activity timeline
  with who wrote it and when.
- **Reschedule requests, not silent edits**: the agent can't rebook the
  caller's calendar, so "Agent: ask to reschedule" doesn't change the time
  itself — it flags the deal with a remark and raises a notification for the caller
  (who can be sent an updated or withdrawn request until they act). The
  deal card gets a "⚠ reschedule requested" badge and the Caller's Summary
  lists it, until the caller picks the actual new time via "Caller: confirm
  new time" — which is what notifies the agent of the change.
- **Meeting follow-up** (agent only): after a meeting the agent logs how it
  went with just two choices — **Not interested** (→ Lost, and the Zoom meeting
  is removed) or **Schedule another meeting** (→ back to Contacted, for the
  caller to book) — plus an optional note. It works the same on Zoom-only
  meetings.
- **Changing your mind (agent)**: a reschedule request or a logged outcome can
  be edited — or the request withdrawn — for as long as the caller hasn't acted
  on it. Editing revises the caller's existing notification instead of adding
  another. It locks once the caller books, moves or deletes that meeting (or
  marks the notification done, for Zoom-only meetings). Meetings rows show a
  "Reschedule requested" tag and the logged outcome.
- **Analytics** (agent — his only stats page, no Pipeline), **one month at a
  time**, chosen with **Year** and **Month** dropdowns (it opens on the current
  month; a new year appears in the list by itself, and earlier years and months
  stay available; months that haven't happened yet can't be picked). For the
  chosen month it shows interviews fixed, interviews attended (ones he logged an
  outcome on) and reschedules made — each compared with the month before — plus a
  bar chart of how the meetings he logged turned out: **Not interested** vs
  **Schedule another meeting**, and a table of every month of that year with a
  yearly total (click a row to open that month). Each number is counted in the
  month it happened — booked, outcome logged, moved — using the viewer's
  timezone. The counters come from a small event log (`lib/stats.js`); the chart
  counts what he currently has logged, so changing an outcome moves the bar.
  Interviews booked straight in Zoom are counted the first time the app sees them
  (whenever either of you opens it, or the daily job).
- **Sending the client the details**: the caller sends the meeting details first
  ("Send details" — right after booking, in the Meetings list and the deal
  window), and the agent reconfirms nearer the date ("Send reminder", different
  wording). Both open WhatsApp with the message ready.
- **Only one Zoom meeting per interview**: rescheduling moves the same Zoom
  meeting (so the join link stays the same). Booking again on a deal that
  already had one, or switching it to a hand-typed link, deletes the old Zoom
  meeting so only the new one is left.
- **Proactive reminders**: a background check runs every 5 minutes (and
  once at startup) and raises a notification when a scheduled meeting is
  within `REMINDER_WINDOW_MIN` (default 60) minutes out. Each meeting is
  reminded once; rescheduling resets it.
- **Calendar export**: every scheduled meeting also gets a "Add to Google
  Calendar" link and a downloadable `.ics` file, for anyone who wants it in
  their own calendar app too.
- **Contacts**: "All contacts" and "New contact" are separate views. Search
  ignores capitalisation and stray spaces and understands phone numbers
  however they're typed. Adding or editing a contact is refused (with a link
  to the existing one) if the phone number already belongs to someone —
  `91234567`, `6591234567` and `+65 9123 4567` all count as the same number —
  and contacts that already share a number are tagged "Duplicate number".
  Leads can also be imported from a Google Sheet (deduped the same way).
- **Zoom**: create an OAuth app at marketplace.zoom.us (Develop → Build App
  → General App), set its redirect URL to match `ZOOM_REDIRECT_URI`, and
  grant it meeting read/write/update/delete + user-read scopes. Put the
  Client ID/Secret in `.env`, restart, then open `/auth/zoom` in the app and
  sign in with **the agent's own Zoom account** to connect it. See the
  comments in `.env.example` for exact scope names.
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
slow or broken endpoint can't freeze the other.

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
   `BASE_URL`, `GOOGLE_SHEETS_*`, `REMINDER_WINDOW_MIN`, and a
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
`activities.json`, `notifications.json`, `accounts.json`, `teams.json`, plus a
per-team copy of each, and `zoom_account`) via `lib/db.js`'s tiny generic collection store when
running locally — good enough for one small team testing on a laptop. On
Vercel the same collections live in Upstash Redis instead (see above),
since serverless functions can't reliably write to disk.

## Accounts, sessions and teams

Passwords are hashed with scrypt (Node's built-in `crypto`, no extra
dependency) and never leave the server. A login sets an `HttpOnly`,
`SameSite=Lax` (and `Secure` over HTTPS) cookie signed with a secret — set
`SESSION_SECRET` to choose your own, otherwise one is generated once and kept
in the same store as the data. Sessions last 90 days and renew themselves whenever you use the app (so you stay logged in on that browser); the app never stores your password — your browser's password manager can, and the login form is set up for that. Five wrong passwords
lock an account for 15 minutes.

Accounts and teams live in shared `accounts` / `teams` collections; everything
else is keyed per team (`t<teamId>:contacts` and so on, `t1_contacts.json`
locally). The connected Zoom account is per team too — it's that team's
agent's own account.

**Data from before teams existed** (the original single-team data, including
its Zoom connection) is handed to the **first team ever created**, once. On a
deployment that already has data, sign up right after deploying so it goes to
you. The old un-prefixed copies are left in place as a backup (the Zoom token
is moved, not copied).

**Zoom is per team.** A new team starts with no Zoom connection; its Agent
clicks "Connect Zoom" and signs in with their own account, and every meeting
that team books (and every Zoom-only interview it shows) comes from that
account. One thing outside this app: a Zoom OAuth app in development mode can
only be authorised by the Zoom account that created it — for other teams'
agents to connect their own Zoom, the app has to be published on the Zoom
Marketplace.

**Leaving a team** (account menu → Leave team) removes you from it but keeps
your login: the team, its data and its invite code stay, your teammate gets a
notification and sees the invite code again for the free seat, and you land on a
screen to join or start another team.

**Deleting your account** (account menu → Delete my account, confirmed with
your password) removes only your login. The team's contacts, meetings, Zoom
connection and invite code stay, so someone holding the code can take the
free seat — that's also how a teammate is replaced.

Not included: email verification and password reset (there's no email
service), so keep your password safe.
