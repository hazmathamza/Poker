/*
 * engine.test.js - headless tests for the JS PokerEngine port.
 * Run with plain Node, no dependencies:  node engine.test.js
 *
 * Ports the Java SelfTest one-for-one: the same evaluator unit tests on the
 * same known hands, the same engine sanity checks, and the same 2,000-hand
 * AI-vs-AI simulation (seed 42, same personality mix) asserting exact chip
 * conservation after every hand. A final section adds snapshot checks for
 * the JS-only getSnapshot() contract (hole-card hiding / showdown reveal).
 */
'use strict';

const { PokerEngine, AiPlayer, HandEvaluator } = require('./engine.js');

const NUM_SEATS = PokerEngine.NUM_SEATS;
const STARTING_STACK = PokerEngine.STARTING_STACK;
const hand = PokerEngine.hand;

let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.log('  FAIL: ' + name);
  }
}

function greater(a, b) {
  return HandEvaluator.evaluate(a) > HandEvaluator.evaluate(b);
}

function equalScore(a, b) {
  return HandEvaluator.evaluate(a) === HandEvaluator.evaluate(b);
}

// ==========================================================================
// Evaluator tests (ported 1:1 from Java)
// ==========================================================================

function evaluatorTests() {
  console.log('== Evaluator tests ==');

  // Categories and names.
  check('royal flush category', HandEvaluator.categoryOf(HandEvaluator.evaluate(
    hand('As', 'Ks', 'Qs', 'Js', 'Ts', '2d', '3c'))) === HandEvaluator.CAT_STRAIGHT_FLUSH);
  check('royal flush name', HandEvaluator.categoryName(
    hand('As', 'Ks', 'Qs', 'Js', 'Ts', '2d', '3c')) === 'Royal Flush');
  check('straight flush name', HandEvaluator.categoryName(
    hand('9s', '8s', '7s', '6s', '5s')) === 'Straight Flush');
  check('quads name', HandEvaluator.categoryName(
    hand('9c', '9d', '9h', '9s', 'Ad')) === 'Four of a Kind');
  check('full house name', HandEvaluator.categoryName(
    hand('Ac', 'Ad', 'Ah', '2s', '2d')) === 'Full House');
  check('flush name', HandEvaluator.categoryName(
    hand('Ah', 'Kh', '9h', '6h', '3h')) === 'Flush');
  check('straight name', HandEvaluator.categoryName(
    hand('9c', '8d', '7h', '6s', '5c')) === 'Straight');
  check('trips name', HandEvaluator.categoryName(
    hand('Qc', 'Qd', 'Qh', '5s', '9d')) === 'Three of a Kind');
  check('two pair name', HandEvaluator.categoryName(
    hand('Ac', 'Ad', 'Kh', 'Ks', 'Qd')) === 'Two Pair');
  check('pair name', HandEvaluator.categoryName(
    hand('Ac', 'Ad', 'Kh', 'Qs', 'Jd')) === 'Pair');
  check('high card name', HandEvaluator.categoryName(
    hand('Ac', 'Kd', 'Qh', 'Js', '9d')) === 'High Card');

  // Category ordering.
  check('straight flush beats quads', greater(
    hand('9s', '8s', '7s', '6s', '5s', '2d', '3c'),
    hand('Ac', 'Ad', 'Ah', 'As', 'Kd', '2c', '3h')));
  check('full house beats flush', greater(
    hand('2c', '2d', '2h', '3s', '3d', '9c', 'Kh'),
    hand('Ah', 'Kh', '9h', '6h', '3h', '2c', '4d')));
  check('trips beat two pair', greater(
    hand('Qc', 'Qd', 'Qh', '5s', '9d'),
    hand('Ac', 'Ad', 'Kh', 'Ks', 'Qd')));

  // Straights, including the wheel.
  check('wheel is a straight', HandEvaluator.categoryOf(HandEvaluator.evaluate(
    hand('Ac', '2d', '3h', '4s', '5c', '9d', 'Kh'))) === HandEvaluator.CAT_STRAIGHT);
  check('wheel loses to 6-high straight', greater(
    hand('2c', '3d', '4h', '5s', '6c', '9d', 'Kh'),
    hand('Ac', '2d', '3h', '4s', '5c', '9d', 'Kh')));
  check('wheel straight flush loses to 6-high straight flush', greater(
    hand('2h', '3h', '4h', '5h', '6h', '9d', 'Kc'),
    hand('As', '2s', '3s', '4s', '5s', '9d', 'Kc')));
  check('7 cards pick the higher straight', greater(
    hand('9c', '5d', '6h', '7s', '8d', 'Tc', '2h'),
    hand('5d', '6h', '7s', '8d', '9c', '2h', '3d')));

  // Tie-breaks within a category.
  check('full house: trips rank decides', greater(
    hand('Ac', 'Ad', 'Ah', '2s', '2d'),
    hand('Kc', 'Kd', 'Kh', 'As', 'Ah')));
  check('full house: pair rank decides second', greater(
    hand('Ac', 'Ad', 'Ah', 'Ks', 'Kd'),
    hand('Ac', 'Ad', 'Ah', 'Qs', 'Qd')));
  check('two pair: kicker decides', greater(
    hand('Ac', 'Ad', 'Kh', 'Ks', 'Qd'),
    hand('Ac', 'Ad', 'Kh', 'Ks', 'Jd')));
  check('pair: third kicker decides', greater(
    hand('Ac', 'Ad', 'Kh', 'Qs', 'Jd'),
    hand('Ac', 'Ad', 'Kh', 'Qs', 'Td')));
  check('quads: kicker decides', greater(
    hand('9c', '9d', '9h', '9s', 'Ad'),
    hand('9c', '9d', '9h', '9s', 'Kd')));
  check('flush: high card decides', greater(
    hand('Ah', '9h', '6h', '4h', '2h'),
    hand('Kd', 'Qd', '9d', '6d', '4d')));
  check('high card: last kicker decides', greater(
    hand('Ac', 'Kd', 'Qh', 'Js', '9d'),
    hand('Ac', 'Kd', 'Qh', 'Js', '8d')));
  check('6 suited cards: flush uses top five', greater(
    hand('Ah', 'Kh', 'Qh', 'Jh', '9h', '8h', '2c'),
    hand('Ad', 'Kd', 'Qd', 'Jd', '8d')));

  // 7-card construction.
  check('two trips make a full house', HandEvaluator.categoryOf(HandEvaluator.evaluate(
    hand('Ac', 'Ad', 'Ah', 'Kc', 'Kd', 'Kh', '2s'))) === HandEvaluator.CAT_FULL_HOUSE);
  check('6-card hand evaluates (pair)', HandEvaluator.categoryOf(HandEvaluator.evaluate(
    hand('As', 'Ad', 'Kc', 'Qd', '7h', '2c'))) === HandEvaluator.CAT_PAIR);

  // Board plays: both players tie using only the board.
  check('royal on board splits', equalScore(
    hand('Ts', 'Js', 'Qs', 'Ks', 'As', '2d', '3c'),
    hand('Ts', 'Js', 'Qs', 'Ks', 'As', '7h', '8d')));
  check('straight on board splits', equalScore(
    hand('5c', '6d', '7h', '8s', '9d', '2c', '3h'),
    hand('5c', '6d', '7h', '8s', '9d', '2h', '4c')));

  // bestFive contents.
  const fh = HandEvaluator.bestFive(hand('As', 'Ad', 'Ah', 'Ks', 'Kd', '2c', '7d'));
  let aces = 0, kings = 0;
  for (const c of fh) {
    if (PokerEngine.rankOf(c) === 14) aces++;
    if (PokerEngine.rankOf(c) === 13) kings++;
  }
  check('bestFive of aces-full is AAA+KK', fh.length === 5 && aces === 3 && kings === 2);
  const wheel = HandEvaluator.bestFive(hand('As', '2d', '3h', '4c', '5s', '9d', 'Kc'));
  const seen = new Array(15).fill(false);
  for (const c of wheel) seen[PokerEngine.rankOf(c)] = true;
  check('bestFive of wheel is A-2-3-4-5',
    wheel.length === 5 && seen[14] && seen[2] && seen[3] && seen[4] && seen[5]);

  console.log('Evaluator: ' + passed + ' passed, ' + failed + ' failed');
}

