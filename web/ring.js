// 星环的几何与着色器：∞ 形（双纽线）的莫比乌斯带，记忆是带上的星光。
import * as THREE from 'three';

export const A = 13;      // 星环大小
export const H = 1.6;     // 上下起伏
export const W = 1.15;    // 带宽
export const TAU = Math.PI * 2;
export const MAX_REGIONS = 12;

export function lemn(t, out = new THREE.Vector3()) {
  const s = Math.sin(t), c = Math.cos(t), d = 1 + s * s;
  return out.set(A * c / d, H * Math.sin(2 * t), A * s * c / d);
}

const _p = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _T = new THREE.Vector3(), _N = new THREE.Vector3(), _B = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export function frame(t) {
  lemn(t + 1e-3, _a); lemn(t - 1e-3, _b);
  _T.subVectors(_a, _b).normalize();
  _N.crossVectors(_T, UP).normalize();
  _B.crossVectors(_N, _T);
  return { T: _T.clone(), N: _N.clone(), B: _B.clone() };
}

// 带上的点：ox 沿带宽方向，oy 沿厚度方向；带子绕一圈扭转半周（莫比乌斯）。
export function ringPos(t, ox, oy, out = new THREE.Vector3()) {
  lemn(t, _p);
  lemn(t + 1e-3, _a); lemn(t - 1e-3, _b);
  _T.subVectors(_a, _b).normalize();
  _N.crossVectors(_T, UP).normalize();
  _B.crossVectors(_N, _T);
  const th = t * 0.5, c = Math.cos(th), s = Math.sin(th);
  return out.copy(_p)
    .addScaledVector(_N, c * ox - s * oy)
    .addScaledVector(_B, s * ox + c * oy);
}

const RING_GLSL = /* glsl */`
  #define TAU 6.28318530718
  uniform float uA; uniform float uH;
  vec3 lemn(float t){ float s=sin(t), c=cos(t), d=1.0+s*s; return vec3(uA*c/d, uH*sin(2.0*t), uA*s*c/d); }
  vec3 ringPos(float t, vec2 o){
    vec3 p = lemn(t);
    vec3 T = normalize(lemn(t+0.001) - lemn(t-0.001));
    vec3 N = normalize(cross(T, vec3(0.0,1.0,0.0)));
    vec3 B = cross(N, T);
    float th = t*0.5; float c = cos(th), s = sin(th);
    return p + N*(c*o.x - s*o.y) + B*(s*o.x + c*o.y);
  }
`;

let _glow;
export function glowTexture() {
  if (_glow) return _glow;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'); const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.18, 'rgba(255,255,255,.55)');
  gr.addColorStop(0.45, 'rgba(255,255,255,.12)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  _glow = new THREE.CanvasTexture(c); _glow.colorSpace = THREE.SRGBColorSpace;
  return _glow;
}

function gauss(R = Math.random) { let u = 0, v = 0; while (u === 0) u = R(); v = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v); }

