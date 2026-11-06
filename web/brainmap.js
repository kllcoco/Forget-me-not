// 脑图：藏在莫比乌斯星环中心的那张大图。拉近星核就会钻进来。
// 每个脑区是一团星，记忆是星，线是数据流和记忆之间的关联。
import * as THREE from 'three';
import { glowTexture, makeStars } from './ring.js';

// 脑区在脑图里的位置（像一张俯视的大脑）
export const HUBS = {
  retrieval:   [0, 15, -2],
  introspect:  [17, 13, -6],
  input:       [27, 6, 2],
  social:      [13, 4, 6],
  visual:      [20, -1, 10],
  expression:  [-18, 7, 0],
  hippocampus: [3, 3, 2],
  limbic:      [-7, -3, 6],
  longterm:    [0, -12, 0],
  life:        [-17, -9, 4],
  working:     [17, -10, 2],
  auditory:    [27, -5, -4],
  metabolism:  [-6, -22, -4],
};
const FLOWS = [
  ['input', 'hippocampus'], ['hippocampus', 'longterm'], ['hippocampus', 'limbic'], ['hippocampus', 'social'],
  ['hippocampus', 'life'], ['hippocampus', 'working'], ['hippocampus', 'expression'], ['hippocampus', 'introspect'],
  ['hippocampus', 'visual'], ['hippocampus', 'auditory'], ['retrieval', 'longterm'], ['retrieval', 'limbic'],
  ['retrieval', 'social'], ['retrieval', 'expression'], ['retrieval', 'introspect'], ['metabolism', 'longterm'],
  ['metabolism', 'working'], ['metabolism', 'life'], ['introspect', 'expression'], ['visual', 'social'],
];

const hashf = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return ((h >>> 0) % 100000) / 100000; };

export function hubPos(key) { const p = HUBS[key] || [0, 0, 0]; return new THREE.Vector3(p[0], p[1], p[2]); }

