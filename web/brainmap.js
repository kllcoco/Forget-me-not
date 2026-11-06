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
  const lineMat = o => new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: o, depthWrite: false, blending: THREE.AdditiveBlending });
  const spokes = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat(0.06));
  const flows = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat(0.22));
  const assoc = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat(0.1));
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

  function setLines(obj, segs) {
    const pos = new Float32Array(segs.length * 6), col = new Float32Array(segs.length * 6);
    segs.forEach(([a, b, ca, cb], i) => { pos.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6); col.set([ca.r, ca.g, ca.b, cb.r, cb.g, cb.b], i * 6); });
    obj.geometry.dispose(); const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    obj.geometry = g;
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
        if (rk !== 'longterm' || i % 3 === 0) spokeSegs.push([hub, p, col, col]);
      });
    }
    setLines(spokes, spokeSegs);
    setLines(flows, FLOWS.map(([a, b]) => [hubPos(a), hubPos(b), new THREE.Color(regions[a]?.color || '#fff'), new THREE.Color(regions[b]?.color || '#fff')]));
    const byId = new Map(memories.map(m => [m.id, m]));
    const tint = m => new THREE.Color(regions[m.region]?.color || '#fff').lerp(new THREE.Color(1, 1, 1), 0.35);
    // 只画跨脑区的关联和重要记忆之间的关联，避免一团乱麻
    setLines(assoc, (links || []).map(([a, b, w]) => [byId.get(a), byId.get(b), w])
      .filter(([a, b, w]) => a?.bpos && b?.bpos && (a.region !== b.region || w > 0.55 || a.importance + b.importance > 1.1))
      .map(([a, b]) => [a.bpos, b.bpos, tint(a), tint(b)]));

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
    flows.material.opacity = 0.18 + 0.07 * Math.sin(time * 1.3);
    hubSprites.children.forEach((s, i) => { s.material.opacity = 0.6 + 0.25 * Math.sin(time * 1.1 + i); });
  }

  return { group, stars, layout, update };
}