// ------------------------------------------------------------------ 星尘
export function makeDust(count = 26000) {
  const g = new THREE.BufferGeometry();
  const aT = new Float32Array(count), aOff = new Float32Array(count * 2), aSize = new Float32Array(count),
    aPhase = new Float32Array(count), aSpeed = new Float32Array(count), aScatter = new Float32Array(count * 3), aHalo = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const halo = Math.random() < 0.16;
    aT[i] = Math.random() * TAU;
    aOff[i * 2] = gauss() * W * (halo ? 1.5 : 0.42);
    aOff[i * 2 + 1] = gauss() * (halo ? 1.1 : 0.12);
    aSize[i] = halo ? 0.4 + Math.random() * 0.9 : 0.55 + Math.random() ** 3 * 2.6;
    aPhase[i] = Math.random();
    aSpeed[i] = (0.006 + Math.random() * 0.012) * (Math.random() < 0.5 ? 1 : 1.15);
    const r = 40 + Math.random() * 80, th = Math.random() * TAU, ph = Math.acos(2 * Math.random() - 1);
    aScatter.set([r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph) * 0.4, r * Math.sin(ph) * Math.sin(th)], i * 3);
    aHalo[i] = halo ? 1 : 0;
  }
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  g.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
  g.setAttribute('aOff', new THREE.BufferAttribute(aOff, 2));
  g.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
  g.setAttribute('aPhase', new THREE.BufferAttribute(aPhase, 1));
  g.setAttribute('aSpeed', new THREE.BufferAttribute(aSpeed, 1));
  g.setAttribute('aScatter', new THREE.BufferAttribute(aScatter, 3));
  g.setAttribute('aHalo', new THREE.BufferAttribute(aHalo, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 200);

  const m = new THREE.ShaderMaterial({
    uniforms: {
      uA: { value: A }, uH: { value: H }, uTime: { value: 0 }, uPixel: { value: 1 }, uReveal: { value: 1 },
      uTint: { value: 0 }, uWarp: { value: 0 }, uBright: { value: 1 },
      uRT: { value: Array.from({ length: MAX_REGIONS }, () => new THREE.Vector2(99, 99)) },
      uRC: { value: Array.from({ length: MAX_REGIONS }, () => new THREE.Color()) },
    },
    vertexShader: /* glsl */`
      ${RING_GLSL}
      attribute float aT; attribute vec2 aOff; attribute float aSize; attribute float aPhase; attribute float aSpeed; attribute vec3 aScatter; attribute float aHalo;
      uniform float uTime, uPixel, uReveal, uTint, uWarp, uBright;
      uniform vec2 uRT[${MAX_REGIONS}]; uniform vec3 uRC[${MAX_REGIONS}];
      varying vec3 vColor; varying float vAlpha;
      void main(){
        float t = aT + uTime * aSpeed;
        float s = mod(aT - 1.5707963 + TAU, TAU) / TAU;               // 揭幕顺序：从星核出发绕一圈
        float appear = clamp((uReveal * 1.08 - s) * 9.0, 0.0, 1.0);
        float head = (1.0 - smoothstep(0.0, 0.06, abs(uReveal * 1.08 - s))) * step(uReveal, 0.999);
        vec3 p = ringPos(t, aOff);
        p = mix(aScatter, p, appear * appear * (3.0 - 2.0 * appear));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float tt = mod(t + 1.5707963, TAU) - 1.5707963;
        vec3 ice = mix(vec3(0.78, 0.86, 1.0), vec3(1.0, 0.93, 0.86), step(0.93, aPhase));
        vec3 col = ice;
        for (int i = 0; i < ${MAX_REGIONS}; i++) {
          float w = smoothstep(uRT[i].x, uRT[i].x + 0.08, tt) * (1.0 - smoothstep(uRT[i].y - 0.08, uRT[i].y, tt));
          col = mix(col, uRC[i], w * uTint * 0.75);
        }
        float tw = 0.65 + 0.35 * sin(uTime * (1.2 + aPhase * 2.4) + aPhase * 40.0);
        vColor = col * (1.0 + head * 3.0);
        vAlpha = tw * (aHalo > 0.5 ? 0.45 : 1.0) * mix(0.15, 1.0, appear) * uBright;
        gl_PointSize = clamp(aSize * (1.0 + head * 2.5 + uWarp * 1.5) * uPixel * (52.0 / -mv.z), 0.0, 48.0);
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vColor; varying float vAlpha;
      void main(){
        vec2 uv = gl_PointCoord - 0.5; float d = length(uv) * 2.0;
        float a = (exp(-d * d * 9.0) + exp(-d * d * 2.5) * 0.25) * vAlpha * (1.0 - smoothstep(0.6, 1.0, d));
        if (a < 0.004) discard;
        gl_FragColor = vec4(vColor * a, a);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  return new THREE.Points(g, m);
}

// ------------------------------------------------------------------ 记忆星光
export function makeStars(capacity = 4096) {
  const g = new THREE.BufferGeometry();
  const attr = (n, k) => new THREE.BufferAttribute(new Float32Array(capacity * k), k).setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('position', attr('position', 3));
  g.setAttribute('aColor', attr('aColor', 3));
  g.setAttribute('aSize', attr('aSize', 1));
  g.setAttribute('aState', attr('aState', 1));
  g.setAttribute('aImg', attr('aImg', 1));
  g.setAttribute('aHi', attr('aHi', 1));
  g.setAttribute('aPhase', attr('aPhase', 1));
  g.setAttribute('aAppear', attr('aAppear', 1));
  g.setAttribute('aS', attr('aS', 1));
  g.setDrawRange(0, 0);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 200);
  const m = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPixel: { value: 1 }, uTint: { value: 0 }, uReveal: { value: 1 }, uDim: { value: 0 } },
    vertexShader: /* glsl */`
      attribute vec3 aColor; attribute float aSize, aState, aImg, aHi, aPhase, aAppear, aS;
      uniform float uTime, uPixel, uTint, uReveal, uDim;
      varying vec3 vColor; varying float vAlpha, vImg, vHi;
      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float reveal = clamp((uReveal * 1.08 - aS) * 6.0, 0.0, 1.0);
        float tw = 0.78 + 0.22 * sin(uTime * (1.4 + aPhase) + aPhase * 50.0);
        vec3 c = mix(vec3(0.86, 0.91, 1.0), aColor, 0.25 + uTint * 0.7);
        if (aState > 0.5) c = mix(c, vec3(0.42, 0.47, 0.6), 0.72);
        vColor = c * (1.0 + aHi * 0.55);   // 高亮时别太亮：太亮的点会被泛光后期糊成一个方块
        vImg = aImg; vHi = aHi;
        float dim = mix(1.0, 0.35, uDim * (1.0 - aHi));
        vAlpha = (aState > 0.5 ? 0.42 : 1.0) * tw * aAppear * reveal * dim;
        gl_PointSize = clamp(aSize * (1.0 + aHi * 1.9) * aAppear * uPixel * (60.0 / -mv.z), 0.0, 150.0);
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vColor; varying float vAlpha, vImg, vHi;
      void main(){
        vec2 uv = gl_PointCoord - 0.5; float d = length(uv) * 2.0;
        float core = exp(-d * d * 22.0) * 1.05;
        float halo = exp(-d * d * 4.0) * 0.32;
        float ring = vImg * (1.0 - smoothstep(0.0, 0.06, abs(d - 0.62))) * 0.5;
        float cross = vHi * (exp(-abs(uv.x) * 60.0) * exp(-abs(uv.y) * 4.0) + exp(-abs(uv.y) * 60.0) * exp(-abs(uv.x) * 4.0)) * 0.9;
        // 光晕在方形边缘之前完全淡出，否则放大时会看到一个方框
        float a = (core + halo + ring) * vAlpha * (1.0 - smoothstep(0.6, 1.0, d)) + cross * vAlpha * (1.0 - smoothstep(0.8, 1.0, max(abs(uv.x), abs(uv.y)) * 2.0));
        if (a < 0.004) discard;
        gl_FragColor = vec4(vColor * a, a);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(g, m); pts.frustumCulled = false;
  return pts;
}

// ------------------------------------------------------------------ 特效粒子池（彗星、光束、灰烬）
export function makeFx(capacity = 6000) {
  const g = new THREE.BufferGeometry();
  const mk = k => new THREE.BufferAttribute(new Float32Array(capacity * k), k).setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('position', mk(3)); g.setAttribute('aColor', mk(3)); g.setAttribute('aSize', mk(1)); g.setAttribute('aAlpha', mk(1));
  g.setDrawRange(0, 0);
  const m = new THREE.ShaderMaterial({
    uniforms: { uPixel: { value: 1 } },
    vertexShader: /* glsl */`
      attribute vec3 aColor; attribute float aSize, aAlpha; uniform float uPixel; varying vec3 vColor; varying float vAlpha;
      void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mv;
        vColor = aColor; vAlpha = aAlpha; gl_PointSize = clamp(aSize * uPixel * (60.0 / -mv.z), 0.0, 80.0); }`,
    fragmentShader: /* glsl */`
      varying vec3 vColor; varying float vAlpha;
      void main(){ vec2 uv = gl_PointCoord - 0.5; float d = length(uv)*2.0; float a = (exp(-d*d*10.0) + exp(-d*d*2.5)*0.3) * vAlpha * (1.0 - smoothstep(0.6, 1.0, d));
        if (a < 0.004) discard; gl_FragColor = vec4(vColor * a, a); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(g, m); pts.frustumCulled = false;
  const list = [];
  const pos = g.attributes.position.array, col = g.attributes.aColor.array, size = g.attributes.aSize.array, alpha = g.attributes.aAlpha.array;
  return {
    points: pts,
    spawn(p) { if (list.length < capacity) list.push(Object.assign({ v: new THREE.Vector3(), life: 0, max: 1, size: 1, drag: 0.98, a: 1, fade: 1 }, p)); },
    update(dt) {
      let n = 0;
      for (let i = list.length - 1; i >= 0; i--) {
        const q = list[i]; q.life += dt;
        if (q.life >= q.max) { list.splice(i, 1); continue; }
        if (q.upd) q.upd(q, dt); else { q.p.addScaledVector(q.v, dt); q.v.multiplyScalar(q.drag); }
      }
      for (const q of list) {
        const k = q.life / q.max;
        pos[n * 3] = q.p.x; pos[n * 3 + 1] = q.p.y; pos[n * 3 + 2] = q.p.z;
        col[n * 3] = q.c.r; col[n * 3 + 1] = q.c.g; col[n * 3 + 2] = q.c.b;
        size[n] = q.size * (q.grow ? 1 + k * q.grow : 1);
        alpha[n] = q.a * (q.fade ? Math.min(1, (1 - k) * 2.5) * Math.min(1, q.life * 8) : 1);
        n++;
      }
      g.setDrawRange(0, n);
      for (const k of ['position', 'aColor', 'aSize', 'aAlpha']) g.attributes[k].needsUpdate = true;
    },
  };
}

// ------------------------------------------------------------------ 星核
export function makeCore() {
  const group = new THREE.Group();
  const geo = new THREE.IcosahedronGeometry(0.62, 5);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPulse: { value: 1 } },
    vertexShader: /* glsl */`
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main(){ vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position,1.0); vV = normalize(-mv.xyz); vP = position; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uPulse; varying vec3 vN; varying vec3 vV; varying vec3 vP;
      float hash(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719))) * 43758.5453); }
      float noise(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
                   mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z); }
      void main(){
        float fres = pow(1.0 - max(dot(vN, vV), 0.0), 2.2);
        vec3 q = vP * 3.2 + vec3(uTime*0.15, uTime*0.11, -uTime*0.13);
        float n = noise(q) * 0.6 + noise(q*2.3) * 0.3 + noise(q*5.1) * 0.1;
        vec3 deep = vec3(0.25, 0.42, 1.0), pale = vec3(0.92, 0.96, 1.0);
        vec3 col = mix(deep, pale, smoothstep(0.35, 0.75, n)) * (0.9 + 0.6 * uPulse);
        col += vec3(0.5, 0.7, 1.0) * fres * 2.2;
        gl_FragColor = vec4(col * uPulse, 1.0);
      }`,
  });
  const sphere = new THREE.Mesh(geo, mat); group.add(sphere);
  const tex = glowTexture();
  const sprite = (scale, color, opacity) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending }));
    s.scale.set(scale[0], scale[1], 1); s.userData.base = { scale: [...scale], opacity }; group.add(s); return s;
  };
  const sprites = [
    sprite([16, 16], 0x2a4cff, 0.16),
    sprite([6.5, 6.5], 0x6f97ff, 0.38),
    sprite([2.8, 2.8], 0xcfe0ff, 0.75),
    sprite([1.2, 1.2], 0xffffff, 0.95),
    sprite([18, 0.22], 0xaecbff, 0.42),   // 横向镜头光斑
    sprite([0.16, 6], 0xaecbff, 0.16),
  ];
  return {
    group, mat,
    set(intensity, time, near = 1) {
      mat.uniforms.uTime.value = time; mat.uniforms.uPulse.value = intensity;
      sphere.scale.setScalar(0.6 + 0.4 * Math.min(intensity, 1.4));
      for (const s of sprites) {
        const b = s.userData.base; const k = intensity * (1 + 0.04 * Math.sin(time * 1.3));
        s.scale.set(b.scale[0] * (0.4 + 0.6 * k), b.scale[1] * (0.6 + 0.4 * k), 1);
        s.material.opacity = b.opacity * Math.min(1, intensity) * near;
      }
    },
  };
}

// ------------------------------------------------------------------ 远方星空与星云
export function makeSky() {
  const group = new THREE.Group();
  const n = 5200, pos = new Float32Array(n * 3), size = new Float32Array(n), ph = new Float32Array(n), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = 300 + Math.random() * 300, th = Math.random() * TAU, p = Math.acos(2 * Math.random() - 1);
    pos.set([r * Math.sin(p) * Math.cos(th), r * Math.cos(p), r * Math.sin(p) * Math.sin(th)], i * 3);
    size[i] = Math.random() ** 4 * 2.6 + 0.5; ph[i] = Math.random();
    const warm = Math.random(); const c = warm < 0.12 ? [1, 0.86, 0.72] : warm < 0.3 ? [0.7, 0.8, 1] : [0.9, 0.93, 1];
    col.set(c, i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  g.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1)); g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  const m = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPixel: { value: 1 }, uFade: { value: 1 } },
    vertexShader: /* glsl */`attribute float aSize, aPhase; attribute vec3 aColor; uniform float uTime, uPixel, uFade; varying float vA; varying vec3 vC;
      void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mv; vC = aColor;
        vA = (0.45 + 0.55 * sin(uTime * (0.4 + aPhase) + aPhase * 30.0)) * uFade; gl_PointSize = aSize * uPixel; }`,
    fragmentShader: /* glsl */`varying float vA; varying vec3 vC; void main(){ float d = length(gl_PointCoord - 0.5) * 2.0; float a = exp(-d*d*6.0) * vA * 0.7 * (1.0 - smoothstep(0.6, 1.0, d)); gl_FragColor = vec4(vC * a, a); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const stars = new THREE.Points(g, m); group.add(stars);

  // 星云：程序化生成的柔光云团
  const neb = document.createElement('canvas'); neb.width = neb.height = 512; const ctx = neb.getContext('2d');
  for (let i = 0; i < 70; i++) {
    const x = 256 + (Math.random() - 0.5) * 300, y = 256 + (Math.random() - 0.5) * 300, r = 40 + Math.random() * 140;
    const gr = ctx.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(255,255,255,.10)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gr; ctx.fillRect(0, 0, 512, 512);
  }
  const mask = ctx.createRadialGradient(256, 256, 100, 256, 256, 256); mask.addColorStop(0, 'rgba(0,0,0,0)'); mask.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = mask; ctx.fillRect(0, 0, 512, 512);
  const tex = new THREE.CanvasTexture(neb); tex.colorSpace = THREE.SRGBColorSpace;
  const clouds = [[0x1b2f8a, -160, 40, -260, 420, 0.55], [0x3a1d7a, 220, -60, -240, 380, 0.45], [0x0d4f6e, 40, 120, 300, 460, 0.35], [0x24124d, -260, -90, 160, 360, 0.4]];
  for (const [c, x, y, z, s, o] of clouds) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: c, transparent: true, opacity: o, depthWrite: false, blending: THREE.AdditiveBlending }));
    sp.position.set(x, y, z); sp.scale.set(s, s, 1); group.add(sp);
  }
  return { group, mat: m };
}
