// ============================================================================
// POKER — configuration
// ============================================================================
// Fill in the two values below from YOUR Supabase project, then commit this
// file. That's it — no build step, no environment variables.
//
// WHERE TO FIND THESE VALUES:
//   1. Go to https://supabase.com/dashboard and open your poker project.
//   2. Click the gear icon (Settings) in the left sidebar.
//   3. Click "API".
//   4. "Project URL"        -> paste it as SUPABASE_URL below.
//      "anon / public" key  -> paste it as SUPABASE_ANON_KEY below.
//      (Use the ANON key. Never the "service_role" key — that one is a
//       master key and must never appear in a browser app.)
//
// IS IT SAFE TO COMMIT THE ANON KEY? YES — for this app, by design.
//   The anon key is meant to be public; it ships in every visitor's browser
//   no matter what. Your protection is Row Level Security, which supabase.sql
//   already set up: the anon key can only read/create/update rows in the
//   `rooms` table, and cannot delete anything. This is a play-money game
//   with no accounts and nothing private in those rows.
//
// If both values are left empty, the game still loads in single-player /
// local mode, but the multiplayer buttons (Create room / Join room) stay
// hidden — that's the sign this file hasn't been filled in yet.
// ============================================================================

window.POKER_CONFIG = {
    SUPABASE_URL: "https://gajqdjuycyvdubvauaig.supabase.co",
    SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdhanFkanV5Y3l2ZHVidmF1YWlnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU1MjUzMzMsImV4cCI6MjExMTEwMTMzM30.84qHsAti2NEEReajI51CZkylEFDunaUkM7LTfU_Jluk"
};
