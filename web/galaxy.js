// 星河内部的群星风暴：钻进莫比乌斯星环之后，脑图背后是一整片旋转的银河。
//  - 发光的金色核心 + 四条对数螺旋旋臂（蓝白色年轻恒星、粉色星云团、暗色尘埃带）
//  - 较差自转：越靠近核心转得越快，所以旋臂像风暴一样被卷起来
//  - 再加一条横跨天空的银河带
import * as THREE from 'three';
import { glowTexture } from './ring.js';

const TAU = Math.PI * 2;
const gauss = () => { let u = 0; while (!u) u = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * Math.random()); };

export function createGalaxy(scene) {
  const group = new THREE.Group(); group.visible = false; scene.add(group);

  // ---------------------------------------------------------------- 旋涡星系
  const N = innerWidth < 760 ? 40000 : 80000, R = 230, ARMS = 4;
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N), ph = new Float32Array(N), kind = new Float32Array(N);
  const core = new THREE.Color('#ffd9a0'), mid = new THREE.Color('#fff4e6'), arm = new THREE.Color('#9fc4ff'), pink = new THREE.Color('#ff7fb8'), dust = new THREE.Color('#7a5a8a');
  const c = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const roll = Math.random();
    let r, a, y, k = 0;
    if (roll < 0.22) { // 核球
      r = Math.abs(gauss()) * R * 0.09; a = Math.random() * TAU; y = gauss() * R * 0.035 * (1 - r / (R * 0.3));
      c.copy(core).lerp(mid, Math.random() * 0.5); size[i] = 0.7 + Math.random() * 1.2;
    } else { // 旋臂：对数螺旋 θ = ln(r)/b
      r = R * (0.08 + Math.pow(Math.random(), 0.75) * 0.92);
      const armIdx = Math.floor(Math.random() * ARMS);
      const spread = 0.2 * (0.3 + r / R);
      a = Math.log(r / (R * 0.08)) / 0.32 + armIdx * TAU / ARMS + gauss() * spread;
      y = gauss() * R * 0.012 * (1 + r / R);
      const t = r / R;
      c.copy(mid).lerp(arm, Math.min(1, t * 1.4));
      size[i] = 0.5 + Math.random() ** 3 * 2.2;
      if (Math.random() < 0.035) { c.copy(pink); size[i] = 1.6 + Math.random() * 2.4; k = 1; }        // 星云团
      else if (Math.random() < 0.12) { c.copy(dust); size[i] = 2.4 + Math.random() * 3; k = 2; }       // 尘埃
    }
    pos.set([r * Math.cos(a), y, r * Math.sin(a)], i * 3);
    col.set([c.r, c.g, c.b], i * 3); ph[i] = Math.random(); kind[i] = k;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1)); g.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1)); g.setAttribute('aKind', new THREE.BufferAttribute(kind, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R * 1.5);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPixel: { value: 1 }, uFade: { value: 0 }, uR: { value: R } },
    vertexShader: /* glsl */`
      attribute vec3 aColor; attribute float aSize, aPhase, aKind;
      uniform float uTime, uPixel, uFade, uR;
      varying vec3 vC; varying float vA;
      void main(){
        vec3 p = position;
        float r = length(p.xz);
        // 整体缓缓旋转 + 内圈像风暴一样来回卷动（不会把旋臂永远卷死）
        float inner = 1.0 - smoothstep(0.0, uR * 0.7, r);
        float a = atan(p.z, p.x) + uTime * 0.018 + sin(uTime * 0.12 + r * 0.045 + aPhase * 0.6) * 0.22 * inner;
        p.xz = vec2(cos(a), sin(a)) * r;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float tw = 0.7 + 0.3 * sin(uTime * (0.8 + aPhase * 2.0) + aPhase * 60.0);
        vC = aColor;
        vA = uFade * (aKind > 1.5 ? 0.22 : (aKind > 0.5 ? 0.9 : tw)) * (0.55 + 0.45 * smoothstep(uR, 0.0, r));
        gl_PointSize = clamp(aSize * uPixel * (140.0 / -mv.z), 0.0, 40.0);
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vC; varying float vA;
      void main(){ float d = length(gl_PointCoord - 0.5) * 2.0; float a = (exp(-d*d*8.0) + exp(-d*d*2.0) * 0.18) * vA; if (a < 0.003) discard; gl_FragColor = vec4(vC * a, a); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const disk = new THREE.Points(g, mat);
  const galaxy = new THREE.Group(); galaxy.add(disk);

  // 核心的光
  const tex = glowTexture();
  const glows = [[120, '#ffb36b', 0.2], [55, '#ffd9a0', 0.32], [20, '#fff4e6', 0.5], [260, '#5a6cff', 0.07]].map(([s, color, o]) => {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color, transparent: true, opacity: o, depthWrite: false, blending: THREE.AdditiveBlending }));
    sp.scale.set(s, s * 0.8, 1); sp.userData.o = o; galaxy.add(sp); return sp;
  });
  // 倾斜着放在脑图后面，像从银河的边上看进去
  galaxy.position.set(150, -60, -640); galaxy.rotation.set(1.05, 0.2, -0.45); galaxy.scale.setScalar(2);
  group.add(galaxy);

  // ---------------------------------------------------------------- 横跨天空的银河带
  const M = 16000, bp = new Float32Array(M * 3), bc = new Float32Array(M * 3), bs = new Float32Array(M), bph = new Float32Array(M), bk = new Float32Array(M);
  for (let i = 0; i < M; i++) {
    const lon = Math.random() * TAU, lat = gauss() * 0.09 * (1 + 0.6 * Math.cos(lon * 2)), rr = 520 + Math.random() * 80;
    bp.set([rr * Math.cos(lat) * Math.cos(lon), rr * Math.sin(lat), rr * Math.cos(lat) * Math.sin(lon)], i * 3);
    c.copy(mid).lerp(Math.random() < 0.5 ? arm : core, Math.random() * 0.6); bc.set([c.r, c.g, c.b], i * 3);
    bs[i] = 0.6 + Math.random() ** 4 * 3; bph[i] = Math.random(); bk[i] = Math.random() < 0.08 ? 2 : 0;
  }
  const bg = new THREE.BufferGeometry();
  bg.setAttribute('position', new THREE.BufferAttribute(bp, 3)); bg.setAttribute('aColor', new THREE.BufferAttribute(bc, 3));
  bg.setAttribute('aSize', new THREE.BufferAttribute(bs, 1)); bg.setAttribute('aPhase', new THREE.BufferAttribute(bph, 1)); bg.setAttribute('aKind', new THREE.BufferAttribute(bk, 1));
  const bandMat = mat.clone(); bandMat.uniforms = THREE.UniformsUtils.clone(mat.uniforms); bandMat.uniforms.uR.value = 1e6;
  const band = new THREE.Points(bg, bandMat); band.rotation.set(0.9, 0.3, 0.5); band.frustumCulled = false;
  group.add(band);

  return {
    group, materials: [mat, bandMat],
    update(time, fade) {
      for (const m of [mat, bandMat]) { m.uniforms.uTime.value = time; m.uniforms.uFade.value = fade; }
      glows.forEach(s => { s.material.opacity = s.userData.o * fade * (0.9 + 0.1 * Math.sin(time * 0.7)); });
      band.rotation.y = 0.3 + time * 0.002;
      group.visible = fade > 0.001;
    },
  };
}
