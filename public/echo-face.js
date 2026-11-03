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

  // ── avatar download (cached in memory; the service worker caches it for offline)
  const bufs = {};
  function getBuffer(key) {
    const url = AVATARS[key] || AVATARS.f1;
    if (!bufs[url]) {
      bufs[url] = fetch(url)
        .then(r => { if (!r.ok) throw new Error("avatar HTTP " + r.status); return r.arrayBuffer(); })
        .catch(e => { delete bufs[url]; throw e; });
    }
    return bufs[url];
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

  // ── lip-sync: text → viseme timeline ─────────────────────────────────────────
  const VM = { a: "aa", e: "E", i: "I", o: "O", u: "U", w: "U", y: "I", b: "PP", m: "PP", p: "PP", f: "FF", v: "FF", t: "DD", d: "DD", l: "DD", k: "kk", g: "kk", c: "kk", q: "kk", s: "SS", z: "SS", x: "SS", j: "CH", r: "RR", n: "nn" };
  const JAW = { aa: .3, O: .2, E: .14, I: .09, U: .08, PP: 0, FF: .02 };
  let mpw = 62; // ms per timeline unit, re-calibrated after every utterance and shared across mounts
  function buildTL(text) {
    const u = [], s = text.toLowerCase(); let i = 0, c = 0;
    while (i < s.length) {
      const ch = s[i], two = s.substr(i, 2); let v = null, w = .3, n = 1, vow = false;
      if (two === "th") { v = "TH"; w = .9; n = 2; } else if (two === "sh" || two === "ch") { v = "CH"; w = .9; n = 2; } else if (two === "ph") { v = "FF"; w = .9; n = 2; }
      else if (VM[ch]) { v = VM[ch]; vow = "aeiou".includes(ch); w = vow ? 1.4 : .8; }
      else if (",;:".includes(ch)) w = 3; else if (".!?".includes(ch)) w = 5; else if (ch === " ") w = .5;
      u.push({ v, w, ci: i, t: c, vow, amp: .82 + ((i * 7) % 5) * .05 }); c += w; i += n;
    }
    return { u, total: c };
  }

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
  function create(container, opts) {
    opts = opts || {};
    let W = container.clientWidth || 260, H = container.clientHeight || 325;
    let disposed = false, ready = false, raf = 0, model = null, morphs = [], B = {}, base = {};
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
    container.appendChild(cv);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x666670, .9));
    const key = new THREE.DirectionalLight(0xfff2e0, 1.1); key.position.set(1.2, 2.6, 2.5); scene.add(key);
    const rim = new THREE.DirectionalLight(0xb8d0ff, .55); rim.position.set(-2, 2, -1.5); scene.add(rim);

    const lost = e => { e.preventDefault(); if (!disposed) { opts.onFail && opts.onFail(); } };
    cv.addEventListener("webglcontextlost", lost);
    function resize() {
      if (disposed) return;
      const w = container.clientWidth, h = container.clientHeight;
      if (!w || !h || (w === W && h === H)) return;
      W = w; H = h; rd.setSize(W, H, false); cam.aspect = W / H; cam.updateProjectionMatrix();
    }
    const ro = window.ResizeObserver ? new ResizeObserver(resize) : null;
    if (ro) ro.observe(container);

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
      const g = await parseGLB(buf);
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
    let speaking = false, endAt = 0, TL = null, tlStart = 0, t0 = 0, evs = [], evi = 0, nodT = -1e9, listenNodAt = 0;
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
      if (disposed) return;
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

      // visemes
      if (spk && TL) {
        const p = (now - tlStart + (+window.EchoFace.lipOffset || 0)) / mpw, U = TL.u;
        let k = 0; while (k < U.length - 1 && U[k + 1].t <= p) k++;
        const un = U[k];
        while (evi < evs.length && p >= evs[evi].t) fire(evs[evi++], now);
        if (p >= 0 && p < TL.total && un.v) {
          const frac = (p - un.t) / un.w, wt = un.v === "PP" ? 1 : (un.vow ? .8 : .55) * un.amp;
          T["viseme_" + un.v] = wt; T.jawOpen = (JAW[un.v] ?? .04) * un.amp;
          if (un.v === "O") { T.mouthFunnel = .4; T.mouthPucker = .15; }
          if (un.v === "U") { T.mouthPucker = .3; T.mouthFunnel = .25; }
          const nx = U[k + 1];
          if (nx && nx.v && frac > .55) { const n = "viseme_" + nx.v; T[n] = Math.max(T[n] || 0, .4 * (frac - .55) / .45); }
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
        const tau = /viseme|jaw|mouthFunnel|mouthPucker/.test(n) ? .045 : /Blink/.test(n) ? .035 : /eyeLook/.test(n) ? .06 : .22;
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
    raf = requestAnimationFrame(loop);

    // ── public API for one mounted face ──
    const api = {
      avatarKey: null,
      setMood(m, color) { baseMood = m in MOOD_EMO ? m : "neutral"; baseEmo = MOOD_EMO[baseMood]; if (color) { try { rim.color.set(color); } catch (e) {} } },
      setListening(b) { listening = !!b; if (listening) listenNodAt = performance.now() + 1200; },
      setThinking(b) { thinking = !!b; },
      setEmotion(name, ms) { if (EMO[name]) { manualEmo = name; manualUntil = performance.now() + (ms || 3000); } },
      setTone(s) { tone = String(s).split(",").map(Number); applyTone(); },
      setAvatar(k) { return k === avatarKey ? Promise.resolve() : loadModel(k); },
      uStart(text) {
        const now = performance.now();
        speaking = true; TL = buildTL(text); plan(text, TL);
        bump = textBump(text); bumpUntil = now + 4000; tlStart = t0 = now;
      },
      boundary(ci) {
        if (!TL) return;
        const U = TL.u, k = U.findIndex(x => x.ci >= ci);
        if (k >= 0) tlStart = performance.now() - U[k].t * mpw;
      },
      uEnd() {
        if (TL && t0 && TL.total) { const d = (performance.now() - t0) / TL.total; mpw = clamp(mpw * .4 + d * .6, 35, 110); }
        TL = null; endAt = performance.now() + 600;
      },
      stop() { TL = null; speaking = false; evs = []; bump = null; endAt = 0; },
      unmount() {
        if (disposed) return; disposed = true; cancelAnimationFrame(raf);
        if (ro) ro.disconnect(); cv.removeEventListener("webglcontextlost", lost);
        if (model) { scene.remove(model); disposeObj(model); model = null; }
        try { rd.dispose(); rd.forceContextLoss && rd.forceContextLoss(); } catch (e) {}
        if (cv.parentNode) cv.parentNode.removeChild(cv);
        if (active === api) active = null;
      },
    };
    api.setMood(opts.mood || "neutral", opts.moodColor);
    api.ready = loadModel(opts.avatar || "f1");
    return api;
  }

  // ── global facade: the app talks to whichever face is on screen ──────────────
  let active = null;
  window.EchoFace = {
    lipOffset: 0, // ms; positive = mouth moves later. Adjust if lips lead/lag the voice on a device.
    mount(el, opts) { active = create(el, opts); return active; },
    utteranceStart(t) { active && active.uStart(t); },
    boundary(ci) { active && active.boundary(ci); },
    utteranceEnd() { active && active.uEnd(); },
    stop() { active && active.stop(); },
    supported() { try { const c = document.createElement("canvas"); return !!(c.getContext("webgl") || c.getContext("experimental-webgl")); } catch (e) { return false; } },
  };
})();
