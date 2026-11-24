/*
 * app.js — UI driver for the web poker game.
 *
 * ==========================================================================
 * ARCHITECTURE / SEAMS (for the net layer and future work)
 * ==========================================================================
 * Everything visual flows through ONE function:
 *
 *   PokerApp.renderSnapshot(snapshot)
 *
 * A snapshot is the JSON-safe object from PokerEngine.getSnapshot(forSeat)
 * (see engine.js). It is viewer-relative: it only ever contains hole cards
 * the viewer is allowed to see, and `legalActions` is filled only when it
 * is the viewer's turn. Any source — the local single-player driver below,
 * or Supabase Realtime via net.js — can feed snapshots in and the table
 * renders identically.
 *
 * Every local player action flows out through ONE callback:
 *
 *   PokerApp.onLocalAction(action)
 *
 * where action is the engine/net wire shape:
 *   { type: 'fold' }  { type: 'check' }  { type: 'call' }
 *   { type: 'raise', to: <total bet this round> }  { type: 'allin' }
 *
 * Modes register their sink with PokerApp.setActionHandler(fn):
 *   - Single-player: applies the action to the local PokerEngine.
 *   - Multiplayer:   forwards it to PokerNet.sendAction(action).
 * The controls never touch the engine or the network directly.
 *
 * Multiplayer itself lives entirely in net.js (window.PokerNet). app.js
 * only calls its public API (createRoom / joinRoom / startGame /
 * sendAction / leaveRoom / tryRejoin) and subscribes to its onSnapshot /
 * onLobby / onStatus callbacks. If PokerNet is absent or unconfigured,
 * the multiplayer UI hides and single-player still works.
 * ==========================================================================
 */
