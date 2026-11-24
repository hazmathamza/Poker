/*
 * PokerEngine (JavaScript port) - a complete, self-contained No-Limit Texas
 * Hold'em engine for the browser and Node. Faithful port of PokerEngine.java:
 * same card encoding, same evaluator semantics, same betting rules, same AI
 * personalities, and a java.util.Random-compatible RNG (identical sequences
 * for identical seeds).
 *
 * Structure (one responsibility per class, mirroring the Java original):
 *   - Card model + Deck        - integer-encoded cards, shuffle/deal.
 *   - HandEvaluator            - correct 5/6/7-card hand evaluation.
 *   - Action helpers, LegalActions factory, Seat factory, enums - data types.
 *   - PokerEngine              - the betting state machine: blinds, rounds,
 *                                min-raise rules, side pots, split pots,
 *                                uncalled-bet return, button rotation,
 *                                bust/rebuy handling, snapshots.
 *   - AiPlayer                 - personality-driven AI opponents (never illegal).
 *
 * Card encoding: card = suit * 13 + (rank - 2), suit 0=spades, 1=hearts,
 * 2=diamonds, 3=clubs; rank 2..14 (11=J, 12=Q, 13=K, 14=A).
 *
 * Actions are plain objects:
 *   {type:'fold'} {type:'check'} {type:'call'}
 *   {type:'raise', to: totalThisRound} {type:'allin'}
 *
 * Loaded as a classic browser script it exposes window.PokerEngine and
 * window.AiPlayer; under Node it fills module.exports.
 */
