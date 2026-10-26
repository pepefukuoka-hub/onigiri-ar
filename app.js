(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const get = (k, d) => { try { return localStorage.getItem(k) || d; } catch (e) { return d; } };
  const put = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

  $('size').value = get('onigiri.size', '0.5') || '0.5';
  $('eye').value = get('onigiri.eye', '1.4') || '1.4';
  $('dist').value = get('onigiri.dist2', '2') || '2';
  if (!$('size').value) $('size').value = '0.5';
  if (!$('eye').value) $('eye').value = '1.4';
  if (!$('dist').value) $('dist').value = '2';

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('読み込み失敗: ' + src));
      document.head.appendChild(s);
    });
  }

  // ---------- 部品 ----------
  function registerComponents() {
    // 端末の向きでカメラを回す(three.js の DeviceOrientationControls と同じ計算)。
    // 位置は使わない。カメラは原点に固定し、おともが、いつも決めた距離の中にいる。
    AFRAME.registerComponent('device-look', {
      init: function () {
        this.ori = null; this.count = 0; this.yaw = 0; this.pitch = -0.9;   // パソコンでは、足元を向いた状態から始める
        this.euler = new THREE.Euler(); this.q0 = new THREE.Quaternion();
        this.q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); this.zee = new THREE.Vector3(0, 0, 1);
        window.addEventListener('deviceorientation', (e) => { if (e.alpha == null && e.beta == null) return; this.ori = e; this.count++; });
        let drag = null;   // 向きが取れないとき(パソコン)は、ドラッグで見回す
        window.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; });
        window.addEventListener('pointermove', (e) => {
          if (!drag || this.count > 5) return;
          this.yaw -= (e.clientX - drag.x) * 0.005;
          this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - (e.clientY - drag.y) * 0.005));
          drag = { x: e.clientX, y: e.clientY };
        });
        window.addEventListener('pointerup', () => { drag = null; });
        const fov = () => {   // 画面の縦の視野。縦持ちは、映像の長辺がそのまま縦になる
          const a = window.innerWidth / window.innerHeight;
          const v = a <= 0.75 ? 65 : 2 * Math.atan(Math.tan(34.5 * Math.PI / 180) / Math.max(a, 1.333)) * 180 / Math.PI;
          this.el.setAttribute('camera', 'fov', v);
        };
        fov(); window.addEventListener('resize', fov);
      },
      tick: function () {
        const o = this.el.object3D, d = this.ori, rad = THREE.MathUtils.degToRad;
        if (d) {
          const screenAngle = (screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle : (window.orientation || 0);
          this.euler.set(d.beta ? rad(d.beta) : 0, rad(d.alpha || 0), d.gamma ? -rad(d.gamma) : 0, 'YXZ');
          o.quaternion.setFromEuler(this.euler);
          o.quaternion.multiply(this.q1);
          o.quaternion.multiply(this.q0.setFromAxisAngle(this.zee, -rad(screenAngle)));
        } else {
          this.euler.set(this.pitch, this.yaw, 0, 'YXZ');
          o.quaternion.setFromEuler(this.euler);
        }
      }
    });

    const BLACK = new THREE.MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.45 });
    const WHITE = new THREE.MeshStandardMaterial({ color: 0xf7f6f1, roughness: 0.85 });

    // 体の形: 横に広い、まるいおにぎり。下がやや広く、上はなだらかな丸み。前向きが +z
    const BX = 0.5, BZ = 0.42, BYU = 0.46, BYL = 0.31;
    const widthAt = (yu) => 1.0 - 0.24 * Math.pow((yu + 1) / 2, 1.3);
    function bodyGeometry() {
      const g = new THREE.SphereGeometry(1, 56, 40), p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i), w = widthAt(y);
        p.setXYZ(i, x * w * BX, y < 0 ? y * BYL : y * BYU, z * w * BZ);
      }
      g.computeVertexNormals();
      return g;
    }
    // 体の表面で、(x, y) の場所の前方向の位置
    function surfaceZ(x, y) {
      const yu = y / (y < 0 ? BYL : BYU), w = widthAt(yu);
      const v = 1 - (x / (w * BX)) * (x / (w * BX)) - yu * yu;
      return w * BZ * Math.sqrt(Math.max(0, v));
    }
    function tube(points, r) {
      const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
      return new THREE.Mesh(new THREE.TubeGeometry(curve, 24, r, 8, false), BLACK);
    }

    AFRAME.registerComponent('pet', {
      schema: { size: { default: 0.5 }, dist: { default: 2 } },
      init: function () {
        const CY = 0.48;                                  // 体の中心の高さ(足は 0.17)
        const root = this.el.object3D;
        root.scale.setScalar(this.data.size);
        const body = this.body = new THREE.Group();       // 向き・弾み・ゆれ
        root.add(body);

        const torso = new THREE.Mesh(bodyGeometry(), WHITE);
        torso.position.y = CY; body.add(torso);

        // 目
        const eyeY = CY + 0.09;
        this.eyes = []; this.pupils = [];
        [-0.145, 0.145].forEach((x) => {
          const g = new THREE.Group();
          g.position.set(x, eyeY, surfaceZ(x, eyeY - CY) + 0.012);
          const h = 0.01, zx = (surfaceZ(x + h, eyeY - CY) - surfaceZ(x - h, eyeY - CY)) / (2 * h), zy = (surfaceZ(x, eyeY - CY + h) - surfaceZ(x, eyeY - CY - h)) / (2 * h);
          g.rotation.set(Math.atan(zy), Math.atan(-zx), 0, 'YXZ');   // 体の表面にそわせる
          const ring = new THREE.Mesh(new THREE.TorusGeometry(0.088, 0.011, 10, 40), BLACK);
          const white = new THREE.Mesh(new THREE.CircleGeometry(0.088, 32), new THREE.MeshBasicMaterial({ color: 0xffffff }));
          white.position.z = -0.002;
          const pupil = new THREE.Mesh(new THREE.CircleGeometry(0.024, 20), new THREE.MeshBasicMaterial({ color: 0x111111 }));
          pupil.position.z = 0.003;
          g.add(white, ring, pupil); body.add(g);
          this.eyes.push(g); this.pupils.push(pupil);
        });
        // 口
        const my = CY - 0.075;
        const mouth = tube([[-0.06, 0.012, 0], [-0.03, -0.01, 0], [0, -0.016, 0], [0.03, -0.01, 0], [0.06, 0.012, 0]], 0.0065);
        mouth.position.set(0, my, surfaceZ(0, my - CY) + 0.008); body.add(mouth);

        // 腕(のりのような細い線)。体のわきで、小さく曲げる
        const arm = (s) => {
          const pv = new THREE.Group(); pv.position.set(s * 0.48, CY + 0.0, 0);
          pv.add(tube([[0, 0, 0], [s * 0.06, 0.0, 0], [s * 0.11, 0.04, 0], [s * 0.09, 0.09, 0], [s * 0.03, 0.10, 0]], 0.012));
          const hand = new THREE.Mesh(new THREE.SphereGeometry(0.02, 10, 8), BLACK); hand.position.set(s * 0.03, 0.10, 0); pv.add(hand);
          body.add(pv); return pv;
        };
        this.armL = arm(-1); this.armR = arm(1);

        // 足(細い線)。つけ根で前後にふる
        const leg = (s) => {
          const pv = new THREE.Group(); pv.position.set(s * 0.14, 0.2, 0);
          pv.add(tube([[0, 0, 0], [0, -0.07, 0], [s * 0.012, -0.13, 0.01], [0, -0.17, 0.045]], 0.014));
          const foot = new THREE.Mesh(new THREE.SphereGeometry(0.02, 10, 8), BLACK); foot.position.set(0, -0.17, 0.05); pv.add(foot);
          body.add(pv); return pv;
        };
        this.legL = leg(-1); this.legR = leg(1);

        // 地面のやわらかい影
        const c = document.createElement('canvas'); c.width = c.height = 128;
        const g2 = c.getContext('2d'), gr = g2.createRadialGradient(64, 64, 4, 64, 64, 62);
        gr.addColorStop(0, 'rgba(0,0,0,0.3)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
        g2.fillStyle = gr; g2.fillRect(0, 0, 128, 128);
        const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 1.0), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
        shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.004; root.add(shadow);

        // ふるまいの状態
        this.mode = 'dance'; this.timer = 1; this.danceOn = true; this.dAmp = 0;   // はじめから踊る this.target = { x: 0, z: 0 }; this.run = false;
        this.yaw = 0; this.phase = 0; this.amp = 0; this.hop = -1; this.blink = 3; this.blinkT = -1; this.away = 0; this.started = false;
        this.heading = { x: 0, z: 1 }; this.shown = '';
        this.cp = new THREE.Vector3(); this.f = new THREE.Vector3(); this.u = new THREE.Vector3(); this.pp = new THREE.Vector3();
        this.rc = new THREE.Raycaster();

        // タップで、ぴょん
        const el = this.el;
        let down = null;
        window.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
        window.addEventListener('pointerup', (e) => {
          if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 12) { down = null; return; }
          down = null;
          if (e.target.closest && e.target.closest('button')) return;
          const cam = el.sceneEl.camera; if (!cam) return;
          this.rc.setFromCamera({ x: e.clientX / window.innerWidth * 2 - 1, y: -(e.clientY / window.innerHeight) * 2 + 1 }, cam);
          if (this.rc.intersectObject(body, true).length && this.hop < 0) this.hop = 0;
        });
      },

      // 見ている方向(水平)。真下を向いているときは、画面の上側が前
      updateHeading: function (cam) {
        cam.getWorldDirection(this.f);
        let hx = this.f.x, hz = this.f.z;
        if (Math.hypot(hx, hz) < 0.4) {
          this.u.set(0, 1, 0).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
          hx = this.f.y < 0 ? this.u.x : -this.u.x; hz = this.f.y < 0 ? this.u.z : -this.u.z;
        }
        const l = Math.hypot(hx, hz);
        if (l > 0.05) { this.heading.x = hx / l; this.heading.z = hz / l; }
      },
      pickTarget: function (run) {
        const a = Math.atan2(this.heading.x, this.heading.z) + (Math.random() - 0.5) * 0.9, r = (0.6 + Math.random() * 0.35) * this.data.dist;
        this.target.x = this.cp.x + Math.sin(a) * r; this.target.z = this.cp.z + Math.cos(a) * r;
        this.mode = 'walk'; this.run = !!run;
      },

      tick: function (time, dtms) {
        const cam = this.el.sceneEl.camera; if (!cam) return;
        const dt = Math.min(dtms, 100) / 1000, pos = this.el.object3D.position;
        cam.getWorldPosition(this.cp);
        this.updateHeading(cam);
        const cp = this.cp, wrap = (a) => ((a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;

        if (!this.started) {
          this.started = true;
          pos.set(cp.x + this.heading.x * 0.8 * this.data.dist, 0, cp.z + this.heading.z * 0.8 * this.data.dist);
          this.yaw = Math.atan2(-this.heading.x, -this.heading.z);
        }

        // 見ている方向から外れたら、追いかけて前に回りこむ。決めた距離より離れたら、走って戻る
        const dC = Math.hypot(pos.x - cp.x, pos.z - cp.z);
        const off = Math.abs(wrap(Math.atan2(pos.x - cp.x, pos.z - cp.z) - Math.atan2(this.heading.x, this.heading.z)));
        this.away = off > 0.9 ? this.away + dt : 0;
        if ((dC > this.data.dist || this.away > 1.5) && !this.run) { this.pickTarget(true); this.away = 0; }

        if (this.mode === 'idle') {
          this.timer -= dt;
          if (this.danceOn) this.mode = 'dance';
          else if (this.timer <= 0) { if (Math.random() < 0.3) this.timer = 1.5 + Math.random() * 2; else this.pickTarget(false); }
          this.yaw += wrap(Math.atan2(cp.x - pos.x, cp.z - pos.z) - this.yaw) * Math.min(1, dt * 4);   // こちらを向く
        } else if (this.mode === 'dance') {
          this.timer -= dt;
          if (!this.danceOn) { this.mode = 'idle'; this.timer = 1; }
          this.yaw += wrap(Math.atan2(cp.x - pos.x, cp.z - pos.z) - this.yaw) * Math.min(1, dt * 4);
        } else {
          const dx = this.target.x - pos.x, dz = this.target.z - pos.z, d = Math.hypot(dx, dz), sp = this.run ? 1.3 : 0.45;
          if (d < 0.04) { this.mode = 'idle'; this.run = false; this.timer = 1.5 + Math.random() * 2.5; }
          else {
            const st = Math.min(d, sp * dt);
            pos.x += dx / d * st; pos.z += dz / d * st;
            this.yaw += wrap(Math.atan2(dx, dz) - this.yaw) * Math.min(1, dt * 8);
          }
        }
        // 決めた距離の外には、出さない
        const ex = pos.x - cp.x, ez = pos.z - cp.z, el = Math.hypot(ex, ez), R = this.data.dist;
        if (el > R) { pos.x = cp.x + ex / el * R; pos.z = cp.z + ez / el * R; }

        // ---- 動き ----
        const moving = this.mode === 'walk';
        this.amp += ((moving ? 1 : 0) - this.amp) * Math.min(1, dt * 8);
        if (moving) this.phase += dt * (this.run ? 16 : 9);
        const sw = Math.sin(this.phase) * this.amp, t = time / 1000;
        this.legL.rotation.x = sw * 0.75; this.legR.rotation.x = -sw * 0.75;
        let by = Math.abs(Math.sin(this.phase)) * 0.035 * (this.run ? 1.6 : 1) * this.amp + Math.sin(t * 3) * 0.006 * (1 - this.amp);
        let up = 0;
        if (this.hop >= 0) {
          this.hop += dt;
          const u = this.hop / 0.6;
          if (u >= 1) this.hop = -1; else { by += 0.3 * Math.sin(Math.PI * u); up = Math.sin(Math.PI * u); }
        }
        // ダンス: 体を左右にゆらして、リズムに合わせて弾む。腕はかわるがわる上げる
        this.dAmp += ((this.mode === 'dance' ? 1 : 0) - this.dAmp) * Math.min(1, dt * 6);
        const da = this.dAmp, w = t * Math.PI * 2 * 1.1, ds = Math.sin(w);
        by += da * Math.abs(ds) * 0.05;
        this.legL.rotation.x += da * ds * 0.35; this.legR.rotation.x -= da * ds * 0.35;
        this.body.position.y = by;
        this.body.rotation.y = this.yaw + da * 0.3 * Math.sin(w * 0.5);
        this.body.rotation.z = sw * 0.07 + da * 0.16 * ds;
        this.body.scale.set(1 + 0.04 * da * Math.cos(w * 2), 1 - 0.04 * da * Math.cos(w * 2), 1);
        this.armL.rotation.z = -up * 1.0 + Math.sin(t * 2.2) * 0.05 + sw * 0.15 - da * (0.6 + 0.5 * ds);
        this.armR.rotation.z = up * 1.0 - Math.sin(t * 2.2 + 1) * 0.05 + sw * 0.15 + da * (0.6 - 0.5 * ds);

        // まばたきと、視線(カメラの方を見る)
        this.blink -= dt;
        if (this.blink <= 0) { this.blinkT = 0; this.blink = 2.5 + Math.random() * 3; }
        let sy = 1;
        if (this.blinkT >= 0) { this.blinkT += dt; sy = Math.max(0.1, Math.abs(this.blinkT - 0.07) / 0.07); if (this.blinkT > 0.14) { this.blinkT = -1; sy = 1; } }
        this.eyes.forEach((e) => { e.scale.y = Math.min(1, sy); });
        const lx0 = cp.x - pos.x, lz0 = cp.z - pos.z, c = Math.cos(this.yaw), s = Math.sin(this.yaw);
        const lx = lx0 * c - lz0 * s, lz = lx0 * s + lz0 * c, ly = cp.y / this.data.size - 0.6, len = Math.hypot(lx, ly, lz) || 1;
        this.pupils.forEach((p) => { p.position.x = Math.max(-1, Math.min(1, lx / len)) * 0.04 + da * ds * 0.025; p.position.y = Math.max(-1, Math.min(1, ly / len)) * 0.03; });

        // 画面の外にいるときは、方向を知らせる
        this.pp.set(pos.x, 0.3 * this.data.size, pos.z).project(cam);
        const q = this.pq || (this.pq = new THREE.Vector3());
        q.set(pos.x, 0.85 * this.data.size, pos.z).project(cam);
        const inV = (p) => p.z < 1 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1;
        setSeen(inV(this.pp) || inV(q));                      // 視界に入っているか(音の大きさに使う)
        const find = $('find'); let msg = '';
        if (this.pp.z > 1) msg = wrap(Math.atan2(pos.x - cp.x, pos.z - cp.z) - Math.atan2(this.heading.x, this.heading.z)) > 0 ? '→ 右にいるよ' : '← 左にいるよ';
        else if (this.pp.x > 1) msg = '→ 右にいるよ';
        else if (this.pp.x < -1) msg = '← 左にいるよ';
        else if (this.pp.y < -1) msg = '↓ 足元を見て';
        else if (this.pp.y > 1) msg = '↑ 上にいるよ';
        if (msg !== this.shown) { this.shown = msg; find.textContent = msg; }
      }
    });
  }

  // ---------- 音 ----------
  // 自分で選んだビデオや音声の音を、ループで流す。おともが視界にいる間は大きく、外れると小さくする。
  // 音のファイルは、この端末の中(IndexedDB)にだけ保存し、公開サイトには入れない。
  const LOW = 0.12;
  let actx = null, bgmGain = null, bgmData = null, bgmType = '', seen = false, dancing = true;
  function applyVolume() {
    if (!bgmGain) return;
    bgmGain.gain.setTargetAtTime(!dancing ? 0 : (seen ? 1 : LOW), actx.currentTime, 0.15);
  }
  function setSeen(v) { if (v === seen) return; seen = v; applyVolume(); }
  function setDancing(v) { dancing = v; applyVolume(); if (v && actx && actx.state === 'suspended') actx.resume().catch(() => {}); }

  function idb() {
    return new Promise((res, rej) => { const r = indexedDB.open('onigiri', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  }
  async function idbDo(mode, fn) {
    const db = await idb();
    return new Promise((res, rej) => { const q = fn(db.transaction('kv', mode).objectStore('kv')); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  }
  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
  async function restoreBgm() {
    try {
      const v = await idbDo('readonly', (s) => s.get('bgm'));
      if (v && v.data) { bgmData = v.data; bgmType = v.type || ''; $('bgmMsg').textContent = '保存した音があります(' + mb(bgmData.byteLength) + ')。はじめると、流れます。'; }
    } catch (e) {}
  }
  $('bgm').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      bgmData = await f.arrayBuffer(); bgmType = f.type || '';
      try { await idbDo('readwrite', (s) => s.put({ data: bgmData, type: bgmType }, 'bgm')); $('bgmMsg').textContent = '音を読み込みました(' + mb(bgmData.byteLength) + ')。この端末の中にだけ保存されます。'; }
      catch (err) { $('bgmMsg').textContent = '音を読み込みました(保存はできませんでした。今回だけ使えます)。'; }
    } catch (err) { $('bgmMsg').textContent = '読み込めませんでした。別のファイルを選んでください。'; }
  };
  $('bgmClear').onclick = async () => {
    bgmData = null;
    try { await idbDo('readwrite', (s) => s.delete('bgm')); } catch (e) {}
    $('bgmMsg').textContent = '保存した音を消しました。';
  };
  // 頭の無音や、立ち上がりの小さい部分は、ループの頭に含めない
  function trimStart(buf) {
    const d = buf.getChannelData(0), w = Math.round(buf.sampleRate * 0.1), r = [];
    for (let i = 0; i + w <= d.length; i += w) { let s = 0; for (let j = i; j < i + w; j++) s += d[j] * d[j]; r.push(Math.sqrt(s / w)); }
    const med = r.slice().sort((x, y) => x - y)[r.length >> 1] || 0;
    let k = 0; while (k < r.length - 1 && r[k] < med * 0.6) k++;
    return Math.min(k * 0.1, 3, Math.max(0, buf.duration - 1));
  }
  async function startBgm() {
    if (!bgmData || !actx) return;
    try { await actx.resume(); } catch (e) {}
    bgmGain = actx.createGain(); bgmGain.gain.value = LOW; bgmGain.connect(actx.destination);
    try {   // 音声だけを取り出して、つなぎ目なくループする
      const buf = await new Promise((res, rej) => { const p = actx.decodeAudioData(bgmData.slice(0), res, rej); if (p && p.catch) p.catch(rej); });
      const src = actx.createBufferSource(); src.buffer = buf; src.loop = true;
      src.loopStart = trimStart(buf); src.loopEnd = buf.duration;
      src.connect(bgmGain); src.start(0, src.loopStart);
    } catch (e) {   // 取り出せない形式のときは、再生用の要素から流す
      const v = document.createElement('video'); v.loop = true; v.playsInline = true; v.style.display = 'none';
      v.src = URL.createObjectURL(new Blob([bgmData], { type: bgmType })); document.body.appendChild(v);
      try { actx.createMediaElementSource(v).connect(bgmGain); await v.play(); } catch (e2) {}
    }
    applyVolume();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && actx && dancing) actx.resume().catch(() => {}); });

  // ---------- 開始 ----------
  let started = false, stream = null;
  function fail(msg) { $('msg').textContent = msg; $('go').disabled = false; }

  async function start() {
    if (started) return;
    $('go').disabled = true;
    $('msg').textContent = '許可を確認しています…';
    // 音は、ボタンを押したこの場面で使えるようにしておく(iPhoneの決まり)
    try {
      actx = new (window.AudioContext || window.webkitAudioContext)(); actx.resume();
      if (navigator.audioSession) navigator.audioSession.type = 'playback';   // 消音スイッチがオンでも鳴らす(対応する端末のみ)
    } catch (e) { actx = null; }
    put('onigiri.size', $('size').value); put('onigiri.eye', $('eye').value); put('onigiri.dist2', $('dist').value);

    // 1. モーション(iPhoneは、ボタンを押したこの場面で許可を求める必要がある)
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const r = await DeviceOrientationEvent.requestPermission();
        if (r !== 'granted') { fail('モーションと方向のアクセスが許可されていません。設定 > Safari > モーションと方向のアクセス をオンにして、ページを開き直してください。'); return; }
      }
    } catch (e) { fail('モーションの許可を取得できませんでした。ページを開き直して、もう一度押してください。'); return; }

    // 2. カメラ
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    } catch (e) { fail('カメラが許可されていません。設定 > Safari > カメラ で許可して、ページを開き直してください。'); return; }

    $('msg').textContent = '準備しています…';
    try { await loadScript('vendor/aframe.min.js'); registerComponents(); }
    catch (e) { fail('部品を読み込めませんでした。通信を確認して、ページを開き直してください。'); return; }

    started = true;
    const v = $('cam');
    v.srcObject = stream;
    document.body.classList.add('ar');
    v.play().catch(() => {});

    const size = parseFloat($('size').value), eye = parseFloat($('eye').value), dist = parseFloat($('dist').value);
    const scene = document.createElement('a-scene');
    scene.setAttribute('vr-mode-ui', 'enabled: false');
    scene.setAttribute('renderer', 'alpha: true; antialias: true');
    scene.setAttribute('embedded', '');
    scene.innerHTML =
      '<a-entity camera="fov: 65; near: 0.05; far: 50" position="0 ' + eye + ' 0" device-look></a-entity>' +
      '<a-entity light="type: ambient; color: #ffffff; intensity: 0.8"></a-entity>' +
      '<a-entity light="type: directional; color: #ffffff; intensity: 0.5" position="1 3 2"></a-entity>' +
      '<a-entity id="pet" pet="size: ' + size + '; dist: ' + dist + '"></a-entity>';
    scene.addEventListener('loaded', () => { if (scene.renderer) scene.renderer.setClearColor(0x000000, 0); });
    $('host').appendChild(scene);
    $('hud').hidden = false;
    startBgm();
  }
  $('go').onclick = start;
  $('dance').onclick = () => {
    const p = document.getElementById('pet'), c = p && p.components.pet;
    if (!c) return;
    c.danceOn = !c.danceOn;
    if (!c.danceOn && c.mode === 'dance') { c.mode = 'idle'; c.timer = 1; }
    setDancing(c.danceOn);   // やめると、音も止まる
    $('dance').textContent = c.danceOn ? 'ダンスをやめる' : 'ダンス';
  };
  $('exit').onclick = () => { location.reload(); };   // カメラを確実に止めるため、ページを開き直す

  restoreBgm();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