export function createBrainMap(scene) {
  const group = new THREE.Group(); group.visible = false; scene.add(group);
  const stars = makeStars(4096); group.add(stars);
  // 神经纤维：弧线，两端亮、中间淡；光脉冲沿着线流动
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
  const flows = new THREE.LineSegments(new THREE.BufferGeometry(), fiberMat({ base: 0.24, pulse: 0.9, speed: 0.18, tail: 0.12 }));
  const assoc = new THREE.LineSegments(new THREE.BufferGeometry(), fiberMat({ base: 0.26, pulse: 0.75, speed: 0.12, tail: 0.22 }));
  group.add(spokes, flows, assoc);
  const hubSprites = new THREE.Group(); group.add(hubSprites);

  // 远处一层淡淡的神经雾
  const fogN = 2600, fp = new Float32Array(fogN * 3), fc = new Float32Array(fogN * 3), fs = new Float32Array(fogN), fa = new Float32Array(fogN);
  for (let i = 0; i < fogN; i++) {
    const r = 30 * Math.cbrt(Math.random()), th = Math.random() * 6.283, ph = Math.acos(2 * Math.random() - 1);
    fp.set([r * Math.sin(ph) * Math.cos(th) * 1.3, r * Math.cos(ph) * 0.9 - 2, r * Math.sin(ph) * Math.sin(th) * 0.6], i * 3);
    fc.set([0.55, 0.62, 0.95], i * 3); fs[i] = 0.4 + Math.random() * 0.6; fa[i] = 0.25 + Math.random() * 0.3;
  }
  const fogG = new THREE.BufferGeometry();
  fogG.setAttribute('position', new THREE.BufferAttribute(fp, 3)); fogG.setAttribute('aColor', new THREE.BufferAttribute(fc, 3));
  fogG.setAttribute('aSize', new THREE.BufferAttribute(fs, 1)); fogG.setAttribute('aAlpha', new THREE.BufferAttribute(fa, 1));
  let fog = null;

  /** segs: [起点, 终点, 起点颜色, 终点颜色, 弯曲程度, 亮度]。弯成一条二次贝塞尔弧线，向外、向上鼓起。 */
  function setLines(obj, segs, steps = 18) {
    const n = segs.length * steps
    const pos = new Float32Array(n * 6), col = new Float32Array(n * 6), u = new Float32Array(n * 2), seed = new Float32Array(n * 2), w = new Float32Array(n * 2)
    const P = new THREE.Vector3(), Q = new THREE.Vector3(), C = new THREE.Vector3(), out = new THREE.Vector3(), c = new THREE.Color()
    const bez = (a, ctl, b, t, o) => o.set(0, 0, 0).addScaledVector(a, (1 - t) ** 2).addScaledVector(ctl, 2 * t * (1 - t)).addScaledVector(b, t * t)
    let k = 0
    segs.forEach(([a, b, ca, cb, bend = 0.22, bright = 1], i) => {
      const mid = a.clone().add(b).multiplyScalar(0.5), len = a.distanceTo(b)
      out.copy(mid); out.y = 0; if (out.lengthSq() < 1e-6) out.set(0, 0, 1); out.normalize()
      C.copy(mid).addScaledVector(out, len * bend * 0.6).add(new THREE.Vector3(0, len * bend, 0))
      const sd = Math.random()
      for (let j = 0; j < steps; j++, k++) {
        const t0 = j / steps, t1 = (j + 1) / steps
        bend ? bez(a, C, b, t0, P) : P.lerpVectors(a, b, t0)
        bend ? bez(a, C, b, t1, Q) : Q.lerpVectors(a, b, t1)
        pos.set([P.x, P.y, P.z, Q.x, Q.y, Q.z], k * 6)
        c.copy(ca).lerp(cb, t0); col.set([c.r, c.g, c.b], k * 6); c.copy(ca).lerp(cb, t1); col.set([c.r, c.g, c.b], k * 6 + 3)
        u.set([t0, t1], k * 2); seed.set([sd, sd], k * 2); w.set([bright, bright], k * 2)
      }
    })
    obj.geometry.dispose(); const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3))
    g.setAttribute('aU', new THREE.BufferAttribute(u, 1)); g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1)); g.setAttribute('aW', new THREE.BufferAttribute(w, 1))
    obj.geometry = g
  }

  /** 根据当前记忆重新排布脑图；每段记忆得到 m.bpos。 */
  function layout(regions, memories, links, fxMaterial) {
    if (!fog) { fog = new THREE.Points(fogG, fxMaterial); group.add(fog); }
    const groups = {};
    for (const m of memories) (groups[m.region] ||= []).push(m);
    const spokeSegs = [];
    for (const [rk, list] of Object.entries(groups)) {
      const hub = hubPos(rk), col = new THREE.Color(regions[rk]?.color || '#fff');
      list.sort((a, b) => (a.event_time || a.created_at) - (b.event_time || b.created_at));
      const n = list.length;
      list.forEach((m, i) => {
        let p;
        if (rk === 'longterm') {
          // 长期记忆库：整齐的点阵，像一座档案馆
          const cols = Math.ceil(Math.sqrt(n * 1.6)), r = Math.floor(i / cols), c = i % cols;
          p = new THREE.Vector3((c - cols / 2) * 1.05, -r * 0.18, (r - n / cols / 2) * 1.05).add(hub);
          p.x += (r % 2) * 0.5;
        } else {
          const R = 1.8 + Math.sqrt(n) * 0.55;
          const k = (i + 0.5) / n, phi = Math.acos(1 - 2 * k), th = Math.PI * (1 + Math.sqrt(5)) * i;
          const rr = R * (0.55 + 0.45 * hashf(m.id));
          p = new THREE.Vector3(Math.sin(phi) * Math.cos(th) * rr * 1.25, Math.cos(phi) * rr * 0.75, Math.sin(phi) * Math.sin(th) * rr).add(hub);
        }
        m.bpos = p;
        if (rk !== 'longterm' || i % 3 === 0) spokeSegs.push([hub, p, col, col.clone().multiplyScalar(0.4), 0, 1]);
      });
    }
    setLines(spokes, spokeSegs, 1);
    setLines(flows, FLOWS.map(([a, b]) => [hubPos(a), hubPos(b), new THREE.Color(regions[a]?.color || '#fff'), new THREE.Color(regions[b]?.color || '#fff'), 0.14, 1]), 28);
    const byId = new Map(memories.map(m => [m.id, m]));
    const tint = m => new THREE.Color(regions[m.region]?.color || '#fff').lerp(new THREE.Color(1, 1, 1), 0.35);
    // 只画跨脑区的关联和重要记忆之间的关联，避免一团乱麻
    setLines(assoc, (links || []).map(([a, b, w]) => [byId.get(a), byId.get(b), w])
      .filter(([a, b, w]) => a?.bpos && b?.bpos && (a.region !== b.region || w > 0.55 || a.importance + b.importance > 1.1))
      .map(([a, b, w]) => [a.bpos, b.bpos, tint(a), tint(b), a.region === b.region ? 0.35 : 0.2, Math.min(1, 0.35 + w)]), 20);

    hubSprites.clear();
    for (const [k] of Object.entries(HUBS)) {
      const c = new THREE.Color(regions[k]?.color || '#fff');
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: c, transparent: true, opacity: 0.75, depthWrite: false, blending: THREE.AdditiveBlending }));
      s.position.copy(hubPos(k)); s.scale.setScalar(regions[k]?.kind === 'process' ? 3.2 : 2.4); hubSprites.add(s);
    }

    // 星光缓冲
    const at = stars.geometry.attributes;
    const cnt = Math.min(memories.length, at.position.count);
    memories.slice(0, cnt).forEach((m, i) => {
      m.bidx = i;
      const c = new THREE.Color(regions[m.region]?.color || '#fff');
      at.position.array.set([m.bpos.x, m.bpos.y, m.bpos.z], i * 3);
      at.aColor.array.set([c.r, c.g, c.b], i * 3);
      at.aSize.array[i] = m.status === 'archived' ? 3 : 4.4 + m.importance * 7;
      at.aState.array[i] = m.status === 'archived' ? 1 : 0;
      at.aImg.array[i] = m.has_image ? 1 : 0;
      at.aPhase.array[i] = hashf(m.id + 'b'); at.aAppear.array[i] = 1; at.aS.array[i] = 0;
    });
    stars.geometry.setDrawRange(0, cnt);
    for (const k of ['position', 'aColor', 'aSize', 'aState', 'aImg', 'aPhase', 'aAppear', 'aS']) at[k].needsUpdate = true;
  }

  function update(time, memories, hiOf) {
    const at = stars.geometry.attributes;
    for (const m of memories) if (m.bidx != null) at.aHi.array[m.bidx] = hiOf(m);
    at.aHi.needsUpdate = true;
    stars.material.uniforms.uTime.value = time; stars.material.uniforms.uTint.value = 1;
    for (const o of [spokes, flows, assoc]) o.material.uniforms.uTime.value = time;
    hubSprites.children.forEach((s, i) => { s.material.opacity = 0.6 + 0.25 * Math.sin(time * 1.1 + i); });
  }

  return { group, stars, layout, update };
}