(function (global) {
'use strict';

// ==========================================================================
// Section: Table constants
// ==========================================================================

var NUM_SEATS      = 6;
var SMALL_BLIND    = 10;
var BIG_BLIND      = 20;
var STARTING_STACK = 1000;
var REBUY_STACK    = STARTING_STACK;

// ==========================================================================
// Section: Card model
// ==========================================================================

var SUIT_SPADES = 0, SUIT_HEARTS = 1, SUIT_DIAMONDS = 2, SUIT_CLUBS = 3;

/** Rank of a card: 2..14 (14 = Ace). */
function rankOf(card) { return card % 13 + 2; }

/** Suit of a card: 0=spades, 1=hearts, 2=diamonds, 3=clubs. */
function suitOf(card) { return Math.floor(card / 13); }

/** Builds a card from suit (0..3) and rank (2..14). */
function makeCard(suit, rank) { return suit * 13 + (rank - 2); }

/** Short display form, e.g. "As", "Td", "9c". */
function cardToString(card) {
  var ranks = '23456789TJQKA';
  var suits = 'shdc';
  return ranks.charAt(rankOf(card) - 2) + suits.charAt(suitOf(card));
}

/** Parses a two-character card string like "As" or "Td" (used by tests/tools). */
function parseCard(s) {
  var rank = '23456789TJQKA'.indexOf(s.charAt(0)) + 2;
  var suit = 'shdc'.indexOf(s.charAt(1));
  if (rank < 2 || suit < 0) throw new Error('Bad card: ' + s);
  return makeCard(suit, rank);
}

/** Convenience: builds a card array from strings, e.g. hand('As','Kd'). */
function hand() {
  var out = [];
  for (var i = 0; i < arguments.length; i++) out.push(parseCard(arguments[i]));
  return out;
}

// ==========================================================================
// Section: Random number generator (java.util.Random compatible)
// ==========================================================================

/**
 * Bit-exact reimplementation of java.util.Random's 48-bit LCG, including
 * nextInt(bound) rejection sampling and nextDouble(), so a JS game dealt
 * from a given seed matches the Java engine card for card. The 48-bit state
 * is held in a BigInt; the values returned are plain numbers.
 */
var RNG_MULTIPLIER = 0x5DEECE66Dn;
var RNG_ADDEND = 0xBn;
var RNG_MASK = (1n << 48n) - 1n;

function JavaRandom(seed) {
  var s = BigInt(Math.trunc(Number(seed)));
  this._state = (s ^ RNG_MULTIPLIER) & RNG_MASK;
}

JavaRandom.prototype._next = function (bits) {
  this._state = (this._state * RNG_MULTIPLIER + RNG_ADDEND) & RNG_MASK;
  return Number(this._state >> BigInt(48 - bits));
};

/** Integer in [0, bound), same algorithm (and sequence) as Java. */
JavaRandom.prototype.nextInt = function (bound) {
  if (bound <= 0) throw new Error('bound must be positive');
  if ((bound & -bound) === bound) {           // power of two
    return Number((BigInt(bound) * BigInt(this._next(31))) >> 31n);
  }
  var bits, val;
  do {
    bits = this._next(31);
    val = bits % bound;
  } while (((bits - val + (bound - 1)) | 0) < 0);   // Java int-overflow check
  return val;
};

/** Double in [0, 1), same construction as Java: (next(26)<<27 + next(27)) / 2^53. */
JavaRandom.prototype.nextDouble = function () {
  return (this._next(26) * 134217728 + this._next(27)) / 9007199254740992;
};

// ==========================================================================
// Section: Deck
// ==========================================================================

/** A standard 52-card deck with Fisher-Yates shuffle. */
function Deck() {
  this.cards = [];
  for (var i = 0; i < 52; i++) this.cards.push(i);
  this.pos = 0;
}

Deck.prototype.shuffle = function (rng) {
  for (var i = 51; i > 0; i--) {
    var j = rng.nextInt(i + 1);
    var t = this.cards[i]; this.cards[i] = this.cards[j]; this.cards[j] = t;
  }
  this.pos = 0;
};

Deck.prototype.deal = function () {
  if (this.pos >= 52) throw new Error('Deck exhausted');
  return this.cards[this.pos++];
};

Deck.prototype.remaining = function () { return 52 - this.pos; };

// ==========================================================================
// Section: Hand evaluation
// ==========================================================================

/**
 * Correct poker hand evaluator for 5, 6 or 7 cards.
 *
 * Scores are numbers that order exactly like real poker hands: category in
 * the high digits, then up to five tie-break ranks packed in base 16 (the
 * Java version uses a long; poker's maximum score is under 2^24, so a JS
 * number holds it exactly). The 5-card evaluator is exact; 6/7-card hands
 * take the best of all 5-card subsets (21 subsets max).
 */
var TIEBREAK_PLACE = 1 << 20; // 16^5

var HandEvaluator = {

  CAT_HIGH_CARD:       0,
  CAT_PAIR:            1,
  CAT_TWO_PAIR:        2,
  CAT_THREE_OF_A_KIND: 3,
  CAT_STRAIGHT:        4,
  CAT_FLUSH:           5,
  CAT_FULL_HOUSE:      6,
  CAT_FOUR_OF_A_KIND:  7,
  CAT_STRAIGHT_FLUSH:  8,

  CATEGORY_NAMES: [
    'High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight',
    'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'
  ],

  /** Category (0..8) encoded in a score returned by evaluate(). */
  categoryOf: function (score) {
    return Math.floor(score / TIEBREAK_PLACE);
  },

  /** Human-readable category name for a score ("Full House", "Royal Flush", ...). */
  categoryName: function (scoreOrCards) {
    if (Array.isArray(scoreOrCards)) return HandEvaluator.categoryName(HandEvaluator.evaluate(scoreOrCards));
    var score = scoreOrCards;
    var cat = HandEvaluator.categoryOf(score);
    if (cat === HandEvaluator.CAT_STRAIGHT_FLUSH) {
      var topTiebreak = Math.floor(score / (TIEBREAK_PLACE / 16)) % 16;
      if (topTiebreak === 14) return 'Royal Flush';
    }
    return HandEvaluator.CATEGORY_NAMES[cat];
  },

  /** Best achievable score over all 5-card subsets of cards (5-7 cards). */
  evaluate: function (cards) {
    if (cards.length < 5 || cards.length > 7) {
      throw new Error('evaluate needs 5-7 cards, got ' + cards.length);
    }
    var best = -1;
    var idx = [0, 1, 2, 3, 4];
    var five = new Array(5);
    while (true) {
      for (var i = 0; i < 5; i++) five[i] = cards[idx[i]];
      var s = HandEvaluator.evaluate5(five);
      if (s > best) best = s;
      if (!HandEvaluator._nextCombination(idx, cards.length)) break;
    }
    return best;
  },

  /** The actual best 5 cards (subset of the input) for cards (5-7 cards). */
  bestFive: function (cards) {
    if (cards.length < 5 || cards.length > 7) {
      throw new Error('bestFive needs 5-7 cards, got ' + cards.length);
    }
    var best = -1;
    var bestSet = null;
    var idx = [0, 1, 2, 3, 4];
    var five = new Array(5);
    while (true) {
      for (var i = 0; i < 5; i++) five[i] = cards[idx[i]];
      var s = HandEvaluator.evaluate5(five);
      if (s > best) { best = s; bestSet = five.slice(); }
      if (!HandEvaluator._nextCombination(idx, cards.length)) break;
    }
    return bestSet;
  },

  /** Exact evaluation of exactly 5 cards. */
  evaluate5: function (cs) {
    var rankCount = new Array(15).fill(0);
    var suitCount = new Array(4).fill(0);
    var i, r;
    for (i = 0; i < cs.length; i++) {
      rankCount[rankOf(cs[i])]++;
      suitCount[suitOf(cs[i])]++;
    }
    var flush = false;
    for (i = 0; i < 4; i++) if (suitCount[i] === 5) flush = true;

    // Distinct ranks, descending.
    var distinct = [];
    for (r = 14; r >= 2; r--) if (rankCount[r] > 0) distinct.push(r);
    var d = distinct.length;

    // Straight detection (wheel: A-2-3-4-5 has high card 5).
    var straightHigh = 0;
    if (d === 5) {
      if (distinct[0] - distinct[4] === 4) straightHigh = distinct[0];
      else if (distinct[0] === 14 && distinct[1] === 5) straightHigh = 5;
    }

    // Ranks grouped by (count desc, rank desc): the natural tie-break order
    // for pairs/trips/quads/full house (e.g. two pair -> [hiPair, loPair, kicker]).
    var grouped = distinct.slice();
    grouped.sort(function (a, b) {
      if (rankCount[b] !== rankCount[a]) return rankCount[b] - rankCount[a];
      return b - a;
    });

    var topCount = rankCount[grouped[0]];
    var secondCount = d > 1 ? rankCount[grouped[1]] : 0;

    var category, tiebreak;
    if (straightHigh > 0 && flush) {
      category = HandEvaluator.CAT_STRAIGHT_FLUSH;
      tiebreak = [straightHigh];
    } else if (topCount === 4) {
      category = HandEvaluator.CAT_FOUR_OF_A_KIND;
      tiebreak = grouped;
    } else if (topCount === 3 && secondCount === 2) {
      category = HandEvaluator.CAT_FULL_HOUSE;
      tiebreak = grouped;
    } else if (flush) {
      category = HandEvaluator.CAT_FLUSH;
      tiebreak = distinct;
    } else if (straightHigh > 0) {
      category = HandEvaluator.CAT_STRAIGHT;
      tiebreak = [straightHigh];
    } else if (topCount === 3) {
      category = HandEvaluator.CAT_THREE_OF_A_KIND;
      tiebreak = grouped;
    } else if (topCount === 2 && secondCount === 2) {
      category = HandEvaluator.CAT_TWO_PAIR;
      tiebreak = grouped;
    } else if (topCount === 2) {
      category = HandEvaluator.CAT_PAIR;
      tiebreak = grouped;
    } else {
      category = HandEvaluator.CAT_HIGH_CARD;
      tiebreak = distinct;
    }

    var score = category;
    for (i = 0; i < 5; i++) {
      score = score * 16 + (i < tiebreak.length ? tiebreak[i] : 0);
    }
    return score;
  },

  /** Advances a 5-of-n index combination; returns false when exhausted. */
  _nextCombination: function (idx, n) {
    for (var i = 4; i >= 0; i--) {
      if (idx[i] < n - 5 + i) {
        idx[i]++;
        for (var j = i + 1; j < 5; j++) idx[j] = idx[j - 1] + 1;
        return true;
      }
    }
    return false;
  }
};

// ==========================================================================
// Section: Core data types
// ==========================================================================

/** Betting streets. COMPLETE means no hand is currently running. */
var Stage = Object.freeze({
  PREFLOP: 'PREFLOP', FLOP: 'FLOP', TURN: 'TURN', RIVER: 'RIVER', COMPLETE: 'COMPLETE'
});

/**
 * AI personality profiles. Parameters:
 * betThreshold   - made-hand strength needed to bet when action is free;
 * raiseThreshold - strength needed to raise for value;
 * callMargin     - call when strength >= potOdds * callMargin (lower = calls lighter);
 * bluffFrequency - probability of bluffing with a weak hand in a given spot.
 */
var Personality = Object.freeze({
  TIGHT_AGGRESSIVE: Object.freeze({ name: 'TIGHT_AGGRESSIVE', betThreshold: 0.52, raiseThreshold: 0.72, callMargin: 1.10, bluffFrequency: 0.05 }),
  LOOSE_AGGRESSIVE: Object.freeze({ name: 'LOOSE_AGGRESSIVE', betThreshold: 0.42, raiseThreshold: 0.62, callMargin: 0.85, bluffFrequency: 0.13 }),
  CALLING_STATION:  Object.freeze({ name: 'CALLING_STATION',  betThreshold: 0.60, raiseThreshold: 0.88, callMargin: 0.55, bluffFrequency: 0.01 })
});

/** Action factories: the plain-object actions the engine consumes. */
var Action = {
  fold:  function () { return { type: 'fold' }; },
  check: function () { return { type: 'check' }; },
  call:  function () { return { type: 'call' }; },
  raiseTo: function (to) { return { type: 'raise', to: to }; },
  allIn: function () { return { type: 'allin' }; }
};

/** Normalizes an action object to an internal kind ('fold'|'check'|'call'|'raise'|'allin'). */
function actionKind(action) {
  if (!action || typeof action.type !== 'string') throw new Error('Unknown action ' + action);
  switch (action.type.toLowerCase()) {
    case 'fold': return 'fold';
    case 'check': return 'check';
    case 'call': return 'call';
    case 'raise': case 'raise_to': case 'raiseto': case 'raise-to': return 'raise';
    case 'allin': case 'all_in': case 'all-in': return 'allin';
    default: throw new Error('Unknown action ' + action.type);
  }
}

/** Creates a fresh LegalActions object (the legal moves for the player to act). */
function newLegalActions() {
  return {
    canFold: false,
    canCheck: false,
    canCall: false,
    canRaise: false,
    /** Chips needed to call, already capped by the player's stack (0 = no bet faced). */
    callAmount: 0,
    /** Smallest legal raise-to total for this round (may equal maxRaiseTo for a short all-in). */
    minRaiseTo: 0,
    /** Largest legal raise-to total (= current round bet + stack, i.e. all-in). */
    maxRaiseTo: 0
  };
}

/** Creates one seat's mutable state. */
function newSeat(name, personalityKey) {
  return {
    name: name,
    personality: personalityKey,   // a Personality key, e.g. 'TIGHT_AGGRESSIVE'
    stack: STARTING_STACK,
    /** Hole cards (array of 2) while a hand is running, otherwise null. */
    hole: null,
    inHand: false,       // dealt into the current hand
    folded: false,
    allIn: false,
    betThisRound: 0,     // chips committed on the current street
    totalCommitted: 0,   // chips committed over the whole hand
    // Internal betting-round bookkeeping (not part of snapshots).
    acted: false,
    raiseLocked: false   // faced only a short all-in raise after acting: may call/fold, not re-raise
  };
}

// ==========================================================================
// Section: Engine - the betting state machine
// ==========================================================================

function PokerEngine(seed) {
  var actualSeed = (seed === undefined || seed === null) ? Date.now() : seed;
  this.rng = new JavaRandom(actualSeed);
  this.deck = new Deck();
  this.seats = [];
  var defaults = [
    'TIGHT_AGGRESSIVE', 'LOOSE_AGGRESSIVE', 'CALLING_STATION',
    'TIGHT_AGGRESSIVE', 'LOOSE_AGGRESSIVE', 'CALLING_STATION'
  ];
  for (var i = 0; i < NUM_SEATS; i++) {
    this.seats.push(newSeat('Player ' + (i + 1), defaults[i]));
  }
  this.boardCards = [0, 0, 0, 0, 0];
  this.boardCount = 0;
  this.button = -1;
  this.stage = Stage.COMPLETE;
  this.handInProgress = false;
  this.currentBet = 0;        // highest betThisRound on the current street
  this.lastFullRaiseSize = 0; // size of the last full raise (drives min-raise)
  this.currentActor = -1;     // seat to act, or -1 when the round is over
  this.handNumber = 0;
  this.autoRebuy = true;
  this.rebuyCount = 0;
  this.totalRebuyChips = 0;
  this.lastPayouts = new Array(NUM_SEATS).fill(0);
  this.lastHandWasShowdown = false;
}

// --------------------------------------------------------------------------
// Hand setup: blinds, dealing, button rotation, rebuys
// --------------------------------------------------------------------------

/**
 * Starts a new hand: rebuys busted players (if enabled), rotates the button,
 * posts blinds, deals two cards to every player who has chips.
 * Throws if a hand is already running or fewer than two players can play.
 */
PokerEngine.prototype.startHand = function () {
  if (this.handInProgress) throw new Error('A hand is already in progress');
  var i, s;

  // Bust / rebuy handling: a player at zero is refilled before the hand.
  for (i = 0; i < NUM_SEATS; i++) {
    s = this.seats[i];
    if (s.stack === 0 && this.autoRebuy) {
      s.stack += REBUY_STACK;
      this.rebuyCount++;
      this.totalRebuyChips += REBUY_STACK;
    }
  }
  var players = 0;
  for (i = 0; i < NUM_SEATS; i++) if (this.seats[i].stack > 0) players++;
  if (players < 2) throw new Error('Need at least 2 players with chips');

  this.handNumber++;
  this.button = this._nextWithChips(this.button);
  this.deck.shuffle(this.rng);
  this.boardCount = 0;
  this.lastPayouts = new Array(NUM_SEATS).fill(0);
  this.lastHandWasShowdown = false;

  for (i = 0; i < NUM_SEATS; i++) {
    s = this.seats[i];
    s.inHand = s.stack > 0;
    s.folded = false;
    s.allIn = false;
    s.acted = false;
    s.raiseLocked = false;
    s.betThisRound = 0;
    s.totalCommitted = 0;
    s.hole = s.inHand ? [0, 0] : null;
  }
  // Deal two rounds, starting left of the button.
  for (var round = 0; round < 2; round++) {
    var seat = this.button;
    for (i = 0; i < NUM_SEATS; i++) {
      seat = (seat + 1) % NUM_SEATS;
      if (this.seats[seat].inHand) this.seats[seat].hole[round] = this.deck.deal();
    }
  }

  // Blinds. Heads-up: the button posts the small blind and acts first preflop.
  var sbSeat, bbSeat;
  if (players === 2) {
    sbSeat = this.button;
    bbSeat = this._nextWithChips(this.button);
  } else {
    sbSeat = this._nextWithChips(this.button);
    bbSeat = this._nextWithChips(sbSeat);
  }
  this._postBlind(sbSeat, SMALL_BLIND);
  this._postBlind(bbSeat, BIG_BLIND);
  this.currentBet = BIG_BLIND;              // the price to play, even if a short stack posted less
  this.lastFullRaiseSize = BIG_BLIND;
  for (i = 0; i < NUM_SEATS; i++) if (this.seats[i].allIn) this.seats[i].acted = true;

  this.stage = Stage.PREFLOP;
  this.handInProgress = true;
  var firstToAct = (players === 2) ? this.button : (bbSeat + 1) % NUM_SEATS;
  this.currentActor = this._findNextActor(firstToAct);
};

PokerEngine.prototype._postBlind = function (seat, blind) {
  var s = this.seats[seat];
  this._moveChips(s, Math.min(blind, s.stack));
};

/** Next seat clockwise (from `from`, exclusive) that has chips. */
PokerEngine.prototype._nextWithChips = function (from) {
  for (var i = 1; i <= NUM_SEATS; i++) {
    var s = (((from + i) % NUM_SEATS) + NUM_SEATS) % NUM_SEATS;
    if (this.seats[s].stack > 0) return s;
  }
  throw new Error('No player with chips');
};

/** Moves chips from a seat's stack into its bets; marks all-in at zero. */
PokerEngine.prototype._moveChips = function (s, amount) {
  var amt = Math.min(amount, s.stack);
  s.stack -= amt;
  s.betThisRound += amt;
  s.totalCommitted += amt;
  if (s.stack === 0) s.allIn = true;
};

// --------------------------------------------------------------------------
// Betting state machine
// --------------------------------------------------------------------------

/** Computes the legal actions for `seat` in the current state. */
PokerEngine.prototype.getLegalActions = function (seat) {
  var p = this.seats[seat];
  var la = newLegalActions();
  var toCall = this.currentBet - p.betThisRound;
  la.canFold = true;
  la.canCheck = toCall === 0;
  la.callAmount = Math.min(Math.max(toCall, 0), p.stack);
  la.canCall = toCall > 0 && p.stack > 0;
  la.maxRaiseTo = p.betThisRound + p.stack;
  // A raise needs chips beyond the call and must exceed the current bet.
  la.canRaise = !p.raiseLocked && p.stack > toCall && la.maxRaiseTo > this.currentBet;
  var fullMin = this.currentBet + this.lastFullRaiseSize;
  la.minRaiseTo = la.canRaise ? Math.min(fullMin, la.maxRaiseTo) : la.maxRaiseTo;
  return la;
};

/**
 * Applies an action ({type:'fold'|'check'|'call'|'raise'|'allin', to}) for
 * the seat currently to act. Throws if it is not the seat's turn or the
 * action is not legal in the current state.
 */
PokerEngine.prototype.applyAction = function (seat, action) {
  if (!this.handInProgress) throw new Error('No hand in progress');
  if (seat !== this.currentActor) {
    throw new Error("Not seat " + seat + "'s turn (actor is " + this.currentActor + ')');
  }
  var p = this.seats[seat];
  var la = this.getLegalActions(seat);
  var kind = actionKind(action);

  if (kind === 'fold') {
    p.folded = true;
  } else if (kind === 'check') {
    if (!la.canCheck) throw new Error('Cannot check facing a bet of ' + la.callAmount);
  } else if (kind === 'call') {
    if (!la.canCall) throw new Error('Nothing to call');
    this._moveChips(p, la.callAmount);
  } else if (kind === 'allin') {
    if (la.canRaise) {
      this._doRaise(p, la.maxRaiseTo);
    } else if (la.canCall) {
      this._moveChips(p, la.callAmount);
    } else {
      throw new Error('All-in not available here');
    }
  } else if (kind === 'raise') {
    this._validateRaise(la, action.to);
    this._doRaise(p, action.to);
  }
  p.acted = true;

  if (this._countRemaining() === 1) {          // everyone else folded
    this._finishHand(false);
    return;
  }
  this.currentActor = this._findNextActor((seat + 1) % NUM_SEATS);
};

PokerEngine.prototype._validateRaise = function (la, raiseTo) {
  if (!la.canRaise) throw new Error('Raising is not available here');
  if (raiseTo <= this.currentBet) {
    throw new Error('Raise to ' + raiseTo + ' does not exceed current bet ' + this.currentBet);
  }
  if (raiseTo > la.maxRaiseTo) {
    throw new Error('Raise to ' + raiseTo + ' exceeds stack (max ' + la.maxRaiseTo + ')');
  }
  var fullRaise = raiseTo >= this.currentBet + this.lastFullRaiseSize;
  if (!fullRaise && raiseTo !== la.maxRaiseTo) {
    throw new Error('Raise to ' + raiseTo + ' is below the minimum '
      + (this.currentBet + this.lastFullRaiseSize) + ' (only an all-in may be smaller)');
  }
};

/**
 * Executes a raise to `raiseTo` (a total for this round) by seat p.
 * A full raise reopens the betting; a short all-in raise does not - players
 * who already acted are then locked to call/fold.
 */
PokerEngine.prototype._doRaise = function (p, raiseTo) {
  var previousBet = this.currentBet;
  this._moveChips(p, raiseTo - p.betThisRound);
  this.currentBet = p.betThisRound;
  var increment = this.currentBet - previousBet;
  var i, s;
  if (increment >= this.lastFullRaiseSize) {
    this.lastFullRaiseSize = increment;
    for (i = 0; i < NUM_SEATS; i++) {
      s = this.seats[i];
      if (s !== p && s.inHand && !s.folded && !s.allIn) {
        s.acted = false;
        s.raiseLocked = false;
      }
    }
  } else {
    // Short all-in raise: betting is not reopened for players who acted.
    for (i = 0; i < NUM_SEATS; i++) {
      s = this.seats[i];
      if (s !== p && s.acted && s.inHand && !s.folded && !s.allIn) s.raiseLocked = true;
    }
  }
};

/** A seat must act if it is live, not all-in, and has not matched the current bet since the last raise. */
PokerEngine.prototype._needsToAct = function (seat) {
  var p = this.seats[seat];
  return p.inHand && !p.folded && !p.allIn
    && (!p.acted || p.betThisRound < this.currentBet);
};

/** First seat at or after `from` (clockwise) that must act, or -1 if the round is over. */
PokerEngine.prototype._findNextActor = function (from) {
  for (var i = 0; i < NUM_SEATS; i++) {
    var s = (from + i) % NUM_SEATS;
    if (this._needsToAct(s)) return s;
  }
  return -1;
};

PokerEngine.prototype._countRemaining = function () {
  var n = 0;
  for (var i = 0; i < NUM_SEATS; i++) {
    var s = this.seats[i];
    if (s.inHand && !s.folded) n++;
  }
  return n;
};

/**
 * Advances the game when the current betting round is complete
 * (getCurrentActor() === -1): deals the next street, or runs the showdown
 * after the river.
 */
PokerEngine.prototype.advanceStage = function () {
  if (!this.handInProgress) throw new Error('No hand in progress');
  if (this.currentActor !== -1) throw new Error('Betting round is not complete');
  if (this.stage === Stage.PREFLOP) {
    this.boardCards[this.boardCount++] = this.deck.deal();
    this.boardCards[this.boardCount++] = this.deck.deal();
    this.boardCards[this.boardCount++] = this.deck.deal();
    this.stage = Stage.FLOP;
    this._beginRound();
  } else if (this.stage === Stage.FLOP) {
    this.boardCards[this.boardCount++] = this.deck.deal();
    this.stage = Stage.TURN;
    this._beginRound();
  } else if (this.stage === Stage.TURN) {
    this.boardCards[this.boardCount++] = this.deck.deal();
    this.stage = Stage.RIVER;
    this._beginRound();
  } else if (this.stage === Stage.RIVER) {
    this._finishHand(true);
  } else {
    throw new Error('Cannot advance from stage ' + this.stage);
  }
};

/** Resets per-street betting state and finds the first actor (left of the button). */
PokerEngine.prototype._beginRound = function () {
  for (var i = 0; i < NUM_SEATS; i++) {
    var s = this.seats[i];
    s.betThisRound = 0;
    s.raiseLocked = false;
    s.acted = !(s.inHand && !s.folded && !s.allIn);
  }
  this.currentBet = 0;
  this.lastFullRaiseSize = BIG_BLIND;   // minimum opening bet is one big blind
  this.currentActor = this._findNextActor((this.button + 1) % NUM_SEATS);
};

// --------------------------------------------------------------------------
// Pot distribution: side pots, split pots, uncalled bets
// --------------------------------------------------------------------------

/**
 * Ends the hand and pays out all committed chips.
 *
 * Distribution uses commitment layers: for each distinct commitment level,
 * the chips in that layer go to the best hand among non-folded players who
 * committed at least that much. This yields correct side pots, and an
 * uncalled bet comes back automatically - the top layer above every other
 * player's commitment has exactly one eligible player, its owner. Split pots
 * divide evenly; odd chips go one at a time to the winners closest to the
 * left of the button.
 */
PokerEngine.prototype._finishHand = function (showdown) {
  this.lastHandWasShowdown = showdown;
  this.lastPayouts = new Array(NUM_SEATS).fill(0);

  var levelSet = {};
  var i, s;
  for (i = 0; i < NUM_SEATS; i++) {
    if (this.seats[i].totalCommitted > 0) levelSet[this.seats[i].totalCommitted] = true;
  }
  var levels = Object.keys(levelSet).map(Number).sort(function (a, b) { return a - b; });

  var prevLevel = 0;
  for (var li = 0; li < levels.length; li++) {
    var level = levels[li];
    var amount = 0;
    for (i = 0; i < NUM_SEATS; i++) {
      s = this.seats[i];
      amount += Math.min(s.totalCommitted, level) - Math.min(s.totalCommitted, prevLevel);
    }
    if (amount <= 0) { prevLevel = level; continue; }

    var eligible = [];
    for (i = 0; i < NUM_SEATS; i++) {
      s = this.seats[i];
      if (s.inHand && !s.folded && s.totalCommitted >= level) eligible.push(i);
    }
    if (eligible.length === 0) {
      // Defensive fallback (unreachable in legal play): the layer goes to
      // the live player with the largest commitment.
      var bestSeat = -1;
      for (i = 0; i < NUM_SEATS; i++) {
        s = this.seats[i];
        if (s.inHand && !s.folded
          && (bestSeat === -1 || s.totalCommitted > this.seats[bestSeat].totalCommitted)) bestSeat = i;
      }
      eligible.push(bestSeat);
    }

    var winners = showdown ? this._showdownWinners(eligible) : eligible;
    var share = Math.floor(amount / winners.length);
    var remainder = amount % winners.length;
    for (i = 0; i < winners.length; i++) this.lastPayouts[winners[i]] += share;
    var cursor = this.button;
    while (remainder > 0) {
      cursor = (cursor + 1) % NUM_SEATS;
      if (winners.indexOf(cursor) !== -1) { this.lastPayouts[cursor]++; remainder--; }
    }
    prevLevel = level;
  }

  for (i = 0; i < NUM_SEATS; i++) this.seats[i].stack += this.lastPayouts[i];
  this.handInProgress = false;
  this.stage = Stage.COMPLETE;
  this.currentActor = -1;
};

/** Best-hand seats among `eligible` at showdown (more than one on a tie). */
PokerEngine.prototype._showdownWinners = function (eligible) {
  var bestScore = -1;
  var scores = new Array(NUM_SEATS).fill(0);
  var boardCards = this.getBoard();
  for (var k = 0; k < eligible.length; k++) {
    var seat = eligible[k];
    var seven = [this.seats[seat].hole[0], this.seats[seat].hole[1]].concat(boardCards);
    scores[seat] = HandEvaluator.evaluate(seven);
    if (scores[seat] > bestScore) bestScore = scores[seat];
  }
  var winners = [];
  for (var j = 0; j < eligible.length; j++) {
    if (scores[eligible[j]] === bestScore) winners.push(eligible[j]);
  }
  return winners;
};

// --------------------------------------------------------------------------
// Read-only accessors (for a GUI or driver)
// --------------------------------------------------------------------------

PokerEngine.prototype.getSeat = function (seat) { return this.seats[seat]; };
PokerEngine.prototype.getSeats = function () { return this.seats; };
PokerEngine.prototype.getStage = function () { return this.stage; };
PokerEngine.prototype.isHandInProgress = function () { return this.handInProgress; };
PokerEngine.prototype.isHandComplete = function () { return !this.handInProgress; };
PokerEngine.prototype.getButton = function () { return this.button; };
PokerEngine.prototype.getCurrentActor = function () { return this.currentActor; };
PokerEngine.prototype.getCurrentBet = function () { return this.currentBet; };
PokerEngine.prototype.getHandNumber = function () { return this.handNumber; };
PokerEngine.prototype.getRebuyCount = function () { return this.rebuyCount; };
PokerEngine.prototype.getTotalRebuyChips = function () { return this.totalRebuyChips; };
PokerEngine.prototype.wasShowdown = function () { return this.lastHandWasShowdown; };
PokerEngine.prototype.getLastPayouts = function () { return this.lastPayouts.slice(); };
PokerEngine.prototype.getRandom = function () { return this.rng; };

/** Community cards dealt so far (0, 3, 4 or 5 cards). */
PokerEngine.prototype.getBoard = function () { return this.boardCards.slice(0, this.boardCount); };

/** Total chips committed by all players in the current hand (the pot). */
PokerEngine.prototype.getPotTotal = function () {
  var pot = 0;
  for (var i = 0; i < NUM_SEATS; i++) pot += this.seats[i].totalCommitted;
  return pot;
};

/** Sum of all stacks (chips not currently in the pot). */
PokerEngine.prototype.getTotalStacks = function () {
  var total = 0;
  for (var i = 0; i < NUM_SEATS; i++) total += this.seats[i].stack;
  return total;
};

PokerEngine.prototype.setAutoRebuy = function (autoRebuy) { this.autoRebuy = !!autoRebuy; };

PokerEngine.prototype.setPersonality = function (seat, p) {
  var key = (typeof p === 'string') ? p : (p && p.name);
  if (!Personality[key]) throw new Error('Unknown personality: ' + p);
  this.seats[seat].personality = key;
};

PokerEngine.prototype.setPlayerName = function (seat, name) { this.seats[seat].name = name; };

/**
 * JSON-safe snapshot of the full table state from one seat's point of view.
 *
 * The viewer's own hole cards are always included; every other seat's hole
 * cards are null except that, once a hand has ended in a showdown, the cards
 * of players who reached the showdown (did not fold) are revealed, together
 * with their hand's category name. legalActions is filled only when it is
 * the viewer's turn; lastPayouts only once the hand is complete.
 */
PokerEngine.prototype.getSnapshot = function (forSeat) {
  var showdownReveal = !this.handInProgress && this.lastHandWasShowdown;
  var board = this.getBoard();
  var seats = [];
  for (var i = 0; i < NUM_SEATS; i++) {
    var s = this.seats[i];
    var hole = null;
    var revealed = false;
    if (s.hole) {
      if (i === forSeat) { hole = s.hole.slice(); revealed = true; }
      else if (showdownReveal && !s.folded) { hole = s.hole.slice(); revealed = true; }
    }
    var snap = {
      name: s.name,
      stack: s.stack,
      betThisRound: s.betThisRound,
      totalCommitted: s.totalCommitted,
      folded: s.folded,
      allIn: s.allIn,
      inHand: s.inHand,
      hole: hole
    };
    if (revealed && showdownReveal) {
      snap.handName = HandEvaluator.categoryName([s.hole[0], s.hole[1]].concat(board));
    }
    seats.push(snap);
  }
  return {
    forSeat: (forSeat === undefined) ? null : forSeat,
    handNumber: this.handNumber,
    stage: this.stage,
    board: board,
    pot: this.getPotTotal(),
    currentBet: this.currentBet,
    button: this.button,
    currentActor: this.handInProgress ? this.currentActor : -1,
    seats: seats,
    legalActions: (this.handInProgress && forSeat !== undefined && forSeat !== null
        && this.currentActor === forSeat)
      ? this.getLegalActions(forSeat) : null,
    lastPayouts: this.handInProgress ? null : this.lastPayouts.slice(),
    wasShowdown: this.handInProgress ? false : this.lastHandWasShowdown
  };
};

// Static card helpers (mirroring the Java statics on PokerEngine).
PokerEngine.rankOf = rankOf;
PokerEngine.suitOf = suitOf;
PokerEngine.makeCard = makeCard;
PokerEngine.cardToString = cardToString;
PokerEngine.parseCard = parseCard;
PokerEngine.hand = hand;
PokerEngine.HandEvaluator = HandEvaluator;
PokerEngine.Personality = Personality;
PokerEngine.Stage = Stage;
PokerEngine.Action = Action;
PokerEngine.NUM_SEATS = NUM_SEATS;
PokerEngine.SMALL_BLIND = SMALL_BLIND;
PokerEngine.BIG_BLIND = BIG_BLIND;
PokerEngine.STARTING_STACK = STARTING_STACK;
PokerEngine.REBUY_STACK = REBUY_STACK;

// ==========================================================================
// Section: AI opponents
// ==========================================================================

/**
 * Personality-driven AI. Preflop it uses the Chen formula; postflop it uses
 * the evaluated made-hand strength plus simple draw awareness (flush draws
 * and straight draws add equity). Decisions are always validated against
 * LegalActions, so the AI can never produce an illegal action.
 */
var AiPlayer = {

  /** Returns a legal action object for `seat` in engine `e`. */
  decide: function (e, seat) {
    var rng = e.rng;
    var me = e.seats[seat];
    var per = Personality[me.personality];
    var la = e.getLegalActions(seat);
    var board = e.getBoard();

    var strength = (board.length === 0)
      ? AiPlayer.preflopStrength(me.hole[0], me.hole[1])
      : AiPlayer.postflopStrength(me.hole, board);
    var pot = e.getPotTotal();
    var call = la.callAmount;

    if (call === 0) {
      // Free action: bet with a good hand, occasionally bluff, else check.
      if (la.canRaise && (strength >= per.betThreshold
          || rng.nextDouble() < per.bluffFrequency * 0.6)) {
        return AiPlayer._raise(e, la, 0.7);
      }
      return Action.check();
    }

    var potOdds = call / (pot + call);
    // Value raise with a strong hand.
    if (la.canRaise && strength >= per.raiseThreshold && rng.nextDouble() < 0.85) {
      return AiPlayer._raise(e, la, 0.8);
    }
    // Bluff raise with a weak hand.
    if (la.canRaise && strength < 0.30 && rng.nextDouble() < per.bluffFrequency) {
      return AiPlayer._raise(e, la, 0.6);
    }
    // Call when the price is right for this personality.
    if (strength >= potOdds * per.callMargin) return Action.call();
    // Calling stations also defend cheap bets with almost anything.
    if (me.personality === 'CALLING_STATION' && call <= BIG_BLIND && strength >= 0.22) {
      return Action.call();
    }
    return Action.fold();
  },

  /** Builds a legal raise: pot-fraction sized, rounded, clamped to the legal range. */
  _raise: function (e, la, sizeFactor) {
    var target = e.currentBet + Math.round((e.getPotTotal() + la.callAmount) * sizeFactor);
    target = Math.floor((target + 5) / 10) * 10;   // round to nearest 10 for tidy bet sizes
    if (target >= la.maxRaiseTo) return Action.allIn();
    if (target < la.minRaiseTo) target = la.minRaiseTo;
    if (target <= e.currentBet) return la.callAmount > 0 ? Action.call() : Action.check();
    return Action.raiseTo(target);
  },

  /** Chen-formula preflop strength, normalized to roughly 0..1. */
  preflopStrength: function (c1, c2) {
    var r1 = rankOf(c1), r2 = rankOf(c2);
    var hi = Math.max(r1, r2), lo = Math.min(r1, r2);
    var score;
    switch (hi) {
      case 14: score = 10; break;
      case 13: score = 8;  break;
      case 12: score = 7;  break;
      case 11: score = 6;  break;
      default: score = hi / 2.0;
    }
    if (r1 === r2) {
      score = Math.max(5, score * 2);
    } else {
      if (suitOf(c1) === suitOf(c2)) score += 2;
      var gap = hi - lo - 1;
      if (gap === 1) score -= 1;
      else if (gap === 2) score -= 2;
      else if (gap === 3) score -= 4;
      else if (gap >= 4) score -= 5;
      if (gap <= 1 && hi < 12) score += 1;   // straight potential bonus
    }
    return AiPlayer._clamp(score / 20.0, 0.0, 1.0);
  },

  /** Made-hand strength (0..1) from the evaluator, plus draw bonuses. */
  postflopStrength: function (hole, board) {
    var all = hole.concat(board);
    var score = HandEvaluator.evaluate(all);
    var cat = HandEvaluator.categoryOf(score);
    var baseByCategory = [0.12, 0.32, 0.52, 0.66, 0.76, 0.82, 0.90, 0.96, 0.99];
    var strength = baseByCategory[cat];
    // Small within-category adjustment from the tie-break digits.
    var tiebreakFraction = (score % TIEBREAK_PLACE) / TIEBREAK_PLACE;
    strength += (tiebreakFraction - 0.5) * 0.06;

    if (board.length === 3 || board.length === 4) {
      var flop = board.length === 3;
      if (AiPlayer._hasFlushDraw(all))    strength += flop ? 0.11 : 0.06;
      if (AiPlayer._hasStraightDraw(all)) strength += flop ? 0.08 : 0.045;
    }
    return AiPlayer._clamp(strength, 0.02, 0.99);
  },

  /** Four cards of one suit among the given cards. */
  _hasFlushDraw: function (cards) {
    var suitCount = [0, 0, 0, 0];
    for (var i = 0; i < cards.length; i++) {
      if (++suitCount[suitOf(cards[i])] === 4) return true;
    }
    return false;
  },

  /** Some 5-rank window contains exactly 4 of the given ranks (open-ender or gutshot). */
  _hasStraightDraw: function (cards) {
    var present = new Array(15).fill(false);
    for (var i = 0; i < cards.length; i++) present[rankOf(cards[i])] = true;
    present[1] = present[14];   // ace also counts low
    for (var start = 1; start <= 10; start++) {
      var count = 0;
      for (var r = start; r < start + 5; r++) if (present[r]) count++;
      if (count === 4) return true;
    }
    return false;
  },

  _clamp: function (v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }
};

// ==========================================================================
// Section: Exports (UMD-lite)
// ==========================================================================

var api = {
  PokerEngine: PokerEngine,
  AiPlayer: AiPlayer,
  HandEvaluator: HandEvaluator,
  Personality: Personality,
  Stage: Stage,
  Action: Action,
  JavaRandom: JavaRandom,
  Deck: Deck,
  rankOf: rankOf,
  suitOf: suitOf,
  makeCard: makeCard,
  cardToString: cardToString,
  parseCard: parseCard,
  hand: hand,
  NUM_SEATS: NUM_SEATS,
  SMALL_BLIND: SMALL_BLIND,
  BIG_BLIND: BIG_BLIND,
  STARTING_STACK: STARTING_STACK,
  REBUY_STACK: REBUY_STACK
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
global.PokerEngine = PokerEngine;
global.AiPlayer = AiPlayer;
global.HandEvaluator = HandEvaluator;
global.Personality = Personality;

})(typeof window !== 'undefined' ? window : globalThis);
