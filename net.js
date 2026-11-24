/*
 * net.js — Supabase multiplayer layer for the web poker game.
 * Classic script (no build step). Load order in index.html:
 *   1. Supabase JS v2 client (CDN)   -> window.supabase
 *   2. config.js                     -> window.POKER_CONFIG = { SUPABASE_URL, SUPABASE_ANON_KEY }
 *   3. engine.js                     -> window.PokerEngine, window.AiPlayer
 *   4. net.js (this file)            -> window.PokerNet
 *   5. app.js                        -> UI; calls PokerNet, renders via PokerApp.renderSnapshot
 *
 * ============================================================================
 * ARCHITECTURE — host-authoritative
 * ============================================================================
 * The room creator's browser runs the one true game on window.PokerEngine.
 * Guests NEVER mutate game state: they only send action intents, and the host
 * validates (token + seat + whose turn + legality) before applying them.
 * Live gameplay flows over a Supabase Realtime broadcast channel named
 * "room-<CODE>". The `rooms` table is used only for discovery and rejoin:
 * the host mirrors the lobby (players + started flag) into rooms.state so a
 * joiner can find the room and a refreshed browser can reattach.
 *
 * Identity: no accounts. Each browser generates a playerToken (UUID) stored
 * in localStorage, plus the current session { roomCode, seat, name }.
 *
 * ============================================================================
 * PROTOCOL — Realtime broadcast messages on channel "room-<CODE>"
 * ============================================================================
 * host -> all:
 *   "snapshot"    { forSeat: <seat>, state: <engine.getSnapshot(forSeat)> }
 *                 Sent per connected human, addressed by forSeat. A client
 *                 applies a snapshot only when forSeat === its own seat, or
 *                 forSeat === -1 (a public/lobby snapshot). The snapshot is
 *                 JSON-safe and hides other players' hole cards except at
 *                 showdown (that is the engine's job, via getSnapshot).
 *   "lobby"       { players: [{ seat, name, isHost, isAI, connected, token }],
 *                   started: <bool> }
 *                 Full lobby roster. A guest learns its own seat by matching
 *                 its playerToken in the roster. (v1: tokens ride along so
 *                 guests can find themselves; this is a friendly game, not a
 *                 security boundary — the host still validates every action.)
 *   "hand-result" { handNumber, summary, payouts? }
 *                 One-line summary per finished hand, for the UI log.
 *
 * guest -> host:
 *   "join-request"    { token, name }            — ask for a seat.
 *   "rejoin-request"  { token, seat, name }      — reclaim a seat after refresh.
 *   "snapshot-request"{ token, seat }            — ask for a fresh snapshot.
 *   "action"          { seat, token, action: { type, to? } }
 *                 type is one of "fold" | "check" | "call" | "raise" | "allin";
 *                 "raise" carries `to` = total bet for the round (raiseTo).
 *   "leave"           { seat, token }            — graceful goodbye.
 *
 * Presence: every client tracks presence on the same channel with its
 * playerToken as the presence key and { seat, name, isHost } as state. The
 * host derives each seat's `connected` flag from presence. A human seat that
 * stays disconnected for > 15 s on its turn is auto-played by the host
 * (check when legal, otherwise fold). If the HOST's presence disappears,
 * guests are told via onStatus("host-disconnected") and the room freezes —
 * a known v1 limitation, surfaced honestly rather than hidden.
 *
 * ============================================================================
 * PUBLIC API — window.PokerNet
 * ============================================================================
 *   isConfigured()            -> bool: config present and non-empty.
 *   createRoom(name)          -> Promise<code>: make a room, become host (seat 0).
 *   joinRoom(code, name)      -> Promise<{ code, seat }>: join as a guest.
 *   tryRejoin()               -> Promise<{ code, seat } | null>: reattach from
 *                                localStorage if a saved session still exists.
 *   leaveRoom()               -> Promise<void>: leave (host also closes the room).
 *   startGame()               -> Promise<void>: host only; needs >= 2 humans.
 *                                AI fills the remaining seats up to 6.
 *   sendAction(action)        -> Promise<void>: send { type, to? } for my seat.
 *                                As host, the action is applied locally.
 *   onSnapshot(cb)            -> cb(state): snapshots addressed to me.
 *   onLobby(cb)               -> cb({ players, started, code }).
 *   onStatus(cb)              -> cb(statusString): "connecting", "connected",
 *                                "waiting-for-host", "host-disconnected",
 *                                "room-not-found", "room-closed", "error", ...
 *   mySeat()                  -> my seat number, or -1 when not in a room.
 *   roomCode()                -> current room code, or null.
 *
 * If the config is missing/empty, isConfigured() returns false and every
 * async call rejects with a clear Error — app.js uses that to hide the
 * multiplayer buttons gracefully.
 */
