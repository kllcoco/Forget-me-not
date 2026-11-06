// 脑图（星河内部）：像太阳系一样。
//   中间的「心核 · TA」是太阳，也是 TA 的人设卡；四个过程器官是内行星；九个记忆脑区是外行星，沿着同一平面上的同心圆轨道公转
//   （越靠外转得越慢，近似开普勒定律；轨道间距经过计算，保证任何时候都不会互相遮挡）。每段记忆是绕着自己脑区转的卫星；长期记忆库像土星，记忆排成一圈光环。
//   线是「神经纤维」：两端亮、中间淡，光脉冲沿着它流动，跟着行星一起移动。
import * as THREE from 'three';
import { makeCore, makeStars } from './ring.js';

// 公转顺序（由内到外）和起始相位
const ORDER = ['input', 'hippocampus', 'retrieval', 'metabolism', 'working', 'limbic', 'expression', 'social', 'life', 'introspect', 'visual', 'auditory', 'longterm'];
const PHASE = Object.fromEntries(ORDER.map((k, i) => [k, (i * 2.399963) % (Math.PI * 2)]));   // 黄金角错开
const PROCESS = new Set(['input', 'hippocampus', 'retrieval', 'metabolism']);
const FLOWS = [
  ['input', 'hippocampus'], ['hippocampus', 'longterm'], ['hippocampus', 'limbic'], ['hippocampus', 'social'],
  ['hippocampus', 'life'], ['hippocampus', 'working'], ['hippocampus', 'expression'], ['hippocampus', 'introspect'],
  ['hippocampus', 'visual'], ['hippocampus', 'auditory'], ['retrieval', 'longterm'], ['retrieval', 'limbic'],
  ['retrieval', 'social'], ['retrieval', 'expression'], ['retrieval', 'introspect'], ['metabolism', 'longterm'],
  ['metabolism', 'working'], ['metabolism', 'life'],
];
const SPEED = 0.55;    // 整体公转速度

// ---- 不遮挡的几何保证 ----
// 所有轨道在同一平面上、是同心圆。从仰角 ≥ MIN_ELEV 的方向看下去，两条半径差 Δr 的圆投影成两个同心椭圆，
// 它们在屏幕上最近的地方（短轴方向）也相距 Δr·sin(仰角)。所以只要
//     Δr · sin(MIN_ELEV) ≥ 内侧模块半径 + 外侧模块半径 + 留白，
// 无论两颗行星各自转到哪里，它们在屏幕上都不会重叠；太阳和第一颗行星之间同理。镜头的仰角被限制在 MIN_ELEV 以上。
export const MIN_ELEV = 35 * Math.PI / 180;
const SUN_R = 5.2, GAP = 1.4;
const SIN = Math.sin(MIN_ELEV);

// 行星用的柔光：没有刺眼的亮芯，只有一团慢慢散开的光晕
let _soft;
function softGlow() {
  if (_soft) return _soft;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  for (let i = 0; i <= 10; i++) { const t = i / 10; gr.addColorStop(t, `rgba(255,255,255,${(Math.exp(-t * t * 5) * (1 - t)).toFixed(3)})`); }
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  _soft = new THREE.CanvasTexture(c); _soft.colorSpace = THREE.SRGBColorSpace;
  return _soft;
}

const hashf = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return ((h >>> 0) % 100000) / 100000; };