(function () {
  'use strict';

  // ======================================================================
  // Constants
  // ======================================================================

  var AI_NAMES = ['Maria', 'Kenji', 'Sofia', 'Dmitri', 'Rosa'];
  var AVATAR_COLORS = ['#2B5FA6', '#8C4A6E', '#B3541E', '#3E7A5E', '#546E7A', '#7A5C2E'];
  var AI_STEP_MS = 700;          // pacing between AI actions (single-player)
  var STREET_PAUSE_MS = 650;     // pause before dealing the next street
  var NEXT_HAND_MS = 4200;       // pause on the result before the next hand
  var TURN_SECONDS = 30;         // cosmetic turn-timer length
  var NUM_SEATS = 6;

  // ======================================================================
  // DOM helpers
  // ======================================================================

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function money(n) { return window.PokerArt ? PokerArt.money(n) : '$' + n; }

  // ======================================================================
  // State
  // ======================================================================

  var state = {
    mode: null,              // 'sp' | 'mp'
    engine: null,            // local engine (single-player only)
    mySeat: 0,
    roomCode: null,
    isHost: false,
    timer: null,             // pending setTimeout id (single-player pacing)
    lastActions: {},         // seat -> short action label for the pod
    prevSnap: null,          // previous snapshot (deal animation, MP log diff)
    lastResultHand: -1,      // handNumber whose result was already shown
    currentLegal: null,      // legalActions from the latest snapshot
    currentSnap: null,
    raiseTurnKey: null,      // identifies the current decision point
    timerActor: -2
  };

  // ======================================================================
  // Screens
  // ======================================================================

  var SCREENS = ['lobby', 'room', 'table'];
  function showScreen(name) {
    for (var i = 0; i < SCREENS.length; i++) {
      $('screen-' + SCREENS[i]).classList.toggle('hidden', SCREENS[i] !== name);
    }
    $('btn-leave').classList.toggle('hidden', name === 'lobby');
  }

  function setNetStatus(text, on) {
    var s = $('net-status');
    s.textContent = text;
    s.classList.toggle('on', !!on);
  }

  function setMsg(id, text, isError) {
    var m = $(id);
    m.textContent = text || '';
    m.classList.toggle('error', !!isError);
  }

  // ======================================================================
  // Action log
  // ======================================================================

  function logLine(text, cls) {
    var log = $('log');
    var li = el('li', cls || '', text);
    log.appendChild(li);
    while (log.children.length > 80) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  function clearLog() { $('log').innerHTML = ''; }

  // ======================================================================
  // Rendering — the single snapshot -> table path
  // ======================================================================

  function initials(name) {
    var parts = String(name || '?').trim().split(/\s+/);
    if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
    return String(name || '?').slice(0, 2).toUpperCase();
  }

  function prettyStage(stage) {
    return { PREFLOP: 'Pre-flop', FLOP: 'Flop', TURN: 'Turn', RIVER: 'River',
             COMPLETE: 'Showdown' }[stage] || stage;
  }

  /** Renders one seat pod. pos is the display position 0..5 (0 = hero). */
  function seatHTML(snap, seatIdx, pos, viewer) {
    var s = snap.seats[seatIdx];
    var cls = 'seat pos-' + pos + (pos === 0 ? ' hero' : '');
    if (s.folded) cls += ' folded';
    if (!s.inHand) cls += ' not-in-hand';
    if (snap.currentActor === seatIdx) cls += ' active';

    var html = '<div class="' + cls + '" data-seat="' + seatIdx + '">';

    // Hole cards: faces when the snapshot reveals them, backs while in hand.
    if (s.inHand) {
      html += '<div class="hole">';
      for (var k = 0; k < 2; k++) {
        var isNew = state.prevSnap && state.prevSnap.handNumber === snap.handNumber &&
                    state.prevSnap.seats[seatIdx] &&
                    !state.prevSnap.seats[seatIdx].inHand && s.inHand;
        var anim = (state.prevSnap === null || state.prevSnap.handNumber !== snap.handNumber || isNew)
                   ? ' deal-in' : '';
        var delay = ' style="animation-delay:' + (seatIdx * 90 + k * 130) + 'ms"';
        if (s.hole) {
          html += '<div class="card' + anim + '"' + delay + '>' +
                  PokerArt.cardSVG(s.hole[k]) + '</div>';
        } else {
          html += '<div class="card' + anim + '"' + delay + '>' +
                  PokerArt.cardBackSVG() + '</div>';
        }
      }
      html += '</div>';
    } else {
      html += '<div class="hole"></div>';
    }

    // Pod: avatar + name/stack/last action.
    html += '<div class="pod">' +
      '<div class="avatar">' + PokerArt.avatarSVG(initials(s.name), AVATAR_COLORS[seatIdx % 6]) + '</div>' +
      '<div class="pod-text">' +
        '<div class="p-name">' + escapeHTML(s.name) +
          (s.allIn ? '<span class="tag-allin">ALL-IN</span>' : '') + '</div>' +
        '<div class="p-stack">' + money(s.stack) + '</div>' +
        '<div class="p-action">' + escapeHTML(state.lastActions[seatIdx] || '') + '</div>' +
        '<div class="timer"><i></i></div>' +
      '</div></div>';

    if (snap.button === seatIdx) {
      html += '<div class="dealer">' + PokerArt.dealerButtonSVG() + '</div>';
    }
    if (s.betThisRound > 0) {
      html += '<div class="bet">' + PokerArt.chipStackSVG(s.betThisRound) + '</div>';
    }
    return html + '</div>';
  }

  function escapeHTML(t) {
    return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * THE render seam. Renders any engine snapshot (local or remote) from
   * the point of view of snapshot.forSeat. Safe to call with every new
   * snapshot; it fully re-renders the table area and refreshes controls.
   */
  function renderSnapshot(snap) {
    if (!snap || !snap.seats) return;
    var viewer = (snap.forSeat === null || snap.forSeat === undefined)
                 ? state.mySeat : snap.forSeat;
    state.currentSnap = snap;
    state.currentLegal = snap.legalActions || null;

    if ($('screen-table').classList.contains('hidden')) showScreen('table');

    $('hand-label').textContent = snap.handNumber ? 'Hand #' + snap.handNumber : '';
    $('stage-label').textContent =
      (snap.stage && snap.stage !== 'COMPLETE') ? prettyStage(snap.stage) : '';

    // Pot (engine pot = all chips committed this hand, bets included).
    $('pot-chips').innerHTML = snap.pot > 0 ? PokerArt.chipStackSVG(snap.pot) : '';
    $('pot-label').textContent = 'Pot ' + money(snap.pot);

    // Board: five slots, newly dealt cards animate in.
    var prevLen = (state.prevSnap && state.prevSnap.handNumber === snap.handNumber)
                  ? state.prevSnap.board.length : 0;
    var boardHTML = '';
    for (var i = 0; i < 5; i++) {
      if (i < snap.board.length) {
        var anim = i >= prevLen ? ' deal-in' : '';
        boardHTML += '<div class="board-slot' + anim + '" style="animation-delay:' +
                     (i * 110) + 'ms">' + PokerArt.cardSVG(snap.board[i]) + '</div>';
      } else {
        boardHTML += '<div class="board-slot empty"></div>';
      }
    }
    $('board-cards').innerHTML = boardHTML;

    // Seats, rotated so the viewer is always at the bottom (position 0).
    var seatsHTML = '';
    for (var seat = 0; seat < NUM_SEATS; seat++) {
      var pos = (seat - viewer + NUM_SEATS) % NUM_SEATS;
      seatsHTML += seatHTML(snap, seat, pos, viewer);
    }
    $('seats').innerHTML = seatsHTML;

    restartTurnTimer(snap);
    updateControls(snap, viewer);
    updateResultOverlay(snap);

    state.prevSnap = snap;
  }

  /** Restarts the cosmetic 30s turn bar for the seat to act. */
  function restartTurnTimer(snap) {
    if (snap.currentActor === state.timerActor) return;
    state.timerActor = snap.currentActor;
    if (snap.currentActor < 0) return;
    var node = document.querySelector('.seat[data-seat="' + snap.currentActor + '"] .timer i');
    if (!node) return;
    node.style.transition = 'none';
    node.style.width = '100%';
    void node.offsetWidth;                       // force reflow
    node.style.transition = 'width ' + TURN_SECONDS + 's linear';
    node.style.width = '0%';
  }

  /** Shows the hand-result overlay + logs the result, once per hand. */
  function updateResultOverlay(snap) {
    var overlay = $('showdown-overlay');
    if (!snap.lastPayouts) { overlay.classList.add('hidden'); return; }
    if (state.lastResultHand === snap.handNumber) return;
    state.lastResultHand = snap.handNumber;

    var winners = [];
    for (var i = 0; i < NUM_SEATS; i++) {
      if (snap.lastPayouts[i] > 0) winners.push(i);
    }
    if (winners.length === 0) { overlay.classList.add('hidden'); return; }

    var title, sub;
    if (winners.length === 1) {
      var w = winners[0];
      title = escapeHTML(snap.seats[w].name) + ' wins <span class="amount">' +
              money(snap.lastPayouts[w]) + '</span>';
      if (snap.wasShowdown && snap.seats[w].handName) {
        sub = '<span class="hand-name">' + escapeHTML(snap.seats[w].handName) + '</span>';
      } else {
        sub = 'Everyone else folded';
      }
      logLine(snap.seats[w].name + ' wins ' + money(snap.lastPayouts[w]) +
              (snap.wasShowdown && snap.seats[w].handName
                ? ' — ' + snap.seats[w].handName : ''), 'result');
    } else {
      title = 'Split pot';
      var parts = [];
      for (var j = 0; j < winners.length; j++) {
        var s2 = winners[j];
        parts.push(escapeHTML(snap.seats[s2].name) + ' <span class="amount">' +
                   money(snap.lastPayouts[s2]) + '</span>' +
                   (snap.seats[s2].handName
                     ? ' — <span class="hand-name">' + escapeHTML(snap.seats[s2].handName) + '</span>'
                     : ''));
        logLine(snap.seats[s2].name + ' wins ' + money(snap.lastPayouts[s2]) +
                (snap.seats[s2].handName ? ' — ' + snap.seats[s2].handName : ''), 'result');
      }
      sub = parts.join('<br>');
    }
    $('showdown-title').innerHTML = title;
    $('showdown-sub').innerHTML = sub;
    overlay.classList.remove('hidden');
  }

  // ======================================================================
  // Controls
  // ======================================================================

  function updateControls(snap, viewer) {
    var la = snap.legalActions;
    var myTurn = !!la && snap.currentActor === viewer;
    var fold = $('btn-fold'), check = $('btn-check'), call = $('btn-call'),
        raiseBtn = $('btn-raise'), slider = $('raise-slider'),
        input = $('raise-input');

    fold.disabled = !myTurn;
    check.disabled = !(myTurn && la.canCheck);
    call.disabled = !(myTurn && la.canCall);
    call.textContent = (la && la.callAmount > 0) ? 'Call ' + money(la.callAmount) : 'Call';

    var canRaise = myTurn && la.canRaise;
    raiseBtn.disabled = !canRaise;
    slider.disabled = !canRaise;
    input.disabled = !canRaise;
    var quick = document.querySelectorAll('[data-raise]');
    for (var i = 0; i < quick.length; i++) quick[i].disabled = !canRaise;

    if (canRaise) {
      var turnKey = snap.handNumber + '|' + snap.stage + '|' + snap.currentBet +
                    '|' + snap.seats[viewer].betThisRound;
      slider.min = la.minRaiseTo;
      slider.max = la.maxRaiseTo;
      if (state.raiseTurnKey !== turnKey) {
        state.raiseTurnKey = turnKey;
        setRaiseAmount(la.minRaiseTo);
      } else {
        setRaiseAmount(clampRaise(parseInt(input.value, 10) || la.minRaiseTo));
      }
    }

    var hint = $('turn-hint');
    if (myTurn) {
      hint.textContent = 'Your turn';
      hint.classList.add('mine');
    } else if (snap.currentActor >= 0) {
      hint.textContent = 'Waiting for ' + snap.seats[snap.currentActor].name + '…';
      hint.classList.remove('mine');
    } else if (snap.lastPayouts) {
      hint.textContent = '';
      hint.classList.remove('mine');
    } else {
      hint.textContent = '';
      hint.classList.remove('mine');
    }
  }

  function clampRaise(v) {
    var la = state.currentLegal;
    if (!la) return v;
    v = Math.round(v / 10) * 10;
    return Math.max(la.minRaiseTo, Math.min(la.maxRaiseTo, v));
  }

  function setRaiseAmount(v) {
    $('raise-slider').value = v;
    $('raise-input').value = v;
  }

  /** Quick-raise sizing: fraction of the pot after calling, as a raise-to. */
  function quickRaise(kind) {
    var la = state.currentLegal, snap = state.currentSnap;
    if (!la || !snap) return;
    if (kind === 'max') { setRaiseAmount(la.maxRaiseTo); return; }
    var potAfterCall = snap.pot + la.callAmount;
    var frac = kind === 'half' ? 0.5 : 1;
    setRaiseAmount(clampRaise(snap.currentBet + Math.round(potAfterCall * frac)));
  }

  function wireControls() {
    $('btn-fold').addEventListener('click', function () {
      PokerApp.onLocalAction({ type: 'fold' });
    });
    $('btn-check').addEventListener('click', function () {
      PokerApp.onLocalAction({ type: 'check' });
    });
    $('btn-call').addEventListener('click', function () {
      PokerApp.onLocalAction({ type: 'call' });
    });
    $('btn-raise').addEventListener('click', function () {
      var la = state.currentLegal;
      if (!la) return;
      var v = clampRaise(parseInt($('raise-input').value, 10) || la.minRaiseTo);
      if (v >= la.maxRaiseTo) PokerApp.onLocalAction({ type: 'allin' });
      else PokerApp.onLocalAction({ type: 'raise', to: v });
    });
    $('raise-slider').addEventListener('input', function () {
      $('raise-input').value = this.value;
    });
    $('raise-input').addEventListener('change', function () {
      setRaiseAmount(clampRaise(parseInt(this.value, 10) || 0));
    });
    var quick = document.querySelectorAll('[data-raise]');
    for (var i = 0; i < quick.length; i++) {
      quick[i].addEventListener('click', function () {
        quickRaise(this.getAttribute('data-raise'));
      });
    }
    $('btn-next-hand').addEventListener('click', function () {
      if (state.mode === 'sp') {
        clearTimeout(state.timer);
        startSpHand();
      }
    });
  }

  // ======================================================================
  // Action narration (log lines + pod labels)
  // ======================================================================

  /** Records + logs an action. la = legal actions BEFORE the action. */
  function narrate(seat, action, la, name) {
    var pod = '', line = '';
    switch (action.type) {
      case 'fold':
        pod = 'Folds'; line = 'folds'; break;
      case 'check':
        pod = 'Checks'; line = 'checks'; break;
      case 'call':
        pod = 'Calls ' + money(la.callAmount);
        line = 'calls ' + money(la.callAmount); break;
      case 'raise':
        pod = (la.callAmount > 0 ? 'Raises to ' : 'Bets ') + money(action.to);
        line = (la.callAmount > 0 ? 'raises to ' : 'bets ') + money(action.to); break;
      case 'allin':
        pod = 'All-in ' + money(la.maxRaiseTo);
        line = 'goes all-in for ' + money(la.maxRaiseTo); break;
    }
    state.lastActions[seat] = pod;
    if (line) logLine(name + ' ' + line);
  }

  // ======================================================================
  // Single-player driver (local engine, AI seats, timed pacing)
  // ======================================================================

  function startSinglePlayer(name) {
    state.mode = 'sp';
    state.mySeat = 0;
    state.isHost = false;
    state.lastResultHand = -1;
    state.prevSnap = null;
    state.lastActions = {};

    var engine = new PokerEngine();
    engine.setPlayerName(0, name);
    for (var i = 0; i < AI_NAMES.length; i++) engine.setPlayerName(i + 1, AI_NAMES[i]);
    state.engine = engine;

    PokerApp.setActionHandler(spHeroAction);
    showScreen('table');
    setNetStatus('Single-player vs AI', false);
    clearLog();
    logLine('Single-player table — you vs five AI opponents.', 'dim');
    logLine('Blinds $10 / $20. Busted seats rebuy $1,000.', 'dim');
    startSpHand();
  }

  function startSpHand() {
    var engine = state.engine;
    if (!engine) return;
    $('btn-next-hand').classList.add('hidden');
    $('showdown-overlay').classList.add('hidden');
    state.lastActions = {};
    engine.startHand();
    logLine('— Hand #' + engine.getHandNumber() + ' —', 'street');
    spStep();
  }

  function spStep() {
    var engine = state.engine;
    if (!engine) return;
    if (!engine.isHandInProgress()) { spHandOver(); return; }

    renderSnapshot(engine.getSnapshot(0));
    var actor = engine.getCurrentActor();

    if (actor === -1) {
      // Betting round finished: deal the next street after a short pause.
      state.timer = setTimeout(function () {
        var before = engine.getStage();
        engine.advanceStage();
        var after = engine.getStage();
        state.lastActions = {};
        if (after !== before && after !== 'COMPLETE') {
          logLine('— ' + prettyStage(after) + ' —', 'street');
        }
        spStep();
      }, STREET_PAUSE_MS);
      return;
    }
    if (actor === 0) return;   // hero's turn: controls are live, wait for input

    state.timer = setTimeout(function () {
      var la = engine.getLegalActions(actor);
      var action = AiPlayer.decide(engine, actor);
      narrate(actor, action, la, engine.getSeat(actor).name);
      engine.applyAction(actor, action);
      spStep();
    }, AI_STEP_MS);
  }

  function spHeroAction(action) {
    var engine = state.engine;
    if (!engine || engine.getCurrentActor() !== 0) return;
    var la = engine.getLegalActions(0);
    try {
      engine.applyAction(0, action);
    } catch (e) {
      logLine('That action is not legal right now.', 'dim');
      return;
    }
    narrate(0, action, la, engine.getSeat(0).name);
    spStep();
  }

  function spHandOver() {
    renderSnapshot(state.engine.getSnapshot(0));
    $('btn-next-hand').classList.remove('hidden');
    state.timer = setTimeout(function () {
      if (state.mode === 'sp') startSpHand();
    }, NEXT_HAND_MS);
  }

  // ======================================================================
  // Multiplayer (net.js) — lobby, room, snapshot feed
  // ======================================================================

  function netAvailable() {
    return typeof window.PokerNet !== 'undefined' && !!window.PokerNet &&
           PokerNet.isConfigured();
  }

  function renderRoomLobby(lobby) {
    if (!lobby) return;
    state.roomCode = lobby.code || state.roomCode;
    $('room-code').textContent = state.roomCode || '------';

    var me = PokerNet.mySeat();
    state.mySeat = me;
    var myRow = null;
    var list = $('room-players');
    list.innerHTML = '';
    (lobby.players || []).forEach(function (p) {
      if (p.seat === me) myRow = p;
      var li = el('li', p.connected === false ? 'off' : '');
      li.appendChild(el('span', 'seat-no', 'Seat ' + (p.seat + 1)));
      li.appendChild(el('span', 'p-name', p.name || 'Empty'));
      if (p.isHost) li.appendChild(el('span', 'badge host', 'Host'));
      if (p.isAI) li.appendChild(el('span', 'badge ai', 'AI'));
      if (p.seat === me) li.appendChild(el('span', 'badge', 'You'));
      list.appendChild(li);
    });

    state.isHost = !!(myRow && myRow.isHost);
    $('btn-start').classList.toggle('hidden', !(state.isHost && !lobby.started));
    $('room-wait').classList.toggle('hidden', !(!state.isHost && !lobby.started));
    if (lobby.started) showScreen('table');
  }

  /**
   * Best-effort action log for multiplayer, derived by diffing snapshots
   * (checks leave no state trace, so they are not logged remotely).
   */
  function mpDiffLog(snap) {
    var prev = state.prevSnap;
    if (!prev || prev.handNumber !== snap.handNumber) {
      state.lastActions = {};
      if (snap.handNumber) logLine('— Hand #' + snap.handNumber + ' —', 'street');
      return;
    }
    if (prev.stage !== snap.stage && snap.stage !== 'COMPLETE') {
      state.lastActions = {};
      logLine('— ' + prettyStage(snap.stage) + ' —', 'street');
    }
    for (var i = 0; i < NUM_SEATS; i++) {
      var a = prev.seats[i], b = snap.seats[i];
      if (!a || !b) continue;
      if (!a.folded && b.folded) {
        state.lastActions[i] = 'Folds';
        logLine(b.name + ' folds');
      } else if (b.betThisRound > a.betThisRound) {
        var verb = (prev.currentBet > 0 && b.betThisRound > prev.currentBet)
                   ? 'raises to ' : (prev.currentBet === 0 ? 'bets ' : 'calls ');
        state.lastActions[i] = verb.charAt(0).toUpperCase() + verb.slice(1) +
                               money(b.betThisRound) + (b.allIn ? ' (all-in)' : '');
        logLine(b.name + ' ' + verb + money(b.betThisRound) + (b.allIn ? ' — all-in' : ''));
      }
    }
  }

  function wireNet() {
    PokerNet.onSnapshot(function (snap) {
      if (!snap) return;
      state.mySeat = PokerNet.mySeat();
      mpDiffLog(snap);
      PokerApp.renderSnapshot(snap);
    });
    PokerNet.onLobby(function (lobby) {
      if ($('screen-table').classList.contains('hidden') || !lobby.started) {
        showScreen('room');
      }
      renderRoomLobby(lobby);
      setNetStatus('Room ' + (lobby.code || state.roomCode || ''), true);
    });
    PokerNet.onStatus(function (status) {
      if (status === 'connected') {
        setNetStatus(state.roomCode ? 'Room ' + state.roomCode : 'Connected', true);
      } else if (status === 'room-not-found') {
        showScreen('lobby');
        setMsg('lobby-msg', 'Room not found — check the code and try again.', true);
        setNetStatus('Single-player', false);
      } else if (status === 'host-disconnected') {
        setMsg('room-msg', 'The host disconnected — the game is frozen.', true);
        $('turn-hint').textContent = 'Host disconnected';
      } else if (status === 'room-closed') {
        leaveToLobby('The room was closed by the host.');
      } else if (status === 'error') {
        setMsg('lobby-msg', 'Connection error — please try again.', true);
      }
    });
  }

  function startMultiplayerHandlers() {
    PokerApp.setActionHandler(function (action) {
      PokerNet.sendAction(action).catch(function () {
        logLine('Could not send that action — connection issue.', 'dim');
      });
    });
  }

  function createRoom(name) {
    setMsg('lobby-msg', 'Creating room…');
    PokerNet.createRoom(name).then(function (code) {
      state.mode = 'mp';
      state.roomCode = code;
      state.mySeat = PokerNet.mySeat();
      startMultiplayerHandlers();
      showScreen('room');
      setMsg('lobby-msg', '');
      setNetStatus('Room ' + code, true);
      logLine('Room ' + code + ' created.', 'dim');
    }).catch(function (err) {
      setMsg('lobby-msg', 'Could not create a room: ' + err.message, true);
    });
  }

  function joinRoom(code, name) {
    setMsg('lobby-msg', 'Joining room ' + code + '…');
    PokerNet.joinRoom(code, name).then(function (res) {
      state.mode = 'mp';
      state.roomCode = res.code;
      state.mySeat = res.seat;
      startMultiplayerHandlers();
      showScreen('room');
      setMsg('lobby-msg', '');
      setNetStatus('Room ' + res.code, true);
    }).catch(function (err) {
      setMsg('lobby-msg', 'Could not join: ' + err.message, true);
    });
  }

  function leaveToLobby(msg) {
    clearTimeout(state.timer);
    state.mode = null;
    state.engine = null;
    state.roomCode = null;
    state.prevSnap = null;
    state.lastResultHand = -1;
    showScreen('lobby');
    setNetStatus('Single-player', false);
    if (msg) setMsg('lobby-msg', msg);
  }

  // ======================================================================
  // Lobby wiring / init
  // ======================================================================

  function heroName() {
    var v = $('name-input').value.trim();
    return v || 'You';
  }

  function init() {
    wireControls();

    var saved = null;
    try { saved = window.localStorage.getItem('poker.name'); } catch (e) { /* private mode */ }
    if (saved) $('name-input').value = saved;
    $('name-input').addEventListener('change', function () {
      try { window.localStorage.setItem('poker.name', this.value.trim()); } catch (e) { /* ignore */ }
    });

    $('btn-ai').addEventListener('click', function () {
      startSinglePlayer(heroName());
    });

    $('btn-leave').addEventListener('click', function () {
      if (state.mode === 'mp' && typeof window.PokerNet !== 'undefined') {
        PokerNet.leaveRoom().catch(function () { /* already gone */ })
          .then(function () { leaveToLobby(); });
      } else {
        leaveToLobby();
      }
    });

    if (netAvailable()) {
      wireNet();
      $('btn-create').addEventListener('click', function () { createRoom(heroName()); });
      $('btn-join').addEventListener('click', function () {
        var code = $('code-input').value.trim().toUpperCase();
        if (code.length < 4) { setMsg('lobby-msg', 'Enter the room code first.', true); return; }
        joinRoom(code, heroName());
      });
      $('code-input').addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') $('btn-join').click();
      });
      $('btn-start').addEventListener('click', function () {
        setMsg('room-msg', 'Starting…');
        PokerNet.startGame().then(function () {
          setMsg('room-msg', '');
          showScreen('table');
        }).catch(function (err) {
          setMsg('room-msg', 'Could not start: ' + err.message, true);
        });
      });
      $('btn-copy-code').addEventListener('click', function () {
        var code = state.roomCode || $('room-code').textContent;
        var btn = this;
        function done() {
          btn.textContent = 'Copied';
          setTimeout(function () { btn.textContent = 'Copy'; }, 1400);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(code).then(done).catch(done);
        } else { done(); }
      });
      // Reattach to a room from a previous tab/session if one is saved.
      PokerNet.tryRejoin().then(function (session) {
        if (session && session.code) {
          state.mode = 'mp';
          state.roomCode = session.code;
          state.mySeat = session.seat;
          startMultiplayerHandlers();
          showScreen('room');
          setNetStatus('Room ' + session.code, true);
        }
      }).catch(function () { /* no saved session — stay in the lobby */ });
    } else {
      // No Supabase config: hide multiplayer, keep single-player.
      $('mp-block').classList.add('hidden');
      $('mp-note').classList.remove('hidden');
    }
  }

  // ======================================================================
  // Public seam object
  // ======================================================================

  var actionSink = null;

  var PokerApp = {
    /** Render any engine snapshot (local or from net.js). */
    renderSnapshot: renderSnapshot,

    /**
     * The single exit point for the local player's actions. Controls call
     * this; the active mode's handler (registered via setActionHandler)
     * receives { type, to? } in engine/net wire shape.
     */
    onLocalAction: function (action) {
      if (actionSink) actionSink(action);
    },

    /** Modes (and net integrations) register their action handler here. */
    setActionHandler: function (fn) { actionSink = fn; },

    /** Convenience for integrations: whose seat this client renders. */
    mySeat: function () { return state.mySeat; }
  };

  window.PokerApp = PokerApp;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
