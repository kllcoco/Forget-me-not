// 脑图（星河内部）：像太阳系一样。
//   中间的「心核 · TA」是太阳；四个过程器官是内行星；九个记忆脑区是外行星，沿着各自倾斜的椭圆轨道公转
//   （越靠外转得越慢，近似开普勒定律）。每段记忆是绕着自己脑区转的卫星；长期记忆库像土星，记忆排成一圈光环。
//   线是「神经纤维」：两端亮、中间淡，光脉冲沿着它流动，跟着行星一起移动。
import * as THREE from 'three';
import { glowTexture, makeCore, makeStars } from './ring.js';

// [半长轴, 轨道倾角, 起始相位, 偏心率, 星球大小]
const ORBITS = {
  input:       [9, 0.30, 0.3, 0.06, 0.8],
  hippocampus: [12.5, -0.18, 2.2, 0.05, 1.0],
  retrieval:   [16, 0.24, 4.1, 0.05, 1.0],
  metabolism:  [19.5, -0.26, 5.3, 0.06, 0.9],
  working:     [25, 0.10, 0.6, 0.08, 1.0],
  limbic:      [30, -0.07, 2.7, 0.06, 1.2],
  expression:  [35, 0.12, 4.5, 0.07, 1.0],
  social:      [40, -0.05, 1.3, 0.05, 1.3],
  life:        [45, 0.08, 3.4, 0.06, 1.3],
  introspect:  [50, -0.10, 5.7, 0.05, 1.0],
  visual:      [55, 0.06, 1.0, 0.06, 1.0],
  auditory:    [60, -0.08, 3.0, 0.05, 1.0],
  longterm:    [67, 0.05, 5.0, 0.04, 1.8],
};
const FLOWS = [
  ['input', 'hippocampus'], ['hippocampus', 'longterm'], ['hippocampus', 'limbic'], ['hippocampus', 'social'],
  ['hippocampus', 'life'], ['hippocampus', 'working'], ['hippocampus', 'expression'], ['hippocampus', 'introspect'],
  ['hippocampus', 'visual'], ['hippocampus', 'auditory'], ['retrieval', 'longterm'], ['retrieval', 'limbic'],
  ['retrieval', 'social'], ['retrieval', 'expression'], ['retrieval', 'introspect'], ['metabolism', 'longterm'],
  ['metabolism', 'working'], ['metabolism', 'life'],
];
const SPEED = 0.55;   // 整体公转速度

const hashf = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return ((h >>> 0) % 100000) / 100000; };
const omega = a => SPEED * 0.3 * Math.pow(a / 9, -1.5);

/** 某个脑区在 t 时刻的位置（倾斜的椭圆轨道，太阳在一个焦点上）。 */
function orbitPos(key, t, out = new THREE.Vector3()) {
  const o = ORBITS[key]; if (!o) return out.set(0, 0, 0);
  const [a, inc, ph, e] = o, b = a * Math.sqrt(1 - e * e);
  const th = ph + t * omega(a);
  const x = a * Math.cos(th) - a * e, z = b * Math.sin(th);
  const node = ph * 0.7;   // 每条轨道的升交点不一样
  const y = z * Math.sin(inc), zz = z * Math.cos(inc);
  return out.set(x * Math.cos(node) - zz * Math.sin(node), y, x * Math.sin(node) + zz * Math.cos(node));
}

