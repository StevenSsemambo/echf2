/* ─────────────────────────────────────────────────────────────────────────────
   YoEcho 3D Face · v1
   Adapted from the "3D AI Lecturer" avatar engine (rigged Ready Player Me
   avatars with ARKit blendshapes + Oculus visemes).

   Needs the globals THREE (r128) and THREE.GLTFLoader. index.html loads them,
   and this file, only when the person opens voice mode.

   The app owns the voice (speechSynthesis in speakText). It calls:
     EchoFace.utteranceStart(text)   when a chunk starts speaking
     EchoFace.boundary(charIndex)    on each spoken word (keeps lips in sync)
     EchoFace.utteranceEnd()         when a chunk finishes
     EchoFace.stop()                 when speech is cancelled
   ───────────────────────────────────────────────────────────────────────────── */
(function () {
  "use strict";
  if (!window.THREE || !THREE.GLTFLoader) { console.warn("EchoFace: THREE / GLTFLoader missing"); return; }

  const V3 = THREE.Vector3, Q = THREE.Quaternion;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const D = (x, y, z) => new V3(x, y, z);
  const AVATARS = { f1: "/avatars/f1.glb", f2: "/avatars/f2.glb" };
  const REDUCED = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);

  // ── avatar download ───────────────────────────────────────────────────────────
  // The avatar files are stored gzip-compressed (about 0.8 MB instead of 2.3 MB). netlify.toml marks
  // them "Content-Encoding: gzip" so the browser unpacks them itself; if a host ignores that header,
  // the bytes are unpacked here instead. The download state lives on window.__echoBuf so index.html
  // can start it in parallel with the scripts and read the progress.
  const store = (window.__echoBuf = window.__echoBuf || {});
  const decoded = {};
  const timing = { download: 0, parse: 0 };
  async function startDownload(key) {
    const url = AVATARS[key] || AVATARS.f1;
    const st = { loaded: 0, total: 0, t0: performance.now() };
    st.promise = (async () => {
      const r = await fetch(url);
      if (!r.ok) throw new Error("avatar HTTP " + r.status);
      st.total = +r.headers.get("content-length") || 0;
      const parts = [];
      if (r.body && r.body.getReader) {
        const rd = r.body.getReader();
        for (;;) { const x = await rd.read(); if (x.done) break; parts.push(x.value); st.loaded += x.value.length; }
      } else { const b = new Uint8Array(await r.arrayBuffer()); parts.push(b); st.loaded = b.length; }
      let n = 0; parts.forEach(p => n += p.length);
      const out = new Uint8Array(n); let o = 0; parts.forEach(p => { out.set(p, o); o += p.length; });
      st.done = true; st.ms = timing.download = performance.now() - st.t0;
      return out;
    })();
    st.promise.catch(() => { if (store[key] === st) delete store[key]; });
    store[key] = st;
    return st;
  }
  async function unpack(bytes) {
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {            // still gzip: unpack in the browser
      if (!window.DecompressionStream) throw new Error("this browser cannot unpack the avatar file");
      const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      return await new Response(ds).arrayBuffer();
    }
    if (bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46) // "glTF"
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    throw new Error("avatar file is not a GLB (check the host's Content-Encoding header)");
  }
  async function getBuffer(key) {
    if (!AVATARS[key]) key = "f1";
    if (decoded[key]) return decoded[key];
    const st = store[key] || await startDownload(key);
    const bytes = await st.promise;
    return (decoded[key] = await unpack(bytes));
  }
  // The loader picks its texture loader when it is constructed, so createImageBitmap is
  // switched off only for that moment (plain <img> decoding is the reliable path here).
  function parseGLB(buf) {
    return new Promise((res, rej) => {
      const cib = window.createImageBitmap;
      try { window.createImageBitmap = undefined; new THREE.GLTFLoader().parse(buf, "", res, rej); }
      catch (e) { rej(e); }
      finally { window.createImageBitmap = cib; }
    });
  }
  function disposeObj(root) {
    root.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
        for (const k in m) if (m[k] && m[k].isTexture) m[k].dispose();
        m.dispose();
      });
    });
  }

  // ── rig helpers ──────────────────────────────────────────────────────────────
  function aim(bone, child, dir, k) {
    bone.updateWorldMatrix(true, true);
    const bp = new V3().setFromMatrixPosition(bone.matrixWorld), cp = new V3().setFromMatrixPosition(child.matrixWorld);
    const q = new Q().setFromUnitVectors(cp.sub(bp).normalize(), dir.clone().normalize());
    const bq = bone.getWorldQuaternion(new Q()), pq = bone.parent.getWorldQuaternion(new Q());
    bone.quaternion.slerp(pq.invert().multiply(q).multiply(bq), k);
  }
  const REST = [.14, -1, .05, .14, -.55, .8];
  function dirs(s, g) { g = g || REST; return [D(s * g[0], g[1], g[2]), D(s * g[3], g[4], g[5])]; }

  // ── emotions (face blendshapes + head pose [pitch, tilt]) ────────────────────
  const L = "Left", R = "Right", bi = (n, v) => ({ [n + L]: v, [n + R]: v });
  const EMO = {
    neutral:   { m: { ...bi("mouthSmile", .14), browInnerUp: .05 }, h: [0, 0] },
    happy:     { m: { ...bi("mouthSmile", .55), ...bi("cheekSquint", .3), ...bi("eyeSquint", .15), ...bi("browOuterUp", .15) }, h: [-.02, .03] },
    excited:   { m: { ...bi("mouthSmile", .7), ...bi("cheekSquint", .4), ...bi("eyeWide", .25), browInnerUp: .25, ...bi("browOuterUp", .35) }, h: [-.03, 0] },
    serious:   { m: { ...bi("browDown", .4), ...bi("mouthPress", .25), ...bi("eyeSquint", .1) }, h: [.03, 0] },
    concerned: { m: { browInnerUp: .65, ...bi("browDown", .12), ...bi("mouthFrown", .3) }, h: [.02, .06] },
    surprised: { m: { ...bi("eyeWide", .6), browInnerUp: .6, ...bi("browOuterUp", .55) }, h: [-.04, 0] },
    thoughtful:{ m: { browInnerUp: .3, browDownLeft: .25, browOuterUpRight: .25, ...bi("mouthPress", .14), mouthLeft: .1 }, h: [0, .05] },
    // attentive, warm, head slightly tilted: shown while the person is speaking to Echo
    listening: { m: { ...bi("mouthSmile", .2), browInnerUp: .2, ...bi("browOuterUp", .1) }, h: [-.01, .07] },
  };
  // Echo's mood (from the AI reply) → how the face responds. Sadness/fear show empathy, not despair.
  const MOOD_EMO = { neutral: "neutral", joy: "happy", hope: "happy", love: "happy", sadness: "concerned", fear: "concerned", anger: "serious", confusion: "thoughtful" };
  const textBump = t =>
    /\b(wow|amazing|incredible|fantastic|awesome)\b/i.test(t) ? "excited" :
    /\b(congrat|great|well done|proud|wonderful|welcome|glad)\b/i.test(t) ? "happy" :
    /\b(sorry|unfortunately|difficult|struggl|painful)\b/i.test(t) ? "concerned" :
    /\b(interesting|surprising)\b/i.test(t) ? "surprised" : null;

  // ── lip-sync v2: text → phoneme-like visemes → word-locked timeline ──────────────
  // 1) a small pronunciation layer turns each word into mouth shapes (visemes). The ~100 most common
  //    words are spelled out, everything else goes through spelling rules (silent e, th/sh/ch, ough…).
  // 2) every word gets a duration in "units". One unit lasts `mpw` ms, which is learned per voice.
  // 3) when the browser reports each spoken word (onboundary), the timeline is re-anchored to that
  //    exact moment, so errors can't build up. Voices that don't report words run on estimated time.
  const DUR = { aa: 1.4, E: 1.2, I: 1.1, O: 1.4, U: 1.2, PP: .65, FF: .8, TH: .8, DD: .6, kk: .65, CH: .85, SS: .85, nn: .7, RR: .8 };
  const JAW = { aa: .46, O: .34, E: .23, I: .14, U: .13, RR: .09, CH: .08, SS: .05, nn: .06, kk: .08, DD: .08, TH: .06, FF: .03, PP: 0 };   // a little exaggerated: reads better on a phone-sized face
  const VOWELS = { aa: 1, E: 1, I: 1, O: 1, U: 1 };
  const FUNC = new Set("the a an and of to in is it i you that he was for on are as with his they be at or by but not we your can do if so my me am".split(" "));
  const DICT_SRC = {
    the: "TH E", a: "E", an: "aa nn", and: "aa nn DD", of: "O FF", to: "DD U", in: "I nn", is: "I SS", it: "I DD", i: "aa I",
    you: "I U", that: "TH aa DD", he: "I", was: "U aa SS", for: "FF O RR", on: "O nn", are: "aa RR", as: "aa SS", with: "U I TH",
    his: "I SS", they: "TH E", be: "PP I", at: "aa DD", one: "U aa nn", have: "aa FF", this: "TH I SS", from: "FF RR aa PP",
    or: "O RR", had: "aa DD", by: "PP aa I", but: "PP aa DD", not: "nn aa DD", what: "U aa DD", all: "O DD", were: "U E RR",
    we: "U I", when: "U E nn", your: "I O RR", can: "kk aa nn", said: "SS E DD", there: "TH E RR", use: "I U SS", each: "I I CH",
    which: "U I CH", she: "CH I", do: "DD U", how: "aa aa U", their: "TH E RR", if: "I FF", will: "U I DD", up: "aa PP",
    other: "aa TH RR", about: "aa PP aa U DD", out: "aa U DD", many: "PP E nn I", then: "TH E nn", them: "TH E PP",
    these: "TH I SS", so: "SS O", some: "SS aa PP", her: "E RR", would: "U U DD", make: "PP E kk", like: "DD aa I kk",
    him: "I PP", into: "I nn DD U", time: "DD aa I PP", has: "aa SS", look: "DD U kk", two: "DD U", more: "PP O RR",
    go: "kk O", see: "SS I", no: "nn O", way: "U E", could: "kk U DD", people: "PP I PP DD", my: "PP aa I", than: "TH aa nn",
    first: "FF E RR SS DD", who: "U", now: "nn aa U", know: "nn O", get: "kk E DD", give: "kk I FF", just: "CH aa SS DD",
    me: "PP I", am: "aa PP", here: "I RR", yes: "I E SS", okay: "O kk E", ok: "O kk E", hello: "E DD O", hi: "aa I",
    hey: "E", echo: "E kk O", thanks: "TH aa nn kk SS", thank: "TH aa nn kk", please: "PP DD I SS", sorry: "SS aa RR I",
    feel: "FF I DD", feeling: "FF I DD I nn", today: "DD U DD E", good: "kk U DD", great: "kk RR E DD", love: "DD aa FF",
    friend: "FF RR E nn DD", help: "E DD PP", think: "TH I nn kk", really: "RR I DD I", very: "FF E RR I", well: "U E DD",
    "what's": "U aa DD SS", "don't": "DD O nn DD", "can't": "kk aa nn DD", "won't": "U O nn DD", "didn't": "DD I DD nn DD",
    "doesn't": "DD aa SS nn DD", "isn't": "I SS nn DD", "i'm": "aa I PP", "i'll": "aa I DD", "i've": "aa I FF", "i'd": "aa I DD",
    "it's": "I DD SS", "that's": "TH aa DD SS", "let's": "DD E DD SS", "you're": "I U RR", "we're": "U I RR", "they're": "TH E RR",
    life: "DD aa I FF", mind: "PP aa I nn DD", heart: "aa RR DD", through: "TH RR U", though: "TH O", because: "PP I kk aa SS",
    something: "SS aa PP TH I nn", anything: "E nn I TH I nn", everything: "E FF RR I TH I nn", always: "aa DD U E SS",
    never: "nn E FF E RR", maybe: "PP E PP I", together: "DD U kk E TH E RR", should: "CH U DD", where: "U E RR", why: "U aa I",
    again: "aa kk E nn", little: "DD I DD DD", "people's": "PP I PP DD SS",
  };
  const DICT = {}; for (const k in DICT_SRC) DICT[k] = DICT_SRC[k].split(" ");
  const SUFFIX = { s: ["SS"], re: ["RR"], ll: ["DD"], m: ["PP"], ve: ["FF"], d: ["DD"] };

  function g2p(w) {
    const o = [], n = w.length, isV = c => "aeiou".includes(c);
    for (let i = 0; i < n;) {
      const ch = w[i], p = w[i - 1] || "", nx = w[i + 1] || "", d = w.substr(i, 2), t = w.substr(i, 3), q = w.substr(i, 4);
      if (i === n - 3 && t === "ing") { o.push("I", "nn"); break; }
      if (q === "tion" || q === "sion") { o.push("CH", "aa", "nn"); i += 4; continue; }
      if (t === "igh") { o.push("aa", "I"); i += 3; continue; }
      if (t === "tch" || t === "dge") { o.push("CH"); i += 3; continue; }
      if (i === n - 2 && d === "ed" && n > 3) { if (p === "t" || p === "d") o.push("I"); o.push("DD"); break; }
      if (i === n - 2 && d === "es" && n > 3 && !/[sxzhc]/.test(p)) { o.push("SS"); break; }
      if (d === "th") { o.push("TH"); i += 2; continue; }
      if (d === "sh" || d === "ch") { o.push("CH"); i += 2; continue; }
      if (d === "ph") { o.push("FF"); i += 2; continue; }
      if (d === "wh") { o.push("U"); i += 2; continue; }
      if (d === "ck") { o.push("kk"); i += 2; continue; }
      if (d === "ng") { o.push("nn"); i += 2; continue; }
      if (d === "nk") { o.push("nn", "kk"); i += 2; continue; }
      if (d === "qu") { o.push("kk", "U"); i += 2; continue; }
      if (i === 0 && (d === "kn" || d === "gn")) { o.push("nn"); i += 2; continue; }
      if (i === 0 && d === "wr") { o.push("RR"); i += 2; continue; }
      if (d === "gh") { if (i === 0) o.push("kk"); i += 2; continue; }
      if (d === "mb" && i === n - 2) { o.push("PP"); i += 2; continue; }
      if (d[0] === d[1] && !isV(d[0])) { i++; continue; }                     // doubled consonant = one sound
      if (d === "ee" || d === "ea" || d === "ie") { o.push("I"); i += 2; continue; }
      if (d === "oo") { o.push("U"); i += 2; continue; }
      if (d === "ou") { o.push("aa", "U"); i += 2; continue; }
      if (d === "ow") { if (i + 2 >= n) o.push("O"); else o.push("aa", "U"); i += 2; continue; }
      if (d === "oa" || d === "oe") { o.push("O"); i += 2; continue; }
      if (d === "ai" || d === "ay" || d === "ei" || d === "ey") { o.push("E"); i += 2; continue; }
      if (d === "au" || d === "aw") { o.push("O"); i += 2; continue; }
      if (d === "eu" || d === "ew" || d === "ue" || d === "ui") { o.push("U"); i += 2; continue; }
      if (d === "oi" || d === "oy") { o.push("O", "I"); i += 2; continue; }
      if (isV(ch)) {
        if (ch === "e" && i === n - 1 && n > 2 && !isV(p)) { i++; continue; }  // silent final e
        const long = i + 2 < n && !isV(w[i + 1]) && w[i + 2] === "e" && i + 3 === n;   // make, time, home
        if (ch === "a") o.push(long ? "E" : "aa");
        else if (ch === "e") o.push(long ? "I" : "E");
        else if (ch === "i") { if (long) o.push("aa", "I"); else o.push("I"); }
        else if (ch === "o") o.push(long || i === n - 1 || nx === "r" ? "O" : "aa");
        else o.push(long || i === 0 || p === "q" || !nx || isV(nx) ? "U" : "aa");
        i++; continue;
      }
      if (ch === "y") { if (i === n - 1 && n <= 3) o.push("aa", "I"); else o.push("I"); i++; continue; }
      if (ch === "c") o.push("eiy".includes(nx) && nx ? "SS" : "kk");
      else if (ch === "g") o.push(nx === "e" && i === n - 2 ? "CH" : "kk");
      else if ("bpm".includes(ch)) o.push("PP");
      else if ("fv".includes(ch)) o.push("FF");
      else if ("tdl".includes(ch)) o.push("DD");
      else if ("kq".includes(ch)) o.push("kk");
      else if ("sz".includes(ch)) o.push("SS");
      else if (ch === "x") o.push("kk", "SS");
      else if (ch === "j") o.push("CH");
      else if (ch === "r") o.push("RR");
      else if (ch === "n") o.push("nn");
      else if (ch === "w") o.push("U");
      i++;                                                                      // h and anything else: silent
    }
    return o;
  }
  function wordVisemes(w) {
    if (DICT[w]) return DICT[w];
    const k = w.indexOf("'");
    if (k > 0) {
      const stem = w.slice(0, k), suf = w.slice(k + 1);
      if (suf === "t" && stem.endsWith("n")) return wordVisemes(stem.slice(0, -1)).concat(["nn", "DD"]);
      return wordVisemes(stem).concat(SUFFIX[suf] || []);
    }
    return g2p(w);
  }
  const ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
  const TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split(" ");
  const below100 = n => n < 20 ? [ONES[n]] : [TENS[Math.floor(n / 10)]].concat(n % 10 ? [ONES[n % 10]] : []);
  const below1000 = n => n < 100 ? below100(n) : [ONES[Math.floor(n / 100)], "hundred"].concat(n % 100 ? below100(n % 100) : []);
  function numWords(s) {                      // "2026" is spoken "twenty twenty six"
    if (s.length > 4) return [...s].map(c => ONES[+c]);
    const n = +s;
    if (s.length === 4 && n >= 1100 && n <= 2099 && n % 100) { const a = Math.floor(n / 100), b = n % 100; return below100(a).concat(b < 10 ? ["oh", ONES[b]] : below100(b)); }
    if (n >= 1000) return [ONES[Math.floor(n / 1000)], "thousand"].concat(n % 1000 ? below1000(n % 1000) : []);
    return below1000(n);
  }

  // text → { u: [{v, d, t, ci, amp}], words: [{ci, t, t1, g1}], total, speech }
  function buildTL(text) {
    const u = [], words = [], s = text.replace(/[’‘]/g, "'");
    const re = /([A-Za-z]+(?:'[A-Za-z]+)*)|(\d+)|([,;:]+)|([.!?…]+)|(—|–|-{2,})/g;
    let c = 0, m, speech = 0;
    while ((m = re.exec(s))) {
      const ci = m.index;
      if (m[1] || m[2]) {
        const toks = m[1] ? [m[1].toLowerCase()] : numWords(m[2]);
        for (const tk of toks) {
          const k = FUNC.has(tk) ? .75 : 1, w = { ci, t: c, tok: tk, punct: "" };
          for (const v of wordVisemes(tk)) { const d = (DUR[v] || 1) * k; u.push({ v, d, t: c, ci, amp: .85 + ((u.length * 7) % 5) * .05 }); c += d; }
          speech = c;
          u.push({ v: null, d: .3, t: c, ci }); c += .3;      // lips relax briefly between words
          w.t1 = c; words.push(w);
        }
      } else {
        const d = m[3] ? 2.2 : m[4] ? 3.6 : 1.6;                  // typical voice pauses: comma ≈ 170 ms, full stop ≈ 270 ms
        u.push({ v: null, d, t: c, ci }); c += d;
        if (words.length) { words[words.length - 1].t1 = c; words[words.length - 1].punct = m[0][0]; }
      }
    }
    for (let i = words.length - 1, g = 0; i >= 0; i--) { if (!g || words[i].ci !== words[i + 1].ci) g = words[i].t1; words[i].g1 = g; }
    return { u, words, total: Math.max(c, 1), speech: Math.max(speech, 1) };
  }

  // speaking speed (ms per unit at rate 1) is remembered per voice between sessions
  const MP_KEY = "echoface_mpw1";
  let mp1 = {}; try { mp1 = JSON.parse(localStorage.getItem(MP_KEY) || "{}") || {}; } catch (e) {}
  const mpFor = v => mp1[v] || 72;

  // ═════════════════════════════════════════════════════════════════════════════
  // BODY LANGUAGE. What Echo says decides how it moves.
  //  · a lexicon turns words into cues (greeting, emphasis, negation, size, uncertainty, feelings…)
  //  · each cue becomes a gesture / expression / head move scheduled on the word-locked timeline,
  //    so the stroke lands on the word itself
  //  · arms are placed by two-bone IK from wrist positions; hands get real finger shapes and palm
  //    orientation; a guard keeps hands out of each other, the torso and the face
  // ═════════════════════════════════════════════════════════════════════════════
  let rnd = Math.random, LOG = null;
  const clampn = clamp, lerp = (a, b, t) => a + (b - a) * t, ease = x => x * x * (3 - 2 * x);
  const ENERGY = { joy: 1, hope: .8, love: .7, neutral: .75, confusion: .7, anger: .9, fear: .5, sadness: .35 };

  // finger shapes: flexion in "curl units" relative to the relaxed rest pose (negative = straighter)
  const FINGERS = ["Thumb", "Index", "Middle", "Ring", "Pinky"];
  const FJ = { Thumb: [.55, .85, .6], Index: [.9, 1.1, .7], Middle: [.9, 1.1, .7], Ring: [.9, 1.1, .7], Pinky: [.9, 1.1, .7] };
  const SHAPES = {
    relaxed: { Thumb: .12, Index: .08, Middle: .12, Ring: .2, Pinky: .28 },
    loose:   { Thumb: .3, Index: .3, Middle: .36, Ring: .42, Pinky: .48 },
    open:    { Thumb: -.1, Index: -.3, Middle: -.3, Ring: -.3, Pinky: -.3 },
    cup:     { Thumb: .1, Index: .2, Middle: .24, Ring: .28, Pinky: .32 },
    point:   { Thumb: .5, Index: -.3, Middle: 1, Ring: 1.05, Pinky: 1.1 },
    count2:  { Thumb: .6, Index: -.3, Middle: -.3, Ring: 1, Pinky: 1.05 },
    count3:  { Thumb: .6, Index: -.3, Middle: -.3, Ring: -.3, Pinky: 1 },
  };
  SHAPES.count1 = SHAPES.point;

  // Gestures. w = wrist position relative to the shoulder in metres [outward, up, forward] for a 0.53 m arm;
  // palm = where the palm should face (outward = +x for each side); w2 = sweep end; kick = one-shot stroke.
  const REST_W = [.10, -.34, .27], REST_PALM = [-1, .05, .2];
  const GEST = {
    open:      { w: [.02, -.17, .38], palm: [0, 1, .2], hand: "open", pole: [.5, -1, -.2] },
    present:   { w: [.08, -.12, .38], palm: [0, 1, .1], hand: "open", pole: [.6, -1, -.2] },
    wide:      { w: [.26, -.03, .22], palm: [0, .35, 1], hand: "open", pole: [.3, -1, -.3] },
    beat:      { w: [.15, -.22, .36], palm: [-.4, -1, .2], hand: "loose", kick: [0, -.06, .02], kickMs: 280 },
    chest:     { w: [-.09, -.19, .21], palm: [-.1, .1, -1], hand: "relaxed", pole: [1, -.6, -.2], touch: true },
    stop:      { w: [.12, .07, .24], palm: [0, 0, 1], hand: "open", pole: [.3, -1, .1] },
    count:     { w: [.11, .02, .27], palm: [-1, 0, .25], hand: "point", pole: [.3, -1, .1] },
    lift:      { w: [.07, -.30, .36], w2: [.07, -.04, .36], sweep: 650, palm: [0, 1, .2], hand: "open" },
    press:     { w: [.07, -.06, .36], w2: [.07, -.26, .36], sweep: 900, palm: [0, -1, .2], hand: "open" },
    narrow:    { w: [-.05, -.14, .40], palm: [-1, 0, 0], hand: "open", gap: .11 },
    together:  { w: [-.075, -.16, .40], palm: [-1, 0, .1], hand: "open", gap: .06 },
    apart:     { w: [.15, -.14, .34], palm: [-1, 0, 0], hand: "open" },
    wave:      { w: [.17, .07, .16], palm: [0, 0, 1], hand: "open", pole: [.9, -1, -.1], osc: [.05, 0, 0], hz: 2.6 },
    shrug:     { w: [.09, -.21, .33], palm: [0, 1, .1], hand: "open", sh: .08 },
    celebrate: { w: [.20, .02, .26], palm: [0, .6, .8], hand: "open", sh: .03 },
    out:       { w: [.13, -.10, .38], palm: [.3, .9, .2], hand: "open" },
  };

  // word → cue
  const CUES = {}; const addCue = (c, l) => l.split(" ").forEach(w => { CUES[w] = c; });
  addCue("greet", "hello hi hey welcome greetings"); addCue("bye", "goodbye bye");
  addCue("thanks", "thanks thank appreciate"); addCue("sorry", "sorry apologize apologies"); addCue("please", "please");
  addCue("yes", "yes yeah yep exactly sure correct indeed absolutely definitely certainly");
  addCue("no", "no never nothing nobody none cannot");
  addCue("emph", "very really truly extremely incredibly important crucial key essential remember always must critical matters vital");
  addCue("count1", "first firstly"); addCue("count2", "second secondly"); addCue("count3", "third thirdly"); addCue("next", "next finally lastly");
  addCue("contrast", "but however although though yet instead");
  addCue("big", "big large huge enormous massive everything everyone world whole many countless endless infinite everywhere");
  addCue("small", "little tiny small bit slightly few minor brief");
  addCue("unsure", "maybe perhaps might possibly guess unsure depends");
  addCue("think", "think thinking consider imagine wonder hmm hm");
  addCue("excited", "wow amazing incredible awesome fantastic wonderful excited brilliant congratulations");
  addCue("sad", "sad difficult hard pain painful hurt lonely tired worried afraid scared anxious stress stressed struggle struggling loss grief cry overwhelmed heavy");
  addCue("surprise", "surprise surprised suddenly unexpected shocking whoa unbelievable");
  addCue("happy", "happy glad love enjoy joy smile fun nice good beautiful proud lovely delighted");
  addCue("calm", "calm relax breathe breath peace peaceful slowly gently easy rest ease");
  addCue("up", "up rise grow increase higher better improve lift climb progress"); addCue("down", "down fall lower decrease drop less");
  addCue("together", "together combine connect join unite"); addCue("apart", "apart separate split divide");
  addCue("there", "there away far ahead future beyond distance"); addCue("here", "here");
  addCue("you", "you your yours you're"); addCue("self", "i me my myself i'm i'll i've i'd mine");
  addCue("heart", "heart feel feeling feelings care"); addCue("explain", "because means example instance reason"); addCue("stop", "stop wait hold pause enough");
  const SELF_NEXT = new Set("think feel believe promise understand care love mean want hope wish know am".split(" "));

  // facial overlays added on top of the mood face while a word is spoken
  const EXPR = {
    smile:    { ...bi("mouthSmile", .5), ...bi("cheekSquint", .25) },
    smileBig: { ...bi("mouthSmile", .85), ...bi("cheekSquint", .45), ...bi("eyeSquint", .22) },
    brow_up:  { browInnerUp: .6, ...bi("browOuterUp", .5), ...bi("eyeWide", .15) },
    flick:    { browInnerUp: .2, ...bi("browOuterUp", .35), ...bi("eyeWide", .08) },
    furrow:   { ...bi("browDown", .7), ...bi("eyeSquint", .3), ...bi("mouthPress", .2) },
    wide:     { ...bi("eyeWide", .8), browInnerUp: .55, ...bi("browOuterUp", .45) },
    concern:  { browInnerUp: .8, ...bi("browDown", .12), ...bi("mouthFrown", .45), ...bi("eyeSquint", .1) },
    think:    { browDownLeft: .3, browOuterUpRight: .5, mouthLeft: .18, ...bi("mouthPress", .15), ...bi("eyeSquint", .12) },
    soft:     { ...bi("eyeSquint", .22), ...bi("mouthSmile", .3), browInnerUp: .12 },
    unsure:   { browInnerUp: .65, mouthShrugLower: .55, ...bi("mouthPress", .25), ...bi("mouthFrown", .25) },
  };

  // text → timed behaviour events on the word-locked timeline (units; t = start of the cue word)
  function planBehavior(TL, mood, text, mpwNow) {
    mpwNow = mpwNow || 75;
    const W = TL.words, E = [], en = ENERGY[mood] != null ? ENERGY[mood] : .7;
    let lastArm = -99, lastHead = -99, lastFace = -99, arms = 0, content = 0, alt = rnd() < .5;
    const side = () => (rnd() < .72 ? "R" : "L");
    const arm = (t, g, o) => { if (t - lastArm < (o && o.pri ? 12 : 20 / (.5 + en)) || arms >= 4) return false; E.push({ k: "arm", t, g, side: "R", ...o }); lastArm = t; arms++; return true; };
    const head = (t, type, amp, dur, n) => { if (t - lastHead < 4) return; E.push({ k: "head", t, type, amp: amp * (.6 + .5 * en), dur, n: n || 1, lead: dur * .15 }); lastHead = t; };
    const face = (t, name, amp, hold, att, lead) => { if (t - lastFace < 2.5) return; E.push({ k: "face", t, name, amp, hold: hold || 600, att: att || 160, dec: 320, lead: lead == null ? 120 : lead }); lastFace = t; };
    for (let i = 0; i < W.length; i++) {
      const w = W[i], tok = w.tok, cue = CUES[tok], t = w.t, nx = W[i + 1] && W[i + 1].tok;
      if (cue) {
        switch (cue) {
          case "greet": arm(t, "wave", { prep: 380, hold: 1300, ret: 500, pri: 1 }); face(t, "smileBig", .9, 1400); head(t, "tilt", .08, 1200); break;
          case "bye":   arm(t, "wave", { prep: 380, hold: 1100, ret: 500, pri: 1 }); face(t, "smile", 1, 1200); break;
          case "thanks": arm(t, "chest", { prep: 450, hold: 900, ret: 500, side: side(), pri: 1 }); face(t, "smile", .9, 1100); head(t, "down", .07, 800); break;
          case "sorry": arm(t, "chest", { prep: 450, hold: 900, ret: 500, side: side(), pri: 1 }); face(t, "concern", .9, 1400); head(t, "down", .06, 900); break;
          case "please": if (rnd() < .6) arm(t, "open", { side: "both", amp: .8 }); face(t, "brow_up", .6, 900); break;
          case "yes": head(t, "nod", .1, 800, 2); face(t, "smile", .5, 700); break;
          case "no": head(t, "shake", .12, 850, 2); face(t, "furrow", .8, 900, 140, 80); if ((tok === "no" || tok === "never") && rnd() < .55) arm(t, "stop", { side: side() }); break;
          case "emph": if (rnd() < .8) arm(t, "beat", { side: (alt = !alt) ? "R" : "L", prep: 260, hold: 300, ret: 380 }); face(t, "brow_up", .6, 450, 120, 100); head(t, "beat", .06, 450); break;
          case "count1": case "count2": case "count3": arm(t, "count", { hand: cue, side: "R", prep: 380, hold: 1100, ret: 480, pri: 1 }); head(t, "beat", .05, 450); break;
          case "next": arm(t, "beat", { side: side() }); head(t, "beat", .06, 450); break;
          case "contrast": if (rnd() < .6) arm(t, "open", { side: side() }); head(t, "tilt", .06, 900); face(t, "brow_up", .5, 700); break;
          case "big": arm(t, "wide", { side: "both", prep: 460, hold: 800, ret: 520 }); face(t, "wide", .7, 900); break;
          case "small": arm(t, "narrow", { side: "both", prep: 420, hold: 800, ret: 500 }); face(t, "soft", .8, 900); break;
          case "unsure": arm(t, "shrug", { side: "both", prep: 420, hold: 900, ret: 550, pri: 1 }); head(t, "tilt", .1, 1100); face(t, "unsure", .9, 1200); break;
          case "think": E.push({ k: "gaze", t, x: -.35, y: .35, dur: 1000, lead: 200 }); head(t, "tilt", .07, 1100); face(t, "think", .8, 1100); break;
          case "excited": if (rnd() < .65) arm(t, "celebrate", { side: "both", prep: 420, hold: 800, ret: 520 }); face(t, "wide", .5, 700); face(t + .1, "smileBig", .9, 1200); head(t, "up", .05, 800); break;
          case "sad": face(t, "concern", .8, 1500, 260, 200); head(t, "down", .06, 1300); break;
          case "surprise": face(t, "wide", .9, 900, 110, 100); head(t, "up", .06, 600); break;
          case "happy": face(t, "smile", .8, 1000); break;
          case "calm": if (rnd() < .75) arm(t, "press", { side: rnd() < .5 ? "both" : "R", prep: 500, hold: 900, ret: 600 }); face(t, "soft", .9, 1500, 300, 200); head(t, "down", .04, 1200); E.push({ k: "blink", t: t + 2 }); break;
          case "up": arm(t, "lift", { side: side(), prep: 380, hold: 800 }); head(t, "up", .04, 700); break;
          case "down": arm(t, "press", { side: side(), prep: 380, hold: 800 }); head(t, "down", .04, 700); break;
          case "together": arm(t, "together", { side: "both", prep: 480, hold: 800, ret: 520 }); break;
          case "apart": arm(t, "apart", { side: "both", prep: 480, hold: 800, ret: 520 }); break;
          case "there": if (rnd() < .7) arm(t, "out", { side: side() }); break;
          case "here": arm(t, "beat", { side: side() }); break;
          case "you": if (rnd() < .45) arm(t, "open", { side: side() }); if (rnd() < .5) face(t, "brow_up", .4, 600); break;
          case "self": if (SELF_NEXT.has(nx) && rnd() < .7) arm(t, "chest", { side: side(), prep: 420, hold: 800, ret: 500 }); break;
          case "heart": if (rnd() < .6) arm(t, "chest", { side: side(), prep: 420, hold: 800, ret: 500 }); face(t, "soft", .6, 900); break;
          case "explain": if (rnd() < .5) arm(t, "open", { side: side() }); break;
          case "stop": arm(t, "stop", { side: side(), pri: 1 }); head(t, "shake", .08, 700, 1); break;
        }
      } else if (tok.length >= 5 && !FUNC.has(tok)) {                  // everyday speech rhythm: small beats on content words
        if (++content % 3 === 0) { head(t, "beat", .035 + .02 * en, 380); if (rnd() < .3) face(t, "flick", .5, 220, 100, 80); }
      }
      if (w.punct === "." || w.punct === "!" ) { if (i < W.length - 1) { head(w.t1 - 3, "beat", .03, 400); if (rnd() < .5) E.push({ k: "blink", t: w.t1 - 2 }); } }
      else if (w.punct === "," && rnd() < .3) E.push({ k: "blink", t: w.t1 - 2 });
    }
    if (W.length) {                                                       // whole-sentence cues
      const L = W[W.length - 1], q = /\?\s*$/.test(text), ex = /!\s*$/.test(text), t = Math.max(0, L.t - 6);
      if (q) { head(t, "tilt", .09, 1100); face(t, "brow_up", .7, 900); if (lastArm < t - 15) arm(L.t, "open", { side: side(), prep: 350, hold: 650 }); }
      if (ex) face(L.t, "wide", .35, 600, 120, 100);
    }
    for (const e of E) if (e.k === "arm") { const avail = e.t * mpwNow + 110; if (avail < (e.prep || 320) + 150) e.prep = Math.max(200, avail - 150 < 200 ? 200 : avail - 150); }   // a cue at the very start can't be prepared earlier
    E.sort((a, b) => a.t - b.t);
    return E;
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // One face instance = one WebGL canvas + one avatar. It is created once and kept alive when the
  // voice screen closes (detach), so opening it again is instant. It is released after 4 idle minutes.
  let pool = null, active = null;
  const stats = { mode: "idle", mpw: 0 };

  function create(opts) {
    opts = opts || {};
    let W = 240, H = 300, container = null, ro = null, attached = false, disposed = false, ready = false, raf = 0, idleTimer = 0;
    let model = null, morphs = [], B = {}, base = {}, frest = {}, shRest = {}, palmLocal = {}, armScale = 1, L1 = .27, L2 = .257;
    let tone = (opts.tone || "1,1,1").split(",").map(Number);
    let avatarKey = null;

    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(30, W / H, .1, 50);
    const rd = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
    rd.setClearColor(0x000000, 0);
    rd.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    rd.setSize(W, H, false);
    rd.outputEncoding = THREE.sRGBEncoding;
    const cv = rd.domElement;
    cv.style.cssText = "display:block;width:100%;height:100%";
    scene.add(new THREE.HemisphereLight(0xffffff, 0x666670, .9));
    const key = new THREE.DirectionalLight(0xfff2e0, 1.1); key.position.set(1.2, 2.6, 2.5); scene.add(key);
    const rim = new THREE.DirectionalLight(0xb8d0ff, .55); rim.position.set(-2, 2, -1.5); scene.add(rim);

    const lost = e => { e.preventDefault(); api.dead = true; if (attached && api.onFail) api.onFail(); destroy(); };
    cv.addEventListener("webglcontextlost", lost);
    function resize(force) {
      if (disposed || !container) return;
      const w = container.clientWidth, h = container.clientHeight;
      if (!w || !h || (!force && w === W && h === H)) return;
      W = w; H = h; rd.setSize(W, H, false); cam.aspect = W / H; cam.updateProjectionMatrix();
    }
    function attach(el) {
      if (disposed) return;
      clearTimeout(idleTimer); idleTimer = 0;
      container = el; el.appendChild(cv); attached = true;
      resize(true);
      if (window.ResizeObserver) { ro = new ResizeObserver(() => resize()); ro.observe(el); }
      api.stop(); gst.Left = gst.Right = null; listening = false; thinking = false;
      last = performance.now();
      if (!raf) raf = requestAnimationFrame(loop);
    }
    function detach() {
      if (disposed) return;
      attached = false; cancelAnimationFrame(raf); raf = 0;
      if (ro) { ro.disconnect(); ro = null; }
      if (cv.parentNode) cv.parentNode.removeChild(cv);
      container = null; api.stop();
      clearTimeout(idleTimer); idleTimer = setTimeout(destroy, 4 * 60 * 1000);
    }
    function destroy() {
      if (disposed) return; disposed = true; api.dead = true;
      clearTimeout(idleTimer); cancelAnimationFrame(raf);
      if (ro) ro.disconnect(); cv.removeEventListener("webglcontextlost", lost);
      if (model) { scene.remove(model); disposeObj(model); model = null; }
      try { rd.dispose(); rd.forceContextLoss && rd.forceContextLoss(); } catch (e) {}
      if (cv.parentNode) cv.parentNode.removeChild(cv);
      if (pool === api) pool = null;
      if (active === api) active = null;
    }

    // ── rig set-up ──
    const wpos = n => model.getObjectByName(n).getWorldPosition(new V3());
    function armsTo(k) { for (const [n, s] of [["Left", 1], ["Right", -1]]) { const d = dirs(s); aim(B[n + "Arm"], B[n + "ForeArm"], d[0], k); aim(B[n + "ForeArm"], B[n + "Hand"], d[1], k); } }
    function applyTone() {
      if (!model) return;
      model.traverse(o => {
        if (o.isMesh && /head|body|skin/i.test(o.name) && !/hair|outfit|eye|teeth|lash|tongue|glass|bottom|top|shoes|foot/i.test(o.name))
          (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.color && m.color.setRGB(tone[0], tone[1], tone[2]));
      });
    }
    // Which way each palm faces, found from the rig itself: straighten the fingers and see where the rig's own curl takes the tips.
    function calibratePalm() {
      model.updateMatrixWorld(true);
      for (const side of [L, R]) {
        const fs = ["Index", "Middle", "Ring", "Pinky"], saved = [];
        const tips0 = fs.map(f => wpos(side + "Hand" + f + "4"));
        fs.forEach(f => [1, 2, 3].forEach(j => { const b = model.getObjectByName(side + "Hand" + f + j); saved.push([b, b.quaternion.clone()]); b.quaternion.identity(); }));
        model.updateMatrixWorld(true);
        const n = new V3(); fs.forEach((f, i) => n.add(tips0[i].clone().sub(wpos(side + "Hand" + f + "4")))); n.normalize();
        saved.forEach(([b, q]) => b.quaternion.copy(q)); model.updateMatrixWorld(true);
        palmLocal[side] = n.applyQuaternion(B[side + "Hand"].getWorldQuaternion(new Q()).invert());
      }
    }
    async function loadModel(k) {
      const buf = await getBuffer(k);
      const tp = performance.now();
      const g = await parseGLB(buf);
      timing.parse = performance.now() - tp;
      if (disposed) { disposeObj(g.scene); return; }
      ready = false;
      if (model) { scene.remove(model); disposeObj(model); }
      model = g.scene; scene.add(model); morphs = []; B = {}; base = {}; frest = {}; shRest = {};
      model.traverse(o => { if (o.isSkinnedMesh) o.frustumCulled = false; if (o.morphTargetDictionary && o.morphTargetInfluences) morphs.push(o); });
      for (const n of ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head", "LeftShoulder", "RightShoulder", "LeftArm", "LeftForeArm", "RightArm", "RightForeArm", "LeftHand", "RightHand", "LeftHandMiddle1", "RightHandMiddle1"]) B[n] = model.getObjectByName(n);
      if (!B.LeftArm || !B.Head) throw new Error("avatar needs a standard humanoid skeleton");
      calibratePalm();
      for (const side of [L, R]) FINGERS.forEach(f => [1, 2, 3].forEach(j => { const b = model.getObjectByName(side + "Hand" + f + j); if (b) frest[side + f + j] = b.quaternion.clone(); }));
      for (const side of [L, R]) if (B[side + "Shoulder"]) shRest[side] = B[side + "Shoulder"].quaternion.clone();
      for (let i = 0; i < 4; i++) armsTo(1);
      for (const n of ["Spine1", "Spine2", "Neck", "Head"]) if (B[n]) base[n] = B[n].quaternion.clone();
      model.updateWorldMatrix(true, true);
      L1 = wpos("LeftArm").distanceTo(wpos("LeftForeArm")); L2 = wpos("LeftForeArm").distanceTo(wpos("LeftHand")); armScale = (L1 + L2) / .526;
      const hy = new V3().setFromMatrixPosition(B.Head.matrixWorld).y;
      headY = hy; applyFrame(true);
      buildGuards(); applyTone(); avatarKey = k; api.avatarKey = k; ready = true;
    }
    // Real points on the avatar's hands, torso and head, sampled from the skinned mesh each frame the hands are
    // raised. Gives the collision guard true distances for any avatar, whatever its body shape.
    const GS = { hand: { Left: [], Right: [] }, torso: [], head: [], meshes: [], front: .153, pts: {} };
    function buildGuards() {
      GS.hand = { Left: [], Right: [] }; GS.torso = []; GS.head = []; GS.meshes = [];
      const take = (list, limit) => { const st = Math.max(1, Math.ceil(list.length / limit)); return list.filter((_, i) => i % st === 0); };
      const hands = { Left: [], Right: [] }, torso = [], head = [];
      model.traverse(o => {
        if (!o.isSkinnedMesh || !o.geometry.attributes.skinIndex) return;
        const a = o.geometry.attributes, names = o.skeleton.bones.map(b => b.name), isHead = /Hair|Glasses|Head/.test(o.name), outfit = /Outfit/.test(o.name);
        if (outfit && !/Top/.test(o.name)) return;
        let used = false;
        for (let i = 0; i < a.position.count; i++) {
          let bi = 0, bw = -1; const w = [a.skinWeight.getX(i), a.skinWeight.getY(i), a.skinWeight.getZ(i), a.skinWeight.getW(i)], ix = [a.skinIndex.getX(i), a.skinIndex.getY(i), a.skinIndex.getZ(i), a.skinIndex.getW(i)];
          for (let k = 0; k < 4; k++) if (w[k] > bw) { bw = w[k]; bi = ix[k]; }
          const n = names[bi] || "";
          if (isHead) { head.push({ m: o, i }); used = true; }
          else if (/^LeftHand/.test(n) && !outfit) { hands.Left.push({ m: o, i }); used = true; }
          else if (/^RightHand/.test(n) && !outfit) { hands.Right.push({ m: o, i }); used = true; }
          else if (/Spine|Hips|Shoulder/.test(n)) { torso.push({ m: o, i }); used = true; }
        }
        if (used) GS.meshes.push(o);
      });
      GS.hand.Left = take(hands.Left, 240); GS.hand.Right = take(hands.Right, 240); GS.torso = torso; GS.head = take(head, 320);
      for (const k of ["hl", "hr", "t", "h"]) GS.pts[k] = [];
      const mk = n => Array.from({ length: n }, () => new V3());
      GS.pts.Left = mk(GS.hand.Left.length); GS.pts.Right = mk(GS.hand.Right.length); GS.pts.t = mk(GS.torso.length); GS.pts.h = mk(GS.head.length);
      // chest-depth profile of this body (front surface z per 2 cm of x, torso height only), measured once in the rest pose
      model.updateMatrixWorld(true); GS.meshes.forEach(m => m.skeleton.update()); sampleSet(GS.torso, GS.pts.t);
      GS.prof = new Array(23).fill(null);
      GS.pts.t.forEach(p => { if (p.y > .9 && p.y < 1.5) { const b = Math.round((p.x + .22) / .02); if (b >= 0 && b < 23 && (GS.prof[b] == null || p.z > GS.prof[b])) GS.prof[b] = p.z; } });
      for (let i = 1; i < 22; i++) if (GS.prof[i] == null) GS.prof[i] = GS.prof[i - 1];
      let z = -9; GS.pts.t.forEach(p => { if (p.y > 1.1 && p.y < 1.4 && Math.abs(p.x) < .15) z = Math.max(z, p.z); });
      if (z > 0) GS.front = z;
      GS.pts.t.length = 0;
    }
    const _v = new V3();
    function sampleSet(list, out) { for (let k = 0; k < list.length; k++) { list[k].m.boneTransform(list[k].i, _v); out[k].copy(_v).applyMatrix4(list[k].m.matrixWorld); } }
    function sampleHands() { GS.meshes.forEach(m => m.skeleton.update()); sampleSet(GS.hand.Left, GS.pts.Left); sampleSet(GS.hand.Right, GS.pts.Right); }
    const bbox = P => { const lo = new V3(1e9, 1e9, 1e9), hi = new V3(-1e9, -1e9, -1e9); for (const p of P) { lo.min(p); hi.max(p); } return [lo, hi]; };
    const boxGap = (a, b) => Math.max(a[0].x - b[1].x, b[0].x - a[1].x, a[0].y - b[1].y, b[0].y - a[1].y, a[0].z - b[1].z, b[0].z - a[1].z);
    // closest pair between two point sets (skipped when their boxes are far apart)
    const nearest = (A, Bp, within) => {
      if (within != null && boxGap(bbox(A), bbox(Bp)) > within) return { d: 1e9, a: null, b: null };
      let d = 1e9, a = null, b = null; for (let i = 0; i < A.length; i++) for (let j = 0; j < Bp.length; j++) { const x = A[i].distanceToSquared(Bp[j]); if (x < d) { d = x; a = A[i]; b = Bp[j]; } }
      return { d: Math.sqrt(d), a, b };
    };

    // camera framing: "torso" shows the face and the hands (default), "face" is a close-up. Changes are eased.
    const FRAMES = { face: { z: 1.3, dy: -.115 }, torso: { z: 1.58, dy: -.2 } };
    let headY = 1.5, frameName = FRAMES[opts.frame] ? opts.frame : "torso", camZ = FRAMES[frameName].z, camDy = FRAMES[frameName].dy;
    function applyFrame(snap, dt) {
      const f = FRAMES[frameName], k = snap ? 1 : 1 - Math.exp(-dt / .35);
      camZ += (f.z - camZ) * k; camDy += (f.dy - camDy) * k;
      cam.position.set(0, headY + camDy, camZ); cam.lookAt(0, headY + camDy, 0);
    }

    // ── state ──
    let baseMood = "neutral", baseEmo = "neutral", listening = false, thinking = false;
    let manualEmo = null, manualUntil = 0;
    let speaking = false, endAt = 0, evs = [], evi = 0, listenNodAt = 0, lastArmAt = -1e9;
    let TL = null, ui = 0, bnd = false, wi = 0, anchorTime = 0, tlStart = 0, t0 = 0, rate = 1, voice = "", mpw = mpFor("");
    const gst = { Left: null, Right: null };                 // active arm gesture per side
    const fc = { Left: {}, Right: {} };                      // current finger curl per side
    const hevs = [], fevs = [];                              // head moves, facial overlays
    let gazeOv = null, shrugNow = 0;
    const cur = {}, gaze = { x: 0, y: 0, tx: 0, ty: 0, next: 2000 };
    let blinkAt = 2500, blinkT = -1, last = performance.now(), hx = 0, hz = 0, frames = 0, acc = 0, wsPh = Math.random() * 100;
    const Z3 = new V3(), AXX = new V3(1, 0, 0), _q = new Q(), _q2 = new Q();
    const push = { Left: new V3(), Right: new V3() }, THR = { hh: .02, head: .025 };   // closest allowed surface distances (m)

    // ── arms: two-bone IK from wrist targets, palm roll, finger shapes, collision guard ──
    function elbowFor(S, T, pole) {
      const d0 = T.clone().sub(S); let d = clamp(d0.length(), Math.abs(L1 - L2) + 1e-3, L1 + L2 - 1e-3); const u = d0.normalize();
      const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
      const pv = pole.clone().addScaledVector(u, -pole.dot(u)); if (pv.lengthSq() < 1e-6) pv.set(0, -1, 0); pv.normalize();
      return { E: S.clone().addScaledVector(u, a).addScaledVector(pv, h), T: S.clone().addScaledVector(u, d) };
    }
    function rotateWorld(bone, axis, ang) {
      bone.updateWorldMatrix(true, false);
      const qw = bone.getWorldQuaternion(_q), qn = new Q().setFromAxisAngle(axis, ang).multiply(qw);
      bone.quaternion.copy(bone.parent.getWorldQuaternion(_q2).invert().multiply(qn));
    }
    function rollPalm(side, want, axis, k) {
      const hand = B[side + "Hand"]; hand.updateWorldMatrix(true, false);
      const n = palmLocal[side].clone().applyQuaternion(hand.getWorldQuaternion(_q));
      const n1 = n.addScaledVector(axis, -n.dot(axis)), w1 = want.clone().addScaledVector(axis, -want.dot(axis));
      if (n1.lengthSq() < 1e-6 || w1.lengthSq() < 1e-6) return;
      n1.normalize(); w1.normalize();
      let ang = Math.acos(clamp(n1.dot(w1), -1, 1)); if (axis.dot(n1.clone().cross(w1)) < 0) ang = -ang;
      ang = clamp(ang * k, -1.2, 1.2);
      rotateWorld(B[side + "ForeArm"], axis, ang * .5); B[side + "ForeArm"].updateWorldMatrix(true, true); rotateWorld(hand, axis, ang * .5);
    }
    function envOf(st, a) {
      if (a < 0) return 0; if (a < st.prep) return ease(a / st.prep);
      if (a < st.prep + st.hold) return 1; const r = (a - st.prep - st.hold) / st.ret; return r >= 1 ? -1 : 1 - ease(r);
    }
    function shapeCurl(name, f) { const S = SHAPES[name] || SHAPES.relaxed; return S[f]; }
    function animArms(now, dt) {
      const sc = armScale, T = {}, info = {};
      for (const side of [L, R]) {
        const s = side === L ? 1 : -1, st = gst[side]; let w = 0, g = null, a = 0;
        if (st) { a = now - st.t0; w = envOf(st, a); if (w < 0) { gst[side] = null; w = 0; } else g = GEST[st.name]; }
        const rel = REST_W.slice(); let palm = REST_PALM, hand = "relaxed", pole = [.5, -1, -.2], gap = 0, touch = false;
        if (g) {
          let tw = g.w; if (g.w2) tw = g.w.map((v, i) => lerp(v, g.w2[i], ease(clamp((a - st.prep) / (g.sweep || 800), 0, 1))));
          const amp = st.amp;
          for (let i = 0; i < 3; i++) rel[i] = REST_W[i] + (tw[i] - REST_W[i]) * w * amp;
          if (g.kick) { const u = clamp((a - st.prep) / (g.kickMs || 300), 0, 1), kv = Math.sin(Math.PI * u) * w; for (let i = 0; i < 3; i++) rel[i] += g.kick[i] * kv; }
          if (g.osc) { const ph = Math.sin(2 * Math.PI * (g.hz || 2.4) * Math.max(0, a - st.prep) / 1000) * w; for (let i = 0; i < 3; i++) rel[i] += g.osc[i] * ph; }
          palm = g.palm; hand = st.hand || g.hand; pole = g.pole || pole; gap = g.gap || 0; touch = !!g.touch;
          if (g.sh) shrugNow = Math.max(shrugNow, g.sh * w * amp);
        }
        // quiet life in the arms
        rel[1] += Math.sin(now / 1700 + (s > 0 ? 0 : 2)) * .004; rel[2] += Math.sin(now / 2300 + (s > 0 ? 1 : 3)) * .004;
        info[side] = { s, w, rel, palm, hand, pole, gap, touch };
      }
      // wrist targets in world space (plus last frame's measured push-away from anything the hands came too close to)
      for (const side of [L, R]) { const I = info[side]; const S = B[side + "Arm"].getWorldPosition(new V3()); I.S = S; I.T = new V3(S.x + I.s * I.rel[0] * sc, S.y + I.rel[1] * sc, S.z + I.rel[2] * sc).add(push[side]); }
      // Guards. The hand is treated as a segment from the wrist to the fingertips (0.17 m along the forearm).
      // Both hands must stay a safe distance apart along their whole length, and out of the torso and face.
      const HL = .17, ikOf = {};
      const solve = () => { for (const side of [L, R]) { const I = info[side], pole = new V3(I.s * I.pole[0], I.pole[1], I.pole[2]); const r = elbowFor(I.S, I.T, pole); r.fore = r.T.clone().sub(r.E); r.fdir = r.fore.clone().normalize(); r.tip = r.T.clone().addScaledVector(r.fdir, HL); ikOf[side] = r; } };
      const segDist = (p1, q1, p2, q2) => {                       // closest distance between two segments
        const d1 = q1.clone().sub(p1), d2 = q2.clone().sub(p2), r = p1.clone().sub(p2), a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
        let s1, t1; const c = d1.dot(r), b = d1.dot(d2), den = a * e - b * b;
        s1 = den > 1e-9 ? clamp((b * f - c * e) / den, 0, 1) : 0; t1 = (b * s1 + f) / e;
        if (t1 < 0) { t1 = 0; s1 = clamp(-c / a, 0, 1); } else if (t1 > 1) { t1 = 1; s1 = clamp((b - c) / a, 0, 1); }
        return p1.clone().addScaledVector(d1, s1).distanceTo(p2.clone().addScaledVector(d2, t1));
      };
      solve();
      const floor = Math.max(.085, info[L].gap, info[R].gap);
      for (let it = 0; it < 4; it++) {
        const d = segDist(ikOf[L].T, ikOf[L].tip, ikOf[R].T, ikOf[R].tip);
        if (d >= floor) break;
        const sgn = info[L].T.x >= info[R].T.x ? 1 : -1, push = (floor - d) / 2 + .004;
        info[L].T.x += sgn * push; info[R].T.x -= sgn * push; solve();
      }
      for (const side of [L, R]) {
        const I = info[side], T3 = I.T, ax = Math.abs(T3.x);
        if (ax < .2 && T3.y > .85 && T3.y < 1.5) { const zmin = GS.front + (I.touch ? .022 : .047); if (T3.z < zmin) T3.z = zmin; }
        if (T3.y > 1.4 && ax < .19 && T3.z < .28) T3.x = Math.sign(T3.x || (side === L ? 1 : -1)) * .19;
      }
      solve();
      for (const side of [L, R]) {                               // fingertips must not poke into the chest either
        const I = info[side], tp = ikOf[side].tip, tmin = GS.front + (I.touch ? .022 : .015);
        if (Math.abs(tp.x) < .17 && tp.y > .85 && tp.y < 1.5 && tp.z < tmin) I.T.z += (tmin - tp.z);
      }
      solve();
      const k = 1 - Math.exp(-dt * 14), kr = 1 - Math.exp(-dt * 10);
      for (const side of [L, R]) {
        const I = info[side], ik = ikOf[side], upper = ik.E.clone().sub(I.S);
        const palmW = new V3(I.s * I.palm[0], I.palm[1], I.palm[2]).normalize();
        aim(B[side + "Arm"], B[side + "ForeArm"], upper, k); aim(B[side + "ForeArm"], B[side + "Hand"], ik.fore, k);
        aim(B[side + "Hand"], B[side + "HandMiddle1"], ik.fdir.clone().addScaledVector(palmW, .12).normalize(), k);   // hand follows the forearm, wrist flexed a touch toward the palm
        rollPalm(side, palmW, ik.fdir.clone(), kr);
        for (const f of FINGERS) {
          const prev = fc[side][f] == null ? SHAPES.relaxed[f] : fc[side][f];
          const tgt = lerp(SHAPES.relaxed[f], shapeCurl(I.hand, f), I.w) + Math.sin(now / 1900 + f.length * 1.7 + (I.s > 0 ? 0 : 2)) * .03;
          const c = fc[side][f] = prev + (tgt - prev) * (1 - Math.exp(-dt / .09));
          for (let j = 1; j <= 3; j++) { const bn = model.getObjectByName(side + "Hand" + f + j), r = frest[side + f + j]; if (bn && r) bn.quaternion.copy(r).multiply(_q.setFromAxisAngle(AXX, c * FJ[f][j - 1])); }
        }
      }
      // measure real vertex distances on the pose just applied; whatever is too close pushes its hand away next frame
      const raised = info[L].w > .03 || info[R].w > .03; let pushed = false;
      if (raised && GS.hand.Left.length) {
        model.updateMatrixWorld(true); sampleHands();
        const HH = nearest(GS.pts.Left, GS.pts.Right, THR.hh + .03);
        if (HH.d < THR.hh) { const p = (THR.hh - HH.d) * .6 + .004; push.Left.x += p; push.Right.x -= p; pushed = true; }   // the avatar's left hand lives at +x, the right at -x, so overlap is always resolved outward
        for (const side of [L, R]) {
          const I = info[side], P = GS.pts[side]; let viol = 0, hiY = -9;
          for (const p of P) {                                                           // chest: every hand point must stay in front of the body
            if (p.y > hiY) hiY = p.y;
            if (p.y > .9 && p.y < 1.5 && Math.abs(p.x) < .21) { const zf = GS.prof[Math.round((p.x + .22) / .02)]; if (zf != null) { const v = zf + (I.touch ? .013 : .022) - p.z; if (v > viol) viol = v; } }
          }
          if (viol > 0) { push[side].z += viol * .7; pushed = true; }
          if (hiY > 1.3) {                                                               // head: only checked when a hand is up there
            sampleSet(GS.head, GS.pts.h); const Hd = nearest(P, GS.pts.h, THR.head + .03);
            if (Hd.d < THR.head) { push[side].add(Hd.a.clone().sub(Hd.b).normalize().multiplyScalar(THR.head - Hd.d + .004)); pushed = true; }
          }
        }
        for (const side of [L, R]) { const pl = push[side].length(); if (pl > .25) push[side].multiplyScalar(.25 / pl); }
      }
      const relax = pushed ? 1 : Math.exp(-dt * (raised ? 1.5 : 4)); push.Left.multiplyScalar(relax); push.Right.multiplyScalar(relax);   // no relaxing while still in contact
    }

    // ── behaviour events ──
    function fire(e, now) {
      if (LOG) LOG.push({ k: e.k, g: e.g || e.type || e.name, t: now, prep: e.prep || 0 });
      if (e.k === "arm") {
        if (now - lastArmAt < (e.pri ? 650 : 1100)) return;
        const sides = e.side === "both" ? [L, R] : [e.side === "L" ? L : R];
        for (const sd of sides) {
          const c = gst[sd]; if (c && !e.pri && now - c.t0 < c.prep + c.hold * .6) continue;
          gst[sd] = { name: e.g, t0: now, prep: e.prep || 320, hold: e.hold || 700, ret: e.ret || 450, amp: (e.amp == null ? 1 : e.amp) * (.75 + .35 * (ENERGY[baseMood] != null ? ENERGY[baseMood] : .7)), hand: e.hand || null };
        }
        lastArmAt = now;
      } else if (e.k === "head") hevs.push({ type: e.type, t0: now, amp: e.amp, dur: e.dur, n: e.n || 1 });
      else if (e.k === "face") fevs.push({ m: EXPR[e.name], t0: now, amp: e.amp, att: e.att, hold: e.hold, dec: e.dec });
      else if (e.k === "gaze") gazeOv = { tx: e.x, ty: e.y, until: now + e.dur };
      else if (e.k === "blink" && blinkT < 0) blinkAt = now;
    }
    function leadMs(e) { return e.k === "arm" ? (e.prep || 320) + 150 : (e.lead || 100); }   // people's gesture strokes land just BEFORE the word they belong to

    function loop(now) {
      if (disposed || !attached) { raf = 0; return; }
      raf = requestAnimationFrame(loop);
      const dt = Math.min(.05, (now - last) / 1000); last = now;
      if (!ready) return;
      if (frames < 90) { acc += dt; if (++frames === 90 && acc / 90 > .036 && rd.getPixelRatio() > 1) { rd.setPixelRatio(1); rd.setSize(W, H, false); } }

      const spk = speaking && (TL || now < endAt);
      if (!spk) speaking = false;
      const emoName = listening ? "listening" : (thinking && !spk) ? "thoughtful" : (manualEmo && now < manualUntil) ? manualEmo : baseEmo;
      const em = EMO[emoName] || EMO.neutral, sc = spk ? .7 : 1, T = {};
      for (const k in em.m) T[k] = em.m[k] * (/smile|press|frown/i.test(k) ? sc : 1);

      // lips + timeline position
      let p = -1;
      if (spk && TL && TL.u.length) {
        const eff = now - (+window.EchoFace.lipDelay || 0), U = TL.u;
        if (!bnd) p = (eff - tlStart) / mpw;
        else { const w = TL.words[wi]; p = w.t + (eff - anchorTime) / mpw; if (p > w.g1) p = w.g1; }
        while (ui > 0 && U[ui].t > p) ui--;
        while (ui < U.length - 1 && U[ui + 1].t <= p) ui++;
        const un = U[ui];
        if (p >= 0 && p < TL.total && un.v) {
          const frac = clamp((p - un.t) / un.d, 0, 1), wt = un.v === "PP" ? 1 : (VOWELS[un.v] ? .85 : .6) * un.amp;
          T["viseme_" + un.v] = wt; T.jawOpen = (JAW[un.v] ?? .05) * un.amp * (VOWELS[un.v] ? 1 : .8);
          if (un.v === "O") { T.mouthFunnel = .4; T.mouthPucker = .15; }
          if (un.v === "U") { T.mouthPucker = .3; T.mouthFunnel = .25; }
          const nx = U[ui + 1];
          if (nx && nx.v && frac > .55) { const n = "viseme_" + nx.v; T[n] = Math.max(T[n] || 0, .45 * (frac - .55) / .45); }
        }
        // behaviour cues fire a little before their word so the stroke lands on it
        while (evi < evs.length && p >= evs[evi].t - leadMs(evs[evi]) / mpw) fire(evs[evi++], now);
      }
      // facial overlays from the words
      for (let i = fevs.length - 1; i >= 0; i--) {
        const f = fevs[i], a = now - f.t0, tot = f.att + f.hold + f.dec;
        if (a >= tot) { fevs.splice(i, 1); continue; }
        const e = (a < f.att ? ease(a / f.att) : a < f.att + f.hold ? 1 : 1 - ease((a - f.att - f.hold) / f.dec)) * f.amp;
        for (const k in f.m) T[k] = clamp((T[k] || 0) + f.m[k] * e * (spk && /^mouth/.test(k) ? .6 : 1), 0, 1);
      }
      // active-listening nods
      if (listening && now > listenNodAt) { hevs.push({ type: "nod", t0: now, amp: .07, dur: 450, n: 1 }); listenNodAt = now + 2200 + Math.random() * 2200; }
      // blink
      if (now > blinkAt && blinkT < 0) blinkT = now;
      let bl = 0;
      if (blinkT >= 0) { const q = (now - blinkT) / 150; if (q >= 1) { blinkT = -1; blinkAt = now + (Math.random() < .2 ? 250 : 2200 + Math.random() * 3300); } else bl = Math.sin(Math.PI * q); }
      T.eyeBlinkLeft = T.eyeBlinkRight = bl;
      // gaze
      if (gazeOv && now < gazeOv.until) { gaze.tx = gazeOv.tx; gaze.ty = gazeOv.ty; gaze.next = gazeOv.until; }
      else if (now > gaze.next) {
        const away = Math.random() < (listening ? .08 : .2) || (emoName === "thoughtful" && Math.random() < .5);
        gaze.tx = away ? (Math.random() - .5) * .7 : 0;
        gaze.ty = away ? (emoName === "thoughtful" ? .35 : (Math.random() - .5) * .4) : 0;
        gaze.next = now + (away ? 600 + Math.random() * 500 : 1500 + Math.random() * 2500);
      }
      gaze.x += (gaze.tx - gaze.x) * (1 - Math.exp(-dt / .07)); gaze.y += (gaze.ty - gaze.y) * (1 - Math.exp(-dt / .07));
      const gx = gaze.x, gy = gaze.y;
      T.eyeLookOutLeft = Math.max(0, gx); T.eyeLookInRight = Math.max(0, gx); T.eyeLookInLeft = Math.max(0, -gx); T.eyeLookOutRight = Math.max(0, -gx);
      T.eyeLookUpLeft = T.eyeLookUpRight = Math.max(0, gy); T.eyeLookDownLeft = T.eyeLookDownRight = Math.max(0, -gy);
      for (const n in T) if (!(n in cur)) cur[n] = 0;
      for (const n in cur) {
        const tau = /viseme|mouthFunnel|mouthPucker/.test(n) ? .032 : /jaw/.test(n) ? .045 : /Blink/.test(n) ? .035 : /eyeLook/.test(n) ? .06 : .16;
        cur[n] += ((T[n] || 0) - cur[n]) * (1 - Math.exp(-dt / tau));
        for (const m of morphs) { const i = m.morphTargetDictionary[n]; if (i !== undefined) m.morphTargetInfluences[i] = cur[n]; }
      }

      // ── body: breathing, weight shift, head moves (before the arms, which hang off the shoulders) ──
      const a = spk ? 1 : .4, t = now, sw = REDUCED ? .3 : 1, en = ENERGY[baseMood] != null ? ENERGY[baseMood] : .7;
      let px = 0, py = 0, pz = 0;
      for (let i = hevs.length - 1; i >= 0; i--) {
        const h = hevs[i], u = (now - h.t0) / h.dur; if (u >= 1) { hevs.splice(i, 1); continue; }
        const env = Math.pow(Math.sin(Math.PI * u), .7);
        if (h.type === "nod") px += h.amp * Math.sin(2 * Math.PI * h.n * u) * env;
        else if (h.type === "shake") py += h.amp * Math.sin(2 * Math.PI * h.n * u) * env;
        else if (h.type === "tilt") pz += h.amp * env;
        else if (h.type === "down") px += h.amp * env;
        else if (h.type === "up") px -= h.amp * env;
        else if (h.type === "beat") px += h.amp * Math.sin(Math.PI * u);
      }
      const breath = Math.sin(t / 1000 * 2 * Math.PI / (spk ? 3.1 : 4.2));
      hx += (em.h[0] - hx) * (1 - Math.exp(-dt / .4)); hz += (em.h[1] - hz) * (1 - Math.exp(-dt / .4));
      const yaw = sw * (.07 * a * Math.sin(t / 2600) + .035 * Math.sin(t / 1500)) + py;
      const e = new THREE.Euler(hx + px + sw * .015 * Math.sin(t / 1900) + (cur.jawOpen || 0) * .08, yaw, hz + pz * sw + sw * .015 * Math.sin(t / 2100));
      B.Head.quaternion.copy(base.Head).multiply(new Q().setFromEuler(e));
      if (B.Neck) B.Neck.quaternion.copy(base.Neck).multiply(new Q().setFromEuler(new THREE.Euler(hx * .4 + px * .35, yaw * .4, hz * .3 + pz * .3)));
      const lean = sw * (.016 * Math.sin(t / 7300 + wsPh) + .01 * Math.sin(t / 4100));       // slow weight shift
      if (B.Spine1) B.Spine1.quaternion.copy(base.Spine1).multiply(new Q().setFromEuler(new THREE.Euler(breath * .007 * sw, lean * .5, lean)));
      if (B.Spine2) B.Spine2.quaternion.copy(base.Spine2).multiply(new Q().setFromEuler(new THREE.Euler(breath * .01 * sw + sw * .012 * Math.sin(t / 1050) * (spk ? 1 : .3) + (emoName === "serious" ? .03 : 0), sw * .03 * Math.sin(t / 3300) + lean * .6, sw * .008 * Math.sin(t / 2700))));
      // shoulders: breathing lift + shrug
      shrugNow *= Math.exp(-dt * 2.5);
      for (const side of [L, R]) if (shRest[side]) B[side + "Shoulder"].quaternion.copy(shRest[side]).multiply(_q.setFromAxisAngle(AXX, -(shrugNow + breath * .012 * sw)));
      model.updateMatrixWorld(true);
      animArms(now, dt);
      applyFrame(false, dt);
      rd.render(scene, cam);
    }

    // ── public API for one face ──
    const api = {
      avatarKey: null, dead: false, onFail: opts.onFail || null, ready: null,
      attach, unmount: detach, destroy,
      setMood(m, color) { baseMood = m in MOOD_EMO ? m : "neutral"; baseEmo = MOOD_EMO[baseMood]; if (color) { try { rim.color.set(color); } catch (e) {} } },
      setListening(b) { listening = !!b; if (listening) listenNodAt = performance.now() + 1200; },
      setThinking(b) { thinking = !!b; },
      setEmotion(name, ms) { if (EMO[name]) { manualEmo = name; manualUntil = performance.now() + (ms || 3000); } },
      setFrame(n) { if (FRAMES[n]) frameName = n; },
      setTone(s) { tone = String(s).split(",").map(Number); applyTone(); },
      setAvatar(k) { if (k === avatarKey) return Promise.resolve(); api.ready = loadModel(k); return api.ready; },
      uStart(text, o) {
        o = o || {}; const now = performance.now();
        rate = clamp(+o.rate || 1, .3, 2); voice = o.voice || "";
        mpw = clamp(mpFor(voice) / rate, 22, 160);
        speaking = true; TL = buildTL(text); ui = 0; bnd = false; wi = 0; anchorTime = tlStart = t0 = now;
        evs = planBehavior(TL, baseMood, text, mpw); evi = 0;
      },
      boundary(ci, name) {
        if (!TL || (name && name !== "word")) return;
        const now = performance.now(), W2 = TL.words; let k = -1;
        for (let i = 0; i < W2.length; i++) { if (W2[i].ci <= ci) k = i; else break; }
        if (k < 0) return;
        while (k > 0 && W2[k - 1].ci === W2[k].ci) k--;
        if (bnd && k > wi) {
          const units = W2[k].t - W2[wi].t, ms = now - anchorTime;
          if (units > .8 && ms > 30 && ms < 3000) mpw = clamp(mpw * .75 + (ms / units) * .25, 22, 160);
        }
        bnd = true; wi = k; anchorTime = now;
      },
      uEnd() {
        const now = performance.now();
        if (TL && t0 && TL.speech > 6) {
          const dur = now - t0;
          if (dur > 400) {
            const obs = clamp((bnd ? mpw : dur / TL.speech) * rate, 25, 150);
            mp1[voice] = mp1[voice] ? clamp(mp1[voice] * .5 + obs * .5, 25, 150) : obs;
            try { localStorage.setItem(MP_KEY, JSON.stringify(mp1)); } catch (e) {}
          }
          stats.mode = bnd ? "words" : "estimated"; stats.mpw = Math.round(mpw);
        }
        TL = null; endAt = now + 600;
      },
      stop() { TL = null; speaking = false; evs = []; endAt = 0; },
      // test hooks
      debug: {
        model: () => model, bones: () => B,
        frame(n) { frameName = n; applyFrame(true); },
        cam(z, y) { cam.position.set(0, y, z); cam.lookAt(0, y, 0); },
        face(name, amp) { fevs.length = 0; if (EXPR[name]) fevs.push({ m: EXPR[name], t0: performance.now(), amp: amp || 1, att: 150, hold: 1e8, dec: 300 }); },
        guard() { model.updateMatrixWorld(true); sampleHands(); const h = nearest(GS.pts.Left, GS.pts.Right); return { hh: h.d, nL: GS.pts.Left.length, nR: GS.pts.Right.length, pushL: push.Left.toArray(), pushR: push.Right.toArray() }; },
        palm(side) { return palmLocal[side].clone().applyQuaternion(B[side + "Hand"].getWorldQuaternion(new Q())); },
        hold(spec) { const n = performance.now(); for (const side of [L, R]) { const s = spec[side === L ? "L" : "R"]; gst[side] = s ? { name: s.g, t0: n - 1e6, prep: 1, hold: 1e12, ret: 1, amp: s.amp || 1, hand: s.hand || null } : null; } },
        step(n, dt) { for (let i = 0; i < n; i++) { model.updateMatrixWorld(true); animArms(performance.now(), dt || .1); } model.updateMatrixWorld(true); },
        render() { rd.render(scene, cam); },
      },
    };
    api.setMood(opts.mood || "neutral", opts.moodColor);
    api.ready = loadModel(opts.avatar || "f1");
    api.ready.catch(() => { if (pool === api) destroy(); });
    idleTimer = setTimeout(destroy, 4 * 60 * 1000);
    return api;
  }

  // ── global facade: the app talks to whichever face is current ────────────────
  window.EchoFace = {
    lipDelay: 60,   // ms. Raise it if the lips move BEFORE the voice, lower (or go negative) if they lag behind.
    stats, timing,
    mount(el, opts) {
      opts = opts || {};
      if (pool && !pool.dead) {
        pool.onFail = opts.onFail || null; pool.attach(el); active = pool;
        pool.setMood(opts.mood || "neutral", opts.moodColor);
        if (opts.tone) pool.setTone(opts.tone);
        if (opts.frame) pool.setFrame(opts.frame);
        if (opts.avatar && pool.avatarKey !== opts.avatar) pool.setAvatar(opts.avatar);
        return pool;
      }
      pool = create(opts); active = pool; pool.attach(el);
      return pool;
    },
    warm(opts) { if (!pool || pool.dead) { pool = create(opts || {}); active = pool; } return pool.ready; },
    utteranceStart(t, o) { active && active.uStart(t, o); },
    boundary(ci, name) { active && active.boundary(ci, name); },
    utteranceEnd() { active && active.uEnd(); },
    stop() { active && active.stop(); },
    supported() { try { const c = document.createElement("canvas"); return !!(c.getContext("webgl") || c.getContext("experimental-webgl")); } catch (e) { return false; } },
    _debug: { buildTL, wordVisemes, planBehavior, GEST, SHAPES, CUES, pool: () => pool, setRandom(f) { rnd = f || Math.random; }, log(on) { LOG = on ? [] : null; return LOG; } },
  };
})();