(function () {
  'use strict';

  // ==========================================================================
  // Constants
  // ==========================================================================

  var TABLE_SIZE = 6;                 // seats per table (engine is 6-max)
  var MIN_HUMANS_TO_START = 2;        // host + at least one guest
  var DISCONNECT_GRACE_MS = 15000;    // >15 s gone on your turn = auto-played
  var AI_STEP_MS = 750;               // pacing between AI actions
  var HAND_PAUSE_MS = 3500;           // pause between hands
  var PUMP_TICK_MS = 1000;            // host watchdog tick (disconnects, stalls)
  var CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L lookalikes
  var CODE_LENGTH = 6;
  var LS_TOKEN_KEY = 'poker.playerToken';
  var LS_SESSION_KEY = 'poker.session';

  // ==========================================================================
  // Small utilities
  // ==========================================================================

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    // Fallback UUID v4 (older browsers).
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function makeRoomCode() {
    var out = '';
    for (var i = 0; i < CODE_LENGTH; i++) {
      out += CODE_ALPHABET.charAt(Math.floor(Math.random() * CODE_ALPHABET.length));
    }
    return out;
  }

  function noop() {}

  function loadJson(key) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function saveJson(key, value) {
    try {
      if (value === null || value === undefined) {
        window.localStorage.removeItem(key);
      } else {
        window.localStorage.setItem(key, JSON.stringify(value));
      }
    } catch (e) { /* private mode etc. — session just won't persist */ }
  }

  // ==========================================================================
  // Identity (token + saved session)
  // ==========================================================================

  var playerToken = loadJson(LS_TOKEN_KEY);
  if (!playerToken || typeof playerToken !== 'string') {
    playerToken = uuid();
    saveJson(LS_TOKEN_KEY, playerToken);
  }

  // ==========================================================================
  // Configuration / Supabase client (created lazily)
  // ==========================================================================

  var supabaseClient = null;

  function isConfigured() {
    var cfg = window.POKER_CONFIG;
    return !!(
      cfg &&
      typeof cfg.SUPABASE_URL === 'string' && cfg.SUPABASE_URL.trim() !== '' &&
      typeof cfg.SUPABASE_ANON_KEY === 'string' && cfg.SUPABASE_ANON_KEY.trim() !== '' &&
      window.supabase && typeof window.supabase.createClient === 'function'
    );
  }

  function requireConfigured() {
    if (!isConfigured()) {
      throw new Error(
        'PokerNet: Supabase is not configured. Set window.POKER_CONFIG = ' +
        '{ SUPABASE_URL, SUPABASE_ANON_KEY } in config.js (and load the ' +
        'Supabase JS client) to enable multiplayer.'
      );
    }
  }

  function client() {
    requireConfigured();
    if (!supabaseClient) {
      supabaseClient = window.supabase.createClient(
        window.POKER_CONFIG.SUPABASE_URL,
        window.POKER_CONFIG.SUPABASE_ANON_KEY
      );
    }
    return supabaseClient;
  }

  // ==========================================================================
  // Callback registries (app.js subscribes here)
  // ==========================================================================

  var snapshotCallbacks = [];
  var lobbyCallbacks = [];
  var statusCallbacks = [];

  function emitSnapshot(state) {
    snapshotCallbacks.forEach(function (cb) { try { cb(state); } catch (e) { console.error(e); } });
  }

  function emitLobby(lobby) {
    lobbyCallbacks.forEach(function (cb) { try { cb(lobby); } catch (e) { console.error(e); } });
  }

  function emitStatus(status) {
    statusCallbacks.forEach(function (cb) { try { cb(status); } catch (e) { console.error(e); } });
  }

  // ==========================================================================
  // Session state (one room at a time)
  // ==========================================================================

  var session = {
    code: null,          // room code while in a room
    seat: -1,            // my seat, -1 when not seated
    name: '',            // my display name
    isHost: false,
    channel: null,       // Supabase Realtime channel
    started: false,      // has the host started the game?
    // Host-only state:
    engine: null,        // the PokerEngine instance (host's browser only)
    players: [],         // [{ seat, name, isHost, isAI, token, connected }]
    pumpTimer: null,     // AI pacing timer
    tickTimer: null,     // 1 s watchdog interval
    handInPause: false,  // between hands
    lastSeen: {},        // seat -> timestamp last present (host's view)
    // Guest-only state:
    hostWasPresent: false
  };

  function saveSession() {
    if (session.code && session.seat >= 0) {
      saveJson(LS_SESSION_KEY, {
        roomCode: session.code,
        seat: session.seat,
        name: session.name
      });
    } else {
      saveJson(LS_SESSION_KEY, null);
    }
  }

  // ==========================================================================
  // Channel plumbing
  // ==========================================================================

  function broadcast(event, payload) {
    if (!session.channel) return Promise.resolve();
    return session.channel
      .send({ type: 'broadcast', event: event, payload: payload })
      .catch(function () { /* a dropped packet is healed by the next snapshot */ });
  }

  function subscribeChannel(code) {
    var ch = client().channel('room-' + code, {
      config: {
        broadcast: { self: false },
        presence: { key: playerToken }
      }
    });

    ch.on('broadcast', { event: 'snapshot' }, function (msg) { onSnapshotMessage(msg.payload); });
    ch.on('broadcast', { event: 'lobby' }, function (msg) { onLobbyMessage(msg.payload); });
    ch.on('broadcast', { event: 'hand-result' }, function (msg) { onHandResultMessage(msg.payload); });
    ch.on('broadcast', { event: 'action' }, function (msg) { onActionMessage(msg.payload); });
    ch.on('broadcast', { event: 'join-request' }, function (msg) { onJoinRequest(msg.payload); });
    ch.on('broadcast', { event: 'rejoin-request' }, function (msg) { onRejoinRequest(msg.payload); });
    ch.on('broadcast', { event: 'snapshot-request' }, function (msg) { onSnapshotRequest(msg.payload); });
    ch.on('broadcast', { event: 'leave' }, function (msg) { onLeaveMessage(msg.payload); });
    ch.on('presence', { event: 'sync' }, function () { onPresenceSync(); });

    session.channel = ch;

    return new Promise(function (resolve, reject) {
      var settled = false;
      ch.subscribe(function (status) {
        if (status === 'SUBSCRIBED' && !settled) {
          settled = true;
          ch.track({
            seat: session.seat,
            name: session.name,
            isHost: session.isHost,
            online_at: new Date().toISOString()
          }).catch(noop);
          resolve();
        } else if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && !settled) {
          settled = true;
          reject(new Error('PokerNet: could not connect to room channel (status: ' + status + ').'));
        } else if (status === 'CLOSED' && session.channel === ch) {
          emitStatus('disconnected');
        }
      });
    });
  }

  function teardownChannel() {
    if (session.pumpTimer) { clearTimeout(session.pumpTimer); session.pumpTimer = null; }
    if (session.tickTimer) { clearInterval(session.tickTimer); session.tickTimer = null; }
    if (session.channel) {
      var ch = session.channel;
      session.channel = null;
      try { ch.untrack().catch(noop); } catch (e) { /* already gone */ }
      client().removeChannel(ch).catch(noop);
    }
  }

  function resetSession() {
    teardownChannel();
    session.code = null;
    session.seat = -1;
    session.name = '';
    session.isHost = false;
    session.started = false;
    session.engine = null;
    session.players = [];
    session.handInPause = false;
    session.lastSeen = {};
    session.hostWasPresent = false;
    saveSession();
  }

  // ==========================================================================
  // Incoming messages — guest side
  // ==========================================================================

  function onSnapshotMessage(payload) {
    if (!payload) return;
    // Apply only snapshots addressed to me, or public ones (forSeat === -1).
    if (payload.forSeat === session.seat || payload.forSeat === -1) {
      emitSnapshot(payload.state);
    }
  }

  function onLobbyMessage(payload) {
    if (!payload || session.isHost) return; // the host is the lobby's source of truth
    session.started = !!payload.started;
    // Learn (or confirm) my seat by matching my token in the roster.
    var players = payload.players || [];
    for (var i = 0; i < players.length; i++) {
      if (players[i].token === playerToken) {
        if (session.seat !== players[i].seat) {
          session.seat = players[i].seat;
          // Re-track presence now that the seat is known.
          if (session.channel) {
            session.channel.track({
              seat: session.seat, name: session.name, isHost: false,
              online_at: new Date().toISOString()
            }).catch(noop);
          }
        }
        break;
      }
    }
    saveSession();
    emitLobby({ players: players, started: session.started, code: session.code });
  }

  function onHandResultMessage(payload) {
    // The UI log listens via onStatus-style side channel: we surface hand
    // results as snapshots-independent events through the lobby callback's
    // sibling — simplest is a status string the app can log. Apps that want
    // the structured payload can read it from the next snapshot as well.
    if (payload && payload.summary) {
      emitStatus('hand-result: ' + payload.summary);
    }
  }

  function onPresenceSync() {
    if (!session.channel) return;
    var state = session.channel.presenceState();
    if (session.isHost) {
      hostRefreshConnected(state);
    } else {
      guestCheckHostPresence(state);
    }
  }

  function guestCheckHostPresence(presenceState) {
    var hostPresent = false;
    Object.keys(presenceState).forEach(function (key) {
      (presenceState[key] || []).forEach(function (p) {
        if (p.isHost) hostPresent = true;
      });
    });
    if (hostPresent) {
      session.hostWasPresent = true;
    } else if (session.hostWasPresent) {
      // Host was here and is gone: the room freezes (v1 limitation).
      session.hostWasPresent = false;
      emitStatus('host-disconnected');
    }
  }

  // ==========================================================================
  // Incoming messages — host side
  // ==========================================================================

  function hostPlayerBySeat(seat) {
    for (var i = 0; i < session.players.length; i++) {
      if (session.players[i].seat === seat) return session.players[i];
    }
    return null;
  }

  function hostPlayerByToken(token) {
    for (var i = 0; i < session.players.length; i++) {
      if (session.players[i].token === token) return session.players[i];
    }
    return null;
  }

  function onJoinRequest(payload) {
    if (!session.isHost || !payload || !payload.token) return;
    if (session.started) return; // no new seats once the game is running (v1)
    if (hostPlayerByToken(payload.token)) {
      hostBroadcastLobby(); // already seated — just re-send the roster
      return;
    }
    // Lowest free human seat (host holds seat 0).
    var used = {};
    session.players.forEach(function (p) { used[p.seat] = true; });
    var seat = -1;
    for (var s = 0; s < TABLE_SIZE; s++) {
      if (!used[s]) { seat = s; break; }
    }
    if (seat === -1) {
      emitStatus('room-full');
      return;
    }
    session.players.push({
      seat: seat,
      name: String(payload.name || 'Player').slice(0, 20),
      isHost: false,
      isAI: false,
      token: payload.token,
      connected: true
    });
    session.players.sort(function (a, b) { return a.seat - b.seat; });
    session.lastSeen[seat] = Date.now();
    hostBroadcastLobby();
    hostPersistLobby();
  }

  function onRejoinRequest(payload) {
    if (!session.isHost || !payload || !payload.token) return;
    var p = hostPlayerBySeat(payload.seat);
    if (p && p.token === payload.token) {
      p.connected = true;
      session.lastSeen[p.seat] = Date.now();
      hostBroadcastLobby();
      hostSendSnapshotTo(p.seat);
    }
  }

  function onSnapshotRequest(payload) {
    if (!session.isHost || !payload) return;
    var p = hostPlayerBySeat(payload.seat);
    if (p && p.token === payload.token) hostSendSnapshotTo(p.seat);
  }

  function onLeaveMessage(payload) {
    if (!session.isHost || !payload) return;
    var p = hostPlayerBySeat(payload.seat);
    if (!p || p.token !== payload.token || p.isHost) return;
    p.connected = false;
    if (!session.started) {
      // In the lobby, leaving frees the seat entirely.
      session.players = session.players.filter(function (x) { return x.seat !== p.seat; });
      hostPersistLobby();
    }
    hostBroadcastLobby();
    hostPump(); // if it was their turn, the watchdog logic takes over
  }

  function onActionMessage(payload) {
    if (!session.isHost || !payload) return;
    hostApplyAction(payload.seat, payload.token, payload.action, false);
  }

  function hostRefreshConnected(presenceState) {
    var presentSeats = {};
    Object.keys(presenceState).forEach(function (key) {
      (presenceState[key] || []).forEach(function (p) {
        if (typeof p.seat === 'number' && p.seat >= 0) presentSeats[p.seat] = true;
      });
    });
    var changed = false;
    var now = Date.now();
    session.players.forEach(function (p) {
      if (p.isAI) return;
      var present = !!presentSeats[p.seat] || p.seat === session.seat;
      if (present) session.lastSeen[p.seat] = now;
      if (p.connected !== present) { p.connected = present; changed = true; }
    });
    if (changed) hostBroadcastLobby();
  }

  // ==========================================================================
  // Host — lobby broadcast + persistence
  // ==========================================================================

  function hostLobbyPayload() {
    return {
      players: session.players.map(function (p) {
        return {
          seat: p.seat, name: p.name, isHost: p.isHost, isAI: p.isAI,
          connected: p.connected, token: p.token
        };
      }),
      started: session.started
    };
  }

  function hostBroadcastLobby() {
    if (!session.isHost) return;
    var payload = hostLobbyPayload();
    broadcast('lobby', payload);
    // The host's own UI consumes the same shape.
    emitLobby({ players: payload.players, started: payload.started, code: session.code });
  }

  function hostPersistLobby() {
    if (!session.isHost || !session.code) return Promise.resolve();
    // DB copy deliberately omits tokens — it exists for discovery/rejoin only.
    var state = {
      players: session.players.map(function (p) {
        return { seat: p.seat, name: p.name, isHost: p.isHost, isAI: p.isAI, connected: p.connected };
      }),
      started: session.started
    };
    return client()
      .from('rooms')
      .update({ state: state, updated_at: new Date().toISOString() })
      .eq('code', session.code)
      .then(noop, noop); // persistence is best-effort; the channel is the live path
  }

  // ==========================================================================
  // Host — engine glue
  // ==========================================================================

  function createEngine() {
    var E = window.PokerEngine;
    if (!E) throw new Error('PokerNet: window.PokerEngine is not loaded (engine.js must load before net.js).');
    // PokerEngine may be a class (new PokerEngine()) or a ready singleton.
    var engine = (typeof E === 'function') ? new E() : E;
    // Best-effort niceties when the engine supports them (the Java-derived
    // API has setPlayerName/setPersonality; the net layer works without them).
    try {
      session.players.forEach(function (p) {
        if (typeof engine.setPlayerName === 'function') engine.setPlayerName(p.seat, p.name);
        if (p.isAI && typeof engine.setPersonality === 'function' && window.PokerEngine.Personality) {
          var personalities = ['TIGHT_AGGRESSIVE', 'LOOSE_AGGRESSIVE', 'CALLING_STATION'];
          var pick = personalities[p.seat % personalities.length];
          if (window.PokerEngine.Personality[pick]) {
            engine.setPersonality(p.seat, window.PokerEngine.Personality[pick]);
          }
        }
      });
    } catch (e) { /* cosmetic only */ }
    return engine;
  }

  function hostSendSnapshotTo(seat) {
    if (!session.engine) return;
    var state;
    try {
      state = session.engine.getSnapshot(seat);
    } catch (e) {
      console.error('PokerNet: getSnapshot failed', e);
      return;
    }
    if (seat === session.seat) {
      emitSnapshot(state); // host's own UI
    } else {
      broadcast('snapshot', { forSeat: seat, state: state });
    }
  }

  function hostBroadcastSnapshots() {
    if (!session.engine) return;
    session.players.forEach(function (p) {
      if (!p.isAI && p.connected) hostSendSnapshotTo(p.seat);
    });
    // Always refresh the host's own view too.
    if (!hostPlayerBySeat(session.seat) || !hostPlayerBySeat(session.seat).connected) {
      hostSendSnapshotTo(session.seat);
    }
  }

  // Translate a wire action { type, to? } into an engine Action, using the
  // engine's factory when present (Action.fold() etc.), else a plain object.
  function toEngineAction(engine, action) {
    var A = engine.Action || window.PokerAction;
    if (A && typeof A.fold === 'function') {
      switch (action.type) {
        case 'fold': return A.fold();
        case 'check': return A.check();
        case 'call': return A.call();
        case 'raise': return A.raiseTo(action.to);
        case 'allin': return (typeof A.allIn === 'function') ? A.allIn() : A.raiseTo(Number.MAX_SAFE_INTEGER);
        default: throw new Error('PokerNet: unknown action type "' + action.type + '".');
      }
    }
    // Plain-object engines: pass a normalized intent through.
    return { type: action.type, to: action.to };
  }

  // Validate + apply one action on the host. Returns true when applied.
  // fromLocal = the host acting for its own seat (token check skipped).
  function hostApplyAction(seat, token, action, fromLocal) {
    var engine = session.engine;
    if (!engine || !action || typeof action.type !== 'string') return false;

    var player = hostPlayerBySeat(seat);
    if (!player || player.isAI) return false;
    if (!fromLocal && player.token !== token) return false;         // identity
    if (engine.getCurrentActor() !== seat) return false;            // turn

    // Legality pre-check so a bad intent never reaches the engine.
    try {
      var legal = engine.getLegalActions(seat);
      if (legal) {
        if (action.type === 'fold' && legal.canFold === false) return false;
        if (action.type === 'check' && legal.canCheck === false) return false;
        if (action.type === 'call' && legal.canCall === false) return false;
        if (action.type === 'raise') {
          if (legal.canRaise === false) return false;
          if (typeof action.to !== 'number') return false;
          if (typeof legal.minRaiseTo === 'number' && action.to < legal.minRaiseTo) return false;
          if (typeof legal.maxRaiseTo === 'number' && action.to > legal.maxRaiseTo) return false;
        }
      }
    } catch (e) { /* if the pre-check itself fails, let applyAction decide */ }

    try {
      engine.applyAction(seat, toEngineAction(engine, action));
    } catch (e) {
      return false; // illegal action — ignored by design; requester re-syncs on next snapshot
    }
    hostAfterEngineChange();
    return true;
  }

  // The host's game driver: after any state change, advance stages, detect
  // hand end, refresh everyone, and schedule AI / disconnected-seat moves.
  function hostAfterEngineChange() {
    var engine = session.engine;
    if (!engine) return;

    if (engine.isHandComplete()) {
      hostBroadcastSnapshots();
      hostOnHandComplete();
      return;
    }
    if (engine.getCurrentActor() === -1) {
      try { engine.advanceStage(); } catch (e) { console.error('PokerNet: advanceStage failed', e); }
      if (engine.isHandComplete()) {
        hostBroadcastSnapshots();
        hostOnHandComplete();
        return;
      }
    }
    hostBroadcastSnapshots();
    hostSchedulePump();
  }

  function hostOnHandComplete() {
    var engine = session.engine;
    session.handInPause = true;
    // Build a one-line result for the UI log from whatever the engine exposes.
    var summary = 'Hand #' + (typeof engine.getHandNumber === 'function' ? engine.getHandNumber() : '?') + ' complete.';
    var payouts = null;
    try {
      if (typeof engine.getLastPayouts === 'function') {
        payouts = engine.getLastPayouts();
        var wins = [];
        session.players.forEach(function (p) {
          if (payouts && payouts[p.seat] > 0) wins.push(p.name + ' +$' + payouts[p.seat]);
        });
        if (wins.length) summary = 'Hand complete — ' + wins.join(', ') + '.';
      }
    } catch (e) { /* summary stays generic */ }
    broadcast('hand-result', {
      handNumber: (typeof engine.getHandNumber === 'function') ? engine.getHandNumber() : null,
      summary: summary,
      payouts: payouts
    });
    emitStatus('hand-result: ' + summary);

    // Next hand automatically while the room is open.
    setTimeout(function () {
      if (!session.isHost || !session.engine) return;
      session.handInPause = false;
      try {
        session.engine.startHand();
      } catch (e) {
        console.error('PokerNet: startHand failed', e);
        return;
      }
      hostAfterEngineChange();
    }, HAND_PAUSE_MS);
  }

  function actorIsAiOrAbsent(seat) {
    var p = hostPlayerBySeat(seat);
    if (!p) return true;               // seat not in the roster — treat as AI-filled
    if (p.isAI) return true;
    if (p.seat === session.seat) return false; // the host itself
    if (p.connected) return false;     // a live human — wait for them
    // Disconnected human: auto-play only after the grace period.
    var last = session.lastSeen[seat] || 0;
    return Date.now() - last > DISCONNECT_GRACE_MS;
  }

  function hostSchedulePump() {
    if (session.pumpTimer) return; // a step is already scheduled
    session.pumpTimer = setTimeout(function () {
      session.pumpTimer = null;
      hostPumpStep();
    }, AI_STEP_MS);
  }

  function hostPumpStep() {
    var engine = session.engine;
    if (!engine || session.handInPause || engine.isHandComplete()) return;
    var actor = engine.getCurrentActor();
    if (actor === -1) { hostAfterEngineChange(); return; }
    if (!actorIsAiOrAbsent(actor)) return; // waiting on a live human

    var action = null;
    var p = hostPlayerBySeat(actor);
    if (p && !p.isAI && !p.connected) {
      // Disconnected human past grace: check when legal, otherwise fold.
      try {
        var legal = engine.getLegalActions(actor);
        action = (legal && legal.canCheck)
          ? toEngineAction(engine, { type: 'check' })
          : toEngineAction(engine, { type: 'fold' });
      } catch (e) { /* fall through to AI */ }
    }
    if (!action) {
      if (!window.AiPlayer || typeof window.AiPlayer.decide !== 'function') {
        console.error('PokerNet: window.AiPlayer.decide is not available.');
        return;
      }
      try {
        action = window.AiPlayer.decide(engine, actor);
      } catch (e) {
        console.error('PokerNet: AiPlayer.decide failed', e);
        return;
      }
    }
    try {
      engine.applyAction(actor, action);
    } catch (e) {
      console.error('PokerNet: AI/auto action rejected', e);
      return;
    }
    hostAfterEngineChange();
    // If the next actor is also AI/absent, hostAfterEngineChange already
    // scheduled the next step via hostSchedulePump.
  }

  // 1 s watchdog: keeps the game moving if a human disconnects mid-turn and
  // re-checks presence-derived state even when no messages are flowing.
  function hostStartWatchdog() {
    if (session.tickTimer) clearInterval(session.tickTimer);
    session.tickTimer = setInterval(function () {
      if (!session.isHost || !session.engine || session.handInPause) return;
      if (session.engine.isHandComplete()) return;
      var actor = session.engine.getCurrentActor();
      if (actor >= 0 && actorIsAiOrAbsent(actor)) hostSchedulePump();
    }, PUMP_TICK_MS);
  }

  // ==========================================================================
  // Public API — room lifecycle
  // ==========================================================================

  function createRoom(name) {
    return Promise.resolve().then(function () {
      requireConfigured();
      if (session.code) throw new Error('PokerNet: already in a room — leaveRoom() first.');
      var displayName = String(name || 'Host').slice(0, 20) || 'Host';

      // Insert a rooms row with a fresh unique code (retry on collision).
      var attempt = function (triesLeft) {
        var code = makeRoomCode();
        var initialState = {
          players: [{ seat: 0, name: displayName, isHost: true, isAI: false, connected: true }],
          started: false
        };
        return client()
          .from('rooms')
          .insert({ code: code, state: initialState, host_token: playerToken })
          .then(function (res) {
            if (res.error) {
              if (triesLeft > 0) return attempt(triesLeft - 1);
              throw new Error('PokerNet: could not create a room (' + res.error.message + ').');
            }
            return code;
          });
      };

      return attempt(4).then(function (code) {
        session.code = code;
        session.seat = 0;
        session.name = displayName;
        session.isHost = true;
        session.started = false;
        session.players = [{
          seat: 0, name: displayName, isHost: true, isAI: false,
          token: playerToken, connected: true
        }];
        session.lastSeen[0] = Date.now();
        saveSession();
        emitStatus('connecting');
        return subscribeChannel(code).then(function () {
          emitStatus('connected');
          hostBroadcastLobby();
          hostStartWatchdog();
          return code;
        });
      });
    });
  }

  function joinRoom(code, name) {
    return Promise.resolve().then(function () {
      requireConfigured();
      if (session.code) throw new Error('PokerNet: already in a room — leaveRoom() first.');
      var cleanCode = String(code || '').trim().toUpperCase();
      if (!cleanCode) throw new Error('PokerNet: a room code is required to join.');
      var displayName = String(name || 'Player').slice(0, 20) || 'Player';

      emitStatus('connecting');
      return client()
        .from('rooms')
        .select('code, state, host_token')
        .eq('code', cleanCode)
        .maybeSingle()
        .then(function (res) {
          if (res.error) throw new Error('PokerNet: room lookup failed (' + res.error.message + ').');
          if (!res.data) {
            emitStatus('room-not-found');
            throw new Error('PokerNet: no room found with code "' + cleanCode + '".');
          }
          if (res.data.state && res.data.state.started) {
            throw new Error('PokerNet: that game has already started — ask the host for a new room.');
          }
          session.code = cleanCode;
          session.seat = -1; // assigned by the host via the lobby handshake
          session.name = displayName;
          session.isHost = false;
          session.started = false;
          return subscribeChannel(cleanCode).then(function () {
            emitStatus('waiting-for-host');
            return broadcast('join-request', { token: playerToken, name: displayName }).then(function () {
              // Resolve once the host's lobby assigns us a seat.
              return waitForSeatAssignment(8000);
            });
          });
        })
        .then(function (seat) {
          saveSession();
          emitStatus('connected');
          return { code: cleanCode, seat: seat };
        })
        .catch(function (err) {
          if (session.code === cleanCode && !session.isHost) {
            var wasStatus = err && err.message;
            resetSession();
            if (wasStatus) emitStatus('error');
          }
          throw err;
        });
    });
  }

  // Poll the lobby-driven seat field until the host assigns us a seat.
  function waitForSeatAssignment(timeoutMs) {
    return new Promise(function (resolve, reject) {
      var startedAt = Date.now();
      var timer = setInterval(function () {
        if (session.seat >= 0) {
          clearInterval(timer);
          resolve(session.seat);
        } else if (Date.now() - startedAt > timeoutMs) {
          clearInterval(timer);
          reject(new Error('PokerNet: the host did not assign a seat in time (is the host still there?).'));
        }
      }, 150);
    });
  }

  function tryRejoin() {
    return Promise.resolve().then(function () {
      requireConfigured();
      var saved = loadJson(LS_SESSION_KEY);
      if (!saved || !saved.roomCode || typeof saved.seat !== 'number') return null;
      return client()
        .from('rooms')
        .select('code, state')
        .eq('code', saved.roomCode)
        .maybeSingle()
        .then(function (res) {
          if (res.error || !res.data) {
            saveJson(LS_SESSION_KEY, null);
            return null; // room is gone — nothing to rejoin
          }
          var isHostRoom = false;
          // If I was the host, the engine state died with my old tab — v1
          // cannot resume hosting; guests, however, can reclaim a seat.
          session.code = saved.roomCode;
          session.seat = saved.seat;
          session.name = saved.name || 'Player';
          session.isHost = false;
          session.started = !!(res.data.state && res.data.state.started);
          return subscribeChannel(saved.roomCode).then(function () {
            return broadcast('rejoin-request', {
              token: playerToken, seat: saved.seat, name: session.name
            }).then(function () {
              return broadcast('snapshot-request', { token: playerToken, seat: saved.seat });
            }).then(function () {
              emitStatus('connected');
              return { code: saved.roomCode, seat: saved.seat };
            });
          });
        })
        .catch(function () {
          resetSession();
          return null; // rejoin is best-effort; the app falls back to the menu
        });
    });
  }

  function leaveRoom() {
    return Promise.resolve().then(function () {
      requireConfigured();
      var code = session.code;
      var wasHost = session.isHost;
      if (session.channel && session.seat >= 0) {
        broadcast('leave', { seat: session.seat, token: playerToken });
      }
      resetSession();
      emitStatus('left');
      if (wasHost && code) {
        // Host leaving closes the room: guests' lookups stop finding it and
        // their presence check reports the host as gone.
        return client().from('rooms').delete().eq('code', code).then(noop, noop);
      }
    });
  }

  function startGame() {
    return Promise.resolve().then(function () {
      requireConfigured();
      if (!session.isHost) throw new Error('PokerNet: only the host can start the game.');
      if (session.started) throw new Error('PokerNet: the game has already started.');
      var humans = session.players.filter(function (p) { return !p.isAI; });
      if (humans.length < MIN_HUMANS_TO_START) {
        throw new Error('PokerNet: need at least ' + MIN_HUMANS_TO_START + ' human players to start (have ' + humans.length + ').');
      }
      // AI fills every remaining seat up to a full 6-max table.
      var used = {};
      session.players.forEach(function (p) { used[p.seat] = true; });
      var aiNames = ['Vex', 'Mara', 'Duke', 'Ivy', 'Sol', 'Noor'];
      for (var s = 0; s < TABLE_SIZE; s++) {
        if (!used[s]) {
          session.players.push({
            seat: s, name: aiNames[s % aiNames.length], isHost: false,
            isAI: true, token: null, connected: true
          });
        }
      }
      session.players.sort(function (a, b) { return a.seat - b.seat; });

      session.engine = createEngine();
      session.started = true;
      hostBroadcastLobby();
      hostPersistLobby();
      try {
        session.engine.startHand();
      } catch (e) {
        session.started = false;
        throw new Error('PokerNet: the engine failed to start the first hand (' + e.message + ').');
      }
      emitStatus('started');
      hostAfterEngineChange();
    });
  }

  function sendAction(action) {
    return Promise.resolve().then(function () {
      requireConfigured();
      if (!session.code || session.seat < 0) {
        throw new Error('PokerNet: not in a room.');
      }
      if (!action || typeof action.type !== 'string') {
        throw new Error('PokerNet: sendAction needs an action like { type: "call" } or { type: "raise", to: 120 }.');
      }
      var wire = { type: action.type.toLowerCase() };
      if (typeof action.to === 'number') wire.to = action.to;
      if (session.isHost) {
        hostApplyAction(session.seat, playerToken, wire, true);
        return;
      }
      return broadcast('action', { seat: session.seat, token: playerToken, action: wire });
    });
  }

  // ==========================================================================
  // Public API surface
  // ==========================================================================

  window.PokerNet = {
    isConfigured: isConfigured,
    createRoom: createRoom,
    joinRoom: joinRoom,
    tryRejoin: tryRejoin,
    leaveRoom: leaveRoom,
    startGame: startGame,
    sendAction: sendAction,
    onSnapshot: function (cb) { if (typeof cb === 'function') snapshotCallbacks.push(cb); },
    onLobby: function (cb) { if (typeof cb === 'function') lobbyCallbacks.push(cb); },
    onStatus: function (cb) { if (typeof cb === 'function') statusCallbacks.push(cb); },
    mySeat: function () { return session.seat; },
    roomCode: function () { return session.code; }
  };
})();