// ==========================================================================
// Engine sanity tests (ported 1:1 from Java)
// ==========================================================================

function engineSanityTests() {
  console.log('== Engine sanity tests ==');
  const before = passed + failed;
  const e = new PokerEngine(7);
  e.startHand();
  check('blinds make a 30-chip pot', e.getPotTotal() === 30);
  check('chips conserved at hand start',
    e.getTotalStacks() + e.getPotTotal() === NUM_SEATS * STARTING_STACK);
  check('first button is seat 0', e.getButton() === 0);
  check('UTG (seat 3) acts first with 6 players', e.getCurrentActor() === 3);
  const la = e.getLegalActions(3);
  check('UTG faces a 20 call', la.canCall && la.callAmount === 20 && !la.canCheck);
  check('UTG min raise is 40', la.canRaise && la.minRaiseTo === 40);
  check('stage is preflop', e.getStage() === 'PREFLOP');
  console.log('Engine sanity: ' + (passed + failed - before) + ' checks, '
    + failed + ' failures so far');
}

// ==========================================================================
// Simulation (ported 1:1 from Java): chip conservation asserted per hand
// ==========================================================================

function simulationTest(hands) {
  console.log('== Simulation: ' + hands + ' AI-vs-AI hands ==');
  const e = new PokerEngine(42);
  e.setAutoRebuy(true);
  const mix = [
    'TIGHT_AGGRESSIVE', 'LOOSE_AGGRESSIVE', 'CALLING_STATION',
    'TIGHT_AGGRESSIVE', 'LOOSE_AGGRESSIVE', 'CALLING_STATION'
  ];
  for (let i = 0; i < NUM_SEATS; i++) e.setPersonality(i, mix[i]);

  let totalActions = 0;
  let showdowns = 0;
  for (let h = 0; h < hands; h++) {
    e.startHand();
    let guard = 0;
    while (!e.isHandComplete()) {
      const actor = e.getCurrentActor();
      if (actor === -1) {
        e.advanceStage();
      } else {
        const a = AiPlayer.decide(e, actor);
        e.applyAction(actor, a);   // throws if the AI ever acts illegally
        totalActions++;
      }
      if (++guard > 100000) throw new Error('Hand ' + h + ' did not terminate');
    }
    if (e.wasShowdown()) showdowns++;
    const expected = NUM_SEATS * STARTING_STACK + e.getTotalRebuyChips();
    if (e.getTotalStacks() !== expected) {
      throw new Error('Chip conservation violated after hand ' + h
        + ': stacks=' + e.getTotalStacks() + ' expected=' + expected);
    }
  }
  check('simulation completed all hands', true);
  console.log('Simulation: ' + hands + ' hands, ' + totalActions + ' actions, '
    + showdowns + ' showdowns, ' + (hands - showdowns) + ' won by folds, '
    + e.getRebuyCount() + ' rebuys, final total chips ' + e.getTotalStacks()
    + ' (expected ' + (NUM_SEATS * STARTING_STACK + e.getTotalRebuyChips()) + ')');
}

