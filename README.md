# Poker — web edition

Texas Hold'em you can play in the browser with friends. One person creates a
room, shares the 4-letter code, and everyone else joins from the link. Empty
seats are filled by AI so a game always runs. Play-money only — the chips are
fake and worth nothing.

No build step, no server of your own: the site is plain static files, and
Supabase does all the syncing.

---

## Setup (do these in order)

### 1. Create the Supabase project
Go to [supabase.com](https://supabase.com), sign in, and create a new project
(any name, e.g. `poker`). Pick a database password and save it somewhere —
you won't need it for this app, but don't lose it. Wait for the project to
finish provisioning (a minute or two).

### 2. Run the database script
In your Supabase project: **SQL Editor → New query**. Open `supabase.sql`
from this repo, paste the whole thing in, and click **Run**.

You should see "Success. No rows returned." That created the `rooms` table,
its security policies, and turned on realtime for it. The script is safe to
run again if you ever need to.

### 3. Put your keys in `config.js`
In Supabase: **Settings (gear icon) → API**. Copy two values into `config.js`
in this repo:

- **Project URL** → `SUPABASE_URL`
- **anon / public key** → `SUPABASE_ANON_KEY`

Committing the anon key is fine — it's public by design, and Row Level
Security (set up in step 2) is what protects the data. Never paste the
`service_role` key anywhere in this repo.

### 4. Deploy on Vercel
Push this repo to GitHub. Then in [Vercel](https://vercel.com): **Add New →
Project → import this repo**. Set the framework preset to **Other** and leave
the build command and output directory **empty** — it's a static site, there
is nothing to build. Click Deploy.

### 5. Play
Open your Vercel URL, hit **Create room**, and share the 4-letter code (or
just the link) with friends. They open the same URL, hit **Join room**, type
the code, and they're seated.

---

## How it works

- **The host's browser runs the game.** Whoever creates the room is the host:
  their browser deals the cards, runs the betting, and decides the winners.
  If the host closes their tab, the game ends — keep that tab open.
- **Supabase syncs everyone.** The host writes the full game state into the
  room's row in the `rooms` table; every other player watches that row with
  Realtime and re-renders instantly. Quick actions ("I call", "I raise") are
  also sent over Realtime broadcast channels straight to the host.
- **AI fills the empty seats.** Any seat without a human in it is played by
  the built-in AI, so even two humans get a full table.
- **Play-money only.** Chips are just numbers in a jsonb column. There are no
  accounts, no payments, and nothing of value stored anywhere.

---

## Troubleshooting

**The Create room / Join room buttons are missing.**
`config.js` is still empty (or the values are wrong). Do step 3 — the game
hides the multiplayer buttons until Supabase is configured. Single-player
against the AI still works without it.

**A friend can't join my room.**
Check the code first — it's 4 letters, and it's easy to mistype one. If the
code is right, check that the room still exists: the host must still have the
game open in their tab, because the host's browser is the game. If the host
closed it, create a fresh room and share the new code.

**It worked yesterday and the room is gone today.**
Old rooms get cleaned up (rooms untouched for 24+ hours can be deleted with
the optional statement at the bottom of `supabase.sql`). Just create a new
room — it takes five seconds.

**The page looks like an old version after I changed something.**
Hard-refresh (Ctrl/Cmd + Shift + R). `index.html` is served with no-cache
headers, but a stubborn browser cache can still hang on once.
