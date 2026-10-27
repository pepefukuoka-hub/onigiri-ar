(function () {
  'use strict';
  const VER = 1;
  const $ = (id) => document.getElementById(id);
  const get = (k, d) => { try { return localStorage.getItem(k) || d; } catch (e) { return d; } };
  const put = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

  // 4匹の子。h は、北からの角度(右まわり)
  const CATS = [
    { name: '北', h: 0, color: 0xf7f4ec, ear: 0xffb6c1, hz: 1.0, ph: 0 },
    { name: '東', h: 90, color: 0xe8a04a, ear: 0xffa7a0, hz: 1.15, ph: 1.3 },
    { name: '南', h: 180, color: 0x2e2d33, ear: 0xe58aa0, hz: 0.9, ph: 2.1 },
    { name: '西', h: 270, color: 0xb7bdc8, ear: 0xffb0c4, hz: 1.05, ph: 0.6 },
  ];
  const DIR8 = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
  const NORTH = { az: 0, src: 'なし', manual: false };   // シーンの中で「北」がどの向きか(ラジアン)

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('読み込み失敗: ' + src));
      document.head.appendChild(s);
    });
  }

  // ---------- 音楽の保存(この端末の中だけ) ----------
  const songs = [null, null, null, null];   // { data, type, name }
  function idb() {
    return new Promise((res, rej) => { const r = indexedDB.open('neko', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  }
  async function idbDo(mode, fn) {
    const db = await idb();
    return new Promise((res, rej) => { const q = fn(db.transaction('kv', mode).objectStore('kv')); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  }
  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
  const songEls = [];
  function showSong(i) {
    const s = songs[i], e = songEls[i];
    e.sm.textContent = s ? s.name + '(' + mb(s.data.byteLength) + ')' : 'まだ選んでいません(音は鳴りません)';
    e.clr.hidden = !s;
  }
  function buildSongs() {
    CATS.forEach((c, i) => {
      const box = document.createElement('div'); box.className = 'song';
      box.innerHTML = '<b>' + c.name + 'の子の音楽</b><div class="row"><input type="file" accept="audio/*,video/*"><button type="button" hidden>消す</button></div><div class="sm"></div>';
      const inp = box.querySelector('input'), clr = box.querySelector('button'), sm = box.querySelector('.sm');
      songEls.push({ sm, clr });
      inp.onchange = async () => {
        const f = inp.files[0]; if (!f) return;
        try {
          const data = await f.arrayBuffer(); songs[i] = { data, type: f.type || '', name: f.name };
          try { await idbDo('readwrite', (st) => st.put(songs[i], 'cat' + i)); } catch (e) { sm.textContent = '(保存はできません。今回だけ使えます)'; }
        } catch (e) { sm.textContent = '読み込めませんでした。別のファイルを選んでください。'; return; }
        showSong(i);
      };
      clr.onclick = async () => { songs[i] = null; inp.value = ''; try { await idbDo('readwrite', (st) => st.delete('cat' + i)); } catch (e) {} showSong(i); };
      $('songs').appendChild(box); showSong(i);
    });
  }
  async function restoreSongs() {
    for (let i = 0; i < 4; i++) { try { const v = await idbDo('readonly', (s) => s.get('cat' + i)); if (v && v.data) { songs[i] = v; showSong(i); } } catch (e) {} }
  }

  // ---------- 音の再生: 向いている子の音楽を大きく ----------
  const LOW = 0.07;
  let actx = null, sndState = '';
  const players = [null, null, null, null];   // { setGain(v) }
  function meow(pitch) {
    if (!actx || actx.state !== 'running') return;
    const t0 = actx.currentTime, o = actx.createOscillator(), f = actx.createBiquadFilter(), g = actx.createGain();
    o.type = 'sawtooth'; o.frequency.setValueAtTime(pitch * 0.8, t0); o.frequency.linearRampToValueAtTime(pitch * 1.25, t0 + 0.12); o.frequency.linearRampToValueAtTime(pitch * 0.7, t0 + 0.42);
    f.type = 'bandpass'; f.Q.value = 3; f.frequency.setValueAtTime(900, t0); f.frequency.linearRampToValueAtTime(1800, t0 + 0.15); f.frequency.linearRampToValueAtTime(900, t0 + 0.42);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.5, t0 + 0.05); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.45);
    o.connect(f); f.connect(g); g.connect(actx.destination); o.start(t0); o.stop(t0 + 0.5);
  }
  async function startSongs() {
    if (!actx) { sndState = 'この端末では音を使えません'; return; }
    try { await actx.resume(); } catch (e) {}
    let n = 0;
    for (let i = 0; i < 4; i++) {
      const s = songs[i]; if (!s) continue; n++;
      const gain = actx.createGain(); gain.gain.value = LOW; gain.connect(actx.destination);
      try {
        const buf = await new Promise((res, rej) => { const p = actx.decodeAudioData(s.data.slice(0), res, rej); if (p && p.catch) p.catch(rej); });
        const src = actx.createBufferSource(); src.buffer = buf; src.loop = true; src.connect(gain); src.start(0);
        players[i] = { setGain: (v) => gain.gain.setTargetAtTime(v, actx.currentTime, 0.15) };
      } catch (e) {   // 取り出せない形式のときは、再生用の要素から流す
        try {
          const v = document.createElement('video'); v.loop = true; v.playsInline = true; v.style.display = 'none';
          v.src = URL.createObjectURL(new Blob([s.data], { type: s.type || 'audio/mp4' })); document.body.appendChild(v);
          actx.createMediaElementSource(v).connect(gain); await v.play();
          players[i] = { setGain: (x) => gain.gain.setTargetAtTime(x, actx.currentTime, 0.15) };
        } catch (e2) { sndState = CATS[i].name + 'の音楽を再生できません'; }
      }
    }
    if (!sndState) sndState = n ? '音楽 ' + n + ' 曲を再生中' : '音楽は未選択(スタート画面で選べます)';
  }
  window.addEventListener('pointerup', () => { if (actx && actx.state !== 'running') actx.resume().catch(() => {}); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && actx) actx.resume().catch(() => {}); });

  // ---------- 部品 ----------
  function registerComponents() {
    // 端末の向きでカメラを回す。Androidは「絶対」の向き(北が基準)を使い、iPhoneはコンパスの値で北を割り出す
    AFRAME.registerComponent('neko-look', {
      init: function () {
        this.ori = null; this.abs = false; this.count = 0; this.yaw = 0; this.pitch = 0; this.ios = null; this.sx = 0; this.sy = 0; this.have = false;
        this.euler = new THREE.Euler(); this.q0 = new THREE.Quaternion(); this.f = new THREE.Vector3();
        this.q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); this.zee = new THREE.Vector3(0, 0, 1);
        window.addEventListener('deviceorientationabsolute', (e) => {
          if (e.alpha == null) return; this.ori = e; this.abs = true; this.count++;
          if (!NORTH.manual) { NORTH.az = 0; NORTH.src = 'コンパス(Android)'; }
        });
        window.addEventListener('deviceorientation', (e) => {
          if (this.abs || (e.alpha == null && e.beta == null)) return;
          this.ori = e; this.count++;
          if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) this.ios = e.webkitCompassHeading;
        });
        let drag = null;   // 向きが取れないとき(パソコン)は、ドラッグで見回す
        window.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; });
        window.addEventListener('pointermove', (e) => {
          if (!drag || this.count > 5) return;
          this.yaw -= (e.clientX - drag.x) * 0.005; this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - (e.clientY - drag.y) * 0.005));
          drag = { x: e.clientX, y: e.clientY };
        });
        window.addEventListener('pointerup', () => { drag = null; });
        const fov = () => {
          const a = window.innerWidth / window.innerHeight;
          const v = a <= 0.75 ? 65 : 2 * Math.atan(Math.tan(34.5 * Math.PI / 180) / Math.max(a, 1.333)) * 180 / Math.PI;
          this.el.setAttribute('camera', 'fov', v);
        };
        fov(); window.addEventListener('resize', fov);
      },
      tick: function () { try { this.look(); } catch (e) {} },
      look: function () {
        const o = this.el.object3D, d = this.ori, rad = THREE.MathUtils.degToRad;
        if (d) {
          const sa = (screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle : (window.orientation || 0);
          this.euler.set(d.beta ? rad(d.beta) : 0, rad(d.alpha || 0), d.gamma ? -rad(d.gamma) : 0, 'YXZ');
          o.quaternion.setFromEuler(this.euler); o.quaternion.multiply(this.q1); o.quaternion.multiply(this.q0.setFromAxisAngle(this.zee, -rad(sa)));
        } else { this.euler.set(this.pitch, this.yaw, 0, 'YXZ'); o.quaternion.setFromEuler(this.euler); }
        // iPhone: コンパスの値と、いま向いている方向の差から、シーンの「北」を求める(ななめ下を向いているときは更新しない)
        if (!this.abs && this.ios != null && !NORTH.manual) {
          this.f.set(0, 0, -1).applyQuaternion(o.quaternion);
          if (Math.hypot(this.f.x, this.f.z) > 0.5) {
            const off = Math.atan2(this.f.x, -this.f.z) - rad(this.ios);
            if (!this.have) { this.sx = Math.cos(off); this.sy = Math.sin(off); this.have = true; }
            else { this.sx += (Math.cos(off) - this.sx) * 0.08; this.sy += (Math.sin(off) - this.sy) * 0.08; }
            NORTH.az = Math.atan2(this.sy, this.sx); NORTH.src = 'コンパス(iPhone)';
          }
        }
        if (!d && !NORTH.manual) NORTH.src = '向きなし(ドラッグで見回す)';
      }
    });

    const MAT = (c, r) => new THREE.MeshStandardMaterial({ color: c, roughness: r == null ? 0.8 : r });
    const DARK = MAT(0x1b1b1d, 0.5);
    function tube(points, r, mat) {
      const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
      return new THREE.Mesh(new THREE.TubeGeometry(curve, 16, r, 6, false), mat);
    }
    // 体: ひとまわり横に広い、まるい形。中心は y=0.52。前向きが +z
    const BX = 0.52, BY = 0.5, BZ = 0.45, CY = 0.52;
    const surfZ = (x, y) => BZ * Math.sqrt(Math.max(0, 1 - (x / BX) * (x / BX) - ((y - CY) / BY) * ((y - CY) / BY)));
    function label(text) {
      const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
      g.fillStyle = 'rgba(30,20,10,.75)'; g.beginPath(); g.arc(64, 64, 58, 0, 7); g.fill();
      g.fillStyle = '#fff'; g.font = 'bold 76px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 64, 70);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthTest: false }));
      sp.scale.set(0.32, 0.32, 1); sp.renderOrder = 5; return sp;
    }
    function makeCat(d) {
      const mat = MAT(d.color, 0.85), pink = MAT(d.ear, 0.7);
      const root = new THREE.Group(), body = new THREE.Group(); root.add(body);
      const torso = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 28), mat); torso.scale.set(BX, BY, BZ); torso.position.y = CY; body.add(torso);
      // ネコミミ
      const ears = [-1, 1].map((s) => {
        const g = new THREE.Group(); g.position.set(s * 0.29, CY + 0.42, -0.02); g.rotation.z = -s * 0.38;
        const out = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.32, 4), mat); out.position.y = 0.1; out.rotation.y = Math.PI / 4; out.scale.z = 0.55;
        const inn = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.2, 4), pink); inn.position.set(0, 0.07, 0.035); inn.rotation.y = Math.PI / 4; inn.scale.z = 0.5;
        g.add(out, inn); body.add(g); return g;
      });
      // 目
      const eyeY = CY + 0.1, eyes = [];
      [-0.18, 0.18].forEach((x) => {
        const g = new THREE.Group(); g.position.set(x, eyeY, surfZ(x, eyeY) - 0.005);
        const e = new THREE.Mesh(new THREE.SphereGeometry(0.058, 16, 12), DARK); e.scale.set(0.9, 1.15, 0.5); g.add(e);
        const sh = new THREE.Mesh(new THREE.SphereGeometry(0.016, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff })); sh.position.set(0.015, 0.025, 0.026); g.add(sh);
        body.add(g); eyes.push(g);
      });
      // 鼻・口(ω)・ひげ
      const noseY = CY - 0.02, nz = surfZ(0, noseY);
      const nose = new THREE.Mesh(new THREE.SphereGeometry(0.024, 12, 8), MAT(0xff8fa8, 0.5)); nose.scale.set(1.2, 0.8, 0.8); nose.position.set(0, noseY, nz + 0.003); body.add(nose);
      [-1, 1].forEach((s) => { const m = tube([[0, 0, 0], [s * 0.025, -0.022, 0], [s * 0.055, -0.004, 0]], 0.0058, DARK); m.position.set(0, noseY - 0.03, surfZ(0, noseY - 0.03) + 0.006); body.add(m); });
      [-1, 1].forEach((s) => [-1, 0, 1].forEach((k) => {
        const w = tube([[0, 0, 0], [s * 0.12, k * 0.025, 0.02], [s * 0.24, k * 0.05, 0.0]], 0.0042, DARK); w.position.set(s * 0.2, noseY - 0.02, surfZ(s * 0.2, noseY - 0.02) - 0.01); body.add(w);
      }));
      // 腕・足・しっぽ
      const arm = (s) => { const pv = new THREE.Group(); pv.position.set(s * 0.5, CY - 0.05, 0.05); pv.add(tube([[0, 0, 0], [s * 0.07, -0.02, 0.02], [s * 0.1, 0.04, 0.05], [s * 0.06, 0.1, 0.06]], 0.042, mat)); const h = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), mat); h.position.set(s * 0.06, 0.1, 0.06); pv.add(h); body.add(pv); return pv; };
      const armL = arm(-1), armR = arm(1);
      const leg = (s) => { const pv = new THREE.Group(); pv.position.set(s * 0.2, 0.2, 0.04); const l = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.07, 0.2, 10), mat); l.position.y = -0.1; const f = new THREE.Mesh(new THREE.SphereGeometry(0.085, 10, 8), mat); f.scale.set(1, 0.6, 1.3); f.position.set(0, -0.2, 0.03); pv.add(l, f); body.add(pv); return pv; };
      const legL = leg(-1), legR = leg(1);
      const tail = new THREE.Group(); tail.position.set(0, CY - 0.18, -BZ + 0.05);
      tail.add(tube([[0, 0, 0], [0, 0.04, -0.14], [0, 0.22, -0.24], [0, 0.42, -0.2], [0, 0.55, -0.06]], 0.05, mat)); body.add(tail);
      const lb = label(d.name); lb.position.set(0, CY + 0.95, 0); root.add(lb);
      body.traverse((o) => { o.frustumCulled = false; });
      // 影
      const c = document.createElement('canvas'); c.width = c.height = 128; const g2 = c.getContext('2d'), gr = g2.createRadialGradient(64, 64, 4, 64, 64, 62);
      gr.addColorStop(0, 'rgba(0,0,0,0.3)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g2.fillStyle = gr; g2.fillRect(0, 0, 128, 128);
      const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
      shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.004; root.add(shadow);
      return { d, root, body, ears, eyes, armL, armR, legL, legR, tail, hop: -1, blink: 2 + Math.random() * 3, blinkT: -1, yaw: 0 };
    }

    AFRAME.registerComponent('neko-cats', {
      schema: { size: { default: 0.9 }, dist: { default: 3 } },
      init: function () {
        this.cats = CATS.map((d) => { const c = makeCat(d); c.root.scale.setScalar(this.data.size); this.el.object3D.add(c.root); return c; });
        this.cp = new THREE.Vector3(); this.f = new THREE.Vector3(); this.rc = new THREE.Raycaster(); this.hudT = 0;
        const el = this.el; let down = null;
        window.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
        window.addEventListener('pointerup', (e) => {
          if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 12) { down = null; return; }
          down = null;
          if (e.target.closest && e.target.closest('button')) return;
          const cam = el.sceneEl.camera; if (!cam) return;
          this.rc.setFromCamera({ x: e.clientX / window.innerWidth * 2 - 1, y: -(e.clientY / window.innerHeight) * 2 + 1 }, cam);
          this.cats.forEach((c, i) => { if (this.rc.intersectObject(c.body, true).length && c.hop < 0) { c.hop = 0; meow(520 + i * 90); } });
        });
      },
      tick: function (time, dtms) { try { this.step(time, dtms); } catch (e) { if (!this.err) { this.err = 1; console.error(e); } } },
      step: function (time, dtms) {
        const cam = this.el.sceneEl.camera; if (!cam) return;
        const dt = Math.min(dtms, 100) / 1000, t = time / 1000, wrap = (a) => ((a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        cam.getWorldPosition(this.cp); cam.getWorldDirection(this.f);
        const phiCam = Math.atan2(this.f.x, -this.f.z), cp = this.cp;
        this.cats.forEach((c, i) => {
          const phi = NORTH.az + THREE.MathUtils.degToRad(c.d.h), pos = c.root.position;
          pos.set(cp.x + Math.sin(phi) * this.data.dist, 0, cp.z - Math.cos(phi) * this.data.dist);
          c.yaw += wrap(Math.atan2(cp.x - pos.x, cp.z - pos.z) - c.yaw) * Math.min(1, dt * 5);
          // 向いている方向に近いほど、音楽を大きく
          const diff = Math.abs(wrap(phiCam - phi)), v = Math.max(0, 1 - diff / (Math.PI / 3));
          if (players[i]) players[i].setGain(LOW + (1 - LOW) * v * v);
          // ダンス
          const w = (t * c.d.hz + c.d.ph) * Math.PI * 2, ds = Math.sin(w);
          let by = Math.abs(ds) * 0.07, up = 0;
          if (c.hop >= 0) { c.hop += dt; const u = c.hop / 0.6; if (u >= 1) c.hop = -1; else { by += 0.35 * Math.sin(Math.PI * u); up = Math.sin(Math.PI * u); } }
          c.body.position.y = by; c.body.rotation.y = c.yaw + 0.3 * Math.sin(w * 0.5); c.body.rotation.z = 0.14 * ds;
          c.body.scale.set(1 + 0.04 * Math.cos(w * 2), 1 - 0.04 * Math.cos(w * 2), 1);
          c.legL.rotation.x = 0.35 * ds; c.legR.rotation.x = -0.35 * ds;
          c.armL.rotation.z = -up * 1.0 - (0.7 + 0.5 * ds); c.armR.rotation.z = up * 1.0 + (0.7 - 0.5 * ds);
          c.tail.rotation.z = Math.sin(w * 0.5 + 1) * 0.5; c.tail.rotation.x = Math.sin(w * 0.25) * 0.15;
          c.ears[0].rotation.z = 0.38 + Math.max(0, Math.sin(t * 1.7 + i * 2)) ** 12 * 0.3; c.ears[1].rotation.z = -0.38 - Math.max(0, Math.sin(t * 1.3 + i)) ** 12 * 0.3;
          c.blink -= dt; if (c.blink <= 0) { c.blinkT = 0; c.blink = 2.5 + Math.random() * 3; }
          let sy = 1; if (c.blinkT >= 0) { c.blinkT += dt; sy = Math.max(0.1, Math.abs(c.blinkT - 0.07) / 0.07); if (c.blinkT > 0.14) { c.blinkT = -1; sy = 1; } }
          c.eyes.forEach((e) => { e.scale.y = Math.min(1, sy); });
        });
        if (time - this.hudT > 250) {
          this.hudT = time;
          const hdg = ((phiCam - NORTH.az) * 180 / Math.PI % 360 + 360) % 360;
          $('find').textContent = DIR8[Math.round(hdg / 45) % 8] + 'を向いています(' + Math.round(hdg) + '°)';
          $('snd').textContent = '方角: ' + NORTH.src + ' / ' + (sndState || '音: 準備中') + ' / 版 ' + VER;
        }
      }
    });
  }

  // ---------- 開始 ----------
  let started = false, stream = null;
  function fail(msg) { $('msg').textContent = '⚠ ' + msg; $('msg').style.color = '#e5484d'; $('go').disabled = false; }
  function step(t) { $('msg').style.color = ''; $('msg').textContent = '準備中 ' + t + ' …'; }
  const errName = (e) => (e && (e.name || e.message)) ? String(e.name || e.message) : '不明';

  async function start() {
    if (started) return;
    $('go').disabled = true;
    try {
      actx = new (window.AudioContext || window.webkitAudioContext)(); actx.resume();
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch (e) { actx = null; }
    put('neko.size', $('size').value); put('neko.eye', $('eye').value); put('neko.dist', $('dist').value);
    step('1/3 モーションの許可');
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const r = await DeviceOrientationEvent.requestPermission();
        if (r !== 'granted') { fail('モーションと方向のアクセスが許可されていません。設定 > Safari > モーションと方向のアクセス をオンにして、ページを開き直してください。'); return; }
      }
    } catch (e) { fail('モーションの許可を取得できませんでした(' + errName(e) + ')。ページを開き直して、もう一度押してください。'); return; }
    step('2/3 カメラの許可');
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }); }
    catch (e) { fail('カメラを開けませんでした(' + errName(e) + ')。設定 > Safari > カメラ で許可し、ページを開き直してください。'); return; }
    step('3/3 画面の準備');
    try { await loadScript('../vendor/aframe.min.js'); registerComponents(); }
    catch (e) { fail('部品を読み込めませんでした(' + errName(e) + ')。通信を確認して、ページを開き直してください。'); return; }

    started = true;
    const v = $('cam'); v.srcObject = stream; document.body.classList.add('ar'); v.play().catch(() => {});
    const size = parseFloat($('size').value), eye = parseFloat($('eye').value), dist = parseFloat($('dist').value);
    const scene = document.createElement('a-scene');
    scene.setAttribute('vr-mode-ui', 'enabled: false'); scene.setAttribute('renderer', 'alpha: true; antialias: true'); scene.setAttribute('embedded', '');
    scene.innerHTML =
      '<a-entity camera="fov: 65; near: 0.05; far: 500" position="0 ' + eye + ' 0" neko-look></a-entity>' +
      '<a-entity light="type: ambient; color: #ffffff; intensity: 0.85"></a-entity>' +
      '<a-entity light="type: directional; color: #ffffff; intensity: 0.5" position="1 3 2"></a-entity>' +
      '<a-entity id="cats" neko-cats="size: ' + size + '; dist: ' + dist + '"></a-entity>';
    scene.addEventListener('loaded', () => { if (scene.renderer) scene.renderer.setClearColor(0x000000, 0); });
    $('host').appendChild(scene);
    $('hud').hidden = false;
    startSongs();
  }
  $('go').onclick = start;
  $('north').onclick = () => {   // いま向いている方向を、北にする
    const sc = document.querySelector('a-scene'), cam = sc && sc.camera; if (!cam) return;
    const f = new THREE.Vector3(); cam.getWorldDirection(f);
    if (Math.hypot(f.x, f.z) < 0.3) return;
    NORTH.az = Math.atan2(f.x, -f.z); NORTH.manual = true; NORTH.src = '手で合わせた北';
  };
  $('exit').onclick = () => { location.reload(); };

  $('size').value = get('neko.size', '0.9'); $('eye').value = get('neko.eye', '1.4'); $('dist').value = get('neko.dist', '3');
  if (!$('size').value) $('size').value = '0.9'; if (!$('eye').value) $('eye').value = '1.4'; if (!$('dist').value) $('dist').value = '3';
  buildSongs(); restoreSongs();
})();