export function createBrainMap(scene) {
  const group = new THREE.Group(); group.visible = false; scene.add(group);
  let clock = 0;
  const radius = {}, extentOf = {};
  const omega = r => SPEED * 0.3 * Math.pow(r / 15, -1.5);   // 越靠外转得越慢（开普勒）
  const orbitPos = (k, t, out = new THREE.Vector3()) => {
    const r = radius[k]; if (r == null) return out.set(0, 0, 0);
    const th = PHASE[k] + t * omega(r);
    return out.set(r * Math.cos(th), 0, r * Math.sin(th));
  };
  const hubs = Object.fromEntries(ORDER.map(k => [k, new THREE.Vector3()]));
  const hub = k => (hubs[k] || new THREE.Vector3()).clone();
  let outer = 60;

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

  let mems = [], orbitByKey = {}, lit = null;
  const Y = new THREE.Vector3(0, 1, 0), ZERO = new THREE.Vector3();
  function placeAll() {
    for (const k of ORDER) orbitPos(k, clock, hubs[k]);
    for (const m of mems) if (m.local) m.bpos.copy(m.local).applyAxisAngle(Y, clock * m.spin).add(hubs[m.region] || ZERO);
  }

  /** 根据当前记忆重新排布：每段记忆得到一个相对自己行星的位置（m.local），每帧算出 m.bpos。 */
  function layout(regions, memories, links) {
    mems = memories;
    const col = k => new THREE.Color(regions[k]?.color || '#fff');
    // 每个模块的「半径」：卫星群有多大
    const counts = {};
    for (const m of memories) counts[m.region] = (counts[m.region] || 0) + 1;
    for (const k of ORDER) extentOf[k] = PROCESS.has(k) ? 1.3 : k === 'longterm' ? 4.2 : 1.3 + Math.sqrt(counts[k] || 0) * 0.24;
    // 由内到外排轨道：相邻两条的间距刚好保证不遮挡
    let r = (SUN_R + extentOf[ORDER[0]] + GAP) / SIN;
    ORDER.forEach((k, i) => {
      if (i) r += (extentOf[ORDER[i - 1]] + extentOf[k] + GAP) / SIN;
      radius[k] = r;
    });
    outer = r + extentOf.longterm;
    orbitLines.clear(); orbitByKey = {};
    for (const k of ORDER) {
      const pts = [];
      for (let i = 0; i <= 200; i++) { const a = (i / 200) * Math.PI * 2; pts.push(new THREE.Vector3(radius[k] * Math.cos(a), 0, radius[k] * Math.sin(a))); }
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({
        color: col(k), transparent: true, opacity: PROCESS.has(k) ? 0.022 : 0.035, depthWrite: false, blending: THREE.AdditiveBlending }));
      line.userData.base = line.material.opacity; orbitByKey[k] = line; orbitLines.add(line);
    }
    planets.clear();
    for (const k of ORDER) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: softGlow(), color: col(k), transparent: true, opacity: 0.32, depthWrite: false, blending: THREE.AdditiveBlending }));
      s.scale.setScalar(k === 'longterm' ? 7 : PROCESS.has(k) ? 3.4 : 4.6); planets.add(s); planetSprites[k] = s;
    }
    const groups = {};
    for (const m of memories) (groups[m.region] ||= []).push(m);
    for (const [rk, list] of Object.entries(groups)) {
      list.sort((a, b) => (a.event_time || a.created_at) - (b.event_time || b.created_at));
      const n = list.length;
      list.forEach((m, i) => {
        if (rk === 'longterm') {
          // 长期记忆库像土星：记忆排成一圈倾斜的光环
          const a = (i / n) * Math.PI * 2, r = 2.8 + (i % 3) * 0.45 + hashf(m.id) * 0.25;
          m.local = new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r).applyAxisAngle(new THREE.Vector3(1, 0, 0), 0.45);
          m.spin = 0.12;
        } else {
          const R = extentOf[rk] - 0.25;
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
      at.aSize.array[i] = (m.status === 'archived' ? 3 : 4.4 + m.importance * 7) * 1.6;
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
    for (const [k, s] of Object.entries(planetSprites)) {
      s.position.copy(hubs[k]);
      const on = k === lit ? 1 : 0;
      s.material.opacity = 0.26 + 0.06 * Math.sin(time * 0.8 + PHASE[k]) + 0.14 * on;   // 慢慢呼吸的柔光
    }
    for (const [k, l] of Object.entries(orbitByKey)) l.material.opacity += ((k === lit ? 0.2 : l.userData.base) - l.material.opacity) * 0.08;
    const at = stars.geometry.attributes;
    for (const m of mems) if (m.bidx != null && m.bpos) { at.position.array.set([m.bpos.x, m.bpos.y, m.bpos.z], m.bidx * 3); at.aHi.array[m.bidx] = hiOf(m); }
    at.position.needsUpdate = at.aHi.needsUpdate = true;
    for (const o of [spokes, flows, assoc]) { updateFibers(o); o.material.uniforms.uTime.value = time; }
    stars.material.uniforms.uTime.value = time; stars.material.uniforms.uTint.value = 1;
    sun.set(1 + 0.08 * Math.sin(time * 1.2), time, 1);
  }

  return {
    group, stars, layout, update, hub, extent: () => outer, sun,
    keys: () => ORDER.filter(k => radius[k] != null),
    sizeOf: k => extentOf[k] || 1,
    highlight: k => { lit = k; },
  };
}