export function createBrainMap(scene) {
  const group = new THREE.Group(); group.visible = false; scene.add(group);
  let clock = 0;
  const hubs = Object.fromEntries(Object.keys(ORBITS).map(k => [k, orbitPos(k, 0)]));
  const hub = k => (hubs[k] || new THREE.Vector3()).clone();

  // ---- 太阳：心核 · TA
  const sun = makeCore();
  sun.group.scale.setScalar(2.6);
  group.add(sun.group);

  const orbitLines = new THREE.Group(); group.add(orbitLines);
  const stars = makeStars(4096); group.add(stars);

  // ---- 神经纤维
  const fiberMat = ({ base, pulse, speed, tail = 0.16 }) => new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uBase: { value: base }, uPulse: { value: pulse }, uSpeed: { value: speed }, uTail: { value: tail }, uFade: { value: 1 } },
    vertexShader: `attribute vec3 color; attribute float aU, aSeed, aW; varying vec3 vC; varying float vU, vSeed, vW;
      void main(){ vC = color; vU = aU; vSeed = aSeed; vW = aW; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform float uTime, uBase, uPulse, uSpeed, uTail, uFade; varying vec3 vC; varying float vU, vSeed, vW;
      void main(){
        float ends = 0.18 + 0.82 * pow(abs(vU - 0.5) * 2.0, 2.0);
        float head = fract(uTime * uSpeed * (0.6 + vSeed) + vSeed * 7.0);
        float behind = head - vU;
        float p = behind >= 0.0 ? pow(clamp(1.0 - behind / uTail, 0.0, 1.0), 3.0) : 0.0;
        float a = (ends * uBase + p * uPulse) * vW * uFade;
        gl_FragColor = vec4(vC * a, a);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const spokes = new THREE.LineSegments(new THREE.BufferGeometry(), fiberMat({ base: 0.07, pulse: 0.0, speed: 0 }));
  const flows = new THREE.LineSegments(new THREE.BufferGeometry(), fiberMat({ base: 0.2, pulse: 0.9, speed: 0.18, tail: 0.12 }));
  const assoc = new THREE.LineSegments(new THREE.BufferGeometry(), fiberMat({ base: 0.24, pulse: 0.75, speed: 0.12, tail: 0.22 }));
  for (const o of [spokes, flows, assoc]) o.frustumCulled = false;
  group.add(spokes, flows, assoc);

  const planets = new THREE.Group(); group.add(planets);
  const planetSprites = {};

  /** 一组弧线。segs: [起点函数, 终点函数, 起点颜色, 终点颜色, 弯曲程度, 亮度]——端点是函数，因为行星在动，每帧重算。 */
  function buildFibers(obj, segs, steps) {
    const n = segs.length * steps;
    const col = new Float32Array(n * 6), u = new Float32Array(n * 2), seed = new Float32Array(n * 2), w = new Float32Array(n * 2), c = new THREE.Color();
    segs.forEach(([, , ca, cb, , bright = 1], i) => {
      const sd = Math.random();
      for (let j = 0; j < steps; j++) {
        const k = i * steps + j, t0 = j / steps, t1 = (j + 1) / steps;
        c.copy(ca).lerp(cb, t0); col.set([c.r, c.g, c.b], k * 6); c.copy(ca).lerp(cb, t1); col.set([c.r, c.g, c.b], k * 6 + 3);
        u.set([t0, t1], k * 2); seed.set([sd, sd], k * 2); w.set([bright, bright], k * 2);
      }
    });
    obj.geometry.dispose(); const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 6), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.setAttribute('aU', new THREE.BufferAttribute(u, 1));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1)); g.setAttribute('aW', new THREE.BufferAttribute(w, 1));
    obj.geometry = g; obj.userData = { segs, steps };
  }
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), P = new THREE.Vector3(), Q = new THREE.Vector3(), OUT = new THREE.Vector3(), UPV = new THREE.Vector3(0, 1, 0);
  function updateFibers(obj) {
    const { segs, steps } = obj.userData; if (!segs) return;
    const pos = obj.geometry.attributes.position.array;
    segs.forEach(([fa, fb, , , bend = 0], i) => {
      A.copy(fa()); B.copy(fb());
      if (bend) {
        const len = A.distanceTo(B);
        C.copy(A).add(B).multiplyScalar(0.5); OUT.copy(C); OUT.y = 0; if (OUT.lengthSq() < 1e-6) OUT.set(0, 0, 1); OUT.normalize();
        C.addScaledVector(OUT, len * bend * 0.6).addScaledVector(UPV, len * bend);
      }
      for (let j = 0; j < steps; j++) {
        const t0 = j / steps, t1 = (j + 1) / steps, k = (i * steps + j) * 6;
        if (bend) {
          P.set(0, 0, 0).addScaledVector(A, (1 - t0) ** 2).addScaledVector(C, 2 * t0 * (1 - t0)).addScaledVector(B, t0 * t0);
          Q.set(0, 0, 0).addScaledVector(A, (1 - t1) ** 2).addScaledVector(C, 2 * t1 * (1 - t1)).addScaledVector(B, t1 * t1);
        } else { P.lerpVectors(A, B, t0); Q.lerpVectors(A, B, t1); }
        pos[k] = P.x; pos[k + 1] = P.y; pos[k + 2] = P.z; pos[k + 3] = Q.x; pos[k + 4] = Q.y; pos[k + 5] = Q.z;
      }
    });
    obj.geometry.attributes.position.needsUpdate = true;
  }

  let mems = [];
  const Y = new THREE.Vector3(0, 1, 0), ZERO = new THREE.Vector3();
  function placeAll() {
    for (const k of Object.keys(ORBITS)) orbitPos(k, clock, hubs[k]);
    for (const m of mems) if (m.local) m.bpos.copy(m.local).applyAxisAngle(Y, clock * m.spin).add(hubs[m.region] || ZERO);
  }

  /** 根据当前记忆重新排布：每段记忆得到一个相对自己行星的位置（m.local），每帧算出 m.bpos。 */
  function layout(regions, memories, links) {
    mems = memories;
    const col = k => new THREE.Color(regions[k]?.color || '#fff');
    orbitLines.clear();
    for (const k of Object.keys(ORBITS)) {
      const T = Math.PI * 2 / omega(ORBITS[k][0]), pts = [];
      for (let i = 0; i <= 160; i++) pts.push(orbitPos(k, (i / 160) * T));
      orbitLines.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({
        color: col(k), transparent: true, opacity: regions[k]?.kind === 'process' ? 0.1 : 0.16, depthWrite: false, blending: THREE.AdditiveBlending })));
    }
    planets.clear();
    for (const k of Object.keys(ORBITS)) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: col(k), transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending }));
      s.scale.setScalar(2.4 * ORBITS[k][4]); planets.add(s); planetSprites[k] = s;
    }
    const groups = {};
    for (const m of memories) (groups[m.region] ||= []).push(m);
    for (const [rk, list] of Object.entries(groups)) {
      list.sort((a, b) => (a.event_time || a.created_at) - (b.event_time || b.created_at));
      const n = list.length;
      list.forEach((m, i) => {
        if (rk === 'longterm') {
          // 长期记忆库像土星：记忆排成一圈倾斜的光环
          const a = (i / n) * Math.PI * 2, r = 3.2 + (i % 3) * 0.55 + hashf(m.id) * 0.3;
          m.local = new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r).applyAxisAngle(new THREE.Vector3(1, 0, 0), 0.45);
          m.spin = 0.12;
        } else {
          const R = 1.4 + Math.sqrt(n) * 0.35;
          const k = (i + 0.5) / n, phi = Math.acos(1 - 2 * k), th = Math.PI * (1 + Math.sqrt(5)) * i;
          const rr = R * (0.6 + 0.4 * hashf(m.id));
          m.local = new THREE.Vector3(Math.sin(phi) * Math.cos(th) * rr, Math.cos(phi) * rr * 0.6, Math.sin(phi) * Math.sin(th) * rr);
          m.spin = 0.25 + hashf(m.id + 's') * 0.2;
        }
        m.bpos = m.bpos || new THREE.Vector3();
      });
    }
    placeAll();
    buildFibers(spokes, memories.filter((m, i) => m.local && (m.region !== 'longterm' || i % 2 === 0))
      .map(m => [() => hubs[m.region], () => m.bpos, col(m.region), col(m.region).multiplyScalar(0.4), 0, 1]), 1);
    buildFibers(flows, FLOWS.map(([a, b]) => [() => hubs[a], () => hubs[b], col(a), col(b), 0.14, 1]), 28);
    const byId = new Map(memories.map(m => [m.id, m]));
    const tint = m => col(m.region).lerp(new THREE.Color(1, 1, 1), 0.35);
    buildFibers(assoc, (links || []).map(([a, b, w]) => [byId.get(a), byId.get(b), w])
      .filter(([a, b, w]) => a?.local && b?.local && (a.region !== b.region || w > 0.55 || a.importance + b.importance > 1.1))
      .map(([a, b, w]) => [() => a.bpos, () => b.bpos, tint(a), tint(b), a.region === b.region ? 0.35 : 0.2, Math.min(1, 0.35 + w)]), 20);
    for (const o of [spokes, flows, assoc]) updateFibers(o);

    const at = stars.geometry.attributes;
    const cnt = Math.min(memories.length, at.position.count);
    memories.slice(0, cnt).forEach((m, i) => {
      m.bidx = i;
      const c = col(m.region);
      at.aColor.array.set([c.r, c.g, c.b], i * 3);
      at.aSize.array[i] = m.status === 'archived' ? 3 : 4.4 + m.importance * 7;
      at.aState.array[i] = m.status === 'archived' ? 1 : 0;
      at.aImg.array[i] = m.has_image ? 1 : 0;
      at.aPhase.array[i] = hashf(m.id + 'b'); at.aAppear.array[i] = 1; at.aS.array[i] = 0;
    });
    stars.geometry.setDrawRange(0, cnt);
    for (const k of ['aColor', 'aSize', 'aState', 'aImg', 'aPhase', 'aAppear', 'aS']) at[k].needsUpdate = true;
  }

  /** running=false 时（比如正在看某段记忆的卡片）公转暂停，方便看清。 */
  function update(dt, time, hiOf, running = true) {
    if (running) clock += dt;
    placeAll();
    for (const [k, s] of Object.entries(planetSprites)) { s.position.copy(hubs[k]); s.material.opacity = 0.65 + 0.2 * Math.sin(time * 1.1 + ORBITS[k][2]); }
    const at = stars.geometry.attributes;
    for (const m of mems) if (m.bidx != null && m.bpos) { at.position.array.set([m.bpos.x, m.bpos.y, m.bpos.z], m.bidx * 3); at.aHi.array[m.bidx] = hiOf(m); }
    at.position.needsUpdate = at.aHi.needsUpdate = true;
    for (const o of [spokes, flows, assoc]) { updateFibers(o); o.material.uniforms.uTime.value = time; }
    stars.material.uniforms.uTime.value = time; stars.material.uniforms.uTint.value = 1;
    sun.set(1 + 0.08 * Math.sin(time * 1.2), time, 1);
  }

  return { group, stars, layout, update, hub };
}
