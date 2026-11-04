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
  // How animated the hands get per mood (probability a sentence gets a gesture)
  const GEST_P = { joy: .8, hope: .6, love: .5, neutral: .55, confusion: .5, anger: .6, fear: .3, sadness: .15 };
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
          const k = FUNC.has(tk) ? .75 : 1, w = { ci, t: c };
          for (const v of wordVisemes(tk)) { const d = (DUR[v] || 1) * k; u.push({ v, d, t: c, ci, amp: .85 + ((u.length * 7) % 5) * .05 }); c += d; }
          speech = c;
          u.push({ v: null, d: .3, t: c, ci }); c += .3;      // lips relax briefly between words
          w.t1 = c; words.push(w);
        }
      } else {
        const d = m[3] ? 3 : m[4] ? 5 : 2;
        u.push({ v: null, d, t: c, ci }); c += d;
        if (words.length) words[words.length - 1].t1 = c;
      }
    }
    for (let i = words.length - 1, g = 0; i >= 0; i--) { if (!g || words[i].ci !== words[i + 1].ci) g = words[i].t1; words[i].g1 = g; }
    return { u, words, total: Math.max(c, 1), speech: Math.max(speech, 1) };
  }

  // speaking speed (ms per unit at rate 1) is remembered per voice between sessions
  const MP_KEY = "echoface_mpw1";
  let mp1 = {}; try { mp1 = JSON.parse(localStorage.getItem(MP_KEY) || "{}") || {}; } catch (e) {}
  const mpFor = v => mp1[v] || 72;

  // ── gestures tied to what is being said ──────────────────────────────────────
  const GP = { welcome: [.65, -.55, .25, .7, .55, .4], open: [.5, -.7, .3, .55, .4, .75], point: [.2, -.7, .6, -.05, .15, 1], count: [.25, -.8, .5, .1, .9, .5], beat: [.3, -.75, .45, .15, .6, .8], ask: [.35, -.8, .4, .2, .35, .9], think: [.15, -.9, .35, -.5, .15, .85] };
  const RULES = [
    [/\b(everyone|welcome|hello|hi there|good (morning|afternoon|evening))\b/i, "welcome", "both"],
    [/\b(you|your|you're)\b/i, "open", "R"],               // an open hand, never a pointing finger
    [/\b(first|second|third|step)\b/i, "count", "R"],
    [/\b(remember|important|always|never|must|careful)\b/i, "beat", "R"],
    [/\b(for example|such as)\b/i, "open", "both"],
    [/\b(think|consider|imagine|wonder|maybe|perhaps)\b/i, "think", "both"],
  ];

  // ═════════════════════════════════════════════════════════════════════════════
  // One face instance = one WebGL canvas + one avatar. It is created once and kept alive when the
  // voice screen closes (detach), so opening it again is instant. It is released after 4 idle minutes.
  let pool = null, active = null;
  const stats = { mode: "idle", mpw: 0 };

  function create(opts) {
    opts = opts || {};
    let W = 240, H = 300, container = null, ro = null, attached = false, disposed = false, ready = false, raf = 0, idleTimer = 0;
    let model = null, morphs = [], B = {}, base = {};
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
      api.stop(); pose.Left = pose.Right = null; listening = false; thinking = false;
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

    // pose
    function armsTo(k) { for (const [n, s] of [["Left", 1], ["Right", -1]]) { const d = dirs(s); aim(B[n + "Arm"], B[n + "ForeArm"], d[0], k); aim(B[n + "ForeArm"], B[n + "Hand"], d[1], k); } }
    function applyTone() {
      if (!model) return;
      model.traverse(o => {
        if (o.isMesh && /head|body|skin/i.test(o.name) && !/hair|outfit|eye|teeth|lash|tongue|glass|bottom|top|shoes|foot/i.test(o.name))
          (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.color && m.color.setRGB(tone[0], tone[1], tone[2]));
      });
    }
    async function loadModel(k) {
      const buf = await getBuffer(k);
      const tp = performance.now();
      const g = await parseGLB(buf);
      timing.parse = performance.now() - tp;
      if (disposed) { disposeObj(g.scene); return; }
      ready = false;
      if (model) { scene.remove(model); disposeObj(model); }
      model = g.scene; scene.add(model); morphs = []; B = {}; base = {};
      model.traverse(o => { if (o.isSkinnedMesh) o.frustumCulled = false; if (o.morphTargetDictionary && o.morphTargetInfluences) morphs.push(o); });
      for (const n of ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head", "LeftShoulder", "RightShoulder", "LeftArm", "LeftForeArm", "RightArm", "RightForeArm", "LeftHand", "RightHand"]) B[n] = model.getObjectByName(n);
      if (!B.LeftArm || !B.Head) throw new Error("avatar needs a standard humanoid skeleton");
      for (let i = 0; i < 4; i++) armsTo(1);
      for (const n of ["Spine1", "Spine2", "Neck", "Head"]) if (B[n]) base[n] = B[n].quaternion.clone();
      model.updateWorldMatrix(true, true);
      const hy = new V3().setFromMatrixPosition(B.Head.matrixWorld).y;
      cam.position.set(0, hy - .115, 1.3); cam.lookAt(0, hy - .115, 0);
      applyTone(); avatarKey = k; api.avatarKey = k; ready = true;
    }

    // state
    let baseMood = "neutral", baseEmo = "neutral", listening = false, thinking = false;
    let manualEmo = null, manualUntil = 0, bump = null, bumpUntil = 0;
    let speaking = false, endAt = 0, evs = [], evi = 0, nodT = -1e9, listenNodAt = 0;
    // lip-sync state
    let TL = null, ui = 0, bnd = false, wi = 0, anchorTime = 0, tlStart = 0, t0 = 0, rate = 1, voice = "", mpw = mpFor("");
    const pose = { Left: null, Right: null };
    const cur = {}, gaze = { x: 0, y: 0, tx: 0, ty: 0, next: 2000 };
    let blinkAt = 2500, blinkT = -1, last = performance.now(), hx = 0, hz = 0, frames = 0, acc = 0;

    function plan(text, tl) {
      evs = []; evi = 0;
      if (REDUCED || text.length < 28 || Math.random() > (GEST_P[baseMood] ?? .5)) return;
      const e = [];
      for (const [r, g, s] of RULES) { const m = r.exec(text); if (m) { const k = tl.u.findIndex(x => x.ci >= m.index); if (k >= 0) e.push({ t: tl.u[k].t, g, s }); } }
      if (/\?\s*$/.test(text)) e.push({ t: tl.total * .6, g: "ask", s: "R" });
      if (!e.length && text.length > 70) e.push({ t: tl.total * .45, g: "open", s: "R" });
      e.sort((a, b) => a.t - b.t);
      for (const x of e) if (!evs.length || x.t - evs[evs.length - 1].t > 16) evs.push(x);
      evs = evs.slice(0, 2);
    }
    function fire(e, now) {
      for (const side of e.s === "both" ? [L, R] : [R]) pose[side] = { g: GP[e.g], t: now, until: now + 1500, beat: e.g === "beat" || e.g === "count" };
      if (e.g === "beat" || e.g === "ask" || e.g === "count") nodT = now;
    }

    function loop(now) {
      if (disposed || !attached) { raf = 0; return; }
      raf = requestAnimationFrame(loop);
      const dt = Math.min(.05, (now - last) / 1000); last = now;
      if (!ready) return;
      // drop to 1x pixel ratio on slow phones
      if (frames < 90) { acc += dt; if (++frames === 90 && acc / 90 > .036 && rd.getPixelRatio() > 1) { rd.setPixelRatio(1); rd.setSize(W, H, false); } }

      const spk = speaking && (TL || now < endAt);
      if (!spk) speaking = false;
      const emoName = listening ? "listening"
        : (thinking && !spk) ? "thoughtful"
        : (manualEmo && now < manualUntil) ? manualEmo
        : (bump && now < bumpUntil) ? bump : baseEmo;
      const em = EMO[emoName] || EMO.neutral, sc = spk ? .7 : 1, T = {};
      for (const k in em.m) T[k] = em.m[k] * (/smile|press|frown/i.test(k) ? sc : 1);

      // visemes: position on the timeline, locked to the latest spoken-word event
      if (spk && TL && TL.u.length) {
        const eff = now - (+window.EchoFace.lipDelay || 0), U = TL.u;
        let p;
        if (!bnd) p = (eff - tlStart) / mpw;                         // voice gives no word events: estimated time
        else { const w = TL.words[wi]; p = w.t + (eff - anchorTime) / mpw; if (p > w.g1) p = w.g1; }  // hold at word end until the next event
        while (ui > 0 && U[ui].t > p) ui--;
        while (ui < U.length - 1 && U[ui + 1].t <= p) ui++;
        while (evi < evs.length && p >= evs[evi].t) fire(evs[evi++], now);
        const un = U[ui];
        if (p >= 0 && p < TL.total && un.v) {
          const frac = clamp((p - un.t) / un.d, 0, 1), wt = un.v === "PP" ? 1 : (VOWELS[un.v] ? .85 : .6) * un.amp;
          T["viseme_" + un.v] = wt; T.jawOpen = (JAW[un.v] ?? .05) * un.amp * (VOWELS[un.v] ? 1 : .8);
          if (un.v === "O") { T.mouthFunnel = .4; T.mouthPucker = .15; }
          if (un.v === "U") { T.mouthPucker = .3; T.mouthFunnel = .25; }
          const nx = U[ui + 1];
          if (nx && nx.v && frac > .55) { const n = "viseme_" + nx.v; T[n] = Math.max(T[n] || 0, .45 * (frac - .55) / .45); }
        }
      }
      // active-listening nods
      if (listening && now > listenNodAt) { nodT = now; listenNodAt = now + 2200 + Math.random() * 2200; }
      // blink
      if (now > blinkAt && blinkT < 0) blinkT = now;
      let bl = 0;
      if (blinkT >= 0) { const q = (now - blinkT) / 150; if (q >= 1) { blinkT = -1; blinkAt = now + (Math.random() < .2 ? 250 : 2200 + Math.random() * 3300); } else bl = Math.sin(Math.PI * q); }
      T.eyeBlinkLeft = T.eyeBlinkRight = bl;
      // gaze: mostly eye contact, with natural glances away
      if (now > gaze.next) {
        const away = Math.random() < (listening ? .08 : .2) || (emoName === "thoughtful" && Math.random() < .5);
        gaze.tx = away ? (Math.random() - .5) * .7 : 0;
        gaze.ty = away ? (emoName === "thoughtful" ? .35 : (Math.random() - .5) * .4) : 0;
        gaze.next = now + (away ? 600 + Math.random() * 500 : 1500 + Math.random() * 2500);
      }
      gaze.x += (gaze.tx - gaze.x) * (1 - Math.exp(-dt / .07)); gaze.y += (gaze.ty - gaze.y) * (1 - Math.exp(-dt / .07));
      const gx = gaze.x, gy = gaze.y;
      T.eyeLookOutLeft = Math.max(0, gx); T.eyeLookInRight = Math.max(0, gx); T.eyeLookInLeft = Math.max(0, -gx); T.eyeLookOutRight = Math.max(0, -gx);
      T.eyeLookUpLeft = T.eyeLookUpRight = Math.max(0, gy); T.eyeLookDownLeft = T.eyeLookDownRight = Math.max(0, -gy);
      // smooth + apply to every mesh that has the morph target
      for (const n in T) if (!(n in cur)) cur[n] = 0;
      for (const n in cur) {
        const tau = /viseme|mouthFunnel|mouthPucker/.test(n) ? .032 : /jaw/.test(n) ? .045 : /Blink/.test(n) ? .035 : /eyeLook/.test(n) ? .06 : .22;
        cur[n] += ((T[n] || 0) - cur[n]) * (1 - Math.exp(-dt / tau));
        for (const m of morphs) { const i = m.morphTargetDictionary[n]; if (i !== undefined) m.morphTargetInfluences[i] = cur[n]; }
      }
      // arms: rest unless a gesture is active
      for (const [n, s] of [[L, 1], [R, -1]]) {
        const ps = pose[n], act = ps && now < ps.until; let g = null;
        if (act) { const a = (now - ps.t) / 1000; g = ps.g.slice(); const bump2 = ps.beat ? .2 * Math.exp(-a * 5) : 0; g[4] += .05 * Math.sin(a * 5) + bump2; g[1] -= bump2 * .6; }
        else if (ps) pose[n] = null;
        const d = dirs(s, g), k = 1 - Math.exp(-dt * (act ? 6 : 3));
        aim(B[n + "Arm"], B[n + "ForeArm"], d[0], k); aim(B[n + "ForeArm"], B[n + "Hand"], d[1], k);
      }
      // head & body
      const a = spk ? 1 : .4, t = now, ns = (now - nodT) / 400, nod = ns < 1 ? .07 * Math.sin(Math.PI * ns) : 0, sw = REDUCED ? .3 : 1;
      hx += (em.h[0] - hx) * (1 - Math.exp(-dt / .4)); hz += (em.h[1] - hz) * (1 - Math.exp(-dt / .4));
      const yaw = sw * (.07 * a * Math.sin(t / 2600) + .035 * Math.sin(t / 1500));
      const e = new THREE.Euler(hx + nod + sw * .015 * Math.sin(t / 1900) + (cur.jawOpen || 0) * .08, yaw, hz + sw * .015 * Math.sin(t / 2100));
      B.Head.quaternion.copy(base.Head).multiply(new Q().setFromEuler(e));
      if (B.Neck) B.Neck.quaternion.copy(base.Neck).multiply(new Q().setFromEuler(new THREE.Euler(hx * .4 + nod * .3, yaw * .4, hz * .3)));
      if (B.Spine2) B.Spine2.quaternion.copy(base.Spine2).multiply(new Q().setFromEuler(new THREE.Euler(sw * .012 * Math.sin(t / 1050) + (emoName === "serious" ? .03 : 0), sw * .03 * Math.sin(t / 3300), sw * .008 * Math.sin(t / 2700))));
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
      setTone(s) { tone = String(s).split(",").map(Number); applyTone(); },
      setAvatar(k) { if (k === avatarKey) return Promise.resolve(); api.ready = loadModel(k); return api.ready; },
      uStart(text, o) {
        o = o || {}; const now = performance.now();
        rate = clamp(+o.rate || 1, .3, 2); voice = o.voice || "";
        mpw = clamp(mpFor(voice) / rate, 22, 160);                    // speaking speed learned for this voice
        speaking = true; TL = buildTL(text); ui = 0; bnd = false; wi = 0; anchorTime = tlStart = t0 = now;
        plan(text, TL); bump = textBump(text); bumpUntil = now + 4000;
      },
      boundary(ci, name) {
        if (!TL || (name && name !== "word")) return;
        const now = performance.now(), W2 = TL.words; let k = -1;
        for (let i = 0; i < W2.length; i++) { if (W2[i].ci <= ci) k = i; else break; }
        if (k < 0) return;
        while (k > 0 && W2[k - 1].ci === W2[k].ci) k--;
        if (bnd && k > wi) {                                           // learn the speed from the word just finished
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
            // word events give the most accurate speed; otherwise use total time. A voice heard for the first
            // time adopts the measurement outright, later ones blend it in.
            const obs = clamp((bnd ? mpw : dur / TL.speech) * rate, 25, 150);
            mp1[voice] = mp1[voice] ? clamp(mp1[voice] * .5 + obs * .5, 25, 150) : obs;
            try { localStorage.setItem(MP_KEY, JSON.stringify(mp1)); } catch (e) {}
          }
          stats.mode = bnd ? "words" : "estimated"; stats.mpw = Math.round(mpw);
        }
        TL = null; endAt = now + 600;
      },
      stop() { TL = null; speaking = false; evs = []; bump = null; endAt = 0; },
    };
    api.setMood(opts.mood || "neutral", opts.moodColor);
    api.ready = loadModel(opts.avatar || "f1");
    api.ready.catch(() => { if (pool === api) destroy(); });          // a failed load must not be reused
    idleTimer = setTimeout(destroy, 4 * 60 * 1000);                    // cleared on attach()
    return api;
  }

  // ── global facade: the app talks to whichever face is current ────────────────
  window.EchoFace = {
    lipDelay: 60,   // ms. Raise it if the lips move BEFORE the voice, lower (or go negative) if they lag behind.
    stats, timing,
    mount(el, opts) {
      opts = opts || {};
      if (pool && !pool.dead) {                                       // reuse the warm face: instant
        pool.onFail = opts.onFail || null; pool.attach(el); active = pool;
        pool.setMood(opts.mood || "neutral", opts.moodColor);
        if (opts.tone) pool.setTone(opts.tone);
        if (opts.avatar && pool.avatarKey !== opts.avatar) pool.setAvatar(opts.avatar);
        return pool;
      }
      pool = create(opts); active = pool; pool.attach(el);
      return pool;
    },
    warm(opts) {                                                      // build the face off-screen ahead of time
      if (!pool || pool.dead) { pool = create(opts || {}); active = pool; }
      return pool.ready;
    },
    utteranceStart(t, o) { active && active.uStart(t, o); },
    boundary(ci, name) { active && active.boundary(ci, name); },
    utteranceEnd() { active && active.uEnd(); },
    stop() { active && active.stop(); },
    supported() { try { const c = document.createElement("canvas"); return !!(c.getContext("webgl") || c.getContext("experimental-webgl")); } catch (e) { return false; } },
    _debug: { buildTL, wordVisemes },
  };
})();