// ==========================================================================
// Snapshot tests (JS-only: the getSnapshot contract)
// ==========================================================================

function snapshotTests() {
  console.log('== Snapshot tests ==');
  const before = passed + failed;

  // Mid-hand: the viewer sees only their own cards; legal actions only on turn.
  const e = new PokerEngine(99);
  e.startHand();
  const viewer = 0;
  const snap = e.getSnapshot(viewer);
  check('snapshot is JSON-safe', !!JSON.parse(JSON.stringify(snap)));
  check('snapshot shows viewer their own hole cards',
    Array.isArray(snap.seats[viewer].hole) && snap.seats[viewer].hole.length === 2);
  let othersHidden = true;
  for (let i = 0; i < NUM_SEATS; i++) {
    if (i !== viewer && snap.seats[i].hole !== null) othersHidden = false;
  }
  check('snapshot hides every other seat\'s hole cards mid-hand', othersHidden);
  check('snapshot has no payouts mid-hand', snap.lastPayouts === null);
  check('snapshot legal actions match the actor',
    (snap.legalActions !== null) === (snap.currentActor === viewer));

  // Play a full hand with the AI driving every seat; then check reveal rules.
  let guard = 0;
  while (!e.isHandComplete()) {
    const actor = e.getCurrentActor();
    if (actor === -1) e.advanceStage();
    else e.applyAction(actor, AiPlayer.decide(e, actor));
    if (++guard > 100000) throw new Error('Snapshot hand did not terminate');
  }
  const endSnap = e.getSnapshot(viewer);
  check('snapshot has payouts once complete',
    Array.isArray(endSnap.lastPayouts) && endSnap.lastPayouts.length === NUM_SEATS);
  let revealOk = true;
  for (let i = 0; i < NUM_SEATS; i++) {
    if (i === viewer) continue;
    const seat = e.getSeats()[i];
    const revealed = endSnap.seats[i].hole !== null;
    const shouldReveal = endSnap.wasShowdown && !seat.folded;
    if (revealed !== shouldReveal) revealOk = false;
    if (revealed && typeof endSnap.seats[i].handName !== 'string') revealOk = false;
  }
  check('showdown reveals only non-folded opponents, with hand names', revealOk);

  console.log('Snapshot: ' + (passed + failed - before) + ' checks, '
    + failed + ' failures so far');
}

// ==========================================================================
// Runner
// ==========================================================================

evaluatorTests();
engineSanityTests();
simulationTest(2000);
snapshotTests();
console.log('TOTAL: ' + passed + ' passed, ' + failed + ' failed');
console.log(failed === 0 ? 'ALL TESTS PASSED' : 'TESTS FAILED: ' + failed);
process.exit(failed === 0 ? 0 : 1);
