/*
 * art.js — SVG art layer for the web poker game.
 *
 * Pure string builders: playing cards (vector suit pips), casino chip
 * stacks, the dealer button and player avatars. No DOM access and no game
 * state — every function returns an SVG string the caller drops into HTML.
 * This is the web sibling of CardArt.java; geometry, pip layouts and
 * colours mirror that file.
 *
 * Card encoding: card = suit * 13 + (rank - 2)
 *   suit: 0 = spades, 1 = hearts, 2 = diamonds, 3 = clubs
 *   rank: 2..10, 11 = J, 12 = Q, 13 = K, 14 = A
 *
 * Exposes window.PokerArt (also globalThis.PokerArt for node smoke tests).
 */
(function (global) {
  'use strict';

  // ======================================================================
  // Named constants
  // ======================================================================

  var SPADES = 0, HEARTS = 1, DIAMONDS = 2, CLUBS = 3;

  // ---- suit colours ----
  var SUIT_BLACK = '#23232E';
  var SUIT_RED = '#C0272D';

  // ---- card face / back ----
  var CARD_FACE_TOP = '#FFFFFF';
  var CARD_FACE_BOTTOM = '#EFF0F4';
  var CARD_EDGE = '#B9BCC6';
  var BACK_TOP = '#274E8F';
  var BACK_BOTTOM = '#12294D';
  var GOLD = '#C9A227';
  var GOLD_LIGHT = '#E9CE6B';
  var COURT_PANEL = '#FBF6E3';

  // ---- chips: denominations, highest first, with their colours ----
  var CHIP_VALUES = [500, 100, 25, 5, 1];
  var CHIP_COLORS = ['#7E2FA0', '#26262B', '#1B8540', '#C62832', '#F2F3F7'];
  var CHIP_BLUE = '#2B5FA6';            // stripes / print on the white $1 chip
  var CHIP_R = 25;                      // top-ellipse half width
  var CHIP_SQUASH = 0.40;               // top-ellipse height ratio
  var CHIP_STEP = 8;                    // stack height per chip
  var MAX_CHIPS_DRAWN = 18;

  var RANK_LABELS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  var FONT = "Arial, Helvetica, sans-serif";

  // Cards are drawn in a 100 x 140 viewBox (standard 5:7 card ratio).
  var CW = 100, CH = 140;

  var uidCounter = 0;
  function uid(prefix) { return prefix + (++uidCounter); }

  // ======================================================================
  // Small shared helpers
  // ======================================================================

  function hexRgb(hex) {
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16),
            parseInt(hex.slice(5, 7), 16)];
  }

  function lighten(hex, f) {
    var c = hexRgb(hex);
    return 'rgb(' + c.map(function (v) { return Math.round(v + (255 - v) * f); }).join(',') + ')';
  }

  function darken(hex, f) {
    var c = hexRgb(hex);
    return 'rgb(' + c.map(function (v) { return Math.round(v * (1 - f)); }).join(',') + ')';
  }

  /** "$1,250"-style formatting. */
  function money(amount) {
    var digits = String(Math.abs(Math.round(amount)));
    var out = '';
    for (var i = 0; i < digits.length; i++) {
      if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
      out += digits[i];
    }
    return (amount < 0 ? '-$' : '$') + out;
  }

  function rankOf(card) { return card % 13 + 2; }
  function suitOf(card) { return Math.floor(card / 13); }
  function rankLabel(card) { return RANK_LABELS[rankOf(card) - 2]; }
  function suitInk(suit) { return (suit === HEARTS || suit === DIAMONDS) ? SUIT_RED : SUIT_BLACK; }

  // ======================================================================
  // Vector suit shapes (unit space, ~1.0 tall, centred on origin)
  // Path data mirrors CardArt.suitPath exactly.
  // ======================================================================

  var SUIT_PATHS = {
    // diamonds: simple polygon
    2: 'M0,-0.5 L0.3,0 L0,0.5 L-0.3,0 Z',
    // hearts: two bezier lobes meeting at the bottom point
    1: 'M0,0.48 C-0.55,0.08 -0.50,-0.32 -0.26,-0.39 ' +
       'C-0.10,-0.44 0,-0.33 0,-0.19 C0,-0.33 0.10,-0.44 0.26,-0.39 ' +
       'C0.50,-0.32 0.55,0.08 0,0.48 Z',
    // spades: heart inverted (stem drawn separately)
    0: 'M0,-0.48 C-0.55,-0.08 -0.50,0.32 -0.26,0.39 ' +
       'C-0.10,0.44 0,0.33 0,0.19 C0,0.33 0.10,0.44 0.26,0.39 ' +
       'C0.50,0.32 0.55,-0.08 0,-0.48 Z'
  };
  var SPADE_STEM = '-0.13,0.30 0.13,0.30 0.27,0.52 -0.27,0.52';
  var CLUB_STEM = '-0.13,0.16 0.13,0.16 0.27,0.52 -0.27,0.52';
  var CLUB_LOBE_R = 0.215;

  /**
   * One suit glyph centred at (cx, cy) with the given height, as an SVG
   * group. flip=true rotates it 180 degrees (lower-half pips on real cards).
   */
  function suitGroup(cx, cy, size, suit, ink, flip) {
    var t = 'translate(' + cx + ' ' + cy + ') scale(' + size + ')' + (flip ? ' scale(1 -1)' : '');
    var inner;
    if (suit === CLUBS) {
      inner = '<circle cx="0" cy="-0.285" r="' + CLUB_LOBE_R + '"/>' +
              '<circle cx="-0.245" cy="0.185" r="' + CLUB_LOBE_R + '"/>' +
              '<circle cx="0.245" cy="0.185" r="' + CLUB_LOBE_R + '"/>' +
              '<polygon points="' + CLUB_STEM + '"/>';
    } else if (suit === SPADES) {
      inner = '<path d="' + SUIT_PATHS[0] + '"/><polygon points="' + SPADE_STEM + '"/>';
    } else {
      inner = '<path d="' + SUIT_PATHS[suit] + '"/>';
    }
    return '<g transform="' + t + '" fill="' + ink + '">' + inner + '</g>';
  }

  // ======================================================================
  // Cards
  // ======================================================================

  /** Rank label + small pip in one corner; flipped = rotated 180 degrees. */
  function cornerIndex(rank, suit, ink, flipped) {
    var label = RANK_LABELS[rank - 2];
    var cx = label.length > 1 ? 15 : 12.5;   // "10" needs a wider berth
    var g = '<text x="' + cx + '" y="21" font-family="' + FONT + '" font-size="19" ' +
            'font-weight="bold" fill="' + ink + '" text-anchor="middle">' + label + '</text>' +
            suitGroup(cx, CH * 0.245, CH * 0.115, suit, ink, false);
    return flipped ? '<g transform="rotate(180 50 70)">' + g + '</g>' : g;
  }

  /** Framed panel for J/Q/K: big letter over a suit pip, gold trim. */
  function courtPanel(rank, suit, ink) {
    return '<rect x="20" y="18.2" width="60" height="103.6" rx="7" fill="' + COURT_PANEL +
             '" stroke="' + GOLD + '" stroke-width="2"/>' +
           '<rect x="24" y="22.2" width="52" height="95.6" rx="5" fill="none" stroke="' +
             GOLD + '" stroke-width="1"/>' +
           '<text x="50" y="' + (CH * 0.40 + 17) + '" font-family="' + FONT + '" font-size="47" ' +
             'font-weight="bold" fill="' + ink + '" text-anchor="middle">' +
             RANK_LABELS[rank - 2] + '</text>' +
           suitGroup(50, CH * 0.70, CH * 0.26, suit, ink, false);
  }

  /**
   * Standard pip layouts for ranks 2-10. Positions are {column, row} pairs
   * in unit space mapped onto the card; lower-half pips are upside down.
   */
  function pipLayout(rank, suit, ink) {
    var L = 0.315, C = 0.50, R = 0.685;                    // pip columns
    var T = 0.185, U = 0.375, M = 0.50, D = 0.625, B = 0.815; // pip rows
    var layouts = {
      2:  [[C, T], [C, B]],
      3:  [[C, T], [C, M], [C, B]],
      4:  [[L, T], [R, T], [L, B], [R, B]],
      5:  [[L, T], [R, T], [C, M], [L, B], [R, B]],
      6:  [[L, T], [R, T], [L, M], [R, M], [L, B], [R, B]],
      7:  [[L, T], [R, T], [C, U], [L, M], [R, M], [L, B], [R, B]],
      8:  [[L, T], [R, T], [C, U], [L, M], [R, M], [C, D], [L, B], [R, B]],
      9:  [[L, T], [R, T], [L, U], [R, U], [C, M], [L, D], [R, D], [L, B], [R, B]],
      10: [[L, T], [R, T], [C, 0.28], [L, U], [R, U], [L, D], [R, D], [C, 0.72], [L, B], [R, B]]
    };
    var pips = layouts[rank] || [];
    var size = CH * 0.155;
    var out = '';
    for (var i = 0; i < pips.length; i++) {
      out += suitGroup(pips[i][0] * CW, pips[i][1] * CH, size, suit, ink, pips[i][1] > 0.5);
    }
    return out;
  }

  /** Patterned card back: gradient, diamond lattice, double frame, medallion. */
  function cardBackInner() {
    var patId = uid('lattice');
    var m = CW * 0.075;                                    // inner field margin
    var s = CH * 0.17;                                     // medallion size
    var cx = CW / 2, cy = CH / 2;
    return '<defs><pattern id="' + patId + '" width="14" height="14" ' +
             'patternUnits="userSpaceOnUse">' +
             '<path d="M0,14 L14,0 M-3.5,3.5 L3.5,-3.5 M10.5,17.5 L17.5,10.5" ' +
             'stroke="#FFFFFF" stroke-opacity="0.10" stroke-width="1"/>' +
             '<path d="M0,0 L14,14 M-3.5,10.5 L3.5,17.5 M10.5,-3.5 L17.5,3.5" ' +
             'stroke="#FFFFFF" stroke-opacity="0.10" stroke-width="1"/>' +
           '</pattern></defs>' +
           '<rect x="' + m + '" y="' + m + '" width="' + (CW - 2 * m) + '" height="' +
             (CH - 2 * m) + '" rx="6" fill="url(#' + patId + ')"/>' +
           '<rect x="' + m + '" y="' + m + '" width="' + (CW - 2 * m) + '" height="' +
             (CH - 2 * m) + '" rx="6" fill="none" stroke="#FFFFFF" stroke-opacity="0.82" ' +
             'stroke-width="1.2"/>' +
           '<rect x="' + (m + 3.5) + '" y="' + (m + 3.5) + '" width="' + (CW - 2 * m - 7) +
             '" height="' + (CH - 2 * m - 7) + '" rx="4" fill="none" stroke="' + GOLD +
             '" stroke-width="1"/>' +
           '<polygon points="' + cx + ',' + (cy - s) + ' ' + (cx + s * 0.7) + ',' + cy + ' ' +
             cx + ',' + (cy + s) + ' ' + (cx - s * 0.7) + ',' + cy + '" fill="none" stroke="' +
             GOLD + '" stroke-width="1.6"/>' +
           '<circle cx="' + cx + '" cy="' + cy + '" r="' + (s * 1.25) + '" fill="none" ' +
             'stroke="' + GOLD + '" stroke-width="1.6"/>';
  }

  /**
   * A full playing card as an inline SVG string (viewBox 0 0 100 140).
   * cardSVG(card) renders the face; cardSVG(card, {faceUp:false}) — or
   * cardBackSVG() — renders the patterned back.
   */
  function cardSVG(card, opts) {
    opts = opts || {};
    var faceUp = opts.faceUp !== false;
    var gid = uid('cardg');
    var body = '<rect x="0.7" y="0.7" width="' + (CW - 1.4) + '" height="' + (CH - 1.4) +
               '" rx="10" ';
    var defs = '', inner = '';
    if (faceUp) {
      var suit = suitOf(card), rank = rankOf(card), ink = suitInk(suit);
      defs = '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
             '<stop offset="0" stop-color="' + CARD_FACE_TOP + '"/>' +
             '<stop offset="1" stop-color="' + CARD_FACE_BOTTOM + '"/></linearGradient></defs>';
      inner = cornerIndex(rank, suit, ink, false) + cornerIndex(rank, suit, ink, true);
      if (rank >= 11 && rank <= 13) inner += courtPanel(rank, suit, ink);
      else if (rank === 14) inner += suitGroup(50, 70, CH * 0.52, suit, ink, false);
      else inner += pipLayout(rank, suit, ink);
      body += 'fill="url(#' + gid + ')" stroke="' + CARD_EDGE + '" stroke-width="1.4"/>';
    } else {
      defs = '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="1" y2="1">' +
             '<stop offset="0" stop-color="' + BACK_TOP + '"/>' +
             '<stop offset="1" stop-color="' + BACK_BOTTOM + '"/></linearGradient></defs>';
      inner = cardBackInner();
      body += 'fill="url(#' + gid + ')" stroke="' + CARD_EDGE + '" stroke-width="1.4"/>';
    }
    return '<svg viewBox="0 0 ' + CW + ' ' + CH + '" xmlns="http://www.w3.org/2000/svg" ' +
           'role="img" aria-label="' + (faceUp ? ariaLabel(card) : 'Card back') + '">' +
           defs + body + inner + '</svg>';
  }

  function cardBackSVG() { return cardSVG(0, { faceUp: false }); }

  function ariaLabel(card) {
    var names = ['Spades', 'Hearts', 'Diamonds', 'Clubs'];
    var r = rankOf(card);
    var rn = r === 14 ? 'Ace' : r === 13 ? 'King' : r === 12 ? 'Queen' : r === 11 ? 'Jack' : String(r);
    return rn + ' of ' + names[suitOf(card)];
  }

  // ======================================================================
  // Chips
  // ======================================================================

  /** Greedy denomination breakdown of an amount, highest first. */
  function chipBreakdown(amount) {
    var counts = [], rest = amount;
    for (var i = 0; i < CHIP_VALUES.length; i++) {
      counts[i] = Math.floor(rest / CHIP_VALUES[i]);
      rest -= counts[i] * CHIP_VALUES[i];
    }
    return counts;
  }

  /** One chip whose top face is centred at (cx, topY); denomIdx indexes CHIP_*. */
  function chipGroup(cx, topY, denomIdx) {
    var base = CHIP_COLORS[denomIdx];
    var r = CHIP_R, hh = r * CHIP_SQUASH;
    var isWhite = denomIdx === CHIP_VALUES.length - 1;
    var stripe = isWhite ? CHIP_BLUE : '#FFFFFF';
    var out = '';
    // Body (the chip's edge, visible because of the stack step).
    out += '<rect x="' + (cx - r) + '" y="' + topY + '" width="' + (2 * r) + '" height="' +
           CHIP_STEP + '" fill="' + darken(base, 0.25) + '"/>' +
           '<ellipse cx="' + cx + '" cy="' + (topY + CHIP_STEP) + '" rx="' + r + '" ry="' + hh +
           '" fill="' + darken(base, 0.25) + '"/>';
    // Top face.
    out += '<ellipse cx="' + cx + '" cy="' + topY + '" rx="' + r + '" ry="' + hh + '" fill="' +
           base + '" stroke="' + darken(base, 0.35) + '" stroke-width="1.2"/>';
    // Edge stripes: six blocks around the rim.
    for (var i = 0; i < 6; i++) {
      var a = Math.PI / 3 * i + Math.PI / 6;
      var sx = cx + Math.cos(a) * r * 0.86, sy = topY + Math.sin(a) * hh * 0.86;
      var deg = a * 180 / Math.PI + 90;
      out += '<rect x="-4.5" y="-2.2" width="9" height="4.4" fill="' + stripe +
             '" transform="translate(' + sx.toFixed(1) + ' ' + sy.toFixed(1) +
             ') rotate(' + deg.toFixed(1) + ')"/>';
    }
    // Inner ring + denomination on the face.
    out += '<ellipse cx="' + cx + '" cy="' + topY + '" rx="' + (r * 0.62) + '" ry="' +
           (hh * 0.62) + '" fill="none" stroke="' + lighten(base, 0.18) + '" stroke-width="1.4"/>' +
           '<text x="' + cx + '" y="' + (topY + 4.5) + '" font-family="' + FONT +
           '" font-size="12" font-weight="bold" fill="' + (isWhite ? CHIP_BLUE : '#FFFFFF') +
           '" text-anchor="middle">' + CHIP_VALUES[denomIdx] + '</text>';
    return out;
  }

  /**
   * A stack of casino chips totalling `amount`, as an inline SVG string.
   * $1 chips sit at the bottom, $500 on top (as in CardArt.drawChipStack);
   * the amount is labelled on a dark plaque underneath.
   */
  function chipStackSVG(amount) {
    if (!amount || amount <= 0) return '';
    var counts = chipBreakdown(amount);
    var total = 0, i;
    for (i = 0; i < counts.length; i++) total += counts[i];
    var drawn = Math.min(total, MAX_CHIPS_DRAWN);

    var W = 84, cx = W / 2, hh = CHIP_R * CHIP_SQUASH;
    var plaqueH = 20;
    var baseY = (drawn - 1) * CHIP_STEP + hh + 8;          // top-face centre of bottom chip
    var H = baseY + hh + 14 + plaqueH;

    var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" ' +
              'role="img" aria-label="' + money(amount) + ' in chips">';
    out += '<ellipse cx="' + cx + '" cy="' + (baseY + hh + 3) + '" rx="27" ry="5" ' +
           'fill="#000000" opacity="0.27"/>';
    // Paint from the bottom chip up; lowest denominations at the bottom.
    var level = 0;
    outer:
    for (var d = CHIP_VALUES.length - 1; d >= 0; d--) {
      for (var k = 0; k < counts[d]; k++) {
        if (level >= drawn) break outer;
        out += chipGroup(cx, baseY - level * CHIP_STEP, d);
        level++;
      }
    }
    // Amount plaque under the stack.
    var label = money(amount);
    var pw = label.length * 7.6 + 14;
    out += '<rect x="' + (cx - pw / 2) + '" y="' + (baseY + hh + 8) + '" width="' + pw +
           '" height="' + plaqueH + '" rx="9" fill="#000000" opacity="0.62"/>' +
           '<text x="' + cx + '" y="' + (baseY + hh + 8 + 14.5) + '" font-family="' + FONT +
           '" font-size="12.5" font-weight="bold" fill="#FFFFFF" text-anchor="middle">' +
           label + '</text>';
    return out + '</svg>';
  }

  // ======================================================================
  // Dealer button & avatars
  // ======================================================================

  /** White dealer button with a gold rim and a bold "D". */
  function dealerButtonSVG() {
    return '<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" role="img" ' +
           'aria-label="Dealer button">' +
           '<circle cx="20" cy="20" r="18.5" fill="#F7F5EE" stroke="' + GOLD +
           '" stroke-width="2"/>' +
           '<circle cx="20" cy="20" r="13.5" fill="none" stroke="' + GOLD_LIGHT +
           '" stroke-width="1.2"/>' +
           '<text x="20" y="27" font-family="' + FONT + '" font-size="19" font-weight="bold" ' +
           'fill="#2A2A33" text-anchor="middle">D</text></svg>';
  }

  /** Circular player avatar: gradient disc, pale rim, centred initials. */
  function avatarSVG(initials, baseColor) {
    var gid = uid('avatar');
    return '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" role="img" ' +
           'aria-label="Player ' + initials + '">' +
           '<defs><radialGradient id="' + gid + '" cx="0.35" cy="0.3" r="0.9">' +
           '<stop offset="0" stop-color="' + lighten(baseColor, 0.35) + '"/>' +
           '<stop offset="1" stop-color="' + darken(baseColor, 0.12) + '"/></radialGradient></defs>' +
           '<circle cx="32" cy="32" r="30" fill="url(#' + gid + ')"/>' +
           '<circle cx="32" cy="32" r="29" fill="none" stroke="#FFFFFF" stroke-opacity="0.86" ' +
           'stroke-width="2"/>' +
           '<circle cx="32" cy="32" r="23.5" fill="none" stroke="#FFFFFF" stroke-opacity="0.24" ' +
           'stroke-width="1.2"/>' +
           '<text x="32" y="40.5" font-family="' + FONT + '" font-size="23" font-weight="bold" ' +
           'fill="#FFFFFF" text-anchor="middle">' + initials + '</text></svg>';
  }

  // ======================================================================
  // Public API
  // ======================================================================

  var PokerArt = {
    SPADES: SPADES, HEARTS: HEARTS, DIAMONDS: DIAMONDS, CLUBS: CLUBS,
    RANK_LABELS: RANK_LABELS,
    CHIP_VALUES: CHIP_VALUES,
    money: money,
    rankOf: rankOf,
    suitOf: suitOf,
    rankLabel: rankLabel,
    suitInk: suitInk,
    cardSVG: cardSVG,
    cardBackSVG: cardBackSVG,
    chipStackSVG: chipStackSVG,
    chipBreakdown: chipBreakdown,
    dealerButtonSVG: dealerButtonSVG,
    avatarSVG: avatarSVG
  };

  global.PokerArt = PokerArt;
  if (typeof module !== 'undefined' && module.exports) module.exports = PokerArt;
})(typeof window !== 'undefined' ? window : globalThis);
