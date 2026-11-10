/*! echo-music.js — YoEcho generative music (v1)
 *  brief -> composer (seeded, endless, rule-based) -> synth engine (Web Audio, no audio files).
 *  Public API: window.EchoMusic  (see the bottom of this file).
 *  Parts: 1 core+theory+recipes · 2 composer · 3 engine · 4 player+API.  ES5-style on purpose (old Android phones).
 */
(function (global) {
  "use strict";

  /* ═══════════════ 1. helpers ═══════════════ */
  function hashStr(s) { var h = 2166136261 >>> 0; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function makeRng(seed) {
    var a = (typeof seed === "string" ? hashStr(seed) : (seed >>> 0)) >>> 0;
    function r() { a = (a + 0x6D2B79F5) | 0; var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
    r.int = function (n) { return Math.floor(r() * n); };
    r.pick = function (arr) { return arr[Math.floor(r() * arr.length)]; };
    r.chance = function (p) { return r() < p; };
    r.range = function (lo, hi) { return lo + (hi - lo) * r(); };
    r.weighted = function (map) {
      var tot = 0, k; for (k in map) tot += Math.max(0, map[k]);
      if (tot <= 0) return Object.keys(map)[0];
      var x = r() * tot, last = null;
      for (k in map) { var w = Math.max(0, map[k]); if (w <= 0) continue; last = k; x -= w; if (x <= 0) return k; }
      return last;
    };
    return r;
  }
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function randomSeed() { return (Math.random() * 4294967296) >>> 0; }
  function seedToStr(n) { return (n >>> 0).toString(36); }
  function strToSeed(s) { var n = parseInt(String(s), 36); return isNaN(n) ? hashStr(String(s)) : (n >>> 0); }
  var NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

  /* ═══════════════ 2. theory ═══════════════ */
  var MODES = {
    ionian: [0, 2, 4, 5, 7, 9, 11], dorian: [0, 2, 3, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10],
    lydian: [0, 2, 4, 6, 7, 9, 11], mixolydian: [0, 2, 4, 5, 7, 9, 10], aeolian: [0, 2, 3, 5, 7, 8, 10]
  };
  var MODE_K = { ionian: 0, dorian: 1, phrygian: 2, lydian: 3, mixolydian: 4, aeolian: 5 };
  var MODE_LABEL = { ionian: "major", dorian: "dorian", phrygian: "phrygian", lydian: "lydian", mixolydian: "mixolydian", aeolian: "minor" };
  function isMinorMode(m) { return m === "aeolian" || m === "dorian" || m === "phrygian"; }
  /* semitones above the root for scale degree d (any integer, 0 = root, 7 = octave) */
  function degSemi(mode, d) { var o = Math.floor(d / 7), i = d - o * 7; return MODES[mode][i] + 12 * o; }
  /* the root that gives the SAME notes in another mode (so a key change is seamless) */
  function relativeRoot(root, fromMode, toMode) {
    var ion = ((root - MODES.ionian[MODE_K[fromMode]]) % 12 + 12) % 12;
    return (ion + MODES.ionian[MODE_K[toMode]]) % 12;
  }
  /* scale degrees that make up a chord built on degree d */
  function chordDegs(d, kind) {
    switch (kind) {
      case "power": return [d, d + 4, d + 7];
      case "7": return [d, d + 2, d + 4, d + 6];
      case "9": return [d, d + 2, d + 4, d + 6, d + 8];
      case "add9": return [d, d + 2, d + 4, d + 8];
      case "sus2": return [d, d + 1, d + 4];
      case "sus4": return [d, d + 3, d + 4];
      default: return [d, d + 2, d + 4];
    }
  }
  /* chord loops as scale-degree indexes (0 = I/i). Qualities fall out of the mode, so every chord is diatonic. */
  var PROGS = {
    ionian: [[0, 4, 5, 3], [0, 5, 3, 4], [0, 3, 4, 3], [5, 3, 0, 4], [0, 2, 3, 4], [1, 4, 0, 5], [0, 4, 3, 0], [3, 0, 4, 5]],
    mixolydian: [[0, 6, 3, 0], [0, 3, 6, 0], [0, 6, 0, 3], [0, 6, 3, 6]],
    lydian: [[0, 1, 0, 1], [0, 1, 4, 0], [0, 4, 1, 0], [0, 1, 5, 4]],
    aeolian: [[0, 5, 2, 6], [0, 3, 6, 2], [0, 6, 5, 6], [0, 3, 4, 0], [0, 5, 3, 6], [5, 6, 0, 2]],
    dorian: [[0, 3, 6, 0], [0, 6, 3, 0], [0, 3, 0, 6], [0, 1, 3, 0]],
    phrygian: [[0, 1, 0, 6], [0, 1, 6, 0], [0, 5, 6, 1], [0, 6, 5, 1]]
  };
  /* chord qualities as semitones above the chord root, for genres that need real chords (dominant 7ths, m7b5, power chords...) */
  var QUAL = { maj: [0, 4, 7], min: [0, 3, 7], "7": [0, 4, 7, 10], "9": [0, 4, 7, 10, 14], "13": [0, 4, 10, 14, 21], "7#9": [0, 4, 7, 10, 15], m7: [0, 3, 7, 10], m9: [0, 3, 7, 10, 14], m11: [0, 3, 7, 10, 14, 17],
               maj7: [0, 4, 7, 11], maj9: [0, 4, 7, 11, 14], "6": [0, 4, 7, 9], m6: [0, 3, 7, 9], m7b5: [0, 3, 6, 10], dim: [0, 3, 6, 9], "5": [0, 7, 12], sus4: [0, 5, 7], add9: [0, 4, 7, 14], "69": [0, 4, 7, 9, 14] };
  var QUPG = { "7": ["9", "13", "7"], m7: ["m9", "m11", "m7"], maj7: ["maj9", "maj7"], "6": ["69", "6"] };
  /* the scale a soloist plays over each chord quality */
  var QSCALE = { maj: [0, 2, 4, 5, 7, 9, 11], maj7: [0, 2, 4, 5, 7, 9, 11], maj9: [0, 2, 4, 5, 7, 9, 11], "6": [0, 2, 4, 5, 7, 9, 11], "69": [0, 2, 4, 5, 7, 9, 11],
                 "7": [0, 2, 4, 5, 7, 9, 10], "9": [0, 2, 4, 5, 7, 9, 10], "13": [0, 2, 4, 5, 7, 9, 10], "7#9": [0, 2, 4, 5, 7, 9, 10],
                 min: [0, 2, 3, 5, 7, 9, 10], m7: [0, 2, 3, 5, 7, 9, 10], m9: [0, 2, 3, 5, 7, 9, 10], m11: [0, 2, 3, 5, 7, 9, 10], m6: [0, 2, 3, 5, 7, 9, 10],
                 m7b5: [0, 1, 3, 5, 6, 8, 10], dim: [0, 2, 3, 5, 6, 8, 9], "5": [0, 2, 4, 5, 7, 9, 10], sus4: [0, 2, 4, 5, 7, 9, 10], add9: [0, 2, 4, 5, 7, 9, 11] };
  function absChord(rs, q) { return { d: 0, rs: ((rs % 12) + 12) % 12, q: q, kind: q, abs: QUAL[q] || QUAL.maj, degs: null }; }
  /* absolute MIDI notes for a list of degrees, shifted by octaves so their mean sits near `center` */
  function placeNotes(mode, root, degs, center, semis) {
    var n = semis ? semis.map(function (x) { return root + x; }) : degs.map(function (d) { return root + degSemi(mode, d); }), sum = 0, i;
    for (i = 0; i < n.length; i++) sum += n[i];
    var shift = Math.round((center - sum / n.length) / 12) * 12;
    return n.map(function (x) { return x + shift; });
  }
  /* voice-leading: pick the inversion that moves least from the previous chord and stays near `center` */
  function voiceChord(mode, root, degs, center, prev, maxSpread, semis) {
    var base = placeNotes(mode, root, degs, center, semis).sort(function (a, b) { return a - b; });
    var best = null, bestCost = 1e9, inv, i, cand, cost, mean;
    for (inv = 0; inv < base.length; inv++) {
      cand = base.slice();
      for (i = 0; i < inv; i++) cand[i] += 12;
      cand.sort(function (a, b) { return a - b; });
      mean = 0; for (i = 0; i < cand.length; i++) mean += cand[i]; mean /= cand.length;
      cost = Math.abs(mean - center) * 0.6;
      if (cand[cand.length - 1] - cand[0] > (maxSpread || 16)) cost += 20;
      if (prev && prev.length) {
        var m = Math.min(prev.length, cand.length);
        for (i = 0; i < m; i++) cost += Math.abs(cand[i] - prev[i]);
        cost += Math.abs(cand.length - prev.length) * 1.5;
      }
      if (cost < bestCost) { bestCost = cost; best = cand; }
    }
    return best;
  }
  function placeInRange(pc, lo, hi) { var m = lo + (((pc - lo) % 12) + 12) % 12; while (m > hi) m -= 12; return m; }

  /* ═══════════════ 3. recipes: moods, styles, instruments ═══════════════ */
  var MOOD_LIST = ["neutral", "joy", "hope", "sadness", "fear", "anger", "love", "confusion"];
  var RECIPES = {
    neutral:   { modes: ["dorian", "ionian", "aeolian"], bpm: [84, 100], energy: .42, bright: .5, space: .5, density: .45, grit: 0, ext: { "7": .35, tri: .35, add9: .3 }, arc: "wave",
                 styles: { lofi: .3, acoustic: .2, afrobeats: .18, amapiano: .1, house: .1, ambient: .07, rnb: .05, jazz: .1, pop: .1, funk: .06, hiphop: .06, reggae: .05 } },
    joy:       { modes: ["ionian", "mixolydian", "lydian"], bpm: [104, 124], energy: .82, bright: .85, space: .35, density: .7, grit: 0, ext: { tri: .6, add9: .25, "7": .15 }, arc: "groove",
                 styles: { afrobeats: .34, amapiano: .24, house: .2, acoustic: .1, lofi: .07, rnb: .05, rocknroll: .14, pop: .16, funk: .1, reggae: .08 } },
    hope:      { modes: ["ionian", "lydian", "dorian"], bpm: [84, 100], energy: .55, bright: .7, space: .6, density: .5, grit: 0, ext: { tri: .45, add9: .35, sus2: .1, "7": .1 }, arc: "story",
                 styles: { cinematic: .3, acoustic: .3, ambient: .08, afrobeats: .1, house: .08, rnb: .1, lofi: .04, pop: .18, rock: .08, reggae: .06 } },
    sadness:   { modes: ["aeolian", "dorian"], bpm: [58, 74], energy: .2, bright: .3, space: .85, density: .28, grit: 0, ext: { "7": .4, add9: .3, tri: .3 }, arc: "drift",
                 styles: { ambient: .3, lofi: .25, cinematic: .2, acoustic: .15, rnb: .1, blues: .15, jazz: .1 } },
    fear:      { modes: ["phrygian", "aeolian"], bpm: [66, 84], energy: .3, bright: .25, space: .8, density: .3, grit: 0, ext: { sus2: .3, tri: .3, "7": .2, sus4: .2 }, arc: "drift",
                 styles: { ambient: .5, cinematic: .35, acoustic: .15 } },
    anger:     { modes: ["phrygian", "aeolian"], bpm: [70, 76], energy: .9, bright: .4, space: .2, density: .8, grit: .6, ext: { power: .6, tri: .4 }, arc: "groove",
                 styles: { trap: .5, house: .2, cinematic: .2, afrobeats: .1, rock: .3, hiphop: .12 } },
    love:      { modes: ["ionian", "mixolydian", "dorian"], bpm: [68, 84], energy: .4, bright: .55, space: .65, density: .4, grit: 0, ext: { "7": .45, "9": .2, add9: .2, tri: .15 }, arc: "wave",
                 styles: { rnb: .4, acoustic: .25, lofi: .15, afrobeats: .1, cinematic: .1, jazz: .12, pop: .12, reggae: .08, blues: .06 } },
    confusion: { modes: ["dorian", "lydian"], bpm: [78, 92], energy: .35, bright: .5, space: .75, density: .4, grit: 0, ext: { sus2: .35, sus4: .25, "7": .2, "9": .2 }, arc: "drift",
                 styles: { ambient: .3, lofi: .3, acoustic: .2, cinematic: .2, jazz: .1 } },
    calm:      { modes: ["ionian", "lydian"], bpm: [56, 68], energy: .16, bright: .45, space: .9, density: .2, grit: 0, ext: { add9: .4, sus2: .3, tri: .3 }, arc: "drift",
                 styles: { ambient: .55, acoustic: .25, cinematic: .2 } }
  };
  var MOOD_WORDS = {
    neutral: [["Open", "Easy", "Plain", "Soft", "Slow"], ["Morning", "Window", "Road", "Table", "Hour"]],
    joy: [["Golden", "Bright", "Sun", "Wild", "Dancing"], ["Streets", "Light", "Parade", "Weekend", "Rhythm"]],
    hope: [["Rising", "First", "New", "Open", "Waking"], ["Light", "Horizon", "Morning", "Roads", "Season"]],
    sadness: [["Quiet", "Blue", "Hollow", "Slow", "Fading"], ["Rain", "Hours", "Letters", "Porch", "Tide"]],
    fear: [["Held", "Thin", "Still", "Low", "Dim"], ["Breath", "Hallway", "Ground", "Lanterns", "Dawn"]],
    anger: [["Iron", "Hard", "Burning", "Heavy", "Red"], ["Pulse", "Engine", "Weight", "Static", "Fire"]],
    love: [["Warm", "Close", "Honey", "Soft", "Slow"], ["Dance", "Evening", "Hands", "Glow", "Letters"]],
    confusion: [["Drifting", "Foggy", "Between", "Loose", "Wandering"], ["Maps", "Echoes", "Rooms", "Threads", "Tides"]],
    calm: [["Still", "Gentle", "Deep", "Soft", "Clear"], ["Water", "Breath", "Evening", "Garden", "Harbor"]]
  };
  /* mood journeys. "lift" starts where the person is and rises; "calm" settles; "match" stays put. */
  var LIFT = { sadness: ["sadness", "hope", "joy"], fear: ["fear", "calm", "hope"], anger: ["anger", "neutral", "hope"], confusion: ["confusion", "neutral", "hope"],
               neutral: ["neutral", "joy"], love: ["love", "joy"], hope: ["hope", "joy"], joy: ["joy"] };
  var CALMJ = { sadness: ["sadness", "calm"], fear: ["fear", "calm"], anger: ["anger", "neutral", "calm"], confusion: ["confusion", "calm"],
                neutral: ["neutral", "calm"], love: ["love", "calm"], hope: ["hope", "calm"], joy: ["joy", "neutral", "calm"] };

  /* instrument metadata: family (so lead and comp never share a timbre), brightness, loudness trim (calibrated by test) */
  var INSTR_META = {
    piano: { fam: "keys", b: .5 }, keys: { fam: "keys", b: .45 }, organ: { fam: "keys", b: .4 },
    guitar: { fam: "pluck", b: .5 }, pluck: { fam: "pluck", b: .5 },
    kalimba: { fam: "mallet", b: .7 }, marimba: { fam: "mallet", b: .55 }, bells: { fam: "mallet", b: .85 },
    strings: { fam: "sus", b: .5 }, pad: { fam: "sus", b: .4 }, choir: { fam: "sus", b: .35 },
    flute: { fam: "wind", b: .6 }, brass: { fam: "wind", b: .55 }, synth: { fam: "synth", b: .65 },
    sax: { fam: "reed", b: .5 }, violin: { fam: "bowed", b: .6 },
    eguitar: { fam: "pluck", b: .55 }, dguitar: { fam: "dist", b: .4 }, lguitar: { fam: "lead", b: .55 }, hammond: { fam: "keys", b: .4 }, horns: { fam: "wind", b: .6 }, clav: { fam: "keys", b: .7 }
  };
  /* instrument articulation: how much of the written length a note holds */
  var ARTIC = { dist: .8, lead: .93, keys: .85, pluck: .5, mallet: .5, sus: .96, wind: .92, synth: .8, reed: .93, bowed: .97 };

  /* styles: the rhythmic skeleton + instrument palette. Patterns are 16 steps (one bar of 16th notes). */
  var STYLE_LIST = ["afrobeats", "amapiano", "lofi", "house", "trap", "rnb", "ambient", "cinematic", "acoustic", "rocknroll", "rock", "blues", "jazz", "reggae", "funk", "pop", "hiphop"];
  var STYLES = {
    afrobeats: { name: "Afrobeats", level: 1.08, lay: .35, bpm: [96, 108], swing: .22, arc: "groove", harm: 1, drums: 2, kit: "afro", feel: "synco",
      drum: { kick: "x..x..x...x...x.", snare: "....x.......x...", clap: "....x.......x..x", hat: "x.xxx.x.x.xxx.x.", open: ".......x.......x", shaker: "xoxoxoxoxoxoxoxo", cLo: "..x...x...x..x..", cHi: "...x.x....x.x...", rim: "x..x..x.x..x..x.", rimV: .3 },
      comp: ["x..x..x...x..x..", "..x..x..x..x..x.", "x..x..x..x..x..."], bass: ["r..r..5...r..a..", "r..r..r...5..o..", "r.....r.r..5..a."], bassMax: 3,
      pal: { pad: ["strings", "pad"], comp: ["guitar", "keys", "marimba"], lead: ["kalimba", "flute", "sax", "guitar", "marimba"], arp: ["kalimba", "pluck"], bass: ["pluck", "sub"] },
      arp: { rate: 2, kind: "updown", gate: .8 }, duck: .22, delay: .22, tex: { vinyl: 0, rain: 0, air: 0 } },
    amapiano: { name: "Amapiano", level: 1.06, lay: .3, bpm: [108, 114], swing: .15, arc: "groove", harm: 2, drums: 2, kit: "afro", feel: "synco",
      drum: { kick: "x...x...x...x...", snare: "", clap: "....x.......x...", hat: "x.oxo.xox.oxo.xo", open: "..x...x...x...x.", shaker: "xoxoxoxoxoxoxoxo", cLo: "", cHi: "" },
      comp: ["x..x..x...x..x.x", "..x..x..x..x.x..", "x.....x..x.x...."], bass: ["r..r..r...r..5..", "r.....5.r..r.o..", "r..r.....r..a.5."], bassMax: 3,
      pal: { pad: ["pad", "strings"], comp: ["piano", "keys"], lead: ["piano", "sax", "flute", "kalimba", "synth"], arp: ["bells", "pluck"], bass: ["log", "sub"] },
      arp: { rate: 2, kind: "alberti", gate: .7 }, duck: .3, delay: .15, tex: { vinyl: 0, rain: 0, air: 0 } },
    lofi: { name: "Lo-fi", level: 1.06, lay: .9, wobble: .0011, bpm: [70, 86], swing: .55, arc: "wave", harm: 1, drums: 2, kit: "lofi", feel: "sparse",
      drum: { kick: "x.....x...x.....", snare: "....x.......x...", clap: "", hat: "x.x.x.x.x.x.x.x.", open: ".......x.......x", shaker: "", cLo: "", cHi: "" },
      comp: ["x.....x...x.....", "x..x....x.......", "x.....x.....x..."], bass: ["r.......r.....5.", "r.....r...5.....", "r.......5.r....."], bassMax: 6,
      pal: { pad: ["pad", "strings"], comp: ["keys", "piano", "guitar"], lead: ["keys", "sax", "guitar", "kalimba", "flute"], arp: ["kalimba", "bells"], bass: ["sub", "pluck"] },
      arp: { rate: 2, kind: "up", gate: .45 }, duck: .12, delay: .3, tex: { vinyl: .35, rain: .08, air: 0 } },
    house: { name: "House", level: 0.85, lay: 0, bpm: [120, 126], swing: .04, arc: "groove", harm: 1, drums: 2, kit: "edm", feel: "straight",
      drum: { kick: "x...x...x...x...", snare: "", clap: "....x.......x...", hat: "xoxoxoxoxoxoxoxo", open: "..x...x...x...x.", shaker: "", cLo: "", cHi: "" },
      comp: ["..x...x...x...x.", "x..x..x...x..x..", "..x...x..x..x..."], bass: ["..r...r...r...r.", "..r...r...r..5r.", ".r..r..r.r..r.5."], bassMax: 2,
      pal: { pad: ["pad", "strings"], comp: ["organ", "piano", "keys"], lead: ["synth", "bells", "pluck"], arp: ["pluck", "synth"], bass: ["synthbass", "sub"] },
      arp: { rate: 1, kind: "up", gate: .75 }, duck: .5, delay: .25, tex: { vinyl: 0, rain: 0, air: 0 } },
    trap: { name: "Trap", level: 1.25, lay: .15, bpm: [68, 76], swing: 0, arc: "groove", harm: 2, drums: 2, kit: "trap", feel: "sparse",
      drum: { kick: "x.....x..x.x....", snare: "........x.......", clap: "........x.......", hat: "x.x.x.x.x.x.x.x.", open: ".......x.......x", shaker: "", cLo: "", cHi: "" },
      comp: ["x.......x.......", "x.....x.........", "x.......x..x...."], bass: ["r.....r..r.r....", "r.......r.....5.", "r..r......r..a.."], bassMax: 8,
      pal: { pad: ["pad", "choir"], comp: ["keys", "bells", "piano"], lead: ["bells", "flute", "synth", "kalimba"], arp: ["bells", "pluck"], bass: ["808"] },
      arp: { rate: 2, kind: "rand", gate: .5 }, duck: .1, delay: .28, rolls: true, tex: { vinyl: 0, rain: 0, air: .1 } },
    rnb: { name: "R&B", level: 1.24, lay: .8, wobble: .0004, bpm: [68, 84], swing: .35, arc: "wave", harm: 2, drums: 2, kit: "lofi", feel: "smooth",
      drum: { kick: "x.....x...x.....", snare: "........x.......", clap: "........x.......", hat: "x.x.x.x.x.x.x.x.", open: "", shaker: "", cLo: "", cHi: "" },
      comp: ["x.....x.x.......", "x..x....x..x....", "x.......x.x....."], bass: ["r.....r.......5.", "r.......r..5....", "r..r....r......."], bassMax: 6,
      pal: { pad: ["strings", "pad"], comp: ["keys", "guitar", "piano"], lead: ["guitar", "sax", "keys", "violin", "flute", "strings"], arp: ["bells", "kalimba"], bass: ["sub", "808"] },
      arp: { rate: 2, kind: "up", gate: .4 }, duck: .1, delay: .25, tex: { vinyl: .12, rain: 0, air: 0 } },
    ambient: { name: "Ambient", level: 1.15, lay: .2, bpm: [58, 72], swing: 0, arc: "drift", harm: 2, drums: 0, kit: "heavy", feel: "sparse",
      drum: { kick: "", snare: "", clap: "", hat: "", open: "", shaker: "", cLo: "", cHi: "" },
      comp: ["x...............", "x.......x......."], bass: ["r..............."], bassMax: 16,
      pal: { pad: ["pad", "choir", "strings"], comp: ["piano", "bells", "kalimba"], lead: ["flute", "violin", "bells", "piano"], arp: ["bells", "kalimba"], bass: ["sub"] },
      arp: { rate: 4, kind: "rand", gate: .45 }, duck: 0, delay: .35, tex: { vinyl: 0, rain: .22, air: .3 } },
    cinematic: { name: "Cinematic", level: 1.16, lay: .2, bpm: [70, 90], swing: 0, arc: "story", harm: 2, drums: 1, kit: "heavy", feel: "sparse",
      drum: { kick: "x...............", snare: "", clap: "", hat: "", open: "", shaker: "", cLo: "", cHi: "", tom: "........x......." },
      comp: ["x...............", "x.......x......."], bass: ["r...............", "r.......r......."], bassMax: 16,
      pal: { pad: ["strings", "choir", "pad"], comp: ["piano", "strings"], lead: ["violin", "strings", "flute", "brass", "piano"], arp: ["piano", "bells", "pluck"], bass: ["sub", "808"] },
      arp: { rate: 2, kind: "updown", gate: .6 }, duck: 0, delay: .2, tex: { vinyl: 0, rain: 0, air: .3 } },
    acoustic: { name: "Acoustic", level: 1.0, lay: .5, bpm: [80, 100], swing: .15, arc: "wave", harm: 1, drums: 1, kit: "lofi", feel: "medium", pick: true,
      drum: { kick: "x.......x.......", snare: "", clap: "", hat: "", open: "", shaker: "x.x.x.x.x.x.x.x.", cLo: "", cHi: "", rim: "....x.......x..." },
      comp: ["0.2.3.2.1.2.3.2.", "0.1.2.3.2.1.2.3.", "0..2.3..1.2.3.2."], bass: ["r.......5.......", "r.....r.5......."], bassMax: 6,
      pal: { pad: ["strings", "pad"], comp: ["guitar", "piano"], lead: ["flute", "violin", "guitar", "kalimba", "piano"], arp: ["guitar", "kalimba"], bass: ["pluck", "sub"] },
      arp: { rate: 2, kind: "alberti", gate: .6 }, duck: 0, delay: .2, tex: { vinyl: 0, rain: 0, air: .08 } },

    /* ── band genres: real chords, real grooves, instruments that belong together ── */
    rocknroll: { name: "Rock and Roll", firm: 1, level: 1.12, lay: .5, bpm: [138, 152], swing: 0, swing8: .55, arc: "song", harm: 1, drums: 2, kit: "rnr", feel: "shuffle", leadGen: "blues",
      drum: { kick: "x.......x.......", snare: "....x.......x...", clap: "", hat: "x.x.x.x.x.x.x.x.", open: "", shaker: "", cLo: "", cHi: "", tamb: "x...x...x...x..." },
      comp: ["x.x.x.x.x.x.x.x.", "x...x...x...x...", "x..x..x.x..x..x."], compGen: ["chuck", "chuck", "pat"], bass: ["r.......5.......", "r...r...5...r..."], bassGen: ["boogie", "boogie", "walk", "rootfifth"], bassMax: 4,
      pal: { pad: ["hammond"], comp: ["eguitar", "piano"], lead: ["lguitar", "sax", "piano"], arp: ["horns"], bass: ["upbass", "ebass"] },
      bands: [ { pad: "hammond", comp: "eguitar", lead: "lguitar", arp: null, bass: "upbass", ans: "sax" }, { pad: null, comp: "piano", lead: "sax", arp: "horns", bass: "upbass", ans: "lguitar" },
               { pad: "hammond", comp: "eguitar", lead: "piano", arp: "horns", bass: "ebass", ans: "lguitar" }, { pad: null, comp: "piano", lead: "lguitar", arp: null, bass: "upbass", ans: "sax" } ],
      stab: ["x.......x.......", "x..x....x..x....", "x...x...x...x..."],
      progs: [ { m: "mixolydian", seq: [[0,"7"],[0,"7"],[0,"7"],[0,"7"],[5,"7"],[5,"7"],[0,"7"],[0,"7"],[7,"7"],[5,"7"],[0,"7"],[7,"7"]] },
               { m: "mixolydian", seq: [[0,"7"],[5,"7"],[0,"7"],[0,"7"],[5,"7"],[5,"7"],[0,"7"],[0,"7"],[7,"7"],[5,"7"],[0,"7"],[7,"7"]] },
               { m: "mixolydian", seq: [[0,"7"],[7,"7"],[5,"7"],[5,"7"],[0,"7"],[7,"7"],[0,"7"],[7,"7"]] },
               { m: "ionian", seq: [[0,"maj"],[9,"min"],[5,"maj"],[7,"7"]] }, { m: "ionian", seq: [[0,"6"],[5,"maj"],[0,"6"],[7,"7"]] } ],
      scales: { mixolydian: [0, 3, 4, 5, 7, 9, 10], ionian: [0, 2, 3, 4, 7, 9] }, duck: 0, delay: .12, tex: { vinyl: .12, rain: 0, air: 0 } },
    rock: { name: "Rock", firm: 1, level: 1.1, lay: .3, bpm: [112, 138], swing: 0, swing8: 0, arc: "song", harm: 1, drums: 2, kit: "rock", feel: "straight", leadGen: "",
      drum: { kick: "x.......x.x.....", snare: "....x.......x...", clap: "", hat: "x.x.x.x.x.x.x.x.", open: "..............x.", shaker: "", cLo: "", cHi: "" },
      comp: ["x...x...x...x...", "x.xxx.xxx.xxx.xx", "x.x.x.x.x.x.x.x."], compGen: ["power", "riff", "power", "riff"], bass: ["r.r.r.r.r.r.r.r.", "r...r...r...r..."], bassGen: ["root8", "root8", "rootfifth"], bassMax: 2,
      pal: { pad: ["hammond", "strings"], comp: ["dguitar"], lead: ["lguitar"], arp: ["eguitar"], bass: ["ebass"] },
      bands: [ { pad: null, comp: "dguitar", lead: "lguitar", arp: null, bass: "ebass", ans: null }, { pad: "hammond", comp: "dguitar", lead: "lguitar", arp: "eguitar", bass: "ebass", ans: "eguitar" },
               { pad: "strings", comp: "dguitar", lead: "lguitar", arp: null, bass: "ebass", ans: "hammond" }, { pad: null, comp: "eguitar", lead: "lguitar", arp: null, bass: "ebass", ans: "hammond" } ],
      progs: [ { m: "mixolydian", seq: [[0,"5"],[10,"5"],[5,"5"],[0,"5"]] }, { m: "aeolian", seq: [[0,"5"],[8,"5"],[10,"5"],[0,"5"]] }, { m: "aeolian", seq: [[0,"5"],[10,"5"],[8,"5"],[10,"5"]] },
               { m: "ionian", seq: [[0,"5"],[7,"5"],[9,"5"],[5,"5"]] }, { m: "ionian", seq: [[9,"5"],[5,"5"],[0,"5"],[7,"5"]] }, { m: "ionian", seq: [[0,"5"],[5,"5"],[7,"5"],[5,"5"]] },
               { m: "mixolydian", seq: [[0,"5"],[3,"5"],[5,"5"],[0,"5"]] }, { m: "aeolian", seq: [[0,"5"],[3,"5"],[10,"5"],[5,"5"]] } ],
      scales: { mixolydian: [0, 2, 4, 7, 9, 10], ionian: [0, 2, 4, 7, 9], aeolian: [0, 3, 5, 7, 10] }, duck: 0, delay: .15, tex: { vinyl: 0, rain: 0, air: 0 } },
    blues: { name: "Blues", firm: 1, level: 1.15, lay: .8, bpm: [68, 94], swing: 0, swing8: .75, arc: "song", harm: 1, drums: 2, kit: "rnr", feel: "shuffle", leadGen: "blues",
      drum: { kick: "x.......x.......", snare: "....x.......x...", clap: "", hat: "x.x.x.x.x.x.x.x.", open: "", shaker: "", cLo: "", cHi: "" },
      comp: ["x.x.x.x.x.x.x.x.", "x.......x.......", "x..x....x..x...."], compGen: ["chuck", "pat", "pat"], bass: ["r.......5.......", "r.....r.5.....5."], bassGen: ["boogie", "boogie", "walk"], bassMax: 4,
      pal: { pad: ["hammond"], comp: ["eguitar", "piano"], lead: ["lguitar", "sax"], arp: [], bass: ["upbass", "ebass"] },
      bands: [ { pad: "hammond", comp: "eguitar", lead: "lguitar", arp: null, bass: "ebass", ans: null }, { pad: null, comp: "piano", lead: "lguitar", arp: null, bass: "upbass", ans: "sax" },
               { pad: "hammond", comp: "eguitar", lead: "sax", arp: null, bass: "upbass", ans: "lguitar" }, { pad: "hammond", comp: "piano", lead: "lguitar", arp: "horns", bass: "ebass", ans: null } ],
      stab: ["x.......x.......", "x..x............"],
      progs: [ { m: "mixolydian", seq: [[0,"7"],[0,"7"],[0,"7"],[0,"7"],[5,"7"],[5,"7"],[0,"7"],[0,"7"],[7,"7"],[5,"7"],[0,"7"],[7,"7"]] },
               { m: "mixolydian", seq: [[0,"9"],[5,"7"],[0,"9"],[0,"7"],[5,"7"],[5,"7"],[0,"9"],[9,"7"],[2,"m7"],[7,"7"],[0,"7"],[7,"7"]] },
               { m: "dorian", seq: [[0,"m7"],[0,"m7"],[0,"m7"],[0,"m7"],[5,"m7"],[5,"m7"],[0,"m7"],[0,"m7"],[8,"7"],[7,"7"],[0,"m7"],[7,"7"]] },
               { m: "mixolydian", seq: [[0,"7"],[7,"7"],[5,"7"],[5,"7"],[0,"7"],[7,"7"],[0,"7"],[7,"7"]] } ],
      scales: { mixolydian: [0, 3, 5, 6, 7, 10], dorian: [0, 3, 5, 6, 7, 10] }, duck: 0, delay: .18, tex: { vinyl: .1, rain: 0, air: 0 } },
    jazz: { name: "Jazz", firm: 1, level: 1.2, lay: .9, wobble: .0004, bpm: [100, 142], swing: 0, swing8: .8, arc: "jazz", harm: 1, drums: 2, kit: "jazz", feel: "swing", leadGen: "bebop", drumGen: "jazz", rootless: true,
      drum: { kick: "x...............", snare: "", clap: "", hat: "", open: "", shaker: "", cLo: "", cHi: "", ride: "x...x.x.x...x.x." },
      comp: ["x.....x.......x.", "..x...x...x...x.", "x..x....x.......", "....x.....x.x...", "x.......x.....x."], compGen: ["pat"], bass: ["r...5...r...5..."], bassGen: ["walk"], bassMax: 4,
      pal: { pad: [], comp: ["piano", "keys", "eguitar"], lead: ["sax", "brass", "marimba", "eguitar", "piano"], arp: [], bass: ["upbass"] },
      bands: [ { pad: null, comp: "piano", lead: "sax", arp: null, bass: "upbass", ans: "brass" }, { pad: null, comp: "piano", lead: "brass", arp: null, bass: "upbass", ans: "sax" },
               { pad: null, comp: "eguitar", lead: "sax", arp: null, bass: "upbass", ans: null }, { pad: null, comp: "piano", lead: "marimba", arp: null, bass: "upbass", ans: "sax" },
               { pad: "strings", comp: "keys", lead: "sax", arp: null, bass: "upbass", ans: null } ],
      progs: [ { m: "ionian", seq: [[2,"m7"],[7,"7"],[0,"maj7"],[0,"6"]] }, { m: "ionian", seq: [[0,"maj7"],[9,"m7"],[2,"m7"],[7,"7"]] }, { m: "ionian", seq: [[4,"m7"],[9,"7"],[2,"m7"],[7,"7"]] },
               { m: "ionian", seq: [[2,"m7"],[7,"7"],[0,"maj7"],[9,"7"]] }, { m: "aeolian", seq: [[2,"m7b5"],[7,"7"],[0,"m7"],[0,"m6"]] }, { m: "ionian", seq: [[0,"maj7"],[5,"maj7"],[4,"m7"],[9,"7"]] },
               { m: "ionian", seq: [[2,"m7"],[7,"7"],[0,"maj7"],[5,"maj7"],[11,"m7b5"],[4,"7"],[9,"m7"],[9,"m7"]] }, { m: "ionian", seq: [[0,"maj7"],[9,"m7"],[2,"m7"],[7,"7"],[4,"m7"],[9,"7"],[2,"m7"],[7,"7"]] } ],
      duck: 0, delay: .2, tex: { vinyl: .06, rain: 0, air: 0 } },
    reggae: { name: "Reggae", firm: 1, level: 1.1, lay: .7, bpm: [70, 84], swing: .18, swing8: 0, arc: "song", harm: 1, drums: 2, kit: "reggae", feel: "smooth", leadGen: "",
      drum: { kick: "........x.......", snare: "", clap: "", hat: "x.x.x.x.x.x.x.x.", open: "..............x.", shaker: "", cLo: "", cHi: "", rim: "........x.......", rimV: .75, tamb: "..x...x...x...x." },
      comp: ["..x...x...x...x."], compGen: ["skank"], chop: 1.2, bass: ["r.....r.5.r...o.", "r..r....5...r.5.", "r.......r..r5..."], bassGen: [], bassMax: 5,
      pal: { pad: ["hammond"], comp: ["eguitar", "clav"], lead: ["keys", "sax", "marimba", "flute"], arp: ["horns"], bass: ["ebass", "upbass"] },
      bands: [ { pad: "hammond", comp: "eguitar", lead: "keys", arp: "horns", bass: "ebass", ans: null }, { pad: "hammond", comp: "eguitar", lead: "sax", arp: null, bass: "ebass", ans: "flute" },
               { pad: null, comp: "clav", lead: "marimba", arp: "horns", bass: "ebass", ans: null }, { pad: "hammond", comp: "eguitar", lead: "flute", arp: null, bass: "upbass", ans: null } ],
      stab: ["..x...x...x...x.", "x...............", "......x......x.."],
      progs: [ { m: "ionian", seq: [[0,"maj"],[7,"maj"],[9,"min"],[5,"maj"]] }, { m: "ionian", seq: [[0,"maj"],[5,"maj"],[0,"maj"],[7,"maj"]] }, { m: "ionian", seq: [[0,"7"],[5,"7"],[0,"7"],[7,"7"]] },
               { m: "aeolian", seq: [[0,"min"],[10,"maj"],[8,"maj"],[10,"maj"]] }, { m: "aeolian", seq: [[0,"m7"],[5,"m7"],[7,"7"],[0,"m7"]] }, { m: "ionian", seq: [[9,"min"],[2,"min"],[7,"maj"],[0,"maj"]] } ],
      scales: { ionian: [0, 2, 4, 7, 9], aeolian: [0, 3, 5, 7, 10] }, duck: 0, delay: .3, tex: { vinyl: 0, rain: 0, air: 0 } },
    funk: { name: "Funk", firm: 1, level: 1.12, lay: .25, bpm: [96, 114], swing: .1, swing8: 0, arc: "song", harm: 2, drums: 2, kit: "funk", feel: "synco", leadGen: "",
      drum: { kick: "x..x...x..x.x...", snare: "....x.......x...", clap: "", hat: "xxxxxxxxxxxxxxxx", open: "......x.......x.", shaker: "", cLo: "", cHi: "", cow: "" },
      comp: ["xx.gx.g.xx.gx.x.", "x.gxgx..x.gxg.x.", "gx.xx.gxx.g.xgx."], compGen: ["pat"], chop: 1.1, bass: ["r..r..b.r.o.r.5.", "r.r...rb..r.o.r.", "r..rr.r.r..5r.b.", "r.....rr.b.r.5.o"], bassGen: [], bassMax: 2,
      pal: { pad: ["hammond"], comp: ["clav", "eguitar"], lead: ["sax", "lguitar", "keys", "horns"], arp: ["horns"], bass: ["ebass", "synthbass"] },
      bands: [ { pad: null, comp: "clav", lead: "sax", arp: "horns", bass: "ebass", ans: null }, { pad: "hammond", comp: "eguitar", lead: "lguitar", arp: "horns", bass: "ebass", ans: null },
               { pad: null, comp: "clav", lead: "keys", arp: "horns", bass: "synthbass", ans: "sax" }, { pad: "hammond", comp: "eguitar", lead: "horns", arp: null, bass: "ebass", ans: "sax" } ],
      stab: ["x.....x...x.....", "..x...x.x.....x.", "x..x......x.x..."],
      progs: [ { m: "mixolydian", seq: [[0,"9"],[0,"9"],[5,"9"],[0,"9"]] }, { m: "dorian", seq: [[0,"m7"],[0,"m7"],[5,"7"],[0,"m7"]] }, { m: "dorian", seq: [[0,"m9"],[5,"9"],[0,"m9"],[7,"7#9"]] },
               { m: "mixolydian", seq: [[0,"9"],[5,"9"],[0,"9"],[7,"9"]] } ],
      scales: { mixolydian: [0, 2, 4, 5, 7, 9, 10], dorian: [0, 2, 3, 5, 7, 9, 10] }, duck: 0, delay: .12, tex: { vinyl: 0, rain: 0, air: 0 } },
    pop: { name: "Pop", firm: 1, level: 1.08, lay: .2, bpm: [100, 124], swing: .05, swing8: 0, arc: "song", harm: 1, drums: 2, kit: "classic", feel: "straight", leadGen: "",
      drum: { kick: "x.......x.x.....", snare: "....x.......x...", clap: "....x.......x...", hat: "x.x.x.x.x.x.x.x.", open: "..x...x...x...x.", shaker: "", cLo: "", cHi: "" },
      comp: ["x..x..x...x..x..", "x.x.x.x.x.x.x.x.", "x...x...x...x..."], compGen: ["pat"], bass: ["r.r.r.r.r.r.r.r.", "r..r..r...r..r..", "r.....r.r.....5."], bassGen: [], bassMax: 3,
      pal: { pad: ["pad", "strings"], comp: ["piano", "eguitar", "keys"], lead: ["synth", "piano", "eguitar", "flute", "bells"], arp: ["pluck", "bells"], bass: ["ebass", "synthbass"] },
      bands: [ { pad: "pad", comp: "piano", lead: "synth", arp: "pluck", bass: "synthbass", ans: "bells" }, { pad: "strings", comp: "eguitar", lead: "piano", arp: "bells", bass: "ebass", ans: "flute" },
               { pad: "pad", comp: "eguitar", lead: "flute", arp: "pluck", bass: "ebass", ans: "keys" }, { pad: "strings", comp: "piano", lead: "eguitar", arp: null, bass: "ebass", ans: "violin" } ],
      progs: [ { m: "ionian", seq: [[0,"add9"],[7,"maj"],[9,"min"],[5,"add9"]] }, { m: "ionian", seq: [[9,"min"],[5,"add9"],[0,"maj"],[7,"sus4"]] }, { m: "ionian", seq: [[0,"maj"],[9,"min"],[5,"maj"],[7,"maj"]] },
               { m: "aeolian", seq: [[0,"min"],[8,"maj"],[3,"maj"],[10,"maj"]] }, { m: "aeolian", seq: [[0,"min"],[10,"maj"],[8,"maj"],[7,"maj"]] }, { m: "ionian", seq: [[5,"maj"],[0,"maj"],[7,"maj"],[9,"min"]] } ],
      scales: { ionian: [0, 2, 4, 5, 7, 9, 11], aeolian: [0, 2, 3, 5, 7, 8, 10] }, duck: .25, delay: .2, tex: { vinyl: 0, rain: 0, air: 0 } },
    hiphop: { name: "Hip-hop", firm: 1, level: 1.2, lay: .9, bpm: [84, 96], swing: .52, swing8: 0, arc: "song", harm: 2, drums: 2, kit: "boombap", feel: "sparse", leadGen: "",
      drum: { kick: "x.....x..x......", snare: "....x.......x...", clap: "", hat: "x.x.x.x.x.x.x.x.", open: "..............x.", shaker: "", cLo: "", cHi: "" },
      comp: ["x.....x...x.....", "x..x....x.......", "x.....x.....x..."], compGen: ["pat"], bass: ["r.....r..r......", "r.......r.....5.", "r..r......r..5.."], bassGen: [], bassMax: 6,
      pal: { pad: ["pad", "strings"], comp: ["piano", "keys", "eguitar"], lead: ["keys", "bells", "sax", "flute"], arp: ["bells", "kalimba"], bass: ["sub", "808"] },
      bands: [ { pad: "pad", comp: "piano", lead: "bells", arp: null, bass: "808", ans: null }, { pad: "strings", comp: "keys", lead: "sax", arp: "kalimba", bass: "sub", ans: null },
               { pad: "pad", comp: "eguitar", lead: "keys", arp: "bells", bass: "808", ans: "flute" } ],
      progs: [ { m: "aeolian", seq: [[0,"m7"],[8,"maj7"],[10,"7"],[0,"m7"]] }, { m: "aeolian", seq: [[0,"m9"],[0,"m9"],[5,"m7"],[7,"7"]] }, { m: "dorian", seq: [[0,"m7"],[5,"7"],[0,"m7"],[10,"maj7"]] },
               { m: "aeolian", seq: [[0,"m7"],[3,"maj7"],[8,"maj7"],[7,"7"]] } ],
      scales: { aeolian: [0, 3, 5, 7, 10], dorian: [0, 3, 5, 7, 9, 10] }, duck: .1, delay: .22, tex: { vinyl: .25, rain: 0, air: 0 } },
    /* solo: one instrument performing; not in STYLE_LIST (only chosen through brief.solo) */
    solo: { name: "Solo", solo: true, level: 1.25, lay: .6, wobble: .0005, bpm: [58, 84], swing: .08, arc: "solo", harm: 2, drums: 0, kit: "lofi", feel: "medium", pick: true,
      drum: { kick: "", snare: "", clap: "", hat: "", open: "", shaker: "", cLo: "", cHi: "" },
      comp: ["0.2.3.2.1.2.3.2.", "0..2..3..1..2.3.", "0.1.2.3.2.1.2.3.", "0...2...3...2..."], bass: ["r.......5.......", "r.......r.....5.", "r...............", "r.....5.r......."], bassMax: 8,
      pal: { pad: ["pad"], comp: ["piano"], lead: ["piano"], arp: ["piano"], bass: ["piano"] },
      arp: { rate: 2, kind: "alberti", gate: .5 }, duck: 0, delay: .24, tex: { vinyl: 0, rain: 0, air: .06 } }
  };
  Object.keys(STYLES).forEach(function (k) { if (!STYLES[k].arp) STYLES[k].arp = { rate: 2, kind: "updown", gate: .6 }; });
  /* what each solo instrument needs: polyphonic ones play melody, chords and bass themselves; single-line ones play the melody over a faint bed */
  var SOLO_SETUP = {
    piano: { poly: true, f: { lead: "piano", comp: "piano", arp: "piano", bass: "piano" } },
    keys: { poly: true, f: { lead: "keys", comp: "keys", arp: "keys", bass: "keys" } },
    guitar: { poly: true, f: { lead: "guitar", comp: "guitar", arp: "guitar", bass: "guitar" } },
    kalimba: { poly: true, f: { lead: "kalimba", comp: "kalimba", arp: "kalimba", bass: "pluck" } },
    marimba: { poly: true, f: { lead: "marimba", comp: "marimba", arp: "marimba", bass: "marimba" } },
    bells: { poly: true, f: { lead: "bells", comp: "bells", arp: "bells", bass: "pluck" } },
    sax: { poly: false, f: { lead: "sax", pad: "pad" } }, violin: { poly: false, f: { lead: "violin", pad: "strings" } },
    flute: { poly: false, f: { lead: "flute", pad: "pad" } }, brass: { poly: false, f: { lead: "brass", pad: "strings" } }
  };
  var SOLO_ALIAS = { saxophone: "sax", keyboard: "keys", rhodes: "keys", acousticguitar: "guitar", guitarist: "guitar", pianist: "piano", violinist: "violin", fiddle: "violin", strings: "violin", cello: "violin", trumpet: "brass", horn: "brass", thumbpiano: "kalimba", mbira: "kalimba", xylophone: "marimba", vibraphone: "marimba", glockenspiel: "bells", chimes: "bells" };


  /* alternative grooves and basslines per genre: each section picks one, so a piece does not loop the same bar all the way through */
  var DRUM_ALT = {
    afrobeats: [{ kick: "x..x..x..x.x....", hat: "x.x.x.xxx.x.x.xx" }, { kick: "x.....x...x..x..", clap: "....x.......x.x.", hat: "xxxxxxxxxxxxxxxx", rim: "x..x..x.x..x.xx." }],
    amapiano: [{ kick: "x...x...x...x..x", hat: "x.xxx.xxx.xxx.xx" }, { kick: "x..x..x...x..x..", clap: "....x.......x...", open: "..x...x.x.x...x." }],
    lofi: [{ kick: "x.....x..x......", snare: "....x.......x..x" }, { kick: "x...x.....x.....", hat: "x.x.x.x.xxx.x.x." }],
    house: [{ hat: "x.xxx.xxx.xxx.xx", open: "..x...x...x...x." }, { clap: "....x.......x..x", hat: "xoxoxoxoxoxoxoxx" }],
    trap: [{ kick: "x.....x...x..x..", hat: "x.xxx.x.xxx.x.xx" }, { kick: "x..x..x.....x...", hat: "x.x.x.xxx.x.x.x." }],
    rnb: [{ kick: "x.....x..x.x....", hat: "x.x.xxx.x.x.xxx." }, { kick: "x...x...x..x....", clap: "........x......x" }],
    acoustic: [{ kick: "x.....x.x.......", rim: "....x.......x..x" }, { kick: "x.......x.x.....", shaker: "xxx.xxx.xxx.xxx." }],
    rocknroll: [{ kick: "x.....x.x.......", tamb: "x.x.x.x.x.x.x.x." }, { kick: "x..x....x.x.....", snare: "....x.......x..x" }, { kick: "x.......x..x....", hat: "x.xxx.xxx.xxx.xx" }],
    rock: [{ kick: "x..x..x.x.......", hat: "x.x.x.x.x.x.x.x." }, { kick: "x.x.....x.x.....", hat: "xxxxxxxxxxxxxxxx" }, { kick: "x.......x..x.x..", open: "..x...x...x...x." }, { kick: "x...x...x...x...", snare: "....x.......x..x" }],
    blues: [{ kick: "x.....x.x.......", hat: "x.x.x.x.x.x.x.x." }, { kick: "x.......x..x....", snare: "....x.......x..x" }],
    reggae: [{ kick: "x...x...x...x...", snare: "", rim: "........x......." }, { kick: "........x.......", rim: "....x...x...x...", hat: "x.xxx.xxx.xxx.xx" }, { kick: "........x...x...", rim: "........x.......", open: "......x.......x." }],
    funk: [{ kick: "x..x..x...x..x..", snare: "....x.......x..x" }, { kick: "x.....x.x..x.x..", hat: "x.xxx.xxx.xxx.xx", cow: "x...x...x...x..." }, { kick: "x..x...x.x..x...", open: "..x...x.....x..." }],
    pop: [{ kick: "x...x...x...x...", hat: "x.x.x.x.x.x.x.x.", clap: "....x.......x..." }, { kick: "x..x....x.x.....", hat: "xxxxxxxxxxxxxxxx" }, { kick: "x.......x..xx...", shaker: "xxxxxxxxxxxxxxxx" }],
    hiphop: [{ kick: "x..x......x.....", snare: "....x.......x..x" }, { kick: "x.....x...x...x.", hat: "x.xxx.x.x.xxx.x." }, { kick: "x.x.....x.......", clap: "....x.......x..." }],
    cinematic: [{ tom: "......x.x......." }, { tom: "........x.x.x..." }]
  };
  var BASS_ALT = {
    reggae: ["r.......r..r5...", "r..5..r.....r.o."], funk: ["r.r..rb.r..5r.o.", "r..r.r..rb.r..5."], pop: ["r.r.r.r.5.5.5.5.", "r...r.5.r...r.5."], hiphop: ["r.....5..r.....", "r..r.....r.r..5."],
    afrobeats: ["r..r.r..5..r..a.", "r.r...5.r..5..o."], amapiano: ["r..r..5..r.r..a.", "r.....r.5..r.o.."], lofi: ["r.....5...r...a.", "r..r....5.....o."],
    house: ["..r..r.r..r..r5.", "r...r...r...r.5."], trap: ["r.....r.r.....5.", "r..r.r....r...5."], rnb: ["r.....r.....5.a.", "r...r.....r.5..."], acoustic: ["r.....5.o.....5.", "r...5...r...5..."]
  };

  /* section templates per arc. n = phrases of 4 bars; e = energy factor; lead = how the melody behaves. */
  var ARCS = {
    groove: [
      { k: "intro", n: 1, e: .38, lead: "none", arp: .3, drums: 1, bass: false, cut: .55 },
      { k: "verse", n: 2, e: .66, lead: "sparse", arp: .5, drums: 2, bass: true, fill: true },
      { k: "chorus", n: 2, e: .92, lead: "theme", arp: .75, drums: 2, bass: true, fill: true, crash: true },
      { k: "verse", n: 2, e: .7, lead: "call", arp: .5, drums: 2, bass: true, fill: true },
      { k: "break", n: 1, e: .28, lead: "sparse", arp: .6, drums: 0, bass: false, cut: .35 },
      { k: "build", n: 1, e: .75, lead: "none", arp: .8, drums: 3, bass: false, riser: true },
      { k: "drop", n: 2, e: 1.0, lead: "varied", arp: 1, drums: 2, bass: true, fill: true, crash: true, lift: true },
      { k: "bridge", n: 1, e: .5, lead: "call", arp: .5, drums: 1, bass: true }
    ],
    drift: [
      { k: "intro", n: 1, e: .32, lead: "none", arp: .3, drums: 0, bass: false, cut: .5 },
      { k: "drift", n: 2, e: .55, lead: "sparse", arp: .5, drums: 1, bass: true },
      { k: "swell", n: 2, e: .8, lead: "theme", arp: .7, drums: 1, bass: true, crash: true },
      { k: "drift", n: 2, e: .48, lead: "call", arp: .5, drums: 1, bass: true },
      { k: "breath", n: 1, e: .22, lead: "none", arp: .4, drums: 0, bass: false, cut: .45 },
      { k: "drift", n: 2, e: .58, lead: "varied", arp: .6, drums: 1, bass: true },
      { k: "swell", n: 2, e: .85, lead: "theme", arp: .8, drums: 1, bass: true, lift: true }
    ],
    story: [
      { k: "intro", n: 1, e: .32, lead: "none", arp: .3, drums: 0, bass: false, cut: .5 },
      { k: "verse", n: 2, e: .52, lead: "sparse", arp: .5, drums: 1, bass: true },
      { k: "rise", n: 2, e: .72, lead: "theme", arp: .7, drums: 1, bass: true, fill: true },
      { k: "build", n: 1, e: .88, lead: "none", arp: .9, drums: 3, bass: true, riser: true },
      { k: "climax", n: 2, e: 1.0, lead: "theme", arp: 1, drums: 2, bass: true, fill: true, crash: true, lift: true },
      { k: "release", n: 2, e: .45, lead: "varied", arp: .5, drums: 1, bass: true },
      { k: "bridge", n: 1, e: .3, lead: "none", arp: .4, drums: 0, bass: false, cut: .5 }
    ],
    solo: [
      { k: "intro", n: 1, e: .3, lead: "sparse", arp: 0, drums: 0, bass: false, cut: .75 },
      { k: "verse", n: 2, e: .5, lead: "call", arp: .25, drums: 0, bass: true },
      { k: "rise", n: 2, e: .72, lead: "theme", arp: .5, drums: 0, bass: true },
      { k: "bridge", n: 1, e: .38, lead: "sparse", arp: .2, drums: 0, bass: false, cut: .7 },
      { k: "climax", n: 2, e: .95, lead: "varied", arp: .65, drums: 0, bass: true, lift: true },
      { k: "release", n: 2, e: .45, lead: "theme", arp: .3, drums: 0, bass: true }
    ],
    song: [
      { k: "intro", n: 1, e: .5, lead: "sparse", arp: .3, drums: 2, bass: true, cut: .7 },
      { k: "verse", n: 2, e: .62, lead: "call", arp: .4, drums: 2, bass: true, fill: true },
      { k: "chorus", n: 2, e: .9, lead: "theme", arp: .6, drums: 2, bass: true, fill: true, crash: true },
      { k: "verse", n: 2, e: .66, lead: "call", arp: .4, drums: 2, bass: true, fill: true },
      { k: "chorus", n: 2, e: .92, lead: "theme", arp: .6, drums: 2, bass: true, fill: true, crash: true },
      { k: "solo", n: 2, e: .98, lead: "varied", arp: .3, drums: 2, bass: true, fill: true, crash: true, lift: true },
      { k: "bridge", n: 1, e: .46, lead: "sparse", arp: .3, drums: 1, bass: true, cut: .8 },
      { k: "chorus", n: 2, e: 1.0, lead: "theme", arp: .7, drums: 2, bass: true, fill: true, crash: true, lift: true }
    ],
    jazz: [
      { k: "intro", n: 1, e: .4, lead: "none", arp: 0, drums: 1, bass: true, cut: .85 },
      { k: "head", n: 2, e: .6, lead: "theme", arp: 0, drums: 2, bass: true, fill: true },
      { k: "solo", n: 2, e: .78, lead: "varied", arp: 0, drums: 2, bass: true, fill: true },
      { k: "solo", n: 2, e: .92, lead: "varied", arp: 0, drums: 2, bass: true, fill: true, lift: true },
      { k: "trade", n: 1, e: .85, lead: "call", arp: 0, drums: 2, bass: true, fill: true },
      { k: "head", n: 2, e: .66, lead: "theme", arp: 0, drums: 2, bass: true, fill: true, crash: true }
    ],
    drums: [
      { k: "groove", n: 1, e: .5, lead: "none", arp: 0, drums: 2, bass: false, fill: true },
      { k: "verse", n: 2, e: .66, lead: "none", arp: 0, drums: 2, bass: false, fill: true },
      { k: "build", n: 1, e: .8, lead: "none", arp: 0, drums: 3, bass: false },
      { k: "chorus", n: 2, e: .95, lead: "none", arp: 0, drums: 2, bass: false, fill: true, crash: true },
      { k: "break", n: 1, e: .6, lead: "none", arp: 0, drums: 2, bass: false, fill: true },
      { k: "chorus", n: 2, e: 1.0, lead: "none", arp: 0, drums: 2, bass: false, fill: true, crash: true, lift: true }
    ],
    wave: [
      { k: "intro", n: 1, e: .4, lead: "none", arp: .3, drums: 1, bass: false, cut: .55 },
      { k: "verse", n: 2, e: .62, lead: "sparse", arp: .4, drums: 2, bass: true },
      { k: "verse", n: 2, e: .72, lead: "theme", arp: .5, drums: 2, bass: true, fill: true },
      { k: "bridge", n: 1, e: .45, lead: "call", arp: .5, drums: 1, bass: true },
      { k: "verse", n: 2, e: .68, lead: "varied", arp: .5, drums: 2, bass: true, fill: true },
      { k: "break", n: 1, e: .3, lead: "none", arp: .5, drums: 0, bass: false, cut: .4 }
    ]
  };
  /* one-bar melody rhythms (onset steps), by feel and busyness */
  var RHYTHMS = {
    sparse: [[0, 8], [0, 6, 10], [2, 8, 12], [0, 10], [4, 12], [0, 6, 12]],
    medium: [[0, 3, 6, 10, 12], [0, 2, 6, 8, 12], [0, 4, 6, 10, 14], [2, 6, 8, 11, 14], [0, 3, 8, 11]],
    busy: [[0, 2, 4, 7, 8, 10, 12, 15], [0, 3, 4, 6, 8, 11, 12, 14]],
    straight: [[0, 4, 8, 12], [0, 2, 6, 8, 10, 14], [0, 4, 6, 8, 12]],
    shuffle: [[0, 2, 4, 8, 10, 12], [0, 4, 6, 8, 12], [2, 4, 6, 8, 12, 14], [0, 2, 4, 6, 8, 12]],
    swing: [[0, 2, 4, 6, 8, 10, 12, 14], [0, 2, 4, 8, 10, 12], [2, 4, 6, 10, 12, 14]],
    synco: [[0, 3, 6, 10, 13], [3, 6, 10, 12, 15], [0, 3, 7, 10], [0, 3, 6, 8, 11, 14]],
    smooth: [[0, 6, 10], [2, 8, 12], [0, 4, 10, 14], [0, 8, 12]]
  };

  /* ═══════════════ taste (what the person liked or skipped; kept in localStorage) ═══════════════ */
  var TASTE_KEY = "yoecho_music_taste";
  var taste = { styles: {}, moods: {}, seeds: [] };
  function loadTaste() { try { var t = JSON.parse(global.localStorage.getItem(TASTE_KEY) || "null"); if (t && t.styles) taste = { styles: t.styles || {}, moods: t.moods || {}, seeds: t.seeds || [] }; } catch (e) {} }
  function saveTaste() { try { global.localStorage.setItem(TASTE_KEY, JSON.stringify(taste)); } catch (e) {} }
  loadTaste();
  function tasteWeight(style) { var s = taste.styles[style] || 0; return clamp(1 + 0.3 * s, 0.3, 2.2); }


  /* ═══════════════ AI composition plans ═══════════════
   * The chat model can write a plan (key, chords per bar, sections, instruments, feel, motif). parsePlan validates and repairs it;
   * anything wrong is clamped or dropped, and a plan that does not hold together returns null so the normal composer plays instead. */
  var PLAN_KINDS = { intro: 1, verse: 1, chorus: 1, solo: 1, bridge: 1, "break": 1, build: 1, drop: 1, outro: 1, head: 1, trade: 1 };
  var PLAN_LEAD = { none: 1, sparse: 1, call: 1, theme: 1, varied: 1 };
  function chordQuality(rest) {
    var r = rest.toLowerCase().replace(/[\s()]/g, "").replace("♭", "b").replace("♯", "#").replace("min", "m").replace("-", "m").replace("ø", "m7b5").replace("°", "dim");
    var map = { "": "maj", maj: "maj", M: "maj", m: "min", "7": "7", m7: "m7", maj7: "maj7", ma7: "maj7", "9": "9", m9: "m9", maj9: "maj9", m11: "m11", "13": "13", "6": "6", m6: "m6", sus4: "sus4", sus: "sus4", sus2: "sus4", dim: "dim", dim7: "dim", m7b5: "m7b5", "5": "5", add9: "add9", "7#9": "7#9", "69": "69", "6/9": "69", "9sus4": "sus4", "7sus4": "sus4", aug: "maj", add: "add9" };
    if (map[r] !== undefined) return map[r];
    if (r.indexOf("maj") === 0) return r.indexOf("9") > 0 ? "maj9" : "maj7";
    if (r.charAt(0) === "m" && r.indexOf("b5") > 0) return "m7b5";
    if (r.charAt(0) === "m") return r.indexOf("9") > 0 ? "m9" : r.indexOf("7") > 0 ? "m7" : "min";
    if (r.indexOf("13") >= 0) return "13";
    if (r.indexOf("9") >= 0) return "9";
    if (r.indexOf("7") >= 0) return "7";
    return "maj";
  }
  function parseChordSym(sym, keyRoot) {
    var m = String(sym || "").trim().split("/")[0].match(/^([A-Ga-g])([#b♯♭]?)(.*)$/); if (!m) return null;
    var base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()], acc = m[2] === "#" || m[2] === "♯" ? 1 : (m[2] === "b" || m[2] === "♭") ? -1 : 0;
    var q = chordQuality(m[3] || ""); return absChord(((base + acc - keyRoot) % 12 + 12) % 12, q);
  }
  function parsePlan(p) {
    if (typeof p === "string") { var t = p.replace(/```(?:json)?/gi, ""), a = t.indexOf("{"), z = t.lastIndexOf("}"); try { p = JSON.parse(t.slice(a, z + 1)); } catch (e) { return null; } }
    if (!p || typeof p !== "object" || !Array.isArray(p.sections)) return null;
    var out = { sections: [] }, rawSecs = p.sections.slice(0, 12), i, j;
    var firstChord = null; for (i = 0; i < rawSecs.length && !firstChord; i++) { var cs0 = rawSecs[i] && rawSecs[i].chords; if (Array.isArray(cs0) && cs0.length) firstChord = String(cs0[0]).match(/^([A-Ga-g])([#b]?)/); }
    var key = parseKey(p.key); if (key === null && firstChord) key = parseKey(firstChord[1] + firstChord[2]); if (key === null) return null;
    out.key = key;
    var md = String(p.mode || "").toLowerCase(); if (md === "minor") md = "aeolian"; if (md === "major") md = "ionian";
    out.mode = MODES[md] ? md : "";
    for (i = 0; i < rawSecs.length; i++) {
      var rs = rawSecs[i]; if (!rs || !Array.isArray(rs.chords)) continue;
      var chords = []; for (j = 0; j < rs.chords.length && j < 16; j++) { var c = parseChordSym(rs.chords[j], key); if (c) chords.push(c); }
      if (chords.length < 2) continue;
      var kind = String(rs.kind || "verse").toLowerCase(); if (!PLAN_KINDS[kind]) kind = "verse";
      var lead = String(rs.lead || "theme").toLowerCase(); if (!PLAN_LEAD[lead]) lead = "theme";
      var bars = clamp(Math.round(Number(rs.bars) || chords.length), 4, 24), dr = Number(rs.drums); if (!isFinite(dr)) dr = 2;
      out.sections.push({ kind: kind, chords: chords, bars: bars, energy: clamp(typeof rs.energy === "number" ? rs.energy : .6, .1, 1), lead: lead, drums: clamp(Math.round(dr), 0, 2),
        bass: rs.bass !== false, arp: rs.arp === true, comp: rs.comp !== false, fill: rs.fill !== false && kind !== "intro", crash: kind === "chorus" || kind === "drop" || kind === "solo" || rs.crash === true });
    }
    if (out.sections.length < 2) return null;
    if (!out.mode) { var c0 = out.sections[0].chords[0].q; out.mode = (c0 === "min" || c0 === "m7" || c0 === "m9" || c0 === "m11" || c0 === "m6") ? "aeolian" : (c0 === "7" || c0 === "9" || c0 === "13") ? "mixolydian" : "ionian"; }
    var st = String(p.style || "").toLowerCase().replace(/[^a-z]/g, ""); st = ({ rockandroll: "rocknroll", hiphop2: "hiphop" })[st] || st; out.style = STYLES[st] && !STYLES[st].solo ? st : "";
    if (typeof p.bpm === "number" && isFinite(p.bpm)) out.bpm = clamp(Math.round(p.bpm), 50, 150);
    if (typeof p.title === "string") out.title = p.title.replace(/[^\w\s'&,.!?-]/g, "").trim().slice(0, 40);
    if (p.band && typeof p.band === "object") {
      out.band = {};
      ["pad", "comp", "lead", "arp", "bass", "ans"].forEach(function (r) {
        if (!(r in p.band)) return; var v = p.band[r];
        if (v === null || v === false || v === "none") { out.band[r] = "none"; return; }
        var nm = normInstr(v); if (INSTR_META[nm] || (r === "bass" && (BASS_LOW[nm] || INSTR_META[nm]))) out.band[r] = nm;
      });
    }
    var mo = p.motif;
    if (mo && Array.isArray(mo.on) && Array.isArray(mo.deg) && mo.on.length === mo.deg.length && mo.on.length >= 2 && mo.on.length <= 10) {
      var on = mo.on.map(function (x) { return clamp(Math.round(Number(x)), 0, 15); }), deg = mo.deg.map(function (x) { return clamp(Math.round(Number(x)), -3, 10); }), ok = true;
      for (i = 1; i < on.length; i++) if (!(on[i] > on[i - 1])) ok = false;
      if (ok && on.every(isFinite) && deg.every(isFinite)) out.motif = { on: on, deg: deg };
    }
    return out;
  }

  /* ═══════════════ brief -> spec ═══════════════ */
  function parseKey(k) {
    if (typeof k === "number") return ((k % 12) + 12) % 12;
    if (typeof k !== "string") return null;
    var m = k.trim().match(/^([A-Ga-g])([#b]?)/); if (!m) return null;
    var base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()];
    return (base + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + 12) % 12;
  }
  /* tolerant parser: the LLM's JSON can be partial or slightly wrong, so every field is validated and clamped */
  function parseBrief(b) {
    if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    b = b && typeof b === "object" ? b : {};
    var o = {};
    var mood = String(b.mood || "").toLowerCase();
    var alias = { happy: "joy", excited: "joy", sad: "sadness", anxious: "fear", scared: "fear", angry: "anger", mad: "anger", lonely: "sadness", tired: "calm", stressed: "fear", calm: "calm", peaceful: "calm", loving: "love", romantic: "love", hopeful: "hope", confused: "confusion" };
    mood = alias[mood] || mood;
    o.mood = (RECIPES[mood] ? mood : "neutral");
    var intent = String(b.intent || "").toLowerCase();
    o.intent = (intent === "match" || intent === "lift" || intent === "calm") ? intent : "";
    var st = String(b.style || "").toLowerCase().replace(/[^a-z]/g, "");
    var salias = { lofi: "lofi", lofibeats: "lofi", chill: "lofi", afrobeat: "afrobeats", afro: "afrobeats", piano: "ambient", hiphop: "hiphop", rb: "rnb", rnb: "rnb", soul: "rnb", orchestral: "cinematic", film: "cinematic", guitar: "acoustic", folk: "acoustic", edm: "house", dance: "house", electronic: "house",
      rocknroll: "rocknroll", rockandroll: "rocknroll", rocknrol: "rocknroll", rockn: "rocknroll", rockabilly: "rocknroll", elvis: "rocknroll", chuckberry: "rocknroll", fifties: "rocknroll", oldies: "rocknroll", twist: "rocknroll",
      rock: "rock", hardrock: "rock", classicrock: "rock", altrock: "rock", punk: "rock", grunge: "rock", metal: "rock", indie: "rock", band: "rock", blues: "blues", bluesy: "blues", jazz: "jazz", jazzy: "jazz", swing: "jazz", bebop: "jazz", bossa: "jazz", smoothjazz: "jazz",
      reggae: "reggae", ska: "reggae", dub: "reggae", dancehall: "reggae", funk: "funk", funky: "funk", disco: "funk", groove: "funk", pop: "pop", popmusic: "pop", hiphop2: "hiphop", boombap: "hiphop", rap: "hiphop" };
    var DRUMS_ALIAS = { drum: 1, drums: 1, drummer: 1, drumsolo: 1, drumkit: 1, drumming: 1, percussion: 1, perc: 1, percussions: 1, beat: 1, beats: 1 };
    st = salias[st] || st;
    o.style = STYLES[st] ? st : "";
    if (typeof b.energy === "number" && isFinite(b.energy)) o.energy = clamp(b.energy, 0, 1);
    if (typeof b.bpm === "number" && isFinite(b.bpm)) o.bpm = clamp(Math.round(b.bpm), 50, 150);
    var k = parseKey(b.key); if (k !== null) o.key = k;
    if (typeof b.mode === "string" && MODES[b.mode.toLowerCase()]) o.mode = b.mode.toLowerCase();
    if (b.instruments && typeof b.instruments === "object") {
      o.instruments = {};
      ["pad", "comp", "lead", "arp", "bass", "ans"].forEach(function (r) { var n = b.instruments[r]; if (typeof n === "string") o.instruments[r] = n === "none" ? n : normInstr(n); });
    }
    if (b.solo) {
      var sn = String(b.solo).toLowerCase().replace(/[^a-z]/g, ""); sn = SOLO_ALIAS[sn] || sn;
      if (DRUMS_ALIAS[sn]) o.drums = true;
      else if (SOLO_SETUP[sn]) { o.solo = sn; o.style = "solo"; }
    }
    if (b.drums === true || b.drums === "solo" || DRUMS_ALIAS[String(b.style || "").toLowerCase().replace(/[^a-z]/g, "")]) { o.drums = true; if (!STYLES[o.style] || o.style === "solo") o.style = ""; }
    if (b.seed !== undefined && b.seed !== null && b.seed !== "") o.seed = typeof b.seed === "number" ? (b.seed >>> 0) : strToSeed(b.seed);
    if (typeof b.stageBars === "number" && isFinite(b.stageBars)) o.stageBars = clamp(Math.round(b.stageBars), 8, 64);
    if (typeof b.note === "string") o.note = b.note.slice(0, 80);
    if ((b.planSrc || b.plan) && !o.solo && !o.drums) {
      var pl = parsePlan(b.planSrc || b.plan);
      if (pl) {
        o.planSrc = b.planSrc || b.plan;
        o.plan = pl; if (pl.style) o.style = pl.style; o.key = pl.key; o.mode = pl.mode; if (pl.bpm && typeof b.bpm !== "number") o.bpm = pl.bpm;
        if (pl.band) { o.instruments = o.instruments || {}; for (var br in pl.band) o.instruments[br] = pl.band[br]; }
      }
    }
    return o;
  }

  var INSTR_ALIAS = { electricguitar: "eguitar", cleanguitar: "eguitar", distortedguitar: "dguitar", distortion: "dguitar", rhythmguitar: "dguitar", leadguitar: "lguitar", electricbass: "ebass", bassguitar: "ebass", fingerbass: "ebass", uprightbass: "upbass", doublebass: "upbass", acousticbass: "upbass",
                      hammondorgan: "hammond", b3: "hammond", horn: "horns", hornsection: "horns", brasssection: "horns", clavinet: "clav", saxophone: "sax", keyboard: "keys", electricpiano: "keys", rhodes: "keys", string: "strings" };
  function normInstr(n) { var k = String(n || "").toLowerCase().replace(/[^a-z0-9]/g, ""); return INSTR_ALIAS[k] || k; }
  function pickInstrument(role, style, recipe, rng, taken, forced) {
    var cands = STYLES[style].pal[role].slice();
    if (!cands.length && !forced) return null;
    if (forced && cands.indexOf(forced) < 0 && (INSTR_META[forced] || role === "bass")) return forced;
    if (forced && cands.indexOf(forced) >= 0) return forced;
    var map = {};
    cands.forEach(function (n, i) {
      var meta = INSTR_META[n], w = 1.4 - i * 0.25;
      if (meta) {
        w *= 1.2 - Math.abs(meta.b - recipe.bright);
        if (taken && taken.fam && (role === "lead" || role === "arp") && meta.fam === taken.fam) w *= 0.25;
      }
      map[n] = Math.max(0.05, w);
    });
    return rng.weighted(map);
  }
  function makePalette(style, recipe, rng, forced) {
    forced = forced || {};
    var pal = {};
    pal.pad = pickInstrument("pad", style, recipe, rng, null, forced.pad);
    pal.comp = pickInstrument("comp", style, recipe, rng, null, forced.comp);
    pal.lead = pickInstrument("lead", style, recipe, rng, INSTR_META[pal.comp], forced.lead);
    pal.arp = pickInstrument("arp", style, recipe, rng, INSTR_META[pal.lead], forced.arp);
    pal.bass = pickInstrument("bass", style, recipe, rng, null, forced.bass);
    /* a band: instruments chosen to belong together in this genre (null = that part sits out) */
    var bands = STYLES[style].bands, band = bands && bands.length ? bands[rng.int(bands.length)] : null;
    if (band) ["pad", "comp", "lead", "arp", "bass"].forEach(function (r) { if (band[r] !== undefined && !forced[r]) pal[r] = band[r]; });
    /* a second melodic voice that answers the lead and doubles it a third below in big sections */
    Object.keys(forced).forEach(function (r) { if (forced[r] === "none" && r !== "ans") pal[r] = null; });
    pal.ans = null; if (STYLES[style].solo) return pal;
    if (forced.ans) { pal.ans = forced.ans === "none" ? null : forced.ans; return pal; }
    if (band && band.ans !== undefined) { pal.ans = band.ans; return pal; }
    for (var tries = 0; tries < 4 && !pal.ans; tries++) { var c = pickInstrument("lead", style, recipe, rng, INSTR_META[pal.lead], null); if (c !== pal.lead && c !== pal.comp && INSTR_META[c]) pal.ans = c; }
    return pal;
  }
  function pickStyle(recipe, rng, forced) {
    if (forced && STYLES[forced]) return forced;
    var map = {}; for (var s in recipe.styles) map[s] = recipe.styles[s] * tasteWeight(s);
    return rng.weighted(map);
  }
  function makeTitle(mood, rng) {
    var w = MOOD_WORDS[mood] || MOOD_WORDS.neutral;
    return rng.pick(w[0]) + " " + rng.pick(w[1]);
  }
  /* the spec is everything the composer needs; it is decided once per piece from the brief and the seed */
  function resolveBrief(brief, seed) {
    var rng = makeRng(seed ^ 0x5bd1e995);
    var b = parseBrief(brief);
    var mood = b.mood;
    var intent = b.intent || (b.solo ? "match" : (mood === "sadness" || mood === "fear" || mood === "anger" || mood === "confusion") ? "lift" : "match");
    var journey = intent === "lift" ? LIFT[mood] : intent === "calm" ? CALMJ[mood] : [mood];
    if (!journey) journey = [mood];
    var stages = journey.map(function (m, i) {
      var recipe = RECIPES[m] || RECIPES.neutral;
      return { mood: m, recipe: recipe, bars: i === journey.length - 1 ? 1e9 : (b.stageBars || 24), style: null };
    });
    stages[0].style = pickStyle(stages[0].recipe, rng, b.style);
    /* later stages keep the style when it fits the new mood, otherwise pick one that does (a style the person named is kept throughout) */
    for (var i = 1; i < stages.length; i++) {
      var prev = stages[i - 1].style;
      stages[i].style = (b.style || stages[i].recipe.styles[prev]) ? prev : pickStyle(stages[i].recipe, rng, null);
    }
    var DRUM_STYLES = ["rock", "rocknroll", "funk", "jazz", "afrobeats", "reggae", "hiphop", "amapiano", "blues", "pop", "trap"];
    if (b.drums) { var dst = (b.style && STYLES[b.style] && STYLES[b.style].drums) ? b.style : rng.pick(DRUM_STYLES); stages.forEach(function (sg) { sg.style = dst; }); }
    var recipe0 = stages[0].recipe;
    var forcedI = {}, sk; if (b.instruments) for (sk in b.instruments) forcedI[sk] = b.instruments[sk];
    if (b.solo) { var ss = SOLO_SETUP[b.solo]; for (sk in ss.f) forcedI[sk] = ss.f[sk]; }
    var mode = b.mode || rng.pick(recipe0.modes), sp0 = b.plan ? null : STYLES[stages[0].style].progs;
    if (sp0) { var fam = sp0.filter(function (q) { return q.m === mode; }); if (!fam.length) mode = rng.pick(sp0).m; }
    var root = b.key !== undefined ? b.key : rng.pick([0, 2, 3, 5, 7, 9, 9, 10, 2, 7]);
    return {
      seed: seed >>> 0, brief: b, mood: mood, intent: intent, stages: stages, mode: mode, root: root,
      forced: forcedI, solo: b.solo || "", drums: !!b.drums, bpmForce: b.bpm || 0, energyBias: typeof b.energy === "number" ? (b.energy - recipe0.energy) : 0,
      plan: b.plan || null, title: (b.plan && b.plan.title) ? b.plan.title : makeTitle(mood === "neutral" && stages.length > 1 ? stages[stages.length - 1].mood : mood, rng)
    };
  }

  /* ═══════════════ 4. composer ═══════════════
   * Turns a spec into an endless stream of bars. Each bar is { events, mix, bpm, ... } that the engine plays.
   * It is a rule-based "band": a theme (motif) that is developed, chord loops that change between sections,
   * layers that enter and leave with the energy arc, and registers kept apart so instruments do not clash.
   */
  var LEAD_CENTER = { flute: 74, kalimba: 76, bells: 84, piano: 69, keys: 67, guitar: 66, marimba: 72, strings: 69, brass: 63, sax: 66, violin: 76, synth: 72, organ: 64, pluck: 70, pad: 66, choir: 66, eguitar: 68, dguitar: 60, lguitar: 72, hammond: 66, horns: 64, clav: 66 };
  var ARP_CENTER = { bells: 84, kalimba: 79, pluck: 74, guitar: 70, piano: 74, synth: 76, marimba: 76, keys: 72, strings: 72 };
  var COMP_CENTER = { eguitar: 55, dguitar: 48, hammond: 58, horns: 60, clav: 66, lguitar: 60, guitar: 57, piano: 62, keys: 62, organ: 58, marimba: 64, strings: 58, pad: 58 };
  var BASS_LOW = { ebass: 28, upbass: 28, sub: 31, "808": 31, log: 33, pluck: 33, synthbass: 33 };
  var BASE_VEL = { pad: .55, comp: .7, lead: .85, arp: .55, bass: .9 };

  function Composer(brief, seed) {
    if (seed === undefined || seed === null) seed = (brief && typeof brief === "object" && brief.seed !== undefined) ? parseBrief(brief).seed : randomSeed();
    seed = seed >>> 0;
    var spec = resolveBrief(brief, seed);
    var rng = makeRng(seed);
    var S = { barNo: 0, stage: -1, stageStart: 0, mode: spec.mode, root: spec.root, bpm: 90, bpmTarget: 90, arcName: "groove", arcIdx: 0, sec: null, secBar: 0, secNo: 0,
              padV: null, compV: null, theme: null, progA: null, progB: null, cycle: 0, bias: spec.energyBias, steer: null,
              pal: null, style: null, styleName: "", recipe: null, tex: null, mask: {}, fixed: null, rub: 0 };
    var SOLO = spec.solo ? SOLO_SETUP[spec.solo] : null, PLAN = spec.plan || null;
    if (spec.drums) S.fixed = { pad: false, comp: false, lead: false, arp: false, bass: false };
    if (SOLO) S.fixed = SOLO.poly ? { drums: false, pad: false } : { drums: false, comp: false, arp: false, bass: false };
    var LAYER_KEYS = { drums: "drums", percussion: "drums", perc: "drums", beat: "drums", bass: "bass", bassline: "bass", pad: "pad", pads: "pad", strings: "pad", atmosphere: "pad", comp: "comp", chords: "comp", harmony: "comp", lead: "lead", melody: "lead", arp: "arp", arpeggio: "arp", sparkle: "arp", fx: "fx", effects: "fx" };
    var ROLES_SET = { pad: 1, comp: 1, lead: 1, arp: 1, bass: 1 };

    function chooseArc(style, recipe) {
      if (spec.drums) return "drums";
      if (style.arc === "solo") return "solo";
      if (style.arc === "song" || style.arc === "jazz") return style.arc;
      if (style.arc === "groove") return "groove";
      if (recipe.arc === "drift") return "drift";
      if (recipe.arc === "story" || style.arc === "story") return "story";
      return style.arc;
    }
    function computeBpm(style, recipe) {
      var lo = style.bpm[0], hi = style.bpm[1];
      var t = lerp((lo + hi) / 2, (recipe.bpm[0] + recipe.bpm[1]) / 2, style.firm ? .1 : 0.55);
      t = clamp(t, lo, hi) + rng.range(-2.5, 2.5);
      return Math.round(clamp(t, lo - 2, hi + 2));
    }
    function buildProg(degs) {
      return degs.map(function (d) { var kind = rng.weighted(S.recipe.ext); return { d: d, kind: kind, degs: chordDegs(d, kind) }; });
    }
    function buildAbs(seq) {
      return seq.map(function (c) { var q = c[1]; if (S.style.rootless && QUPG[q] && rng.chance(.5)) q = rng.pick(QUPG[q]); return absChord(c[0], q); });
    }
    function bridgeProg() { return S.style.progs ? buildAbs(rng.pick(S.progPool).seq) : buildProg(rng.pick(PROGS[S.mode])); }
    function makeProgs() {
      if (PLAN) { S.progA = S.progB = PLAN.sections[0].chords; S.progPool = []; S.planIdx = 0; S.mode = PLAN.mode; S.root = PLAN.key; return; }
      var sp = S.style.progs;
      if (sp) {
        var fam = sp.filter(function (q) { return q.m === S.mode; });
        if (!fam.length) { S.mode = rng.pick(sp).m; fam = sp.filter(function (q) { return q.m === S.mode; }); }
        var pa = rng.int(fam.length), pb2 = rng.int(fam.length); if (fam.length > 1 && pb2 === pa) pb2 = (pa + 1) % fam.length;
        S.progPool = fam; S.progA = buildAbs(fam[pa].seq); S.progB = buildAbs(fam[pb2].seq); return;
      }
      var pool = PROGS[S.mode], a = rng.int(pool.length), b = rng.int(pool.length);
      if (pool.length > 1 && b === a) b = (a + 1) % pool.length;
      S.progA = buildProg(pool[a]); S.progB = buildProg(pool[b]);
    }
    function textures() {
      var t = S.style.tex, o = { vinyl: t.vinyl, rain: t.rain, air: t.air };
      if (S.recipe === RECIPES.sadness || S.recipe === RECIPES.calm) o.rain += .1;
      if (S.recipe === RECIPES.fear || S.recipe === RECIPES.calm) o.air += .12;
      return o;
    }
    function enterStage(i, relative) {
      var st = spec.stages[i];
      S.stage = i; S.stageStart = S.barNo; S.recipe = st.recipe; S.styleName = st.style; S.style = PLAN ? Object.assign({}, STYLES[st.style], { harm: 1, progs: null }) : STYLES[st.style];
      if (relative && !S.style.progs && !PLAN) { var nm = rng.pick(st.recipe.modes); S.root = relativeRoot(S.root, S.mode, nm); S.mode = nm; }
      S.pal = makePalette(st.style, st.recipe, rng, spec.forced);
      S.bpmTarget = spec.bpmForce || computeBpm(S.style, st.recipe);
      if (S.barNo === 0) S.bpm = S.bpmTarget;
      S.arcName = chooseArc(S.style, st.recipe);
      S.arcIdx = (i === 0 || S.barNo === 0) ? (spec.skipIntro ? 1 : 0) : 1;   /* later stages skip the intro: the music is already playing */
      S.tex = textures();
      makeProgs(); S.theme = makeTheme(); S.lines = {}; S.riffs = {};
    }

    /* ── melody: one theme per piece/stage, developed bar by bar ── */
    function pickRhythm(feel, dens) {
      var set = feel;
      if (dens > .62 && (feel === "synco" || feel === "medium" || feel === "straight") && rng.chance(.4)) set = "busy";
      return rng.pick(RHYTHMS[set] || RHYTHMS.medium).slice();
    }
    function walk(n, start) {
      var d = start, out = [], i;
      for (i = 0; i < n; i++) {
        out.push(d);
        var step = parseInt(rng.weighted({ "-1": 3, "1": 3, "2": 1.2, "-2": 1.2, "0": .6, "3": .4, "-3": .4 }), 10);
        if (d > 8) step = -Math.abs(step || 1); else if (d < 0) step = Math.abs(step || 1);
        d = clamp(d + step, -2, 10);
      }
      return out;
    }
    function makeTheme() {
      if (PLAN && PLAN.motif) {
        var mo = PLAN.motif, d1 = mo.deg.slice(), L2 = mo.on.length, sh2 = rng.pick([1, -1, 2]), mid = Math.floor(L2 / 2);
        d1[L2 - 1] += rng.pick([-2, -1, 1, 2]);
        return { m: [{ on: mo.on.slice(), deg: mo.deg.slice() }, { on: mo.on.slice(), deg: d1 }, { on: mo.on.slice(), deg: mo.deg.map(function (x) { return x + sh2; }) },
                     { on: [mo.on[0], mo.on[mid], mo.on[L2 - 1]], deg: [mo.deg[0], mo.deg[mid], rng.pick([0, 4, 0])] }] };
      }
      var feel = S.style.feel, dens = S.recipe.density;
      var r0 = pickRhythm(feel, dens), r2 = rng.chance(.5) ? r0.slice() : pickRhythm(feel, dens);
      var start = rng.pick([4, 2, 4, 5, 7]);
      var d0 = walk(r0.length, start), m0 = { on: r0, deg: d0 };
      var d1 = d0.slice(), L = d1.length;
      d1[L - 1] += rng.pick([-2, -1, 1, 2]); if (L > 2) d1[L - 2] += rng.pick([-1, 1]);
      var m1 = { on: r0.slice(), deg: d1 };
      var sh = rng.pick([1, -1, 2, -2]);
      var m2 = { on: r2, deg: r2.length === r0.length && r2.join() === r0.join() ? d0.map(function (x) { return x + sh; }) : walk(r2.length, start + sh) };
      var r3 = r0.length > 3 ? [r0[0], r0[Math.floor(r0.length / 2)], r0[r0.length - 1]] : r0.slice();
      var d3 = walk(r3.length, start); d3[d3.length - 1] = rng.pick([0, 7, 2, 4]);
      return { m: [m0, m1, m2, { on: r3, deg: d3 }] };
    }
    function vary(m, amt) {
      var on = m.on.slice(), deg = m.deg.slice(), i, k;
      if (rng.chance(.45 * amt)) { var t = rng.pick([-2, -1, 1, 2]); deg = deg.map(function (x) { return x + t; }); }
      if (rng.chance(.35 * amt) && on.length > 2) { k = 1 + rng.int(on.length - 1); on[k] = clamp(on[k] + rng.pick([-1, 1]), 0, 15); }
      if (rng.chance(.3 * amt) && on.length > 3) { k = 1 + rng.int(on.length - 2); on.splice(k, 1); deg.splice(k, 1); }
      if (rng.chance(.35 * amt)) {
        for (i = 0; i < on.length - 1; i++) if (on[i + 1] - on[i] >= 3) { on.splice(i + 1, 0, on[i] + Math.floor((on[i + 1] - on[i]) / 2)); deg.splice(i + 1, 0, Math.round((deg[i] + deg[i + 1]) / 2)); break; }
      }
      if (rng.chance(.2 * amt)) { var d0 = deg[0]; deg = deg.map(function (x) { return d0 - (x - d0); }); }
      var pairs = on.map(function (s, j) { return { s: s, d: deg[j] }; }).sort(function (a, b) { return a.s - b.s; }), o = { on: [], deg: [] };
      pairs.forEach(function (p) { if (o.on.length && o.on[o.on.length - 1] === p.s) return; o.on.push(p.s); o.deg.push(p.d); });
      return o;
    }
    function leadOrigin() { var c = LEAD_CENTER[S.pal.lead] || 70; return placeInRange(S.root, c - 13, c - 2); }
    function chordRs(c) { return c.rs !== undefined ? c.rs : degSemi(S.mode, c.d); }
    function chordThird(c) { return c.abs ? c.abs[1] : (degSemi(S.mode, c.degs[1]) - degSemi(S.mode, c.degs[0])); }
    function chordPcs(chord) { return chord.abs ? chord.abs.map(function (x) { return (S.root + chord.rs + x) % 12; }) : chord.degs.map(function (d) { return (S.root + degSemi(S.mode, d)) % 12; }); }
    function lscale() { return (S.style.scales && S.style.scales[S.mode]) || MODES[S.mode]; }
    function ls(d) { var sc = lscale(), n = sc.length, o = Math.floor(d / n); return sc[d - o * n] + 12 * o; }
    function inChord(pcs, deg) { return pcs.indexOf((S.root + ls(deg)) % 12) >= 0; }
    function voice(chord, center, prev, spread, rootless) {
      if (chord.abs) { var semis = chord.abs.map(function (x) { return chord.rs + x; }); if (rootless && semis.length >= 4) semis = semis.slice(1); return voiceChord(S.mode, S.root, null, center, prev, Math.max(spread, 18), semis); }
      return voiceChord(S.mode, S.root, chord.degs, center, prev, spread);
    }
    function snapToChord(pcs, deg) {
      if (inChord(pcs, deg)) return deg;
      var order = rng.chance(.5) ? [-1, 1, -2, 2] : [1, -1, 2, -2];
      for (var i = 0; i < order.length; i++) if (inChord(pcs, deg + order[i])) return deg + order[i];
      return deg;
    }
    function fam(name) { var m = INSTR_META[name]; return m ? m.fam : "synth"; }

    function leadBar(sec, chord, ci, cb) {
      var mode = sec.lead, out = [];
      if (!S.pal.lead) return out;
      if (S.style.leadGen && (mode === "theme" || mode === "varied" || mode === "call")) return genLead(sec, chord, ci, cb, mode);
      if (SOLO && !SOLO.poly && (mode === "call" || (mode === "sparse" && sec.kind !== "intro" && sec.kind !== "bridge"))) mode = "theme";
      if (mode === "none") return out;
      var orig = leadOrigin(), pcs = chordPcs(chord), pb = S.secBar % 4, artic = ARTIC[fam(S.pal.lead)] || .8, v0 = BASE_VEL.lead * sec.dyn, harm = S.style.harm;
      if (mode === "sparse") {
        if ((cb % harm) !== 0 || !rng.chance(.78)) return out;
        var cands = [0, 2, 4, 7, 9].map(function (x) { return x + (rng.chance(.5) ? 0 : 0); }).filter(function (d) { return inChord(pcs, d) || d === 9; });
        var deg = rng.pick(cands.length ? cands : [4]), s = rng.pick([0, 2, 4]);
        out.push({ s: s, r: "lead", i: S.pal.lead, m: orig + ls(deg), d: Math.min(harm * 16 - s - 2, 14), v: v0 * .9, p: 1 });
        if (rng.chance(.35)) out.push({ s: s + 8, r: "lead", i: S.pal.lead, m: orig + ls(deg + rng.pick([-1, 1, 2])), d: 5, v: v0 * .75, p: 1 });
        return out;
      }
      if (mode === "call" && (pb % 2) === 1) return out;
      var m = S.theme.m[pb];
      if (mode === "varied") m = vary(m, 1);
      else if (sec.loop > 0 || S.cycle > 0) m = vary(m, .5);
      var lift = (sec.lift && (sec.loop % 2) === 1) ? 7 : 0, n = m.on.length, atPhraseEnd = (pb === 3), halfEnd = (pb === 1), prevM = null;
      var lf = fam(S.pal.lead), glidy = lf !== "pluck" && lf !== "mallet" && lf !== "keys";
      var rich = !!(S.pal.ans && sec.layers.ans && (sec.kind === "chorus" || sec.kind === "drop" || sec.kind === "climax" || sec.kind === "swell"));
      for (var k = 0; k < n; k++) {
        var step = m.on[k], deg2 = m.deg[k] + lift;
        if (step % 4 === 0) deg2 = snapToChord(pcs, deg2);
        if (k === n - 1) {
          if (atPhraseEnd && cb >= sec.loopLen - S.style.harm) deg2 = pickStable(pcs, deg2, [0, 7, 14, 2, 4]);
          else if (halfEnd || atPhraseEnd) deg2 = snapToChord(pcs, deg2);
        }
        deg2 = clamp(deg2, -3, lscale().length * 2);
        var next = k < n - 1 ? m.on[k + 1] : 16, len = next - step;
        if (k === n - 1) len = Math.min(8, 16 - step);
        var legato = (k === n - 1 && atPhraseEnd) ? 1.12 : .95 + rng() * .1;
        var d = Math.max(1, Math.min(len, 12) * artic * legato);
        if (k === n - 1 && atPhraseEnd && rng.chance(.25)) continue;
        var nm = orig + ls(deg2), contour = .9 + .16 * Math.sin(Math.PI * (pb * 16 + step) / 64);
        var evn = { s: step, r: "lead", i: S.pal.lead, m: nm, d: d, v: v0 * (step % 4 === 0 ? 1 : .82) * contour * (1 + (rng() - .5) * .12), p: 1 };
        /* a player slides between close notes and sometimes pushes into a note from beside it */
        if (glidy && prevM !== null && prevM !== nm && Math.abs(prevM - nm) <= 4 && rng.chance(.35)) evn.gl = prevM - nm;
        else if (step > 0 && step % 4 === 0 && len >= 3 && rng.chance(.09)) out.push({ s: step - .45, r: "lead", i: S.pal.lead, m: lo56(orig + ls(deg2 + rng.pick([-1, 1]))), d: .5, v: evn.v * .45, p: 3 });
        out.push(evn); prevM = nm;
        if (rich && step % 4 === 0 && rng.chance(.7)) out.push({ s: step, r: "lead", i: S.pal.ans, m: lo56(orig + ls(deg2 - 2)), d: d, v: evn.v * .55, p: 2, ans: 1 });
      }
      return out;
    }
    function lo56(x) { return x < 56 ? x + 12 : x; }
    /* the second voice answers the lead's call: on the bars where the lead rests, it plays the cadence of the theme a step lower */
    function answerBar(sec, chord, pb) {
      var out = []; if (!S.pal.ans || !sec.layers.ans || sec.lead !== "call" || (pb % 2) !== 1 || S.style.leadGen) return out;
      var pcs = chordPcs(chord), mm = S.theme.m[pb === 1 ? 3 : 2], c = LEAD_CENTER[S.pal.ans] || 66, orig = placeInRange(S.root, c - 14, c - 3);
      var v0 = BASE_VEL.lead * sec.dyn * .7, art = ARTIC[fam(S.pal.ans)] || .8, half = Math.max(2, Math.ceil(mm.on.length * .7));
      for (var k = 0; k < half && k < mm.on.length; k++) {
        var step = mm.on[k]; if (step > 12) break;
        var deg = mm.deg[k] - 1; if (step % 4 === 0) deg = snapToChord(pcs, deg); deg = clamp(deg, -3, lscale().length * 2);
        var nx = k < half - 1 ? mm.on[k + 1] : Math.min(16, step + 5);
        out.push({ s: step, r: "lead", i: S.pal.ans, m: lo56(orig + ls(deg)), d: Math.max(1, Math.min(nx - step, 8) * art), v: v0 * (1 + (rng() - .5) * .1), p: 2, ans: 1 });
      }
      return out;
    }

    /* ── genre lead generators: blues licks and bebop lines ── */
    var BLUES_ON = [[0, 3, 6], [0, 2, 4, 6], [0, 4, 6, 8], [0, 3, 4, 8, 11], [2, 4, 6, 8, 10], [0, 2, 4, 6, 8, 10, 12, 14], [0, 3, 6, 10, 12], [0, 2, 4, 8], [4, 6, 8, 12, 14], [0, 4, 8, 10, 12]];
    var SWING_ON = [[0, 2, 4, 6, 8, 10, 12, 14], [0, 2, 4, 6, 8, 10], [2, 4, 6, 8, 10, 12, 14], [0, 4, 6, 8, 12, 14], [0, 2, 6, 8, 10, 14], [0, 2, 4, 8, 10, 12, 14]];
    function makeLick(pb, dens) {
      var on = rng.pick(dens > .9 ? BLUES_ON.slice(4, 6).concat(BLUES_ON.slice(8)) : BLUES_ON).slice(), i = rng.pick([4, 5, 6, 7, 8]), ix = [];
      for (var k = 0; k < on.length; k++) { ix.push(i); i = clamp(i + parseInt(rng.weighted({ "-1": 4, "1": 2.2, "-2": 2, "2": 1, "0": .8, "-3": .6 }), 10), 0, 11); }
      if (pb === 3) ix[ix.length - 1] = rng.pick([0, 6, 4]);
      return { on: on, ix: ix };
    }
    function makeLine(pb, dens) {
      var on = rng.pick(SWING_ON).filter(function (s2, j) { return j === 0 || rng.chance(.55 + dens * .4); }), i = rng.pick([3, 4, 5, 6]), dir = rng.chance(.5) ? 1 : -1, ix = [];
      for (var k = 0; k < on.length; k++) {
        if (on[k] % 4 === 0) { var m = ((i % 7) + 7) % 7; if (m % 2 === 1) i += dir; }
        ix.push(i); i += dir * (rng.chance(.72) ? 1 : 2); if (rng.chance(.22) || i > 11 || i < 0) dir = -dir; i = clamp(i, 0, 12);
      }
      if (pb === 3) { var l = ((ix[ix.length - 1] % 7) + 7) % 7; ix[ix.length - 1] += rng.pick([0, 2, 4]) - (l % 2 ? 1 : 0) * 0; }
      return { on: on, ix: ix };
    }
    function genLead(sec, chord, ci, cb, mode) {
      var out = [], pb = S.secBar % 4, kind = S.style.leadGen;
      if (mode === "call" && (pb % 2) === 1) return out;
      var key = (mode === "varied" ? "v" : sec.kind) + pb + (mode === "call" ? "c" : ""), ln = mode === "varied" ? null : S.lines[key];
      if (!ln) { ln = kind === "blues" ? makeLick(pb, mode === "varied" ? 1 : sec.e) : makeLine(pb, mode === "varied" ? 1 : sec.e); if (mode !== "varied") S.lines[key] = ln; }
      var c = LEAD_CENTER[S.pal.lead] || 70, v0 = BASE_VEL.lead * sec.dyn, art = ARTIC[fam(S.pal.lead)] || .9, n = ln.on.length, k, base, sc;
      if (kind === "blues") { sc = lscale(); base = placeInRange(S.root, c - 12, c - 1); }
      else { sc = (chord.q && QSCALE[chord.q]) || MODES.ionian; base = placeInRange((S.root + chordRs(chord)) % 12, c - 12, c - 1); }
      var lift = (sec.lift && (sec.loop % 2) === 1) ? 12 : 0;
      for (k = 0; k < n; k++) {
        var st = ln.on[k], ix = ln.ix[k], len = (k < n - 1 ? ln.on[k + 1] : Math.min(16, st + 6)) - st, o = Math.floor(ix / sc.length), m = base + sc[ix - o * sc.length] + 12 * o + lift;
        var ev = { s: st, r: "lead", i: S.pal.lead, m: m, d: Math.max(1, Math.min(len, 8) * art * (k === n - 1 ? 1.1 : .96)), v: v0 * (st % 4 === 0 ? 1 : .84) * (1 + (rng() - .5) * .12), p: 1 };
        if (kind === "blues" && S.pal.lead === "lguitar" && len >= 3 && rng.chance(.34)) ev.gl = -rng.pick([1, 2, 2]);
        if (kind === "bebop" && st > 0 && st % 4 === 0 && rng.chance(.18)) out.push({ s: st - .5, r: "lead", i: S.pal.lead, m: m - 1, d: .5, v: ev.v * .5, p: 3 });
        out.push(ev);
      }
      return out;
    }
    function pickStable(pcs, deg, targets) {
      var best = deg, bd = 99;
      for (var i = 0; i < targets.length; i++) { var t = targets[i], dist = Math.abs(t - deg); if (dist < bd && inChord(pcs, t)) { bd = dist; best = t; } }
      return best;
    }

    /* ── accompaniment ── */
    function padBar(sec, chord, chordStart) {
      if (!chordStart || !S.pal.pad) return [];
      var out = [], v = S.padV, harm = S.style.harm;
      for (var i = 0; i < v.length; i++) out.push({ s: 0, r: "pad", i: S.pal.pad, m: v[i], d: harm * 16 - 1, v: BASE_VEL.pad * sec.dyn * (SOLO ? .5 : 1), p: 1 });
      return out;
    }
    function compPat(sec, chord, cb) {
      var out = [], pats = S.style.comp, pat = pats[sec.compVar % pats.length], v = S.compV, i, s;
      if (!sec.layers.comp || !pat) return out;
      var art = ARTIC[fam(S.pal.comp)] || .8, base = BASE_VEL.comp * sec.dyn;
      if (S.style.pick) {
        var tones = [v[0] - 12].concat(v);
        for (s = 0; s < 16; s++) {
          var ch = pat.charAt(s); if (ch < "0" || ch > "9") continue;
          var idx = parseInt(ch, 10) % tones.length;
          out.push({ s: s, r: "comp", i: S.pal.comp, m: tones[idx], d: 3, v: base * (s % 4 === 0 ? 1 : .78) * (1 + (rng() - .5) * .14), p: 2 });
        }
        return out;
      }
      var hits = []; for (s = 0; s < 16; s++) if (pat.charAt(s) === "x") hits.push(s);
      var strummed = fam(S.pal.comp) === "pluck", spread = strummed ? .14 : .055;
      for (var h = 0; h < hits.length; h++) {
        var L = (h < hits.length - 1 ? hits[h + 1] : 16) - hits[h], d = S.style.chop ? S.style.chop : Math.max(1, Math.min(L, 8) * art + (fam(S.pal.comp) === "keys" ? 1 : 0)), up = strummed && (h % 2 === 1);
        for (i = 0; i < v.length; i++) { var ii = up ? v.length - 1 - i : i; out.push({ s: hits[h] + i * spread, r: "comp", i: S.pal.comp, m: v[ii], d: d, v: base * (hits[h] % 4 === 0 ? 1 : .8) * (up ? .88 : 1) * (1 + (rng() - .5) * .14), p: 2 }); }
      }
      for (s = 0; s < 16; s++) if (pat.charAt(s) === "g") for (i = Math.max(0, v.length - 2); i < v.length; i++) out.push({ s: s, r: "comp", i: S.pal.comp, m: v[i], d: .6, v: base * .32 * (1 + (rng() - .5) * .3), p: 3 });
      return out;
    }
    function compBar(sec, chord, cb) {
      if (!S.pal.comp || !sec.layers.comp) return [];
      var gens = S.style.compGen, gen = gens ? gens[sec.compVar % gens.length] : "pat";
      if (gen === "chuck") return chuckBar(sec, chord);
      if (gen === "power") return powerBar(sec, chord);
      if (gen === "riff") return riffBar(sec, chord);
      if (gen === "skank") return skankBar(sec);
      return compPat(sec, chord, cb);
    }
    function lowRoot(chord) { return placeInRange((S.root + chordRs(chord)) % 12, 40, 51); }
    /* rock and roll rhythm guitar / boogie piano: the alternating "5 to 6" shape on every eighth note */
    function chuckBar(sec, chord) {
      var out = [], rootM = lowRoot(chord) + (S.pal.comp === "piano" ? 12 : 0), shapes = [[0, 7], [0, 9], [0, 7], [0, 10]], base = BASE_VEL.comp * sec.dyn;
      for (var j = 0; j < 8; j++) { var st = j * 2, sh = shapes[j % 4]; for (var q = 0; q < sh.length; q++) out.push({ s: st, r: "comp", i: S.pal.comp, m: rootM + sh[q], d: 1.8, v: base * (st % 4 === 0 ? 1 : .8) * (1 + (rng() - .5) * .14), p: 2 }); }
      return out;
    }
    /* hard rock power chords: sustained hits and palm-muted chugs */
    function powerBar(sec, chord) {
      var out = [], rootM = lowRoot(chord), pats = ["x...x...x...x...", "x.xxx.xxx.xxx.xx", "x.x.x.x.x.x.x.x.", "x..x..x.x..x..x."], pi = sec.compVar % pats.length, pat = pats[pi], base = BASE_VEL.comp * sec.dyn;
      for (var s2 = 0; s2 < 16; s2++) {
        if (pat.charAt(s2) !== "x") continue;
        var sus = pi === 0, d = sus ? 3.8 : (s2 % 4 === 0 ? 1.5 : 1.0), vv = base * (s2 % 4 === 0 ? 1 : .72) * (1 + (rng() - .5) * .12);
        [0, 7, 12].forEach(function (x) { out.push({ s: s2, r: "comp", i: S.pal.comp, m: rootM + x, d: d, v: vv, p: 2 }); });
      }
      return out;
    }
    var RIFF_R = [[0, 3, 6, 8, 11, 14], [0, 2, 4, 6, 8, 10, 12, 14], [0, 3, 4, 8, 11, 12], [0, 2, 3, 6, 8, 10, 11], [0, 1, 3, 6, 8, 9, 11, 14]];
    function riffBar(sec, chord) {
      var out = [], rf = S.riffs[sec.kind];
      if (!rf) { var on = rng.pick(RIFF_R).slice(), sc = lscale(), iv = on.map(function (x, j) { return j === 0 || rng.chance(.4) ? 0 : rng.pick(sc); }); rf = S.riffs[sec.kind] = { on: on, iv: iv }; }
      var rootM = lowRoot(chord), base = BASE_VEL.comp * sec.dyn;
      for (var k = 0; k < rf.on.length; k++) {
        var st = rf.on[k], nx = k < rf.on.length - 1 ? rf.on[k + 1] : 16, d = Math.max(1, (nx - st) * .8), vv = base * (st % 4 === 0 ? 1.05 : .8), m = rootM + rf.iv[k];
        out.push({ s: st, r: "comp", i: S.pal.comp, m: m, d: d, v: vv, p: 2 });
        if (rf.iv[k] === 0 && st % 4 === 0) out.push({ s: st, r: "comp", i: S.pal.comp, m: m + 7, d: d, v: vv * .9, p: 2 });
      }
      return out;
    }
    /* reggae: the guitar chops the off-beat, short and dry */
    function skankBar(sec) {
      var out = [], pat = S.style.comp[0], v = S.compV, base = BASE_VEL.comp * sec.dyn * .95, top = v.slice(-3);
      for (var s2 = 0; s2 < 16; s2++) if (pat.charAt(s2) === "x") for (var i = 0; i < top.length; i++) out.push({ s: s2 + i * .03, r: "comp", i: S.pal.comp, m: top[i], d: S.style.chop || 1.2, v: base * (1 + (rng() - .5) * .1), p: 2 });
      return out;
    }
    function stabBar(sec) {
      var out = [], pats = S.style.stab, pat = pats[sec.compVar % pats.length], v = S.compV.slice(), mean = 0, i, s2;
      for (i = 0; i < v.length; i++) mean += v[i]; mean /= v.length; var sh = Math.round(((LEAD_CENTER[S.pal.arp] || 62) - mean) / 12) * 12; v = v.map(function (x) { return x + sh; });
      for (s2 = 0; s2 < 16; s2++) if (pat.charAt(s2) === "x") for (i = 0; i < v.length; i++) out.push({ s: s2, r: "arp", i: S.pal.arp, m: v[i], d: 2.2, v: BASE_VEL.arp * sec.dyn * 1.15 * (s2 % 4 === 0 ? 1 : .85), p: 2 });
      return out;
    }
    function arpBar(sec) {
      var cfg = S.style.arp, out = [], i;
      if (!sec.layers.arp || !S.pal.arp) return out;
      if (S.style.stab) return stabBar(sec);
      var base = S.compV.slice(), tones = base.concat(base.map(function (x) { return x + 12; })).sort(function (a, b) { return a - b; });
      var c = ARP_CENTER[S.pal.arp] || 74, mean = 0; for (i = 0; i < tones.length; i++) mean += tones[i]; mean /= tones.length;
      var shift = Math.round((c - mean) / 12) * 12; tones = tones.map(function (x) { return x + shift; });
      var kinds = ["up", "updown", "alberti", "rand"], kind = ((S.secBar % 8) < 4) ? cfg.kind : (rng.chance(.5) ? cfg.kind : rng.pick(kinds));
      var n = tones.length, k = 0, rate = cfg.rate, gate = cfg.gate * (.55 + .45 * sec.e), art = ARTIC[fam(S.pal.arp)] || .6;
      for (var s = 0; s < 16; s += rate) {
        var idx;
        if (kind === "up") idx = k % n;
        else if (kind === "updown") { var cyc = Math.max(1, 2 * (n - 1)), q = k % cyc; idx = q < n ? q : cyc - q; }
        else if (kind === "alberti") idx = [0, 2, 1, 2][k % 4] % n;
        else idx = rng.int(n);
        k++;
        if (!rng.chance(gate)) continue;
        out.push({ s: s, r: "arp", i: S.pal.arp, m: tones[idx], d: Math.max(1, rate * art * 1.6), v: BASE_VEL.arp * sec.dyn * (s % 4 === 0 ? 1 : .72) * (1 + (rng() - .5) * .16), p: 3, pan: (rng() - .5) * 1.1 });
      }
      return out;
    }
    function bassGenBar(g, chord, nextChord, rootM, nextM, vb, lastOfChord, cb, harm) {
      var out = [], third = chordThird(chord), inst = S.pal.bass, sameRoot = chordRs(chord) === chordRs(nextChord);
      function ev(s2, m, d, v) { out.push({ s: s2, r: "bass", i: inst, m: m, d: d, v: vb * v, p: 1 }); }
      function approach() { return sameRoot ? rootM + rng.pick([7, 5, 4]) : nextM + (nextM - rootM >= 3 ? -1 : (rng.chance(.5) ? -1 : 1)); }
      var j;
      if (g === "boogie") {
        var P = ((S.secBar % 8) < 4 || rng.chance(.3)) ? [0, third, 7, 9, 10, 9, 7, third] : [0, 0, 7, 7, 9, 9, 10, 7];
        for (j = 0; j < 8; j++) ev(j * 2, rootM + P[j] - (P[j] > 9 ? 0 : 0), 1.9, j % 2 === 0 ? 1 : .8);
        if (lastOfChord && !sameRoot && rng.chance(.5)) { out.pop(); ev(14, approach(), 1.9, .85); }
      } else if (g === "walk") {
        var n2 = rootM + rng.pick([third, 7, 2, third]), n3 = rootM + rng.pick([7, third, 9, 12]); if (n3 === n2) n3 = rootM + 7;
        var n4 = lastOfChord ? approach() : rootM + rng.pick([5, 7, 9]);
        ev(0, rootM, 3.7, 1); ev(4, n2, 3.7, .8); ev(8, n3, 3.7, .85); ev(12, n4, 3.7, .82);
        if (rng.chance(.12)) ev(13.5, n4 + (n4 > n3 ? -1 : 1), 1, .4);
      } else if (g === "root8") {
        for (j = 0; j < 8; j++) { var m = rootM; if (j % 4 === 3 && rng.chance(.3)) m = rootM + 12; else if (j === 5 && rng.chance(.25)) m = rootM + 7; ev(j * 2, m, 1.7, j % 2 === 0 ? 1 : .8); }
        if (lastOfChord && !sameRoot && rng.chance(.4)) { out.pop(); ev(14, approach(), 1.7, .85); }
      } else {
        ev(0, rootM, 3.6, 1); ev(4, rootM + 7, 3.6, .8); ev(8, rootM, 3.6, .9); ev(12, lastOfChord && !sameRoot ? approach() : rootM + (rng.chance(.5) ? 7 : 12), 3.6, .8);
      }
      return out;
    }
    function bassBar(sec, chord, nextChord, cb) {
      var out = [], gens = S.style.bassGen || [], pats = S.style.bass.concat(BASS_ALT[S.styleName] || []), harm = S.style.harm;
      if (!sec.layers.bass || !S.pal.bass) return out;
      var lo = BASS_LOW[S.pal.bass] || 33, rootPc = (S.root + chordRs(chord)) % 12, rootM = placeInRange(rootPc, lo, lo + 11);
      var nextPc = (S.root + chordRs(nextChord)) % 12, nextM = placeInRange(nextPc, rootM - 6, rootM + 5);
      var lastOfChord = (cb % harm) === harm - 1, vb = BASE_VEL.bass * sec.dyn, max = S.style.bassMax;
      var total = gens.length + pats.length, pick = sec.bassVar % total;
      if (pick < gens.length) return bassGenBar(gens[pick], chord, nextChord, rootM, nextM, vb, lastOfChord, cb, harm);
      var pat = pats[pick - gens.length], third = chordThird(chord);
      if (max >= 16 && pat.length === 16 && pat.replace(/\./g, "").length === 1) {
        if ((cb % harm) === 0) out.push({ s: 0, r: "bass", i: S.pal.bass, m: rootM, d: harm * 16 - 1, v: vb, p: 1 });
        return out;
      }
      var steps = []; for (var s = 0; s < 16; s++) if (pat.charAt(s) !== ".") steps.push(s);
      var bp = S.pal.bass, glideOk = bp === "synthbass" || bp === "sub" || bp === "808", prevN = null;
      for (var j = 0; j < steps.length; j++) {
        var st = steps[j], ch = pat.charAt(st), note = rootM;
        if (ch === "5") note = rootM + 7; else if (ch === "o") note = rootM + 12; else if (ch === "b") note = rootM + 10; else if (ch === "3") note = rootM + third; else if (ch === "6") note = rootM + 9;
        else if (ch === "a") note = lastOfChord ? (nextM > rootM ? nextM - 1 : nextM + 1) : rootM + 7;
        var len = (j < steps.length - 1 ? steps[j + 1] : 16) - st;
        var evb = { s: st, r: "bass", i: S.pal.bass, m: note, d: Math.max(1, Math.min(len, max) * .92), v: vb * (j === 0 ? 1 : .82), p: 1 };
        if (glideOk && prevN !== null && note !== prevN && Math.abs(note - prevN) <= (bp === "808" ? 7 : 5) && rng.chance(bp === "808" ? .22 : .1)) evb.gl = prevN - note;
        out.push(evb); prevN = note;
      }
      return out;
    }

    function jazzDrums(out, hit, sec, level, firstBar, lastBar, pb) {
      var e = sec.e, dyn = sec.dyn, i, ride = "x...x.x.x...x.x.", soft = level === 1 ? .7 : 1;
      for (i = 0; i < 16; i++) if (ride.charAt(i) === "x") { if ((i === 6 || i === 14) && rng.chance(.1)) continue; hit(i, "perc", "ride", (i % 4 === 0 ? .62 : .44) * soft * (.75 + .3 * dyn), i === 0 && rng.chance(.15) ? { bell: 1 } : null); }
      hit(4, "perc", "chick", .5 * soft); hit(12, "perc", "chick", .5 * soft);
      if (rng.chance(.55)) hit(0, "drums", "kick", .22 * soft);
      if (rng.chance(.35)) hit(8, "drums", "kick", .2 * soft);
      if (level > 1 && rng.chance(.3 * (.5 + e))) hit(rng.pick([3, 7, 10, 11, 14]), "drums", "kick", .5);
      var nsn = 0, cand = [3, 6, 7, 10, 11, 14, 15], q; for (q = 0; q < cand.length; q++) if (level > 1 && nsn < 2 && rng.chance(.16 * (.6 + e))) { hit(cand[q], "drums", "snare", .22 + rng() * .2); nsn++; }
      if (sec.tpl.fill && pb === 3 && !(level === 1) && (lastBar || rng.chance(.5))) {
        out = out.filter(function (ev) { return !(ev.s >= 12 && ev.k !== "crash" && ev.r !== "fx"); });
        hit(12, "perc", "ride", .5); hit(12, "drums", "snare", .5); hit(13.33, "drums", "snare", .45); hit(14, "drums", "tom", .6, { n: 1 }); hit(14.67, "drums", "tom", .6, { n: 2 }); hit(15, "drums", "kick", .6);
      }
      return out;
    }
    /* ── drums ── */
    function drumBar(sec, firstBar, lastBar) {
      var dOnly = !!spec.drums, D = S.style.drum, out = [], alts = DRUM_ALT[S.styleName], av = alts ? (sec.drumVar + (dOnly ? Math.floor(S.secBar / 4) : 0)) % (alts.length + 1) : 0;
      if (av > 0) { var D2 = {}, dk; for (dk in D) D2[dk] = D[dk]; for (dk in alts[av - 1]) D2[dk] = alts[av - 1][dk]; D = D2; }
      var _u = [], level = sec.layers.drums, i, s, e = sec.e;
      var dyn = sec.dyn, pb = S.secBar % 4, endOfGroup = (pb === 3);
      function hit(step, r, k, v, extra) { var o = { s: step, r: r, k: k, v: Math.min(1, v * (1 + (rng() - .5) * .14)), p: (r === "perc" ? 3 : 1) }; if (extra) for (var q in extra) o[q] = extra[q]; out.push(o); }
      function pattern(str, r, k, vel, filter) {
        if (!str) return;
        for (var st = 0; st < 16; st++) {
          var c = str.charAt(st); if (c === "." || (filter && !filter(st))) continue;
          var acc = c === "o" ? .42 : (st % 4 === 0 ? 1 : st % 2 === 0 ? .82 : .64);
          hit(st, r, k, vel * acc, r === "perc" ? { pan: (st % 4 < 2 ? -1 : 1) * .3 } : null);
        }
      }
      if (sec.tpl.crash && firstBar && level > 0) hit(0, "drums", "crash", .62 * dyn + .2);
      if (sec.tpl.riser && firstBar) out.push({ s: 0, r: "fx", k: "riser", d: sec.bars * 16, v: .5, p: 2 });
      if ((sec.kind === "drop" || sec.kind === "climax") && firstBar) out.push({ s: 0, r: "fx", k: "impact", v: (S.styleName === "cinematic" || S.arcName === "story") ? .8 : .42, p: 1 });
      if (dOnly && level > 0 && level < 3) level = 2;
      if (level <= 0) return out;
      if (S.style.drumGen === "jazz" && level < 3) return jazzDrums(out, hit, sec, level, firstBar, lastBar, pb);
      var inBuild = level === 3 && !(dOnly && S.secBar < sec.bars - 2);
      if (inBuild) {
        var bb = S.secBar, last2 = sec.bars - 2;
        if (bb >= last2) {
          var fine = bb === sec.bars - 1, stepGap = fine ? 1 : 2, total = fine ? 16 : 8, idx2 = 0;
          for (s = 0; s < 16; s += stepGap) { idx2++; hit(s, "drums", "snare", (fine ? .45 : .3) + .5 * (idx2 / total) * (fine ? 1 : .7)); }
        } else { pattern(D.hat, "perc", "hat", .5 * dyn); }
        if (bb < sec.bars - 1) pattern(D.kick, "drums", "kick", .95, function (st) { return st % 8 === 0; });
        return out;
      }
      var light = level === 1;
      var kf = light ? function (st) { return st === 0 || (S.styleName === "house" && st % 4 === 0); } : null;
      pattern(D.kick, "drums", "kick", 1.0, kf);
      if (!light) { pattern(D.snare, "drums", "snare", .85); pattern(D.clap, "drums", "clap", .8); }
      if (!light || S.styleName === "lofi" || S.styleName === "acoustic") {
        pattern(D.hat, "perc", "hat", (light ? .45 : .6) * dyn + .12);
        if (!light && (S.styleName === "lofi" || S.styleName === "rnb") && rng.chance(.14)) hit(rng.pick([3, 7, 11, 15]) + .5, "perc", "hat", .26);
        if (!light) pattern(D.open, "perc", "open", .5 * dyn + .1);
      }
      if (!light && D.tamb) pattern(D.tamb, "perc", "tamb", .38 * dyn + .1);
      if (!light && D.cow) pattern(D.cow, "perc", "cow", .42);
      if (dOnly && e > .4) { var ox = ["shaker", "tamb", "cow", "conga"][sec.drumVar % 4], op = ["x.x.x.x.x.x.x.x.", "..x...x...x...x.", "x..x..x..x..x..x", "x.xx.xx.x.xx.xx."][(sec.drumVar + S.secNo) % 4]; pattern(op, "perc", ox, .4 * dyn + .1, null); }
      if (D.rim) pattern(D.rim, "perc", "rim", D.rimV !== undefined ? D.rimV : .5 * dyn + .1);
      /* ghost notes: very quiet snare taps between the backbeats give a played feel */
      var GH = { lofi: [2, 7, 10, 15], rnb: [6, 7, 14, 15], afrobeats: [3, 10, 15], amapiano: [], acoustic: [], funk: [3, 6, 7, 9, 14, 15], hiphop: [7, 10, 15], rock: dOnly ? [3, 7, 11, 15] : [], pop: dOnly ? [3, 10, 15] : [], rocknroll: [], blues: [] }[S.styleName];
      if (!light && GH && D.snare) for (var gi = 0; gi < GH.length; gi++) if (D.snare.charAt(GH[gi]) === "." && rng.chance((dOnly ? .4 : S.styleName === "funk" ? .35 : .22) * (.6 + e))) hit(GH[gi], "drums", "snare", .15 + rng() * .1);
      if (D.shaker && (!light || e > .3)) pattern(D.shaker, "perc", "shaker", .46 * dyn + .1);
      if (!light && e > .5) { pattern(D.cLo, "perc", "conga", .6, null); if (D.cHi) pattern(D.cHi, "perc", "conga", .5, null); }
      if (D.tom && (!light || firstBar)) pattern(D.tom, "drums", "tom", .8, null);
      /* ghost kick for movement */
      if (!light && D.kick && S.styleName !== "house" && rng.chance(.16)) { var gh = rng.pick([10, 11, 14, 15]); if (D.kick.charAt(gh) === ".") hit(gh, "drums", "kick", .55); }
      /* fills at the end of a 4-bar group */
      var fillNow = sec.tpl.fill && !light && ((endOfGroup && (lastBar || dOnly || rng.chance(.5))) || (dOnly && pb === 1 && rng.chance(.4)));
      if (fillNow) {
        out = out.filter(function (ev) { return !(ev.s >= 12 && ev.r !== "fx" && ev.k !== "crash"); });
        var rockish = S.styleName === "rock" || S.styleName === "rocknroll" || S.styleName === "blues", ft = rng.int(dOnly ? 5 : 4);
        if (S.styleName === "cinematic" || S.recipe === RECIPES.anger) ft = 1;
        if (ft === 1 || (rockish && ft === 0 && rng.chance(.5))) { for (i = 0; i < 4; i++) hit(12 + i, "drums", "tom", .6 + i * .1, { n: 3 - i }); }
        else if (ft === 2) { hit(12, "drums", "snare", .7); hit(13, "drums", "kick", .75); hit(14, "drums", "snare", .65); hit(14.5, "drums", "tom", .6, { n: 1 }); hit(15, "drums", "tom", .7, { n: 0 }); }
        else if (ft === 3) { for (i = 0; i < 8; i++) hit(12 + i / 2, "drums", i % 2 ? "tom" : "snare", .45 + i * .07, { n: Math.max(0, 3 - Math.floor(i / 2)) }); }
        else if (ft === 4) { hit(12, "drums", "kick", .8); hit(12.5, "drums", "snare", .5); hit(13, "drums", "snare", .6); hit(13.5, "drums", "tom", .6, { n: 2 }); hit(14, "drums", "tom", .7, { n: 1 }); hit(14.5, "drums", "tom", .75, { n: 0 }); hit(15, "drums", "snare", .8); }
        else { for (i = 0; i < 4; i++) hit(12 + i, "drums", "snare", .4 + i * .18); }
        if (rockish && lastBar) hit(15.5, "drums", "kick", .8);
      } else if (S.style.rolls && rng.chance(.28) && !light) {
        out = out.filter(function (ev) { return !(ev.k === "hat" && ev.s >= 14); });
        for (i = 0; i < 6; i++) hit(14 + i / 3, "perc", "hat", .4 + i * .1);
      }
      return out;
    }

    /* ── sections ── */
    function applySteer() {
      var st = S.steer; if (!st) return; S.steer = null;
      if (st.mood && RECIPES[st.mood] && st.mood !== spec.stages[S.stage].mood) {
        var r = RECIPES[st.mood];
        spec.stages = [{ mood: st.mood, recipe: r, bars: 1e9, style: st.style && STYLES[st.style] ? st.style : (r.styles[S.styleName] ? S.styleName : pickStyle(r, rng, null)) }];
        enterStage(0, true); S.barNo = Math.max(S.barNo, 1);
      } else if (st.style && STYLES[st.style] && st.style !== S.styleName) {
        spec.stages[S.stage].style = st.style; enterStage(S.stage, false); S.arcIdx = 1;
      }
    }
    function startSection() {
      applySteer();
      if (S.stage < spec.stages.length - 1 && S.barNo - S.stageStart >= spec.stages[S.stage].bars) enterStage(S.stage + 1, true);
      var arc = ARCS[S.arcName], tpl = arc[S.arcIdx % arc.length], ps = null;
      if (PLAN) {
        ps = PLAN.sections[S.planIdx % PLAN.sections.length]; S.planIdx++;
        tpl = { k: ps.kind, n: ps.bars / 4, e: ps.energy, lead: ps.lead, arp: ps.arp ? 1 : 0, drums: ps.drums, bass: ps.bass, fill: ps.fill, crash: ps.crash, lift: ps.kind === "solo" || ps.kind === "drop", cut: ps.kind === "intro" ? .6 : ps.kind === "outro" ? .6 : 0, riser: ps.kind === "build" };
        if (S.planIdx > 0 && S.planIdx % PLAN.sections.length === 0) S.cycle++;
      } else if (S.arcIdx > 0 && S.arcIdx % arc.length === 0) {
        S.cycle++;
        if (rng.chance(.5)) makeProgs();
        if (rng.chance(.55)) S.theme = makeTheme();
        if (S.cycle % 3 === 0 && rng.chance(.5)) { var rel = rng.pick([7, 5, 2, 0]); if (rel) S.root = (S.root + rel) % 12; }
      }
      S.arcIdx++;
      var harm = S.style.harm, prog = ps ? ps.chords : (tpl.k === "chorus" || tpl.k === "drop" || tpl.k === "climax" || tpl.k === "swell" || tpl.k === "rise") ? S.progB : (tpl.k === "bridge" ? bridgeProg() : S.progA), L = prog.length * harm, bars = Math.ceil(tpl.n * 4 / L) * L;
      var e = clamp(.18 + S.recipe.energy * .8 * (.35 + .65 * tpl.e) + S.bias, .1, 1);
      var dl = tpl.drums; if (S.style.drums === 0) dl = 0; else if (S.style.drums === 1 && dl === 2) dl = 1;
      S.sec = {
        kind: tpl.k, tpl: tpl, bars: bars, loopLen: L, e: e, dyn: .55 + .45 * e, lead: tpl.lead, lift: !!tpl.lift, prog: prog,
        layers: { comp: S.style.solo ? true : tpl.k === "intro" ? rng.chance(.55) : tpl.k === "break" ? rng.chance(.8) : true, bass: !!tpl.bass && e >= .15, drums: dl, arp: rng.chance(tpl.arp * (.5 + e * .7)) },
        compVar: rng.int(4), bassVar: rng.int(6), drumVar: rng.int(4), loop: 0, ans: false
      };
      if (ps) { S.sec.layers.comp = ps.comp; S.sec.layers.arp = ps.arp && !!S.pal.arp; S.sec.layers.bass = ps.bass && e >= .15; S.sec.loop = 0; }
      if (tpl.k === "intro" && S.style.drums === 2 && !S.sec.layers.comp && !ps) S.sec.layers.arp = true;
      S.sec.layers.ans = !!S.pal.ans && rng.chance(.25 + .55 * e);
      S.secBar = 0; S.secNo++;
      S.secStartBarNo = S.barNo;
    }

    function nextBar() {
      var first = false;
      if (S.stage < 0) { enterStage(0, false); }
      if (!S.sec || S.secBar >= S.sec.bars) { startSection(); first = true; }
      var sec = S.sec, harm = S.style.harm, cb = S.secBar % sec.loopLen, ci = Math.floor(cb / harm);
      sec.loop = Math.floor(S.secBar / sec.loopLen);
      var chord = sec.prog[ci], nextChord = sec.prog[(ci + 1) % sec.prog.length], chordStart = (cb % harm) === 0;
      if (Math.abs(S.bpmTarget - S.bpm) > .01) S.bpm += clamp(S.bpmTarget - S.bpm, -1.5, 1.5);
      if (chordStart || !S.padV) {
        var pc = COMP_CENTER[S.pal.pad] || 54;
        S.padV = voice(chord, Math.min(pc, 56), S.padV, 14, false);
        S.compV = voice(chord, COMP_CENTER[S.pal.comp] || 62, S.compV, 14, S.style.rootless);
      }
      var lastBar = S.secBar === sec.bars - 1, ev = [];
      ev = ev.concat(padBar(sec, chord, chordStart), bassBar(sec, chord, nextChord, cb), compBar(sec, chord, cb), leadBar(sec, chord, ci, cb), answerBar(sec, chord, S.secBar % 4), arpBar(sec), drumBar(sec, S.secBar === 0, lastBar));
      /* transitions: the bar before a drop leaves a gap and a reversed cymbal pulls into it; a break opens with a falling sweep */
      if (lastBar && sec.kind === "build") {
        ev = ev.filter(function (e) { return !(e.s >= 14 && (e.r === "pad" || e.r === "comp" || e.r === "lead" || e.r === "arp" || e.r === "bass")); });
        ev.push({ s: 8, r: "fx", k: "revcrash", d: 8, v: .55, p: 2 });
      }
      var mk = S.mask, fxm = S.fixed, hasMask = !!fxm; for (var mq in mk) if (mk[mq] === false) hasMask = true;
      if (hasMask) ev = ev.filter(function (e) { var kk = (e.r === "drums" || e.r === "perc") ? "drums" : e.r; return mk[kk] !== false && !(fxm && fxm[kk] === false && e.r !== "fx"); });
      if (S.secBar === 0 && (sec.kind === "break" || sec.kind === "breath" || sec.kind === "bridge")) ev.push({ s: 0, r: "fx", k: "fall", d: 12, v: .4, p: 2 });
      if (S.style.solo) ev = ev.filter(function (e) { return e.r !== "fx"; });
      ev.sort(function (a, b) { return a.s - b.s; });
      /* mix automation: filter opens through intros and builds, closes in breaks */
      var cut = 1, tpl = sec.tpl, prog = S.secBar / sec.bars;
      if (tpl.k === "intro") cut = lerp(tpl.cut || .55, 1, prog);
      else if (tpl.k === "build") cut = lerp(.55, 1, prog);
      else if (tpl.cut) cut = tpl.cut;
      var wet = (S.style.solo ? 1.5 : 1) + ((tpl.k === "break" || tpl.k === "breath" || tpl.k === "bridge") ? .7 : 0) + S.recipe.space * .2;
      var human = S.style.solo ? 1 : spec.drums ? .5 : S.styleName === "jazz" ? .75 : S.styleName === "blues" || S.styleName === "rocknroll" ? .65 : S.styleName === "lofi" ? .85 : (S.styleName === "house" || S.styleName === "trap") ? .12 : .45;
      /* rubato: a solo player breathes with the phrase, easing at phrase ends and drifting slightly otherwise */
      var bpmB = S.bpm;
      if (S.style.solo) { S.rub = clamp(S.rub * .8 + (rng() - .5) * .012, -.03, .03); bpmB = S.bpm * (1 + S.rub - ((S.secBar % 4) === 3 ? .035 : 0) - (lastBar ? .03 : 0)); }
      var bar = {
        idx: S.barNo, bpm: bpmB, stepDur: 60 / bpmB / 4, barDur: 60 / bpmB * 4, swing: S.style.swing, swing8: S.style.swing8 || 0, human: human, events: ev,
        lay: S.style.lay || 0,
        mix: { wobble: S.style.wobble || 0, cut: cut, wet: wet, duck: S.style.duck, delay: S.style.delay, tex: S.tex, grit: S.recipe.grit, bright: S.recipe.bright, space: S.recipe.space, level: S.style.level || 1 },
        kit: S.style.kit, sec: { kind: sec.kind, idx: S.secNo, bar: S.secBar, len: sec.bars, e: sec.e }, secStart: first, stage: S.stage, mood: spec.stages[S.stage].mood, style: S.styleName,
        key: { root: S.root, mode: S.mode }, palette: S.pal
      };
      S.secBar++; S.barNo++;
      return bar;
    }
    /* live control. Energy and tempo change at once (heard within the 1.6 s lookahead); mood and style end the current section so a new one starts on the next bar. */
    function steer(p) {
      p = p || {};
      if (typeof p.energy === "number" && isFinite(p.energy)) {
        var d = clamp(p.energy, -.5, .5); S.bias = clamp(S.bias + d, -.5, .5);
        if (S.sec) {
          var sc = S.sec; sc.e = clamp(sc.e + d, .1, 1); sc.dyn = .55 + .45 * sc.e;
          if (sc.e >= .45 && S.style.drums !== undefined) sc.layers.arp = true;
          if (sc.e >= .6 && S.style.drums > 0 && sc.layers.drums > 0 && sc.layers.drums < 2) sc.layers.drums = Math.min(S.style.drums, 2);
          if (sc.e < .3) { sc.layers.arp = false; if (sc.layers.drums > 1) sc.layers.drums = 1; }
        }
      }
      if (typeof p.bpm === "number" && isFinite(p.bpm)) S.bpmTarget = clamp(S.bpmTarget + clamp(p.bpm, -30, 30), 50, 150);
      if (typeof p.tempo === "number" && isFinite(p.tempo)) S.bpmTarget = clamp(p.tempo, 50, 150);
      /* switch whole parts off or on ("no drums", "bring the bass back") */
      if (p.reset) S.mask = {};
      if (p.layers && typeof p.layers === "object") for (var lk in p.layers) { var key = LAYER_KEYS[String(lk).toLowerCase()]; if (!key) continue; var on = !(p.layers[lk] === false || p.layers[lk] === "off" || p.layers[lk] === 0); if (on) delete S.mask[key]; else S.mask[key] = false; }
      /* swap the instrument a part uses ("play the lead on piano"); it sticks across sections */
      if (p.instrument && typeof p.instrument === "object") for (var rk in p.instrument) {
        var role = LAYER_KEYS[String(rk).toLowerCase()] || rk, nm = normInstr(p.instrument[rk]);
        if (ROLES_SET[role] && (INSTR_META[nm] || (role === "bass" && BASS_LOW[nm]))) { S.pal[role] = nm; spec.forced = spec.forced || {}; spec.forced[role] = nm; }
      }
      if ((p.mood && RECIPES[p.mood]) || (p.style && STYLES[p.style])) {
        S.steer = { mood: RECIPES[p.mood] ? p.mood : null, style: STYLES[p.style] ? p.style : null };
        if (S.sec) S.sec.bars = S.secBar;
      }
    }
    /* DJ mix hooks: the piece was started at the mix tempo; release lets it glide to its own tempo once the outgoing track has gone */
    function hold() { spec.bpmForce = S.bpm; S.bpmTarget = S.bpm; }
    function release(nat) { spec.bpmForce = 0; if (nat) S.bpmTarget = clamp(nat, 50, 150); }
    function info() {
      return { solo: spec.solo || "", drums: !!spec.drums, planned: !!PLAN, root: S.root, modeName: S.mode, seed: seed, title: spec.title, mood: spec.stages[Math.max(0, S.stage)].mood, journey: spec.stages.map(function (s) { return s.mood; }), intent: spec.intent,
               style: S.styleName, styleName: S.style ? S.style.name : "", bpm: Math.round(S.bpm), key: NOTE_NAMES[S.root] + " " + MODE_LABEL[S.mode], palette: S.pal, section: S.sec ? S.sec.kind : "", bar: S.barNo, muted: Object.keys(S.mask).filter(function (k) { return S.mask[k] === false; }) };
    }
    return { spec: spec, seed: seed, nextBar: nextBar, steer: steer, info: info, release: release, hold: hold, state: function () { return S; } };
  }

  /* ═══════════════ 5. engine ═══════════════
   * Plays composer bars with Web Audio. Everything is synthesized, so there are no audio files to download.
   * One Engine = one piece: its own mixer, reverb, delay, sidechain and limiter, so pieces can crossfade.
   */
  var KITS = {
    classic: { kickStart: 165, kickEnd: 42, kickDecay: .5, snareTone: 200, snareNoise: .55, snareDecay: .18, clapFreq: 1400, hatFreq: 8000, hatDecay: .05 },
    afro:    { kickStart: 150, kickEnd: 50, kickDecay: .32, snareTone: 330, snareNoise: .4, snareDecay: .11, clapFreq: 1700, hatFreq: 9500, hatDecay: .035 },
    heavy:   { kickStart: 130, kickEnd: 38, kickDecay: .8, snareTone: 170, snareNoise: .7, snareDecay: .28, clapFreq: 1100, hatFreq: 6500, hatDecay: .07 },
    trap:    { kickStart: 120, kickEnd: 34, kickDecay: 1.15, snareTone: 260, snareNoise: .6, snareDecay: .14, clapFreq: 1500, hatFreq: 10500, hatDecay: .03 },
    lofi:    { kickStart: 105, kickEnd: 50, kickDecay: .3, snareTone: 185, snareNoise: .32, snareDecay: .2, clapFreq: 950, hatFreq: 5200, hatDecay: .06 },
    rock:    { kickStart: 140, kickEnd: 46, kickDecay: .42, snareTone: 195, snareNoise: .85, snareDecay: .26, clapFreq: 1300, hatFreq: 7200, hatDecay: .05 },
    rnr:     { kickStart: 125, kickEnd: 50, kickDecay: .3, snareTone: 215, snareNoise: .7, snareDecay: .2, clapFreq: 1300, hatFreq: 6800, hatDecay: .06 },
    jazz:    { kickStart: 115, kickEnd: 52, kickDecay: .26, snareTone: 240, snareNoise: .38, snareDecay: .14, clapFreq: 1200, hatFreq: 6200, hatDecay: .07 },
    reggae:  { kickStart: 105, kickEnd: 44, kickDecay: .34, snareTone: 300, snareNoise: .3, snareDecay: .1, clapFreq: 1500, hatFreq: 8200, hatDecay: .04 },
    funk:    { kickStart: 150, kickEnd: 52, kickDecay: .22, snareTone: 225, snareNoise: .62, snareDecay: .13, clapFreq: 1500, hatFreq: 9000, hatDecay: .03 },
    boombap: { kickStart: 135, kickEnd: 40, kickDecay: .55, snareTone: 195, snareNoise: .6, snareDecay: .17, clapFreq: 1100, hatFreq: 6500, hatDecay: .045 },
    edm:     { kickStart: 185, kickEnd: 46, kickDecay: .36, snareTone: 230, snareNoise: .8, snareDecay: .24, clapFreq: 1650, hatFreq: 9000, hatDecay: .04 }
  };
  /* mixer strips: level, reverb send, delay send, how much the kick ducks them */
  var STRIPS = {
    drums: { lvl: .46, rv: .05, dy: 0, duck: 0, hp: 36, pk: [4500, 1.5, .8], cmp: [-18, 3, .012, .12] }, hats: { lvl: .55, rv: .05, dy: 0, duck: 0, hp: 450 },
    bass: { lvl: .3, rv: 0, dy: 0, duck: 1, hp: 30, cmp: [-20, 3.5, .025, .16] }, pad: { lvl: .3, rv: .5, dy: 0, duck: 1, hp: 150, pk: [380, -2, .8] },
    comp: { lvl: .32, rv: .26, dy: .1, duck: .8, hp: 130, pk: [320, -2, .8] }, lead: { lvl: .7, rv: .32, dy: .25, duck: 0, hp: 200, pk: [3200, 2, .9], cmp: [-22, 2.5, .02, .22] },
    arp: { lvl: .5, rv: .38, dy: .3, duck: .6, hp: 280, pk: [6500, 1.5, .8] }, tex: { lvl: .3, rv: 0, dy: 0, duck: 0, hp: 80 }, fx: { lvl: .5, rv: .3, dy: 0, duck: 0, hp: 120 }
  };
  /* per-instrument loudness trim, measured so a middle C at the same velocity sounds equally loud for every instrument */
  var LOUD = { piano: .76, keys: .9, organ: .57, guitar: 1.1, pluck: 1.25, kalimba: 1.18, marimba: 1.28, bells: 1, strings: 1, pad: 1.05, choir: 1.2, flute: .35, brass: .59, sax: .33, violin: .32, synth: 1.15, sub: .6, "808": .65, synthbass: .5, log: 1.2, eguitar: 1.05, dguitar: .47, lguitar: .45, ebass: .75, upbass: .9, hammond: .36, horns: .49, clav: 2.6 };
  var COST = { piano: 4, keys: 2, organ: 4, guitar: 1, pluck: 2, kalimba: 2, marimba: 3, bells: 3, strings: 4, pad: 4, choir: 5, flute: 3, brass: 3, sax: 4, violin: 4, synth: 3, sub: 2, "808": 2, synthbass: 3, log: 2, eguitar: 1, dguitar: 4, lguitar: 4, ebass: 3, upbass: 2, hammond: 5, horns: 4, clav: 3 };
  var ROLE_STRIP = { pad: "pad", comp: "comp", lead: "lead", arp: "arp", bass: "bass" };
  var PERC_STRIP = { hat: "hats", open: "hats", shaker: "hats", conga: "hats", rim: "hats", ride: "hats", tamb: "hats", cow: "hats", chick: "hats" };

  function makeIR(ctx, sec, dark) {
    var sr = ctx.sampleRate, n = Math.floor(sr * sec), buf = ctx.createBuffer(2, n, sr), ch, i;
    for (ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch), y = 0, seed = ch ? 911 : 337;
      for (i = 0; i < n; i++) {
        var t = i / n; seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        var x = (seed / 4294967296) * 2 - 1, a = .12 + .82 * Math.pow(t, .55) * dark;
        y = y * a + x * (1 - a);
        d[i] = y * Math.pow(1 - t, 2.6) * (i < sr * .004 ? i / (sr * .004) : 1);
      }
    }
    return buf;
  }

  function Engine(ctx, dest, opts) {
    opts = opts || {};
    var E = { ctx: ctx, lite: !!opts.lite, bright: .5, grit: 0, duckDepth: 0 };
    var sr = ctx.sampleRate, solo = opts.solo || null, muted = opts.mute || [], i;
    E.out = ctx.createGain(); E.out.gain.value = 1; E.out.connect(dest);

    /* master chain: rumble filter -> tone -> glue compressor -> limiter */
    var premix = ctx.createGain(), hp = ctx.createBiquadFilter(), tone = ctx.createBiquadFilter(), glue = ctx.createDynamicsCompressor(), lim = ctx.createDynamicsCompressor(), trim = ctx.createGain();
    hp.type = "highpass"; hp.frequency.value = 42; hp.Q.value = .5;
    tone.type = "lowpass"; tone.frequency.value = 16000; tone.Q.value = .6;
    glue.threshold.value = -18; glue.knee.value = 14; glue.ratio.value = 3; glue.attack.value = .012; glue.release.value = .22;
    lim.threshold.value = -1.5; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = .002; lim.release.value = .08;
    trim.gain.value = opts.trim || .4;
    /* last line of defence: a soft clipper so the output can never exceed full scale, whatever the mix does */
    var clip = ctx.createWaveShaper(), cc = new Float32Array(2048);
    for (i = 0; i < 2048; i++) { var cx = i / 1023.5 - 1; cc[i] = Math.tanh(cx * 1.15) / Math.tanh(1.15) * .97; }
    clip.curve = cc;
    /* tape wow and flutter: a short delay whose time wobbles slowly; depth is set per bar (zero for most styles) */
    var wow = ctx.createDelay(.05), wowLfo = ctx.createOscillator(), wowAmt = ctx.createGain();
    wow.delayTime.value = .012; wowLfo.frequency.value = .55; wowAmt.gain.value = 0; wowLfo.connect(wowAmt); wowAmt.connect(wow.delayTime); wowLfo.start(0); E.wowAmt = wowAmt;
    premix.connect(wow); wow.connect(hp); hp.connect(tone);
    if (E.lite) {
      /* lite mode skips the per-part compressors, so one wider master compressor brings it up to the same loudness as full quality */
      var lc = ctx.createDynamicsCompressor(); lc.threshold.value = -34; lc.knee.value = 12; lc.ratio.value = 3.5; lc.attack.value = .01; lc.release.value = .18;
      tone.connect(lc); lc.connect(glue);
    }
    else {
      /* three-band compression (Linkwitz-Riley crossovers) so the bass cannot pump the highs, plus a touch of parallel tube-style warmth */
      var biq = function (type, fc, from) { var a = ctx.createBiquadFilter(), b = ctx.createBiquadFilter(); a.type = b.type = type; a.frequency.value = b.frequency.value = fc; a.Q.value = b.Q.value = .7071; from.connect(a); a.connect(b); return b; };
      var band = function (src, th, ra, at, rl) { var c = ctx.createDynamicsCompressor(); c.threshold.value = th; c.knee.value = 10; c.ratio.value = ra; c.attack.value = at; c.release.value = rl; src.connect(c); return c; };
      var mh = biq("highpass", 150, tone), sumB = ctx.createGain();
      band(biq("lowpass", 150, tone), -24, 2.5, .03, .25).connect(sumB);
      band(biq("lowpass", 3800, mh), -22, 2.2, .015, .15).connect(sumB);
      band(biq("highpass", 3800, mh), -26, 1.8, .004, .08).connect(sumB);
      var wsh = ctx.createWaveShaper(), wc = new Float32Array(1024), whp = ctx.createBiquadFilter(), wlp = ctx.createBiquadFilter(), wg = ctx.createGain();
      for (i = 0; i < 1024; i++) { var wx = i / 512 - 1; wc[i] = Math.tanh(wx * 2.4) * .8 + .03 * wx * wx; }
      wsh.curve = wc; whp.type = "highpass"; whp.frequency.value = 180; wlp.type = "lowpass"; wlp.frequency.value = 5200; wg.gain.value = .07;
      tone.connect(wsh); wsh.connect(whp); whp.connect(wlp); wlp.connect(wg); wg.connect(sumB);
      sumB.connect(glue);
    }
    glue.connect(trim); trim.connect(lim); lim.connect(clip);
    /* DJ high-pass: sits last in the chain so a whole piece can have its bass swept out or in during a mix */
    var djhp = ctx.createBiquadFilter(); djhp.type = "highpass"; djhp.frequency.value = 10; djhp.Q.value = .7; clip.connect(djhp); djhp.connect(E.out);
    E.djSet = function (f, t) { djhp.frequency.cancelScheduledValues(0); djhp.frequency.setValueAtTime(Math.max(10, f), t); };
    E.djSweep = function (t0, dur, from, to) { var f = djhp.frequency; f.cancelScheduledValues(t0); f.setValueAtTime(Math.max(10, from), t0); f.exponentialRampToValueAtTime(Math.max(10, to), t0 + dur); };
    /* equal-power level curve for crossfades (up: 0->1, down: 1->0) */
    E.xfade = function (t0, dur, up) {
      var n = 48, c = new Float32Array(n), q; for (q = 0; q < n; q++) { var x = q / (n - 1); c[q] = up ? Math.sin(x * Math.PI / 2) : Math.cos(x * Math.PI / 2); }
      E.out.gain.cancelScheduledValues(0); E.out.gain.setValueAtTime(up ? .0001 : 1, Math.max(0, t0 - .02)); E.out.gain.setValueCurveAtTime(c, t0, dur);
    };

    /* reverb */
    var rvIn = ctx.createGain(), conv = ctx.createConvolver(), rvOut = ctx.createGain();
    conv.buffer = makeIR(ctx, E.lite ? 1.8 : 3.2, .9); rvOut.gain.value = .9;
    /* the reverb return is pre-delayed and band-limited so it adds space without muddying the mix */
    var rvPre = ctx.createDelay(.1), rvHp = ctx.createBiquadFilter(), rvLp = ctx.createBiquadFilter();
    rvPre.delayTime.value = .018; rvHp.type = "highpass"; rvHp.frequency.value = 220; rvLp.type = "lowpass"; rvLp.frequency.value = 8000;
    rvIn.connect(rvPre); rvPre.connect(conv); conv.connect(rvHp); rvHp.connect(rvLp); rvLp.connect(rvOut); rvOut.connect(premix);
    /* ping-pong delay (dotted eighth) */
    var dIn = ctx.createGain(), dl = ctx.createDelay(2), dr = ctx.createDelay(2), f1 = ctx.createGain(), f2 = ctx.createGain(), dlp = ctx.createBiquadFilter(), mg = ctx.createChannelMerger(2), dOut = ctx.createGain();
    dlp.type = "lowpass"; dlp.frequency.value = 3200; f1.gain.value = E.lite ? .25 : .36; f2.gain.value = E.lite ? .25 : .36; dOut.gain.value = .8;
    dl.delayTime.value = .4; dr.delayTime.value = .4;
    dIn.connect(dl); dl.connect(mg, 0, 0); dl.connect(dlp); dlp.connect(f1); f1.connect(dr); dr.connect(mg, 0, 1); dr.connect(f2); f2.connect(dl); mg.connect(dOut); dOut.connect(premix);

    /* strips */
    E.strips = {}; var ducks = [];
    Object.keys(STRIPS).forEach(function (name) {
      var c = STRIPS[name], inn = ctx.createGain(), lvl = ctx.createGain(), rv = ctx.createGain(), dy = ctx.createGain(), node = inn, dk = null;
      lvl.gain.value = c.lvl;
      if (c.duck > 0) { dk = ctx.createGain(); inn.connect(dk); node = dk; ducks.push({ g: dk, k: c.duck }); }
      var last = node;
      if (c.hp) { var hf = ctx.createBiquadFilter(); hf.type = "highpass"; hf.frequency.value = c.hp; hf.Q.value = .6; last.connect(hf); last = hf; }
      if (c.pk) { var pf = ctx.createBiquadFilter(); pf.type = "peaking"; pf.frequency.value = c.pk[0]; pf.gain.value = c.pk[1]; pf.Q.value = c.pk[2] || .9; last.connect(pf); last = pf; }
      if (c.cmp && !E.lite) { var cm = ctx.createDynamicsCompressor(); cm.threshold.value = c.cmp[0]; cm.ratio.value = c.cmp[1]; cm.attack.value = c.cmp[2]; cm.release.value = c.cmp[3]; cm.knee.value = 8; last.connect(cm); last = cm; }
      last.connect(lvl); lvl.connect(premix);
      rv.gain.value = c.rv; dy.gain.value = c.dy;
      lvl.connect(rv); rv.connect(rvIn); lvl.connect(dy); dy.connect(dIn);
      E.strips[name] = { in: inn, lvl: lvl, rv: rv, dy: dy, cfg: c };
    });
    function kickDuck(t) {
      if (E.duckDepth <= 0) return;
      for (var k = 0; k < ducks.length; k++) {
        var g = ducks[k].g.gain, depth = clamp(E.duckDepth * ducks[k].k, 0, .8);
        g.setTargetAtTime(1 - depth, t, .004); g.setTargetAtTime(1, t + .035, .09);
      }
    }
    /* vibrato shared by every sustained voice (one LFO, many listeners) */
    var vibLfo = ctx.createOscillator(), vib = ctx.createGain(); vibLfo.frequency.value = 5.2; vib.gain.value = 6; vibLfo.connect(vib); vibLfo.start(0); E.vib = vib;
    /* noise + plucked-string buffers */
    var noiseBuf = ctx.createBuffer(1, sr * 2, sr), nd = noiseBuf.getChannelData(0), seed = 1234567;
    for (i = 0; i < nd.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; nd[i] = (seed / 4294967296) * 2 - 1; }
    var ksCache = {};
    E.ks = function (f, damp, seconds, pluckPos) {
      var key = Math.round(f * 100) + ":" + damp + ":" + seconds + ":" + pluckPos;
      if (ksCache[key]) return ksCache[key];
      var N = Math.max(2, Math.round(44100 / f + .5)), bsr = f * (N - .5), n = Math.round(bsr * seconds), buf = ctx.createBuffer(1, n, bsr), d = buf.getChannelData(0), line = new Float32Array(N), sd = 22695477 + N, q;
      for (q = 0; q < N; q++) { sd = (Math.imul(sd, 1664525) + 1013904223) >>> 0; line[q] = (sd / 4294967296) * 2 - 1; }
      if (pluckPos > 0) { var kk = Math.max(1, Math.round(N * pluckPos)), tmp = new Float32Array(N); for (q = 0; q < N; q++) tmp[q] = line[q] - line[(q + kk) % N]; line = tmp; }
      for (q = 0; q < n; q++) { var idx = q % N, nx = (idx + 1) % N, y = line[idx]; d[q] = y; line[idx] = damp * .5 * (y + line[nx]); }
      ksCache[key] = buf; return buf;
    };
    E.noise = function (t, dur, type, freq, q, peak, decay, out) {
      var s = ctx.createBufferSource(), fl = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noiseBuf; fl.type = type; fl.frequency.value = freq; fl.Q.value = q;
      g.gain.setValueAtTime(Math.max(.0002, peak), t); g.gain.exponentialRampToValueAtTime(.0001, t + decay);
      s.connect(fl); fl.connect(g); g.connect(out); s.start(t, Math.random() * 1.2); s.stop(t + dur);
    };
    E.tone = function (t, type, f0, f1, fdur, peak, decay, out) {
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, t); if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + fdur);
      g.gain.setValueAtTime(Math.max(.0002, peak), t); g.gain.exponentialRampToValueAtTime(.0001, t + decay);
      o.connect(g); g.connect(out); o.start(t); o.stop(t + decay + .05);
    };
    /* pre-rendered noise hits: synthesized once into a buffer, so every later hit is just a source + a gain */
    var sampleCache = {};
    function biquadInPlace(x, type, fc, q) {
      var w0 = 2 * Math.PI * Math.min(fc, sr * .45) / sr, cw = Math.cos(w0), al = Math.sin(w0) / (2 * q), b0, b1, b2, a0 = 1 + al, a1 = -2 * cw, a2 = 1 - al;
      if (type === "highpass") { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; } else { b0 = al; b1 = 0; b2 = -al; }
      b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
      var x1 = 0, x2 = 0, y1 = 0, y2 = 0, n = x.length, k, y;
      for (k = 0; k < n; k++) { y = b0 * x[k] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x[k]; y2 = y1; y1 = y; x[k] = y; }
    }
    E.noiseSample = function (key, parts) {
      if (sampleCache[key]) return sampleCache[key];
      var total = 0, q; parts.forEach(function (p) { total = Math.max(total, p.at + p.sec); });
      var n = Math.floor(sr * total), buf = ctx.createBuffer(1, n, sr), d = buf.getChannelData(0), sd = 4242 + key.length;
      parts.forEach(function (p) {
        var m = Math.floor(sr * p.sec), x = new Float32Array(m), off = Math.floor(sr * p.at);
        for (q = 0; q < m; q++) { sd = (Math.imul(sd, 1664525) + 1013904223) >>> 0; x[q] = (sd / 4294967296) * 2 - 1; }
        biquadInPlace(x, p.type, p.fc, p.q);
        var k = 6.9078 / p.decay; for (q = 0; q < m && off + q < n; q++) d[off + q] += x[q] * p.peak * Math.exp(-k * q / sr);
      });
      return (sampleCache[key] = buf);
    };
    E.playSample = function (buf, t, v, o) {
      var s = ctx.createBufferSource(), g = ctx.createGain(); s.buffer = buf; g.gain.value = v; s.connect(g); g.connect(o); s.start(t);
    };
    /* curGl: slide in from this many semitones away; curDet: a few cents of natural pitch wander per note. Both are set around each note. */
    E.curGl = 0; E.curDet = 0;
    E.osc = function (type, f, t, t1, detune) {
      var o = ctx.createOscillator(); o.type = type;
      if (E.curGl) { o.frequency.setValueAtTime(f * Math.pow(2, E.curGl / 12), t); o.frequency.exponentialRampToValueAtTime(f, t + .07); } else o.frequency.value = f;
      var dt = (detune || 0) + E.curDet; if (dt) o.detune.value = dt; o.start(t); o.stop(t1); return o;
    };

    /* gritty bass path (anger): voices go through a soft clipper */
    var grit = ctx.createWaveShaper(), gritIn = ctx.createGain(), curve = new Float32Array(1024);
    for (i = 0; i < 1024; i++) { var xx = i / 512 - 1; curve[i] = Math.tanh(xx * 3.2) * .9; }
    var gritOut = ctx.createGain(); gritOut.gain.value = .6; grit.curve = curve; gritIn.connect(grit); grit.connect(gritOut); gritOut.connect(E.strips.bass.in);
    E.bassOut = function () { return E.grit > 0 ? gritIn : E.strips.bass.in; };

    /* textures: vinyl crackle, rain and air loop quietly under the music */
    var tex = {};
    function texBuffer(kind) {
      var n = sr * (kind === "air" ? 6 : 4), b = ctx.createBuffer(1, n, sr), d = b.getChannelData(0), q, y = 0, s2 = kind === "vinyl" ? 99 : kind === "rain" ? 555 : 777;
      for (q = 0; q < n; q++) {
        s2 = (Math.imul(s2, 1664525) + 1013904223) >>> 0; var r = (s2 / 4294967296) * 2 - 1;
        if (kind === "vinyl") { d[q] = r * .006 + (Math.abs(r) > .9985 ? r * 1.2 : 0); if (q > 0 && Math.abs(d[q - 1]) > .5) d[q] += d[q - 1] * -.6; }
        else if (kind === "rain") { y = y * .35 + r * .65; d[q] = y * (.55 + .45 * Math.sin(q / sr * 6.2832 * 3.5) * Math.sin(q / sr * 6.2832 * 1.5)); }
        else { y = y * .985 + r * .015; d[q] = y * (.55 + .45 * Math.sin(q / n * 6.2832 * 2)) * 9; }
      }
      return b;
    }
    function ensureTex(kind) {
      if (tex[kind]) return tex[kind];
      var src = ctx.createBufferSource(), g = ctx.createGain(), fl = ctx.createBiquadFilter();
      src.buffer = texBuffer(kind); src.loop = true;
      if (kind === "vinyl") { fl.type = "highpass"; fl.frequency.value = 900; }
      else if (kind === "rain") { fl.type = "bandpass"; fl.frequency.value = 3200; fl.Q.value = .35; }
      else { fl.type = "lowpass"; fl.frequency.value = 900; }
      g.gain.value = 0; src.connect(fl); fl.connect(g); g.connect(E.strips.tex.in); src.start(0);
      return (tex[kind] = { src: src, g: g });
    }

    /* ── instruments: (engine, frequency, start, seconds, loudness, out) ── */
    var satCurve = new Float32Array(1024);
    for (i = 0; i < 1024; i++) satCurve[i] = Math.tanh((i / 512 - 1) * 4) * .8;
    var INST = {};
    INST.piano = function (E, f, t, d, v, o) {
      var tau = clamp(3.2 - .55 * Math.log(f / 110) / Math.LN2, .6, 3.2), dur = Math.min(3.2, .5 + d * 1.3 + tau * .5), top = E.lite ? 2 : clamp(Math.floor(5000 / f), 3, 5), n;
      for (n = 1; n <= top; n++) {
        var os = ctx.createOscillator(), g = ctx.createGain(); os.type = "sine"; os.frequency.value = f * n * Math.sqrt(1 + .0004 * n * n);
        var a = (n % 2 === 0 ? .7 : 1) / Math.pow(n, 1.2) * .5 * v;
        g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(Math.max(.0003, a), t + .004); g.gain.exponentialRampToValueAtTime(.0001, t + dur / (1 + .55 * (n - 1)));
        os.connect(g); g.connect(o); os.start(t); os.stop(t + dur + .05);
      }
      if (!E.lite) E.noise(t, .06, "bandpass", Math.min(4000, f * 6), 1.2, .07 * v, .03, o);
    };
    INST.keys = function (E, f, t, d, v, o) {
      var c = ctx.createOscillator(), m = ctx.createOscillator(), mgn = ctx.createGain(), g = ctx.createGain(), dur = Math.min(2.6, .8 + d * 1.5);
      c.type = "sine"; c.frequency.value = f; m.type = "sine"; m.frequency.value = f;
      mgn.gain.setValueAtTime(f * 2.4, t); mgn.gain.exponentialRampToValueAtTime(f * .12, t + .55); m.connect(mgn); mgn.connect(c.frequency);
      g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(.6 * v, t + .005); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
      c.connect(g); g.connect(o); c.start(t); m.start(t); c.stop(t + dur + .05); m.stop(t + dur + .05);
    };
    function pluckVoice(E, f, t, d, v, o, damp, secs, pos, cutoff, holdMul, minHold, peak) {
      var src = ctx.createBufferSource(), g = ctx.createGain(), lp = ctx.createBiquadFilter(), hold = Math.max(minHold, d * holdMul);
      src.buffer = E.ks(f, damp, E.lite ? Math.min(secs, 1.1) : secs, pos); lp.type = "lowpass"; lp.frequency.value = cutoff; lp.Q.value = .7;
      g.gain.setValueAtTime(peak * v, t); g.gain.setValueAtTime(peak * v, t + hold); g.gain.exponentialRampToValueAtTime(.0001, t + hold + .5);
      src.connect(lp); lp.connect(g); g.connect(o); src.start(t); src.stop(t + hold + .55);
    }
    INST.guitar = function (E, f, t, d, v, o) { pluckVoice(E, f, t, d, v, o, .9972, 1.8, .14, 3600, 2, .45, .9); };
    INST.pluck = function (E, f, t, d, v, o) {
      pluckVoice(E, f, t, d, v, o, .9945, 1.4, 0, 900, 1.3, .25, 1.1);
      var sub = ctx.createOscillator(), sg = ctx.createGain(), hold = Math.max(.25, d * 1.3);
      sub.type = "sine"; sub.frequency.value = f; sg.gain.setValueAtTime(.0001, t); sg.gain.linearRampToValueAtTime(.4 * v, t + .01); sg.gain.exponentialRampToValueAtTime(.0001, t + hold + .25);
      sub.connect(sg); sg.connect(o); sub.start(t); sub.stop(t + hold + .3);
    };
    INST.kalimba = function (E, f, t, d, v, o) {
      var dur = .9 + d * .15, a = ctx.createOscillator(), ag = ctx.createGain(), b = ctx.createOscillator(), bg = ctx.createGain();
      a.type = "sine"; a.frequency.value = f; b.type = "sine"; b.frequency.value = f * 5.42;
      ag.gain.setValueAtTime(.0001, t); ag.gain.linearRampToValueAtTime(.55 * v, t + .002); ag.gain.exponentialRampToValueAtTime(.0001, t + dur);
      bg.gain.setValueAtTime(.0001, t); bg.gain.linearRampToValueAtTime(.13 * v, t + .002); bg.gain.exponentialRampToValueAtTime(.0001, t + dur * .2);
      a.connect(ag); ag.connect(o); b.connect(bg); bg.connect(o); a.start(t); b.start(t); a.stop(t + dur + .05); b.stop(t + dur * .2 + .05);
      if (!E.lite) E.noise(t, .03, "bandpass", Math.min(6000, f * 4), 2, .03 * v, .015, o);
    };
    INST.marimba = function (E, f, t, d, v, o) {
      var parts = E.lite ? [[1, .6, .75], [4, .22, .12]] : [[1, .6, .75], [4, .22, .12], [9.9, .06, .04]];
      parts.forEach(function (p) {
        var os = ctx.createOscillator(), g = ctx.createGain(); os.type = "sine"; os.frequency.value = f * p[0];
        g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(p[1] * v, t + .002); g.gain.exponentialRampToValueAtTime(.0001, t + p[2]);
        os.connect(g); g.connect(o); os.start(t); os.stop(t + p[2] + .05);
      });
      if (!E.lite) E.noise(t, .03, "bandpass", Math.min(5000, f * 5), 1.5, .05 * v, .02, o);
    };
    INST.bells = function (E, f, t, d, v, o) {
      var parts = [[1, 1, 3.4], [2.756, .55, 2.4], [5.404, .3, 1.6], [8.933, .17, 1.0], [13.34, .08, .6]], n = E.lite ? 2 : 4;
      for (var q = 0; q < n; q++) {
        var p = parts[q], os = ctx.createOscillator(), g = ctx.createGain(); os.type = "sine"; os.frequency.value = f * p[0];
        g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(.32 * p[1] * v, t + .003); g.gain.exponentialRampToValueAtTime(.0001, t + p[2]);
        os.connect(g); g.connect(o); os.start(t); os.stop(t + p[2] + .05);
      }
    };
    INST.organ = function (E, f, t, d, v, o) {
      var bars = E.lite ? [[1, 1], [2, .6]] : [[.5, .45], [1, 1], [2, .7], [3, .4]], hold = Math.max(.2, d), g = ctx.createGain();
      g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(.2 * v, t + .012); g.gain.setValueAtTime(.2 * v, t + hold); g.gain.exponentialRampToValueAtTime(.0001, t + hold + .14); g.connect(o);
      bars.forEach(function (b) { var os = E.osc("sine", f * b[0], t, t + hold + .2); var bg = ctx.createGain(); bg.gain.value = b[1]; os.connect(bg); bg.connect(g); });
    };
    function sustained(E, f, t, d, v, o, type, detunes, cutoff, atk, rel, peak, sweepFrom) {
      var hold = Math.max(.3, d), end = t + hold + rel + .1, lp = ctx.createBiquadFilter(), g = ctx.createGain();
      lp.type = "lowpass"; lp.Q.value = .6;
      if (sweepFrom) { lp.frequency.setValueAtTime(sweepFrom, t); lp.frequency.exponentialRampToValueAtTime(cutoff, t + Math.min(atk * 1.6, hold)); } else lp.frequency.value = cutoff;
      g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(peak * v, t + atk); g.gain.setValueAtTime(peak * v, t + hold); g.gain.exponentialRampToValueAtTime(.0001, t + hold + rel);
      detunes.forEach(function (dt) { var os = E.osc(type, f, t, end, dt); E.vib.connect(os.detune); os.connect(lp); });
      lp.connect(g); g.connect(o);
    }
    INST.strings = function (E, f, t, d, v, o) { sustained(E, f, t, d, v, o, "sawtooth", [-8, 8], clamp(1400 + f * 2.5, 1500, 4500) * (.6 + E.bright * .8), .35, .8, .15); };
    INST.pad = function (E, f, t, d, v, o) {
      sustained(E, f, t, d, v, o, "sawtooth", [-9, 9], (900 + E.bright * 1100), .6, 1.2, .13, 450);
      var sub = E.osc("sine", f, t, t + Math.max(.3, d) + 1.3), sg = ctx.createGain(); sg.gain.setValueAtTime(.0001, t); sg.gain.linearRampToValueAtTime(.1 * v, t + .6); sg.gain.setValueAtTime(.1 * v, t + Math.max(.3, d)); sg.gain.exponentialRampToValueAtTime(.0001, t + Math.max(.3, d) + 1.2);
      sub.connect(sg); sg.connect(o);
    };
    INST.choir = function (E, f, t, d, v, o) {
      var hold = Math.max(.4, d), end = t + hold + 1, g = ctx.createGain(), forms = [[800, 1.2, .9], [1150, 2, .5], [2900, 5, .22]];
      g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(.45 * v, t + .5); g.gain.setValueAtTime(.45 * v, t + hold); g.gain.exponentialRampToValueAtTime(.0001, t + hold + .9); g.connect(o);
      var srcs = [E.osc("sawtooth", f, t, end, -6), E.osc("sawtooth", f, t, end, 6)];
      srcs.forEach(function (os) { E.vib.connect(os.detune); });
      forms.forEach(function (fm) { var bp = ctx.createBiquadFilter(), fg = ctx.createGain(); bp.type = "bandpass"; bp.frequency.value = fm[0]; bp.Q.value = fm[1] * 4; fg.gain.value = fm[2]; srcs.forEach(function (os) { os.connect(bp); }); bp.connect(fg); fg.connect(g); });
    };
    INST.flute = function (E, f, t, d, v, o) {
      var hold = Math.max(.25, d), end = t + hold + .3, g = ctx.createGain(), a = E.osc("sine", f, t, end), b = E.osc("sine", f * 2, t, end), bg = ctx.createGain();
      E.vib.connect(a.detune); g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(.5 * v, t + .07); g.gain.setValueAtTime(.5 * v, t + hold); g.gain.exponentialRampToValueAtTime(.0001, t + hold + .15);
      bg.gain.value = .1; a.connect(g); b.connect(bg); bg.connect(g); g.connect(o);
      E.noise(t, hold + .1, "bandpass", Math.min(7000, f * 3), 1.1, .045 * v, hold + .1, o);
    };
    /* vibrato that fades in after the note settles, like a player would (depth in cents multiplier) */
    function lateVib(E, os, t, depth, delay) {
      var vg = ctx.createGain(); vg.gain.setValueAtTime(0, t); vg.gain.setValueAtTime(0, t + delay); vg.gain.linearRampToValueAtTime(depth, t + delay + .35); E.vib.connect(vg); vg.connect(os.detune);
    }
    INST.sax = function (E, f, t, d, v, o) {
      var hold = Math.max(.25, d), end = t + hold + .25, g = ctx.createGain(), lp = ctx.createBiquadFilter(), hon = ctx.createBiquadFilter(), body = ctx.createBiquadFilter();
      lp.type = "lowpass"; lp.Q.value = .9; lp.frequency.setValueAtTime(Math.min(3200, f * 4 + 500), t); lp.frequency.linearRampToValueAtTime(Math.min(4200, f * 6 + 900), t + .1); lp.frequency.linearRampToValueAtTime(Math.min(2600, f * 4 + 600), t + hold);
      hon.type = "peaking"; hon.frequency.value = 1150; hon.Q.value = 1.4; hon.gain.value = 7;
      body.type = "peaking"; body.frequency.value = 2400; body.Q.value = 1; body.gain.value = 3;
      g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(.55 * v, t + .05); g.gain.setValueAtTime(.55 * v, t + hold * .85); g.gain.exponentialRampToValueAtTime(.0001, t + hold + .18);
      var a = E.osc("sawtooth", f, t, end, 0), b = E.osc("square", f, t, end, 6), bg = ctx.createGain(); bg.gain.value = .35;
      /* reed scoop: pitch rises into the note */
      [a, b].forEach(function (os) { if (!E.curGl) { os.frequency.setValueAtTime(f * .965, t); os.frequency.exponentialRampToValueAtTime(f, t + .045); } lateVib(E, os, t, 2.4, .22); });
      a.connect(lp); b.connect(bg); bg.connect(lp); lp.connect(hon); hon.connect(body); body.connect(g); g.connect(o);
      E.noise(t, hold + .1, "bandpass", Math.min(6000, f * 4 + 800), 1.4, .05 * v, hold + .1, o);
    };
    INST.violin = function (E, f, t, d, v, o) {
      var hold = Math.max(.3, d), end = t + hold + .3, g = ctx.createGain(), lp = ctx.createBiquadFilter(), b1 = ctx.createBiquadFilter(), b2 = ctx.createBiquadFilter();
      lp.type = "lowpass"; lp.Q.value = .7; lp.frequency.setValueAtTime(Math.min(3000, f * 3 + 700), t); lp.frequency.linearRampToValueAtTime(clamp(f * 6 + 800, 2200, 6000), t + .25);
      b1.type = "peaking"; b1.frequency.value = 450; b1.Q.value = 1.2; b1.gain.value = 5;
      b2.type = "peaking"; b2.frequency.value = 2900; b2.Q.value = 1.5; b2.gain.value = 4;
      g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(.5 * v, t + .11); g.gain.setValueAtTime(.5 * v, t + hold * .9); g.gain.exponentialRampToValueAtTime(.0001, t + hold + .28);
      var dts = E.lite ? [0] : [-5, 5];
      dts.forEach(function (dt) { var os = E.osc("sawtooth", f, t, end, dt); lateVib(E, os, t, 4.2, .18); os.connect(lp); });
      lp.connect(b1); b1.connect(b2); b2.connect(g); g.connect(o);
      /* bow noise: a short scrape at the start, a quiet hiss while it sounds */
      E.noise(t, .09, "highpass", 3500, .8, .07 * v, .09, o);
      E.noise(t, hold + .1, "bandpass", Math.min(7000, f * 5), 1.2, .02 * v, hold + .1, o);
    };
    INST.brass = function (E, f, t, d, v, o) { sustained(E, f, t, d, v, o, "sawtooth", [-4, 4], Math.min(5000, 900 + f * 5), .04, .15, .3, 350); };
    INST.synth = function (E, f, t, d, v, o) {
      var dec = clamp(d * 1.1, .12, 1.2), a = E.osc("triangle", f, t, t + dec + .1), b = E.osc("square", f * 1.004, t, t + dec + .1), gb = ctx.createGain(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
      gb.gain.value = .18; lp.type = "lowpass"; lp.frequency.value = 2600; lp.Q.value = 1;
      g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(.55 * v, t + .006); g.gain.exponentialRampToValueAtTime(.0001, t + dec);
      a.connect(lp); b.connect(gb); gb.connect(lp); lp.connect(g); g.connect(o);
    };
    INST.sub = function (E, f, t, d, v, o) {
      var hold = Math.max(.15, d * .95), end = t + hold + .2, g = ctx.createGain(), a = E.osc("sine", f, t, end), b = E.osc("triangle", f * 2, t, end), bg = ctx.createGain();
      bg.gain.value = .38; g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(.9 * v, t + .008); g.gain.setValueAtTime(.9 * v, t + hold); g.gain.exponentialRampToValueAtTime(.0001, t + hold + .12);
      a.connect(g); b.connect(bg); bg.connect(g); g.connect(o);
    };
    INST["808"] = function (E, f, t, d, v, o) {
      var dur = clamp(d * 1.25, .5, 2.4), end = t + dur, os = ctx.createOscillator(), g = ctx.createGain(), h = ctx.createOscillator(), hg = ctx.createGain();
      os.type = "sine";
      if (E.curGl) { os.frequency.setValueAtTime(f * Math.pow(2, E.curGl / 12), t); os.frequency.exponentialRampToValueAtTime(f, t + .11); } else { os.frequency.setValueAtTime(f * 2.2, t); os.frequency.exponentialRampToValueAtTime(f, t + .05); }
      g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(.95 * v, t + .004); g.gain.exponentialRampToValueAtTime(.5 * v, t + dur * .45); g.gain.exponentialRampToValueAtTime(.0001, end);
      h.type = "triangle"; h.frequency.value = f * 2; hg.gain.setValueAtTime(.22 * v, t); hg.gain.exponentialRampToValueAtTime(.0001, t + dur * .45);
      var sh = ctx.createWaveShaper(), shg = ctx.createGain(); sh.curve = satCurve; shg.gain.value = .16;
      os.connect(g); g.connect(o); g.connect(sh); sh.connect(shg); shg.connect(o); h.connect(hg); hg.connect(o); os.start(t); h.start(t); os.stop(end + .05); h.stop(end + .05);
    };
    INST.synthbass = function (E, f, t, d, v, o) {
      var len = Math.max(.1, d), end = t + len + .12, lp = ctx.createBiquadFilter(), g = ctx.createGain(), g3 = ctx.createGain();
      var o1 = E.osc("sawtooth", f, t, end), o2 = E.osc("sine", f, t, end), o3 = E.osc("sine", f * 2, t, end);
      g3.gain.value = .35; lp.type = "lowpass"; lp.Q.value = 3; lp.frequency.setValueAtTime(1100, t); lp.frequency.exponentialRampToValueAtTime(260, t + len);
      g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(.7 * v, t + .01); g.gain.setValueAtTime(.7 * v, t + Math.max(.02, len * .6)); g.gain.exponentialRampToValueAtTime(.0001, t + len + .06);
      o1.connect(lp); lp.connect(g); o2.connect(g); o3.connect(g3); g3.connect(g); g.connect(o);
    };
    INST.log = function (E, f, t, d, v, o) {
      var lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 1200; lp.connect(o);
      E.tone(t, "sine", f * 1.55, f, .05, .95 * v, .45, lp); E.tone(t, "triangle", f * 2, f * 2, .01, .2 * v, .16, lp);
    };


    /* ── band instruments: guitars, basses, organ, horns, clavinet ── */
    var distCurve = new Float32Array(2048);
    for (i = 0; i < 2048; i++) { var dx = i / 1024 - 1; distCurve[i] = Math.tanh(dx * 5) * .8; }
    var odCurve = new Float32Array(2048);
    for (i = 0; i < 2048; i++) { var ox = i / 1024 - 1; odCurve[i] = Math.tanh(ox * 2.2) * .85; }
    /* guitar amp: oscillators -> preamp gain -> clipper -> mid hump -> speaker low-pass */
    function ampGuitar(E, f, t, d, v, o, o1, pre, curve, cut, peak, vib) {
      var hold = Math.max(.1, d), rel = .12, end = t + hold + rel + .08, g = ctx.createGain(), p = ctx.createGain(), sh = ctx.createWaveShaper(), mid = ctx.createBiquadFilter(), lp = ctx.createBiquadFilter();
      p.gain.value = pre; sh.curve = curve; mid.type = "peaking"; mid.frequency.value = 1200; mid.gain.value = 4; mid.Q.value = .8;
      lp.type = "lowpass"; lp.frequency.value = clamp(cut + f * .8, cut, cut + 1500); lp.Q.value = .6;
      g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(peak * v, t + .005);
      g.gain.exponentialRampToValueAtTime(peak * v * .55, t + Math.max(.09, hold * .9)); g.gain.exponentialRampToValueAtTime(.0001, t + hold + rel);
      o1.forEach(function (c) { var os = E.osc(c[0], f * (c[2] || 1), t, end, c[1]); if (vib) E.vib.connect(os.detune); var cg = ctx.createGain(); cg.gain.value = c[3] === undefined ? 1 : c[3]; os.connect(cg); cg.connect(p); });
      p.connect(sh); sh.connect(mid); mid.connect(lp); lp.connect(g); g.connect(o);
      if (!E.lite) E.noise(t, .025, "bandpass", Math.min(4000, f * 6), 1.2, .05 * v, .012, o);
    }
    INST.eguitar = function (E, f, t, d, v, o) {
      pluckVoice(E, f, t, d, v, o, .9978, 1.7, .2, 5400, 2.2, .4, .85);
      if (!E.lite) E.noise(t, .02, "bandpass", Math.min(5000, f * 5), 1.5, .04 * v, .012, o);
    };
    INST.dguitar = function (E, f, t, d, v, o) { ampGuitar(E, f, t, d, v, o, [["sawtooth", -6], ["sawtooth", 6], ["square", 0, 1, .35]], 4.5, distCurve, 2600, .34, false); };
    INST.lguitar = function (E, f, t, d, v, o) { ampGuitar(E, f, t, d, v, o, [["sawtooth", -4], ["triangle", 3, 1, .8], ["sawtooth", 5, 2, .12]], 2.6, odCurve, 3200, .4, true); };
    INST.ebass = function (E, f, t, d, v, o) {
      var len = Math.max(.12, d * .95), end = t + len + .14, lp = ctx.createBiquadFilter(), g = ctx.createGain(), cg = ctx.createGain();
      var a = E.osc("sawtooth", f, t, end), b = E.osc("sine", f, t, end), c = E.osc("triangle", f * 2, t, end);
      lp.type = "lowpass"; lp.Q.value = 1.2; lp.frequency.setValueAtTime(clamp(f * 14, 500, 1800), t); lp.frequency.exponentialRampToValueAtTime(clamp(f * 3.2, 160, 600), t + Math.min(.22, len));
      g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(.8 * v, t + .006); g.gain.exponentialRampToValueAtTime(.5 * v, t + Math.min(.3, len)); g.gain.setValueAtTime(.5 * v, t + len * .85); g.gain.exponentialRampToValueAtTime(.0001, t + len + .09);
      cg.gain.value = .18; a.connect(lp); lp.connect(g); b.connect(g); c.connect(cg); cg.connect(g); g.connect(o);
    };
    INST.upbass = function (E, f, t, d, v, o) {
      pluckVoice(E, f, t, d, v, o, .9955, 1.5, .12, 1100, 1.1, .3, 1.15);
      var sub = ctx.createOscillator(), sg = ctx.createGain(), hold = Math.max(.2, d);
      sub.type = "sine"; sub.frequency.value = f; sg.gain.setValueAtTime(.0001, t); sg.gain.linearRampToValueAtTime(.3 * v, t + .012); sg.gain.exponentialRampToValueAtTime(.0001, t + hold + .12);
      sub.connect(sg); sg.connect(o); sub.start(t); sub.stop(t + hold + .2);
      if (!E.lite) E.noise(t, .04, "bandpass", 220, 1.5, .18 * v, .02, o);
    };
    INST.hammond = function (E, f, t, d, v, o) {
      var hold = Math.max(.15, d), g = ctx.createGain(), sh = ctx.createWaveShaper(), sg = ctx.createGain();
      var bars = E.lite ? [[1, 1], [2, .7], [.5, .5]] : [[.5, .6], [1.5, .35], [1, 1], [2, .8], [3, .5], [4, .35]];
      g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(.19 * v, t + .008); g.gain.setValueAtTime(.19 * v, t + hold); g.gain.exponentialRampToValueAtTime(.0001, t + hold + .09);
      sh.curve = odCurve; sg.gain.value = .35; g.connect(o); g.connect(sh); sh.connect(sg); sg.connect(o);
      bars.forEach(function (b) { var os = E.osc("sine", f * b[0], t, t + hold + .2), bg = ctx.createGain(); E.vib.connect(os.detune); bg.gain.value = b[1]; os.connect(bg); bg.connect(g); });
      var pc = E.osc("sine", f * 3, t, t + .25), pg = ctx.createGain(); pg.gain.setValueAtTime(.5, t); pg.gain.exponentialRampToValueAtTime(.0001, t + .16); pc.connect(pg); pg.connect(g);
      if (!E.lite) E.noise(t, .02, "highpass", 3500, 1, .04 * v, .01, o);
    };
    INST.horns = function (E, f, t, d, v, o) {
      var hold = Math.max(.12, d * .9), end = t + hold + .2, lp = ctx.createBiquadFilter(), g = ctx.createGain();
      lp.type = "lowpass"; lp.Q.value = 1.1; lp.frequency.setValueAtTime(500, t); lp.frequency.exponentialRampToValueAtTime(Math.min(5200, 1300 + f * 4.5), t + .05); lp.frequency.exponentialRampToValueAtTime(Math.min(3200, 900 + f * 2.5), t + hold);
      g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(.3 * v, t + .02); g.gain.setValueAtTime(.26 * v, t + hold); g.gain.exponentialRampToValueAtTime(.0001, t + hold + .1);
      (E.lite ? [0] : [-9, 0, 9]).forEach(function (dt) { var os = E.osc("sawtooth", f, t, end, dt); E.vib.connect(os.detune); os.connect(lp); });
      lp.connect(g); g.connect(o);
    };
    INST.clav = function (E, f, t, d, v, o) {
      var dec = clamp(d * .8, .07, .35), a = E.osc("sawtooth", f, t, t + dec + .1), b = E.osc("square", f * 2.003, t, t + dec + .1), bg = ctx.createGain(), lp = ctx.createBiquadFilter(), pk = ctx.createBiquadFilter(), g = ctx.createGain();
      lp.type = "lowpass"; lp.Q.value = 1.4; lp.frequency.setValueAtTime(5200, t); lp.frequency.exponentialRampToValueAtTime(1400, t + .07);
      pk.type = "peaking"; pk.frequency.value = 2200; pk.gain.value = 5; pk.Q.value = 1;
      bg.gain.value = .25; g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(.55 * v, t + .002); g.gain.exponentialRampToValueAtTime(.0001, t + dec);
      a.connect(lp); b.connect(bg); bg.connect(lp); lp.connect(pk); pk.connect(g); g.connect(o);
    };

    /* ── drums ── */
    var DRUM = {
      kick: function (E, t, v, K, o) { E.tone(t, "sine", K.kickStart, K.kickEnd, .12, v, K.kickDecay, o); E.tone(t, "sine", K.kickStart * 2.2, K.kickStart * .9, .03, .4 * v, .07, o); E.noise(t, .03, "bandpass", 2800, 1, .3 * v, .012, o); },
      snare: function (E, t, v, K, o) { E.playSample(E.noiseSample("snare" + K.snareNoise + K.snareDecay, [{ at: 0, sec: .3, type: "highpass", fc: 1800, q: .7, decay: K.snareDecay, peak: K.snareNoise }]), t, v, o); E.tone(t, "triangle", K.snareTone, K.snareTone * .7, .08, .5 * v, K.snareDecay * .75, o); },
      clap: function (E, t, v, K, o) {
        var b = E.noiseSample("clap" + K.clapFreq, [{ at: 0, sec: .05, type: "bandpass", fc: K.clapFreq, q: 1.1, decay: .025, peak: .7 }, { at: .011, sec: .05, type: "bandpass", fc: K.clapFreq, q: 1.1, decay: .025, peak: .7 }, { at: .022, sec: .05, type: "bandpass", fc: K.clapFreq, q: 1.1, decay: .025, peak: .7 }, { at: .033, sec: .25, type: "bandpass", fc: K.clapFreq - 100, q: 1.1, decay: .17, peak: .6 }]);
        E.playSample(b, t, v, o);
      },
      hat: function (E, t, v, K, o) { E.playSample(E.noiseSample("hat" + K.hatFreq + K.hatDecay, [{ at: 0, sec: .14, type: "highpass", fc: K.hatFreq, q: .7, decay: K.hatDecay, peak: .32 }]), t, v, o); },
      open: function (E, t, v, K, o) { E.playSample(E.noiseSample("open" + K.hatFreq + K.hatDecay, [{ at: 0, sec: .45, type: "highpass", fc: K.hatFreq - 1000, q: .7, decay: K.hatDecay * 6.5, peak: .3 }]), t, v, o); },
      rim: function (E, t, v, K, o) { E.tone(t, "sine", 1700, 1500, .01, .4 * v, .03, o); E.playSample(E.noiseSample("rim", [{ at: 0, sec: .05, type: "bandpass", fc: 3000, q: 2, decay: .02, peak: .25 }]), t, v, o); },
      shaker: function (E, t, v, K, o) { E.playSample(E.noiseSample("shaker", [{ at: 0, sec: .1, type: "bandpass", fc: 6500, q: 1, decay: .055, peak: .22 }]), t, v, o); },
      conga: function (E, t, v, K, o, ev) { var hi = (ev && ev.s % 2 === 1), f = hi ? 330 : 220; E.tone(t, "sine", f * 1.15, f, .04, .6 * v, .2, o); E.noise(t, .04, "bandpass", 1800, 1.4, .12 * v, .02, o); },
      tom: function (E, t, v, K, o, ev) { var f = [200, 150, 110, 78][clamp((ev && ev.n) !== undefined ? ev.n : 2, 0, 3)]; E.tone(t, "sine", f * 1.45, f, .09, .85 * v, .55, o); E.noise(t, .05, "bandpass", 900, 1, .1 * v, .03, o); },
      ride: function (E, t, v, K, o, ev) {
        E.playSample(E.noiseSample("ride", [{ at: 0, sec: .9, type: "highpass", fc: 6200, q: .6, decay: .5, peak: .2 }]), t, v, o);
        E.tone(t, "sine", 3400, 3400, .001, .07 * v * (ev && ev.bell ? 2 : 1), .35, o); E.tone(t, "sine", 5100, 5100, .001, .05 * v, .28, o); E.tone(t, "sine", 2270, 2270, .001, .05 * v, .5, o);
      },
      tamb: function (E, t, v, K, o) { E.playSample(E.noiseSample("tamb", [{ at: 0, sec: .12, type: "highpass", fc: 7500, q: 1, decay: .06, peak: .2 }, { at: .025, sec: .1, type: "bandpass", fc: 9500, q: 2, decay: .05, peak: .12 }]), t, v, o); },
      cow: function (E, t, v, K, o) { E.tone(t, "square", 587, 587, .001, .11 * v, .1, o); E.tone(t, "square", 845, 845, .001, .09 * v, .08, o); },
      chick: function (E, t, v, K, o) { E.playSample(E.noiseSample("chick", [{ at: 0, sec: .06, type: "bandpass", fc: 5200, q: 1.2, decay: .03, peak: .3 }]), t, v, o); },
      crash: function (E, t, v, K, o) { E.playSample(E.noiseSample("crash", [{ at: 0, sec: 2.2, type: "highpass", fc: 3500, q: .6, decay: 1.7, peak: .35 }]), t, v, o); }
    };
    E.drum = function (ev, t, bar) {
      var K = KITS[bar.kit] || KITS.classic, name = ev.k, strip = ev.r === "perc" ? (PERC_STRIP[name] || "hats") : "drums", o = E.strips[strip].in, vel = clamp(ev.v, .02, 1.2);
      if (ev.pan && ctx.createStereoPanner) { var pn = ctx.createStereoPanner(); pn.pan.value = clamp(ev.pan, -1, 1); pn.connect(o); o = pn; }
      if (name === "kick") kickDuck(t);
      if (DRUM[name]) DRUM[name](E, t, vel, K, o, ev);
    };
    E.fx = function (ev, t, bar) {
      var o = E.strips.fx.in;
      if (ev.k === "riser") {
        var dur = Math.min(24, ev.d * bar.stepDur), s = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
        s.buffer = noiseBuf; s.loop = true; bp.type = "bandpass"; bp.Q.value = 1.4; bp.frequency.setValueAtTime(300, t); bp.frequency.exponentialRampToValueAtTime(9000, t + dur);
        g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.5 * ev.v, t + dur * .97); g.gain.linearRampToValueAtTime(0, t + dur);
        s.connect(bp); bp.connect(g); g.connect(o); s.start(t, Math.random()); s.stop(t + dur + .05);
      } else if (ev.k === "revcrash") {
        var rd = Math.min(4, ev.d * bar.stepDur), s2 = ctx.createBufferSource(), hp2 = ctx.createBiquadFilter(), g2 = ctx.createGain();
        s2.buffer = noiseBuf; s2.loop = true; hp2.type = "highpass"; hp2.frequency.setValueAtTime(1200, t); hp2.frequency.exponentialRampToValueAtTime(6500, t + rd);
        g2.gain.setValueAtTime(.0001, t); g2.gain.exponentialRampToValueAtTime(.6 * ev.v, t + rd * .96); g2.gain.linearRampToValueAtTime(0, t + rd + .03);
        s2.connect(hp2); hp2.connect(g2); g2.connect(o); s2.start(t, Math.random()); s2.stop(t + rd + .1);
      } else if (ev.k === "fall") {
        var fd = Math.min(3, ev.d * bar.stepDur), s3 = ctx.createBufferSource(), bp3 = ctx.createBiquadFilter(), g3 = ctx.createGain();
        s3.buffer = noiseBuf; s3.loop = true; bp3.type = "bandpass"; bp3.Q.value = 1.1; bp3.frequency.setValueAtTime(7000, t); bp3.frequency.exponentialRampToValueAtTime(380, t + fd);
        g3.gain.setValueAtTime(.35 * ev.v, t); g3.gain.exponentialRampToValueAtTime(.0001, t + fd);
        s3.connect(bp3); bp3.connect(g3); g3.connect(o); s3.start(t, Math.random()); s3.stop(t + fd + .05);
      } else if (ev.k === "impact") {
        E.tone(t, "sine", 62, 30, .6, .9 * ev.v, 1.8, o); E.noise(t, 1.4, "lowpass", 500, .7, .5 * ev.v, 1.2, o);
      }
    };

    /* ── per-bar mix: filter, reverb, delay, sidechain depth, textures ── */
    E.setMix = function (mix, t, bar) {
      var tc = Math.max(.05, bar.barDur / 3), maxCut = 5500 + mix.bright * 12500;
      E.bright = mix.bright; E.grit = mix.grit || 0; E.duckDepth = mix.duck || 0;
      E.wowAmt.gain.setTargetAtTime(mix.wobble || 0, t, .6);
      trim.gain.setTargetAtTime((opts.trim || .4) * (mix.level || 1), t, .8);
      tone.frequency.setTargetAtTime(300 * Math.pow(maxCut / 300, clamp(mix.cut, 0, 1)), t, tc);
      var beat = 60 / bar.bpm; dl.delayTime.setTargetAtTime(beat * .75, t, .05); dr.delayTime.setTargetAtTime(beat * .75, t, .05);
      Object.keys(E.strips).forEach(function (n) {
        var s = E.strips[n];
        s.rv.gain.setTargetAtTime(s.cfg.rv * mix.wet * (.5 + mix.space), t, tc);
        s.dy.gain.setTargetAtTime(s.cfg.dy * (mix.delay / .22), t, tc);
      });
      ["vinyl", "rain", "air"].forEach(function (k) { var lv = mix.tex ? mix.tex[k] : 0; if (solo && solo !== "tex") lv = 0; if (lv > 0 || tex[k]) ensureTex(k).g.gain.setTargetAtTime(lv, t, 1.2); });
    };

    /* ── voice budget: a phone can only synthesize so many voices at once ── */
    var voices = [], cap = E.lite ? 40 : 90;
    E.quality = E.lite ? 1 : 0;
    /* 0 = full, 1 = lite (fewer oscillators and voices), 2 = minimal. Can be changed while a piece plays. */
    E.setQuality = function (q) { E.quality = q; E.lite = q >= 1; cap = q >= 2 ? 18 : q === 1 ? 40 : 90; };
    E.admit = function (ev, t, cost, dur) {
      var n = 0, k; for (k = voices.length - 1; k >= 0; k--) { if (voices[k] < t - .05) voices.splice(k, 1); else n++; }
      var prio = ev.p || 2;
      if ((prio >= 3 && n > cap * .6) || (prio === 2 && n > cap * .85) || n > cap * 1.3) return false;
      voices.push(t + dur); if (cost > 1) for (k = 1; k < cost; k++) voices.push(t + dur); return true;
    };

    E.note = function (ev, t, bar) {
      var name = ev.i, fn = INST[name]; if (!fn) return;
      var sec = ev.d * bar.stepDur, o = ev.r === "bass" ? E.bassOut() : E.strips[ROLE_STRIP[ev.r]].in;
      if (!E.admit(ev, t, COST[name] || 2, sec + .3)) return;
      var pv = ev.pan !== undefined ? ev.pan : (E.lite ? 0 : ev.r === "pad" ? ((ev.m % 5) - 2) * .15 : ev.r === "comp" ? ((ev.m % 3) - 1) * .16 : (ev.r === "lead" && ev.ans) ? -.28 : 0);
      if (pv && ctx.createStereoPanner) { var pn = ctx.createStereoPanner(); pn.pan.value = clamp(pv, -1, 1); pn.connect(o); o = pn; }
      E.curGl = ev.gl || 0; E.curDet = (Math.random() - .5) * 6;
      try { fn(E, mtof(ev.m), t, sec, clamp(ev.v, .02, 1.2) * (LOUD[name] || 1), o); } finally { E.curGl = 0; E.curDet = 0; }
    };
    function stepTime(s, bar) {
      var base = s * bar.stepDur, r = Math.round(s);
      if (bar.swing > 0 && r % 2 === 1 && Math.abs(s - r) < .2) base += bar.swing * .333 * bar.stepDur;
      if (bar.swing8 > 0 && r % 4 === 2 && Math.abs(s - r) < .2) base += bar.swing8 * .667 * bar.stepDur;
      return base;
    }
    /* where each part sits against the grid (seconds, scaled by the style's "lay-back"): kick pushes, snare and lead lean back */
    var LAY = { kick: -.004, snare: .012, clap: .012, hat: .002, open: .002, bass: .006, lead: .014, comp: .008, arp: .004 }, drift = 0;
    E.playBar = function (bar, t0) {
      E.setMix(bar.mix, t0, bar);
      drift = drift * .7 + (Math.random() - .5) * .008 * (bar.human || 0);
      for (var k = 0; k < bar.events.length; k++) {
        var ev = bar.events[k], key = ev.r === "perc" ? "hats" : ev.r === "drums" ? "drums" : ev.r;
        if (solo && key !== solo) continue;
        if (muted.indexOf(key) >= 0) continue;
        var t = t0 + stepTime(ev.s, bar) + drift + (LAY[(ev.r === "drums" || ev.r === "perc") ? ev.k : ev.r] || 0) * (bar.lay || 0);
        if (bar.human > 0) t += (Math.random() - .5) * (ev.r === "drums" || ev.r === "perc" ? .006 : .014) * bar.human;
        if (t < t0) t = t0;
        if (ev.r === "drums" || ev.r === "perc") E.drum(ev, t, bar);
        else if (ev.r === "fx") E.fx(ev, t, bar);
        else E.note(ev, t, bar);
      }
    };
    E.fadeIn = function (t, dur) { E.out.gain.cancelScheduledValues(t); E.out.gain.setValueAtTime(.0001, t); E.out.gain.linearRampToValueAtTime(1, t + dur); };
    E.fadeOut = function (t, dur) { E.out.gain.cancelScheduledValues(t); E.out.gain.setValueAtTime(E.out.gain.value, t); E.out.gain.linearRampToValueAtTime(0, t + dur); };
    E.dispose = function () {
      try { vibLfo.stop(); } catch (e) {}
      Object.keys(tex).forEach(function (k) { try { tex[k].src.stop(); } catch (e) {} });
      setTimeout(function () { try { E.out.disconnect(); } catch (e) {} }, 400);
    };
    E.INST = INST; E.DRUM = DRUM;
    return E;
  }

  /* ═══════════════ 6. player + public API ═══════════════ */
  var AC = global.AudioContext || global.webkitAudioContext;
  var VOL_KEY = "yoecho_music_vol";
  var LOOKAHEAD = 1.6, TICK = 220;
  var P = { outs: [], mix: null, ctx: null, volG: null, duckG: null, holdG: null, analyser: null, vol: .8, piece: null, timer: null, listeners: [], paused: false, ducked: false, held: false, lastBrief: null, lite: false, lvlBuf: null };
  try { var sv = parseFloat(global.localStorage.getItem(VOL_KEY)); if (isFinite(sv)) P.vol = clamp(sv, 0, 1); } catch (e) {}
  try { var nav = global.navigator || {}; P.lite = !!((nav.hardwareConcurrency && nav.hardwareConcurrency <= 4) || (nav.deviceMemory && nav.deviceMemory <= 2) || /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent || "")); } catch (e) {}
  P.quality = P.lite ? 1 : 0;

  function emit(type, extra) { var o = extra || {}; o.type = type; P.listeners.slice().forEach(function (fn) { try { fn(o); } catch (e) {} }); }
  function ensureCtx() {
    if (!AC) return null;
    if (!P.ctx) {
      try { P.ctx = new AC({ latencyHint: "playback" }); } catch (e) { P.ctx = new AC(); }
      var c = P.ctx;
      P.volG = c.createGain(); P.volG.gain.value = P.vol;
      P.duckG = c.createGain(); P.holdG = c.createGain();
      P.analyser = c.createAnalyser(); P.analyser.fftSize = 512; P.lvlBuf = new Float32Array(512);
      P.volG.connect(P.duckG); P.duckG.connect(P.holdG); P.holdG.connect(P.analyser); P.analyser.connect(c.destination);
    }
    if (P.ctx.state === "suspended" && !P.paused) { try { P.ctx.resume(); } catch (e) {} }
    return P.ctx;
  }
  function unlock() {
    var c = ensureCtx(); if (!c) return false;
    try { var b = c.createBuffer(1, 1, 22050), s = c.createBufferSource(); s.buffer = b; s.connect(c.destination); s.start(0); } catch (e) {}
    return true;
  }

  function tick() {
    var pc = P.piece; if (!pc || P.paused || !P.ctx) return;
    var c = P.ctx;
    /* the browser can suspend or "interrupt" audio (after the microphone, a call, another app): bring it back */
    if (c.state !== "running" && !(global.document && global.document.hidden)) { try { c.resume(); } catch (e) {} }
    health(pc);
    var list = [pc].concat(P.outs), k;
    for (k = 0; k < list.length; k++) drive(list[k], c);
    P.outs = P.outs.filter(function (o) {
      if (o.done && c.currentTime > o.endT + 3) { o.eng.dispose(); return false; }
      return true;
    });
  }
  function drive(pc, c) {
    if (pc.nextT < c.currentTime) pc.nextT = c.currentTime + .05;      /* fell behind (throttled tab): re-sync */
    while (pc.nextT < c.currentTime + LOOKAHEAD) {
      if (pc.endT && pc.nextT >= pc.endT) {
        pc.done = true;
        if (pc === P.piece && !pc.finished) { pc.finished = true; setTimeout(function () { if (P.piece === pc) { emit("mixend", {}); stop(); } }, 400); }
        break;
      }
      var bar;
      try { bar = pc.comp.nextBar(); } catch (e) {
        /* a composer fault must never mean silence: after two faults in a row, swap in a fresh built-in composer */
        pc.faults = (pc.faults || 0) + 1; emit("error", { message: String(e && e.message || e) });
        if (pc.faults >= 2) { pc.faults = 0; try { var lb = {}; for (var q in (P.lastBrief || {})) lb[q] = P.lastBrief[q]; delete lb.planSrc; lb.seed = randomSeed(); pc.comp = Composer(parseBrief(lb), lb.seed); } catch (e2) {} }
        pc.nextT += .25; continue;
      }
      if (P.mix && P.mix.ctl) {
        var made = P.mix.ctl.afterBar(pc, bar);
        if (made) { P.outs.push(P.piece); P.piece = made; mediaSession(info()); emit("mixtrack", { info: info(), index: P.mix.ctl.idx, total: P.mix.ctl.plan.tracks.length }); }
      }
      try { pc.eng.playBar(bar, pc.nextT); } catch (e) { emit("error", { message: String(e && e.message || e) }); }
      if (bar.secStart && pc === P.piece) {
        (function (b, at) { setTimeout(function () { if (P.piece === pc) emit("section", { section: b.sec.kind, mood: b.mood, style: b.style, bpm: Math.round(b.bpm), info: pc.comp.info() }); }, Math.max(0, (at - c.currentTime) * 1000)); })(bar, pc.nextT);
      }
      pc.nextT += bar.barDur; pc.bars++;
    }
  }
  /* is this device keeping up? If the audio clock falls behind the wall clock, step down to a lighter sound. */
  function health(pc) {
    var c = P.ctx, now = Date.now();
    if (c.state !== "running" || (global.document && global.document.hidden)) { pc.h = null; return; }
    if (!pc.h) { pc.h = { w0: now, a0: c.currentTime, lag0: null, last: now }; return; }
    if (now - pc.h.last < 2000) return;
    pc.h.last = now;
    var lag = (now - pc.h.w0) / 1000 - (c.currentTime - pc.h.a0);
    if (pc.h.lag0 === null) { pc.h.lag0 = lag; return; }
    if (lag - pc.h.lag0 > .35 && P.quality < 2) { P.quality++; pc.eng.setQuality(P.quality); pc.h.lag0 = lag; emit("quality", { quality: P.quality }); }
  }
  function startTimer() { if (!P.timer) P.timer = setInterval(tick, TICK); }
  function stopTimer() { if (P.timer) { clearInterval(P.timer); P.timer = null; } }
  if (global.document && global.document.addEventListener) {
    global.document.addEventListener("visibilitychange", function () { if (!global.document.hidden) tick(); });
    /* any tap brings suspended audio back (some browsers only allow resuming from a user gesture) */
    ["pointerdown", "touchend", "keydown"].forEach(function (ev) { global.document.addEventListener(ev, function () { if (P.piece && !P.paused && P.ctx && P.ctx.state !== "running") { try { P.ctx.resume(); } catch (e) {} } }, true); });
  }

  function seedStr(pc) { return seedToStr(pc.seed); }
  function info() {
    var pc = P.piece, i = pc ? pc.comp.info() : {};
    i.sleepMin = P.sleepAt ? Math.max(0, Math.round((P.sleepAt - Date.now()) / 60000)) : 0; i.quality = P.quality; i.playing = !!pc && !P.paused; i.paused = P.paused; i.active = !!pc; i.ducked = P.ducked; i.held = P.held; i.volume = P.vol;
    if (pc) { i.seedStr = seedStr(pc); i.elapsed = P.ctx ? Math.max(0, P.ctx.currentTime - pc.start) : 0; }
    return i;
  }
  function mediaSession(inf) {
    try {
      var ms = global.navigator && global.navigator.mediaSession; if (!ms || !global.MediaMetadata) return;
      ms.metadata = new global.MediaMetadata({ title: inf.title, artist: "YoEcho", album: inf.mood + " · " + inf.styleName });
      ms.setActionHandler("play", function () { resume(); }); ms.setActionHandler("pause", function () { pause(); }); ms.setActionHandler("nexttrack", function () { next(); });
    } catch (e) {}
  }

  function play(brief, opts) {
    opts = opts || {};
    var c = ensureCtx(); if (!c) { emit("error", { message: "Web Audio is not supported here" }); return null; }
    var pb = parseBrief(brief), seed = pb.seed !== undefined ? pb.seed : randomSeed();
    var keep = {}; for (var k in pb) if (k !== "seed" && k !== "plan") keep[k] = pb[k];
    if (pb.planSrc) { delete keep.key; delete keep.mode; delete keep.bpm; delete keep.instruments; delete keep.style; }   /* the plan carries these; a fresh piece must not inherit its key and tempo */
    P.lastBrief = keep;
    var comp = Composer(pb, seed), eng = Engine(c, P.volG, { lite: P.quality >= 1 }), now = c.currentTime; eng.setQuality(P.quality);
    if (!opts.keepMix) P.mix = null;
    P.outs.forEach(function (o) { o.eng.fadeOut(now, 1.2); setTimeout(function () { o.eng.dispose(); }, 1500); }); P.outs = [];
    if (P.piece) { var old = P.piece; old.eng.fadeOut(now, 1.8); setTimeout(function () { old.eng.dispose(); }, 2000); }
    eng.fadeIn(now, opts.fade || 2.2);
    P.piece = { comp: comp, eng: eng, nextT: now + .12, bars: 0, start: now, seed: seed, t0: Date.now() };
    P.paused = false;
    if (c.state === "suspended") { try { c.resume(); } catch (e) {} }
    P.holdG.gain.setTargetAtTime(P.held ? 0 : 1, now, .05);
    startTimer(); tick();
    var inf = info(); mediaSession(inf); try { global.navigator.mediaSession.playbackState = "playing"; } catch (e) {}
    emit("start", { info: inf });
    return inf;
  }
  function next() {
    if (P.mix && P.piece) { P.mix.ctl.skip(); return info(); }
    if (!P.lastBrief) return null;
    var pc = P.piece;
    if (pc && Date.now() - pc.t0 < 25000) { var st = pc.comp.info().style; taste.styles[st] = (taste.styles[st] || 0) - .5; saveTaste(); }
    var nb = {}; for (var q in P.lastBrief) nb[q] = P.lastBrief[q]; delete nb.planSrc;   /* a new piece composes its own structure */
    return play(nb);
  }
  function pause() {
    if (!P.piece || P.paused || !P.ctx) return;
    P.paused = true; var c = P.ctx;
    P.holdG.gain.setTargetAtTime(0, c.currentTime, .05);
    setTimeout(function () { if (P.paused) { try { c.suspend(); } catch (e) {} } }, 220);
    try { global.navigator.mediaSession.playbackState = "paused"; } catch (e) {}
    emit("pause", { info: info() });
  }
  function resume() {
    if (!P.piece || !P.paused || !P.ctx) return;
    var c = P.ctx; P.paused = false; P.piece.h = null;
    try { c.resume(); } catch (e) {}
    P.holdG.gain.setTargetAtTime(P.held ? 0 : 1, c.currentTime, .15);
    startTimer(); tick();
    try { global.navigator.mediaSession.playbackState = "playing"; } catch (e) {}
    emit("resume", { info: info() });
  }
  /* sleep timer: after the given minutes the music fades out and stops; sleep(0) cancels it */
  function sleep(min) {
    if (P.sleepT) { clearTimeout(P.sleepT); P.sleepT = null; } P.sleepAt = 0;
    min = Number(min); if (!(min > 0)) { emit("sleep", { info: info() }); return 0; }
    min = Math.min(min, 600); P.sleepAt = Date.now() + min * 60000;
    P.sleepT = setTimeout(function () {
      P.sleepT = null; P.sleepAt = 0; if (!P.piece || !P.ctx) return;
      var c = P.ctx; P.volG.gain.cancelScheduledValues(c.currentTime); P.volG.gain.setTargetAtTime(0, c.currentTime, 4);
      setTimeout(function () { stop(); try { P.volG.gain.cancelScheduledValues(0); P.volG.gain.setValueAtTime(P.vol, P.ctx.currentTime + 1.6); } catch (e) {} }, 14000);
    }, min * 60000);
    emit("sleep", { info: info() }); return min;
  }
  function toggle() { if (!P.piece) return false; if (P.paused) resume(); else pause(); return !P.paused; }
  function stop() {
    var pc = P.piece; if (!pc) return;
    P.piece = null; P.mix = null; P.paused = false; stopTimer();
    P.outs.forEach(function (o) { try { o.eng.fadeOut(P.ctx.currentTime, 1.2); } catch (e) {} setTimeout(function () { o.eng.dispose(); }, 1500); }); P.outs = []; if (P.sleepT) { clearTimeout(P.sleepT); P.sleepT = null; P.sleepAt = 0; }
    var c = P.ctx; if (c) { pc.eng.fadeOut(c.currentTime, 1.2); setTimeout(function () { pc.eng.dispose(); }, 1400); try { if (c.state === "suspended") c.resume(); } catch (e) {} }
    try { global.navigator.mediaSession.playbackState = "none"; } catch (e) {}
    emit("stop", {});
  }
  function setVolume(v, secs) {
    P.vol = clamp(v, 0, 1); try { global.localStorage.setItem(VOL_KEY, String(P.vol)); } catch (e) {}
    if (P.ctx) P.volG.gain.setTargetAtTime(P.vol, P.ctx.currentTime, secs ? secs / 3 : .08);
  }
  /* Echo is speaking: music steps back, then returns */
  function duck(on) { P.ducked = !!on; if (P.ctx) P.duckG.gain.setTargetAtTime(on ? .2 : 1, P.ctx.currentTime, on ? .15 : .9); }
  /* the microphone is listening: music goes silent so it is not heard by speech recognition */
  function hold(on) { P.held = !!on; if (P.ctx && !P.paused) P.holdG.gain.setTargetAtTime(on ? 0 : 1, P.ctx.currentTime, on ? .1 : .5); }
  function steer(p) { if (P.piece) P.piece.comp.steer(p || {}); }
  function level() {
    if (!P.analyser || !P.piece || P.paused) return 0;
    P.analyser.getFloatTimeDomainData(P.lvlBuf); var s = 0, i; for (i = 0; i < P.lvlBuf.length; i++) s += P.lvlBuf[i] * P.lvlBuf[i];
    return clamp(Math.sqrt(s / P.lvlBuf.length) * 2.4, 0, 1);
  }
  function like() {
    var pc = P.piece; if (!pc) return false;
    var inf = pc.comp.info(); taste.styles[inf.style] = (taste.styles[inf.style] || 0) + 1; taste.moods[inf.mood] = (taste.moods[inf.mood] || 0) + 1;
    var s = seedStr(pc); if (!taste.seeds.some(function (x) { return x.s === s; })) taste.seeds.unshift({ s: s, t: inf.title, b: P.lastBrief || {} });
    taste.seeds = taste.seeds.slice(0, 30); saveTaste(); emit("like", { info: info() }); return true;
  }
  function saved() { return taste.seeds.slice(); }
  function playSaved(i) { var e = taste.seeds[i]; if (!e) return null; var b = {}; for (var k in e.b) b[k] = e.b[k]; b.seed = strToSeed(e.s); return play(b); }
  function tasteSummary() {
    var arr = Object.keys(taste.styles).filter(function (k) { return taste.styles[k] > 0; }).sort(function (a, b) { return taste.styles[b] - taste.styles[a]; }).slice(0, 2);
    return arr.map(function (k) { return STYLES[k] ? STYLES[k].name : k; }).join(", ");
  }

  /* ═══════════════ DJ mix ═══════════════ */
  var MIX_DEFAULT_STYLES = ["afrobeats", "amapiano", "house"];
  var MIX_TRANS = { blend: 16, quick: 8, cut: 2 };
  function normStyle(x) { var p = parseBrief({ style: x }); return p.style && p.style !== "solo" ? p.style : ""; }
  /* a mix plan: which genres, how long, how the energy travels; tempos are chosen to stay close to the previous track so every handover can be beat-matched */
  function buildMixPlan(o) {
    o = o || {};
    var seed = (o.seed !== undefined && o.seed !== null && o.seed !== "") ? (typeof o.seed === "number" ? o.seed >>> 0 : strToSeed(o.seed)) : randomSeed(), rng = makeRng(seed);
    var styles = (Array.isArray(o.styles) ? o.styles : (o.style ? [o.style] : [])).map(normStyle).filter(Boolean);
    if (!styles.length) styles = MIX_DEFAULT_STYLES.slice();
    var moods = (Array.isArray(o.moods) ? o.moods : (o.mood ? [o.mood] : [])).map(function (m) { return parseBrief({ mood: m }).mood; }).filter(function (m) { return m !== "neutral"; });
    var minutes = clamp(Number(o.minutes) || 15, 1, 120), shape = ["wave", "build", "peak", "chill", "warmup"].indexOf(o.shape) >= 0 ? o.shape : "wave";
    var trans = MIX_TRANS[o.trans] ? o.trans : "blend", transBars = MIX_TRANS[trans];
    var tsec = clamp(Number(o.trackSec) || 170, 30, 300), n = Math.max(2, Math.round(minutes * 60 / tsec)), tracks = [], prev = 0, lastStyle = "", key = o.key !== undefined ? parseKey(o.key) : null;
    for (var i = 0; i < n; i++) {
      var u = n > 1 ? i / (n - 1) : 0, e;
      e = shape === "build" ? .45 + .5 * u : shape === "warmup" ? .35 + .45 * u : shape === "peak" ? .8 + .15 * Math.sin(i * 1.3) : shape === "chill" ? .3 + .2 * Math.sin(i * 1.1) : .62 + .3 * Math.sin(i * 1.15 + .4);
      e = clamp(e + rng.range(-.04, .04), .2, 1);
      /* choose the genre whose tempo range sits closest to the previous track's tempo */
      var map = {}; styles.forEach(function (st) {
        var r = STYLES[st].bpm, mid = (r[0] + r[1]) / 2, dist = prev ? Math.abs(mid - prev) : 0;
        map[st] = Math.exp(-dist / 14) * (st === lastStyle && styles.length > 1 ? .25 : 1);
      });
      var st = rng.weighted(map), r2 = STYLES[st].bpm, nat = Math.round(lerp(r2[0], r2[1], clamp(e, 0, 1)) + rng.range(-1.5, 1.5));
      var mood = moods.length ? moods[i % moods.length] : (e > .78 ? "joy" : e > .58 ? "hope" : e > .42 ? "love" : "calm");
      var barDur = 240 / nat, secs = tsec * rng.range(.88, 1.18);
      tracks.push({ style: st, mood: mood, energy: e, nat: nat, bars: Math.max(tsec < 60 ? 16 : 32, Math.round(secs / barDur / 8) * 8), seed: (seed + i * 7919) >>> 0 });
      prev = nat; lastStyle = st;
    }
    return { seed: seed, tracks: tracks, trans: trans, transBars: transBars, minutes: minutes, shape: shape, key: key, name: String(o.name || "").slice(0, 60) };
  }
  function mixTrackPiece(ctx, dest, tr, root, mode, lite, quality, at, bpm) {
    var brief = { mood: tr.mood, style: tr.style, energy: tr.energy, seed: tr.seed, intent: "match" };
    if (root !== null && root !== undefined) { brief.key = root; if (mode) brief.mode = mode; }
    var pb = parseBrief(brief), comp = Composer(pb, tr.seed), eng = Engine(ctx, dest, { lite: lite }); eng.setQuality(quality);
    if (bpm) { comp.spec.bpmForce = bpm; comp.spec.skipIntro = true; } else comp.spec.bpmForce = tr.nat;
    return { comp: comp, eng: eng, nextT: at, bars: 0, start: at, seed: tr.seed, t0: Date.now(), tr: tr };
  }
  /* the controller is clock-agnostic: the live scheduler and the offline renderer both call afterBar() for every bar they generate */
  function MixCtl(ctx, dest, plan, lite, quality) {
    var M = { plan: plan, idx: 0, ctx: ctx, last: false, forceNext: false };
    /* shared bus: while two tracks overlap their limiters add up, so one more compressor guards the sum */
    var bus = ctx.createDynamicsCompressor(), bg = ctx.createGain(), sc = ctx.createWaveShaper(), cv = new Float32Array(512), q;
    bus.threshold.value = -9; bus.knee.value = 8; bus.ratio.value = 10; bus.attack.value = .003; bus.release.value = .2; bg.gain.value = .92;
    for (q = 0; q < 512; q++) { var x = q / 255.5 - 1; cv[q] = Math.tanh(x * 1.1) / Math.tanh(1.1); } sc.curve = cv;
    bus.connect(bg); bg.connect(sc); sc.connect(dest); dest = bus; M.bus = bus;
    var rng = makeRng(plan.seed ^ 0x5bd1e995);
    M.begin = function (at) { var pc = mixTrackPiece(ctx, dest, plan.tracks[0], plan.key, null, lite, quality, at, 0); pc.eng.fadeIn(at, 1.5); return pc; };
    M.afterBar = function (pc, bar) {
      var tr = plan.tracks[M.idx];
      if (pc.leaving || pc.tr !== tr) { if (pc.tr && pc.tr === plan.tracks[M.idx] && pc.bars >= plan.transBars && !pc.released) { pc.released = true; pc.comp.release(pc.tr.nat); } return null; }
      if (pc.bars >= plan.transBars && !pc.released) { pc.released = true; if (M.idx > 0) pc.comp.release(tr.nat); }
      var lastTrack = M.idx >= plan.tracks.length - 1, B = plan.transBars;
      if (lastTrack) {
        if (pc.bars >= tr.bars - 8 && !pc.leaving) { pc.leaving = true; M.last = true; pc.endT = pc.nextT + 8 * bar.barDur; pc.eng.xfade(pc.nextT, 8 * bar.barDur, false); }
        return null;
      }
      var go = M.forceNext ? (bar.secStart || pc.bars > 2) : (pc.bars >= tr.bars - B && (bar.secStart || pc.bars >= tr.bars));
      if (!go || pc.bars < 4) return null;
      M.forceNext = false;
      return M.transition(pc, bar);
    };
    M.transition = function (pc, bar) {
      var at = pc.nextT, bd = bar.barDur, B = plan.transBars, dur = B * bd, nxt = plan.tracks[M.idx + 1], st = pc.comp.state();
      pc.comp.hold(); pc.leaving = true;
      /* harmonic mixing: move to a closely related key (same, fifth up, fourth up, or step up) and keep the mode */
      var step = rng.weighted({ "0": 3, "7": 3, "5": 2.2, "2": .8 }), root = (st.root + parseInt(step, 10)) % 12;
      var inc = mixTrackPiece(ctx, dest, nxt, root, rng.chance(.75) ? st.mode : null, lite, quality, at, bar.bpm);
      M.idx++;
      var sd = { stepDur: bar.stepDur }, swap = at + dur * .5;
      if (plan.trans === "cut") {
        pc.eng.xfade(at + bd * .25, bd * .75, false); inc.eng.out.gain.cancelScheduledValues(0); inc.eng.out.gain.setValueAtTime(1, Math.max(0, at - .01));
        try { inc.eng.fx({ k: "impact", v: .6 }, at, sd); } catch (e) {}
        pc.endT = at + bd + .2;
      } else {
        inc.eng.xfade(at, dur * .5, true); pc.eng.xfade(at + dur * .55, dur * .45, false);
        inc.eng.djSet(480, Math.max(0, at - .02)); inc.eng.djSweep(swap, bd, 480, 12); pc.eng.djSweep(swap, bd, 12, 480);
        try { pc.eng.fx({ k: "revcrash", d: 16, v: .5 }, swap - bd, sd); inc.eng.fx({ k: "impact", v: .38 }, swap, sd); } catch (e) {}
        pc.endT = at + dur + .1;
      }
      return inc;
    };
    M.skip = function () { M.forceNext = true; };
    return M;
  }
  function mix(opts, popts) {
    var c = ensureCtx(); if (!c) { emit("error", { message: "Web Audio is not supported here" }); return null; }
    var plan = buildMixPlan(opts), now = c.currentTime;
    P.outs.forEach(function (o) { o.eng.fadeOut(now, 1.2); setTimeout(function () { o.eng.dispose(); }, 1500); }); P.outs = [];
    if (P.piece) { var old = P.piece; old.eng.fadeOut(now, 1.8); setTimeout(function () { old.eng.dispose(); }, 2000); }
    var ctl = MixCtl(c, P.volG, plan, P.quality >= 1, P.quality), pc = ctl.begin(now + .12);
    P.lastBrief = { mix: opts || {} };
    P.mix = { ctl: ctl, plan: plan }; P.piece = pc; P.paused = false;
    if (c.state === "suspended") { try { c.resume(); } catch (e) {} }
    P.holdG.gain.setTargetAtTime(P.held ? 0 : 1, now, .05);
    startTimer(); tick();
    var inf = info(); mediaSession(inf); try { global.navigator.mediaSession.playbackState = "playing"; } catch (e) {}
    emit("start", { info: inf, mix: true }); return inf;
  }
  function mixNext() { if (!P.mix) return false; P.mix.ctl.skip(); return true; }
  function mixInfo() {
    if (!P.mix) return null; var m = P.mix.ctl;
    return { index: m.idx, total: m.plan.tracks.length, trans: m.plan.trans, minutes: m.plan.minutes, shape: m.plan.shape, tracks: m.plan.tracks.map(function (t) { return { style: STYLES[t.style].name, mood: t.mood, bpm: t.nat }; }) };
  }
  function renderMix(opts, seconds, ropts) {
    ropts = ropts || {};
    var OAC = global.OfflineAudioContext || global.webkitOfflineAudioContext, sr = ropts.sampleRate || 44100, off = new OAC(2, Math.ceil(sr * seconds), sr);
    var plan = buildMixPlan(opts), ctl = MixCtl(off, off.destination, plan, !!ropts.lite, ropts.lite ? 1 : 0), pcs = [ctl.begin(0)], primary = pcs[0];
    for (var guard = 0; guard < 20000; guard++) {
      var live = pcs.filter(function (p) { return !(p.endT && p.nextT >= p.endT) && p.nextT < seconds; }); if (!live.length) break;
      var pc = live.reduce(function (a, b) { return a.nextT <= b.nextT ? a : b; });
      var bar = pc.comp.nextBar(), made = ctl.afterBar(pc, bar);
      pc.eng.playBar(bar, pc.nextT); pc.nextT += bar.barDur; pc.bars++;
      if (made) { pcs.push(made); primary = made; }
    }
    return off.startRendering().then(function (buf) { buf.echoPlan = plan; return buf; });
  }

  /* ── offline render: for tests and for saving a piece as a WAV file ── */
  function render(brief, seconds, opts) {
    opts = opts || {};
    var OAC = global.OfflineAudioContext || global.webkitOfflineAudioContext, sr = opts.sampleRate || 44100;
    var off = new OAC(2, Math.ceil(sr * seconds), sr), pb = parseBrief(brief), seed = pb.seed !== undefined ? pb.seed : (opts.seed !== undefined ? opts.seed >>> 0 : randomSeed());
    var comp = Composer(pb, seed), eng = Engine(off, off.destination, { lite: !!opts.lite, solo: opts.solo, mute: opts.mute, trim: opts.trim });
    var t = 0; while (t < seconds) { var bar = comp.nextBar(); eng.playBar(bar, t); t += bar.barDur; }
    if (opts.fade !== false) { eng.out.gain.setValueAtTime(.0001, 0); eng.out.gain.linearRampToValueAtTime(1, Math.min(2, seconds / 4)); eng.out.gain.setValueAtTime(1, Math.max(0, seconds - 3)); eng.out.gain.linearRampToValueAtTime(0, seconds); }
    return off.startRendering().then(function (buf) { buf.echoInfo = comp.info(); return buf; });
  }
  function toWav(buf) {
    var ch = buf.numberOfChannels, n = buf.length, sr = buf.sampleRate, ab = new ArrayBuffer(44 + n * ch * 2), v = new DataView(ab), o = 0, c, i;
    function w(s) { for (var q = 0; q < s.length; q++) v.setUint8(o++, s.charCodeAt(q)); }
    w("RIFF"); v.setUint32(o, 36 + n * ch * 2, true); o += 4; w("WAVEfmt "); v.setUint32(o, 16, true); o += 4; v.setUint16(o, 1, true); o += 2; v.setUint16(o, ch, true); o += 2;
    v.setUint32(o, sr, true); o += 4; v.setUint32(o, sr * ch * 2, true); o += 4; v.setUint16(o, ch * 2, true); o += 2; v.setUint16(o, 16, true); o += 2; w("data"); v.setUint32(o, n * ch * 2, true); o += 4;
    var d = []; for (c = 0; c < ch; c++) d.push(buf.getChannelData(c));
    for (i = 0; i < n; i++) for (c = 0; c < ch; c++) { var x = clamp(d[c][i], -1, 1); v.setInt16(o, x < 0 ? x * 32768 : x * 32767, true); o += 2; }
    return new Blob([ab], { type: "audio/wav" });
  }
  function exportMixWav(opts, seconds) { return renderMix(opts, seconds || 120, { lite: false }).then(toWav); }
  function exportWav(brief, seconds) { return render(brief, seconds || 60, { lite: false }).then(toWav); }

  var API = {
    version: 1, supported: function () { return !!AC; },
    unlock: unlock, play: play, next: next, pause: pause, resume: resume, toggle: toggle, stop: stop, sleep: sleep,
    setVolume: setVolume, getVolume: function () { return P.vol; }, duck: duck, hold: hold, steer: steer,
    current: function () { var pc = P.piece; if (!pc || !P.lastBrief) return null; var b = {}; for (var k in P.lastBrief) b[k] = P.lastBrief[k]; b.seed = pc.seed; return b; },
    like: like, saved: saved, playSaved: playSaved, tasteSummary: tasteSummary, info: info, level: level,
    on: function (fn) { P.listeners.push(fn); return function () { API.off(fn); }; }, off: function (fn) { P.listeners = P.listeners.filter(function (x) { return x !== fn; }); },
    parseBrief: parseBrief, moods: MOOD_LIST.slice(), styles: STYLE_LIST.map(function (k) { return { id: k, name: STYLES[k].name }; }),
    mix: mix, mixNext: mixNext, mixInfo: mixInfo, buildMixPlan: buildMixPlan, renderMix: renderMix,
    render: render, toWav: toWav, exportWav: exportWav, exportMixWav: exportMixWav,
    _t: { ctx: function () { return P.ctx; }, Composer: Composer, Engine: Engine, LOUD: LOUD, STYLES: STYLES, RECIPES: RECIPES, KITS: KITS, STRIPS: STRIPS }
  };
  global.EchoMusic = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : globalThis);
