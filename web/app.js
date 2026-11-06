// 勿忘我 · 记忆星环
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { A, TAU, MAX_REGIONS, frame, makeCore, makeDust, makeFx, makeSky, makeStars, ringPos } from './ring.js';
import { paint, paintSealed } from './painter.js';
import { createBrainMap, MIN_ELEV } from './brainmap.js';
import { createMusic } from './music.js';
import { createGalaxy } from './galaxy.js';

const $ = s => document.querySelector(s);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, k) => a + (b - a) * k;
const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const hash = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return ((h >>> 0) % 100000) / 100000; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EMBED = new URLSearchParams(location.search).has('embed');

// ------------------------------------------------------------------ API
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  let body = opts.body;
  if (body && typeof body !== 'string') { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  const r = await fetch(path, { ...opts, headers, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status });
  return j;
}

// ------------------------------------------------------------------ three.js 场景
const stage = $('#stage');
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x010208);
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.05, 2000);
const NARROW = innerWidth / innerHeight < 1;
const HOME = NARROW
  ? { pos: new THREE.Vector3(-3, 50, 56), target: new THREE.Vector3(0, -1, 0) }
  : { pos: new THREE.Vector3(-8, 19, 24), target: new THREE.Vector3(-3, -1.2, 0) };
camera.position.set(0, 1.2, 5.5);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.dampingFactor = 0.06;
controls.minDistance = 1.6; controls.maxDistance = 110;
controls.zoomToCursor = true; controls.zoomSpeed = 0.9; controls.rotateSpeed = 0.55;
controls.autoRotateSpeed = 0.35; controls.enabled = false;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
// 限亮：泛光的模糊只能往外扩散有限的距离，太亮的点会被它「切」成方块。
// 所以在泛光之前，把超过上限的亮度柔和地压下来（软膝），光晕就永远是圆的。
const limiter = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uMax: { value: 1.5 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uMax; varying vec2 vUv;
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      float l = max(max(c.r, c.g), c.b), knee = uMax * 0.5;
      if (l > knee) { float over = l - knee; c.rgb *= (knee + over / (1.0 + over / knee)) / l; }
      gl_FragColor = c;
    }`,
});
composer.addPass(limiter);
// 泛光分 5 层，越往后分辨率越低（最后一层只有 1/32）。小亮点在低分辨率层里只占一个像素，
// 放大回来就成了方块——所以只用前几层清晰的，最后一层关掉；星星本身已经有圆形光晕了。
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.9, 0.0, 0.2);
bloom.compositeMaterial.uniforms.bloomFactors.value = [0.45, 0.32, 0.2, 0.08, 0.0];
composer.addPass(bloom);
composer.addPass(new OutputPass());

const sky = makeSky(); scene.add(sky.group);
const dust = makeDust(innerWidth < 760 ? 15000 : 26000); scene.add(dust);
const stars = makeStars(); scene.add(stars);
const fx = makeFx(); scene.add(fx.points);
const core = makeCore(); scene.add(core.group);
const brain = createBrainMap(scene);
const galaxy = createGalaxy(scene);
let galaxyFade = 0;
const ringObjs = [dust, stars, core.group];

const pixelUniforms = () => {
  const px = renderer.getPixelRatio() * (innerHeight / 900);
  for (const m of [dust.material, stars.material, fx.points.material, sky.mat, brain.stars.material, ...galaxy.materials]) m.uniforms.uPixel.value = m === sky.mat ? renderer.getPixelRatio() : px;
};
pixelUniforms();
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight); pixelUniforms();
});

// ------------------------------------------------------------------ 数据与布局
const S = {
  regions: [], regionBy: {}, memories: [], byId: new Map(), stats: {}, sealed: true, key: { initialized: false, unlocked: false },
  links: [], adj: new Map(), persona: null, view: 'ring',
  lastEvent: 0, arcs: {}, organs: {}, mode: 'intro', hover: null, idleAt: 0, interacting: false,
};

const ORGAN_POS = {
  retrieval: new THREE.Vector3(0, 3.9, 0),
  metabolism: new THREE.Vector3(0, -3.6, 0.3),
  input: new THREE.Vector3(0.4, 1.5, 4.2),
  hippocampus: new THREE.Vector3(-0.4, 1.3, -4.2),
};

function memoryRegions() { return S.regions.filter(r => r.kind === 'memory'); }

// 把每个记忆脑区分配到 ∞ 的一段弧上：右半圈、左半圈各放一部分。
function layoutArcs() {
  const regs = memoryRegions();
  const w = regs.map(r => 1.2 + Math.sqrt(r.count || 0));
  const total = w.reduce((a, b) => a + b, 0);
  let acc = 0, split = 0, best = 1e9;
  for (let i = 0; i < regs.length; i++) { acc += w[i]; const d = Math.abs(acc - total / 2); if (d < best) { best = d; split = i + 1; } }
  const gap = 0.42, pad = 0.035;
  const lobes = [[-Math.PI / 2 + gap, Math.PI / 2 - gap, regs.slice(0, split), w.slice(0, split)],
                 [Math.PI / 2 + gap, 3 * Math.PI / 2 - gap, regs.slice(split), w.slice(split)]];
  S.arcs = {};
  for (const [a, b, rs, ws] of lobes) {
    const sum = ws.reduce((x, y) => x + y, 0) || 1; let t = a;
    rs.forEach((r, i) => { const len = (b - a) * ws[i] / sum; S.arcs[r.key] = { t0: t + pad, t1: t + len - pad, color: new THREE.Color(r.color) }; t += len; });
  }
  const keys = Object.keys(S.arcs);
  for (let i = 0; i < MAX_REGIONS; i++) {
    const arc = S.arcs[keys[i]];
    dust.material.uniforms.uRT.value[i].set(arc ? arc.t0 : 99, arc ? arc.t1 : 99);
    if (arc) dust.material.uniforms.uRC.value[i].copy(arc.color);
  }
}

function sortKey(m) { return m.event_time || m.created_at; }

function layoutMemories() {
  const groups = {};
  for (const m of S.memories) (groups[m.region] ||= []).push(m);
  for (const [rk, list] of Object.entries(groups)) {
    const arc = S.arcs[rk]; if (!arc) continue;
    list.sort((a, b) => sortKey(a) - sortKey(b));
    list.forEach((m, i) => {
      const k = list.length === 1 ? 0.5 : i / (list.length - 1);
      const h1 = hash(m.id), h2 = hash(m.id + 'y');
      m.t = lerp(arc.t0 + 0.04, arc.t1 - 0.04, k) + (h1 - 0.5) * 0.02;
      m.ox = (h1 - 0.5) * 1.5; m.oy = (h2 - 0.5) * 0.35;
      m.target = ringPos(m.t, m.ox, m.oy, m.target || new THREE.Vector3());
      if (!m.pos) m.pos = m.target.clone();
      m.color = arc.color;
      m.s = ((m.t - Math.PI / 2 + TAU * 4) % TAU) / TAU;
      m.order = i;
    });
  }
}

function writeStarBuffers() {
  const g = stars.geometry, at = g.attributes;
  const n = Math.min(S.memories.length, at.position.count);
  for (let i = 0; i < n; i++) {
    const m = S.memories[i]; m.idx = i;
    at.aColor.array.set([m.color.r, m.color.g, m.color.b], i * 3);
    at.aSize.array[i] = (m.status === 'archived' ? 3.2 : 4.2 + m.importance * 9) * (m.has_image ? 1.12 : 1);
    at.aState.array[i] = m.status === 'archived' ? 1 : 0;
    at.aImg.array[i] = m.has_image ? 1 : 0;
    at.aPhase.array[i] = hash(m.id + 'p');
    at.aS.array[i] = m.s;
    if (m.appear == null) m.appear = 1;
  }
  g.setDrawRange(0, n);
  for (const k of ['aColor', 'aSize', 'aState', 'aImg', 'aPhase', 'aS']) at[k].needsUpdate = true;
}

async function loadBrain(first = false) {
  const data = await api('api/brain');
  const prev = S.byId;
  S.regions = data.regions; S.regionBy = Object.fromEntries(data.regions.map(r => [r.key, r]));
  S.stats = data.stats; S.sealed = data.sealed; S.key = data.key || S.key; S.types = data.types;
  S.links = data.links || []; S.persona = data.persona; S.portrait = data.portrait;
  if (first) S.lastEvent = data.last_event;
  S.memories = data.memories.map(m => {
    const old = prev.get(m.id);
    const nm = Object.assign(old || {}, m);
    if (!old && !first) nm.appear = 0;    // 新出生的星
    return nm;
  });
  S.byId = new Map(S.memories.map(m => [m.id, m]));
  S.adj = new Map(); for (const [a, b, w] of S.links) { (S.adj.get(a) || S.adj.set(a, []).get(a)).push([b, w]); (S.adj.get(b) || S.adj.set(b, []).get(b)).push([a, w]); }
  layoutArcs(); layoutMemories(); writeStarBuffers();
  brain.layout(S.regionBy, S.memories, S.links, fx.points.material);
  renderLegend(); renderStats(); buildLabels(); renderKey(); renderPersona(); loadCharacters(); renderHint();
  if (reel.on) refreshReelList();
}

// ------------------------------------------------------------------ 标签
const labelsEl = $('#labels');
let labelEls = [];
function buildLabels() {
  labelsEl.innerHTML = ''; labelEls = [];
  for (const r of S.regions) {
    const el = document.createElement('div');
    el.className = 'rlabel' + (r.kind === 'process' ? ' organ' : '');
    el.style.setProperty('--c', r.color);
    const [zh, sub] = r.name.split('·');
    el.innerHTML = `<span class="zh">${esc(zh)}${sub ? ' · ' + esc(sub) : ''}</span><span class="en">${esc(r.en)}</span>`;
    let anchor;
    if (r.kind === 'memory') {
      const arc = S.arcs[r.key]; if (!arc) continue;
      const tm = (arc.t0 + arc.t1) / 2;
      anchor = ringPos(tm, 0, 0); const out = new THREE.Vector3(anchor.x, 0, anchor.z).normalize();
      anchor.addScaledVector(out, 2.1).add(new THREE.Vector3(0, 1.5, 0));
      el.onclick = () => openRegion(r.key);
    } else if (ORGAN_POS[r.key]) {
      anchor = ORGAN_POS[r.key].clone().add(new THREE.Vector3(0, 0.75, 0));
    }
    if (anchor) { labelsEl.appendChild(el); labelEls.push({ el, anchor, region: r, view: 'ring' }); }   // 小卫星只在脑图里出现
    // 脑图里的大字标签
    const bel = el.cloneNode(true); bel.classList.remove('organ'); bel.classList.add('big');
    bel.onclick = () => openRegion(r.key);
    labelsEl.appendChild(bel);
    const lift = new THREE.Vector3(0, r.key === 'longterm' ? 4.2 : r.kind === 'satellite' ? 1.2 : r.kind === 'process' ? 1.4 : 2.2, 0);
    if (r.kind === 'satellite') bel.onclick = openPortrait;
    labelEls.push({ el: bel, anchor: () => brain.hub(r.key).add(lift), region: r, view: 'brain' });
  }
  // 太阳：心核 · TA
  const sun = document.createElement('div'); sun.className = 'rlabel big sun'; sun.style.setProperty('--c', '#cfe0ff');
  sun.innerHTML = `<span class="zh">心核 · ${esc(personaName())}</span><span class="en">${S.persona ? 'PERSONA CARD' : 'THE SELF'}</span>`;
  sun.onclick = focusSun;
  labelsEl.appendChild(sun);
  labelEls.push({ el: sun, anchor: new THREE.Vector3(0, 6.5, 0), region: { key: 'sun', kind: 'memory' }, view: 'brain' });
}

const _v = new THREE.Vector3();
function project(p, out = {}) {
  _v.copy(p).project(camera);
  out.x = (_v.x * 0.5 + 0.5) * innerWidth; out.y = (-_v.y * 0.5 + 0.5) * innerHeight; out.z = _v.z; out.vis = _v.z < 1 && _v.z > -1;
  return out;
}

// 3D 标签飘到左边图例、底部按钮、右边卡片下面时自动变淡，不和界面文字叠在一起
const UI_COVER = ['#legend', '#toolbar', '#persona', '#planetpanel', '#musicpanel', '#brand', '#zoom', '#search'];
let coverRects = [], coverAt = 0;
function underUI(x, y) {
  const now = performance.now();
  if (now - coverAt > 400) {
    coverAt = now;
    coverRects = UI_COVER.map(s => document.querySelector(s)).filter(e => e && +getComputedStyle(e).opacity > 0.1).map(e => e.getBoundingClientRect()).filter(r => r.width > 0);
  }
  return coverRects.some(r => x > r.left - 24 && x < r.right + 24 && y > r.top - 16 && y < r.bottom + 16);
}
// 脑图里标签的优先级：心核 > 我眼中的你 > 记忆行星 > 过程器官；后画的撞上先画的就压暗，避免中心一团字叠在一起
const LBL_PRIO = L => L.region.key === 'sun' ? 0 : L.region.kind === 'satellite' ? 1 : L.region.kind === 'process' ? 3 : 2;
let labelOrder = null, labelOrderSrc = null;
function updateLabels(dist) {
  const base = smooth(80, 34, dist) * 0.9 + 0.1;
  const tmp = {}, placed = [];
  if (labelOrderSrc !== labelEls) { labelOrderSrc = labelEls; labelOrder = labelEls.slice().sort((a, b) => LBL_PRIO(a) - LBL_PRIO(b)); }
  for (const L of labelOrder) {
    if (L.view !== S.view) { L.el.style.opacity = '0'; L.el.style.pointerEvents = 'none'; continue; }
    const anc = typeof L.anchor === 'function' ? L.anchor() : L.anchor;
    project(anc, tmp);
    const d = camera.position.distanceTo(anc);
    let o = L.view === 'brain' ? smooth(2, 8, d) * smooth(brain.extent() * 4, brain.extent() * 2.4, d) * (L.region.kind === 'process' ? 0.75 : 1)
      : L.region.kind === 'process' ? smooth(30, 12, dist) * 0.85 : base * smooth(1.5, 5, d);
    if (reel.on) o *= L.region.key === reel.region ? 1 : 0.12;
    if (!tmp.vis) o = 0;
    const sc = clamp((L.view === 'brain' ? 110 : 26) / d, 0.55, 1.5);
    // 脑图里标签整个放在行星上方（底边对齐），并且让鼠标穿过去，这样不会挡住行星
    const brainLbl = L.view === 'brain';   // 脑图里所有标签（包括太阳的）都让鼠标穿过，点击交给画面去判断
    const w = (L.w ||= L.el.offsetWidth) * sc, h = (L.h ||= L.el.offsetHeight) * sc;
    const cy = brainLbl ? tmp.y - h / 2 : tmp.y;   // 用标签框的中心判断，而不是锚点（脑图标签在锚点上方）
    if (o > 0.01 && underUI(tmp.x, cy)) o *= 0.06;
    if (brainLbl && o > 0.3) {
      const r = { l: tmp.x - w / 2, r: tmp.x + w / 2, t: tmp.y - h, b: tmp.y };
      if (placed.some(q => r.l < q.r && r.r > q.l && r.t < q.b && r.b > q.t)) o *= 0.15; else placed.push(r);
    }
    L.el.style.opacity = o.toFixed(3);
    L.el.style.transform = `translate(${tmp.x}px, ${tmp.y}px) translate(-50%, ${brainLbl ? '-100%' : '-50%'}) scale(${sc.toFixed(3)})`;
    L.el.style.transformOrigin = brainLbl ? '50% 100%' : '50% 50%';
    L.el.style.pointerEvents = o > 0.3 && !brainLbl ? 'auto' : 'none';
  }
}

// ------------------------------------------------------------------ 图例 / 统计
function placeLegend() {
  const b = $('#brand').getBoundingClientRect();
  document.documentElement.style.setProperty('--lockh', $('#lockbar').offsetHeight + 'px');
  const l = $('#legend'); l.style.top = Math.round(b.bottom + 14) + 'px';
  requestAnimationFrame(() => l.classList.toggle('scroll', l.scrollHeight > l.clientHeight + 4));
}
addEventListener('resize', placeLegend);
$('#legend').addEventListener('scroll', e => e.target.classList.toggle('at-end', e.target.scrollTop + e.target.clientHeight >= e.target.scrollHeight - 4));
function renderLegend() {
  const el = $('#legend'); requestAnimationFrame(placeLegend);
  const mem = S.regions.filter(r => r.kind === 'memory'), proc = S.regions.filter(r => r.kind === 'process');
  el.innerHTML = `<div class="head">${esc(personaName())} 的回忆</div>` +
    `<button class="moon" data-moon="1" style="--c:#e6eeff"><span class="dot"></span><span>我眼中的你</span><span class="n">☾</span></button>` +
    mem.map(r => `<button data-k="${r.key}" style="--c:${r.color}" class="${reel.on && reel.region === r.key ? 'on' : ''}"><span class="dot"></span><span>${esc(r.name)}</span><span class="n">${r.count}</span></button>`).join('') +
    `<div class="sep"></div>` +
    proc.map(r => `<button class="proc" data-p="${r.key}" style="--c:${r.color}"><span class="dot"></span><span>${esc(r.name)}</span><span class="n"></span></button>`).join('');
  el.querySelectorAll('[data-k]').forEach(b => b.onclick = () => S.view === 'brain' ? followPlanet(b.dataset.k) : openRegion(b.dataset.k));
  el.querySelector('[data-moon]').onclick = openPortrait;
  el.querySelectorAll('[data-p]').forEach(b => b.onclick = () => {
    if (S.view === 'brain') followPlanet(b.dataset.p);
    else flyTo(ORGAN_POS[b.dataset.p].clone().add(new THREE.Vector3(6, 3, 8)), ORGAN_POS[b.dataset.p], 2.2);
  });
}

function ago(ts) {
  if (!ts) return '—';
  const s = Date.now() / 1000 - ts;
  if (s < 60) return '刚刚'; if (s < 3600) return `${Math.floor(s / 60)} 分钟前`; if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}
function renderStats() {
  const s = S.stats;
  $('#stats').title = '已遗忘 ≠ 删除：遗忘的记忆还在，聊到相关的事会被重新想起，也可以手动召回';
  $('#stats').innerHTML = `还记得 <b>${s.active}</b><i>·</i>已遗忘 <b>${s.archived}</b><i>·</i>关联 <b>${S.links.length}</b><i>·</i>最近回想 <b>${ago(s.last_recall)}</b>`;
}

// ------------------------------------------------------------------ 镜头飞行（过场）
let flight = null;
// straight：直线飞（穿越用，不绕弯、不回弹）；warp：'in' 越飞越快，'out' 从最快慢慢停下，true 中间最快
function flyTo(pos, target, dur = 2.4, { warp = true, cinema = false, straight = false, easing = ease, white = null, sys = false, done } = {}) {
  if (swapping && !sys) return;   // 穿越星核的过场里不接受别的飞行，否则会把过场的 done 顶掉，swapping 永远卡在 true
  const p0 = camera.position.clone(), t0 = controls.target.clone();
  const dir = new THREE.Vector3().subVectors(pos, target).normalize();
  const c1 = straight ? p0.clone().lerp(pos, 1 / 3) : p0.clone().lerp(target, 0.15).add(new THREE.Vector3(0, 3, 0));
  const c2 = straight ? p0.clone().lerp(pos, 2 / 3) : pos.clone().addScaledVector(dir, 5).add(new THREE.Vector3(0, 2.5, 0));
  flight = { p0, c1, c2, p1: pos.clone(), t0, t1: target.clone(), dur, k: 0, warp, done, easing, white };
  if (cinema) document.body.classList.add('cinema');
  controls.enabled = false;
}
function stepFlight(dt) {
  if (!flight) return;
  const f = flight; f.k = Math.min(1, f.k + Math.min(dt, 0.1) / f.dur); const e = f.easing(f.k), u = 1 - e;   // 掉帧时不跳
  camera.position.set(0, 0, 0)
    .addScaledVector(f.p0, u * u * u).addScaledVector(f.c1, 3 * u * u * e).addScaledVector(f.c2, 3 * u * e * e).addScaledVector(f.p1, e * e * e);
  controls.target.lerpVectors(f.t0, f.t1, f.easing(Math.min(1, f.k * 1.15)));
  const w = f.warp === 'in' ? e * e : f.warp === 'out' ? (1 - e) ** 2 : f.warp ? Math.sin(Math.PI * f.k) : 0;
  camera.fov = 45 + 16 * w; camera.updateProjectionMatrix();
  bloom.strength = 0.9 + 0.8 * w; dust.material.uniforms.uWarp.value = w;
  // 白光跟着飞行进度走（不用 CSS 定时器）：掉帧时也保证换场景那一帧刚好全白
  if (f.white) whiteEl.style.opacity = (f.white === 'in' ? smooth(0.45, 1, f.k) : 1 - smooth(0, 0.6, f.k)).toFixed(3);
  camera.lookAt(controls.target);
  if (f.k >= 1) {
    flight = null; controls.enabled = S.mode !== 'intro'; camera.fov = 45; camera.updateProjectionMatrix(); bloom.strength = 0.9;
    f.done && f.done();
  }
}

// ------------------------------------------------------------------ 走马灯
const reel = { on: false, list: [], i: 0, playing: true, t: 0, dur: 4, region: null, follow: false };
const card = $('#card'), wires = $('#wires');
const cardPos = { x: innerWidth / 2, y: innerHeight / 2, w: 340, h: 300, init: false };

const posOf = m => (S.view === 'brain' ? m.bpos : m.pos) || m.pos;
const tgtOf = m => (S.view === 'brain' ? m.bpos : m.target) || m.target;
function camFor(m) {
  if (S.view === 'brain') {
    const dir = camera.position.clone().sub(controls.target).normalize();
    const minY = Math.sin(MIN_ELEV + 0.12); if (dir.y < minY) { dir.y = minY; const h = Math.hypot(dir.x, dir.z) || 1, k = Math.sqrt(1 - minY * minY) / h; dir.x *= k; dir.z *= k; }
    return m.bpos.clone().addScaledVector(dir, 20);
  }
  const { T, N } = frame(m.t);
  const out = N.clone(); if (out.dot(new THREE.Vector3(m.target.x, 0, m.target.z)) < 0) out.negate();
  return m.target.clone().addScaledVector(out, 4.6).addScaledVector(T, -1.2).add(new THREE.Vector3(0, 2.1, 0));
}

/** 一颗星和它关联的记忆（最多两跳），按关联度排好——联想式的走马灯。 */
function chainOf(m) {
  const out = [m], seen = new Set([m.id]);
  let frontier = [m.id];
  for (let d = 0; d < 2 && out.length < 14; d++) {
    const next = [];
    for (const id of frontier) for (const [b] of (S.adj.get(id) || []).slice().sort((x, y) => y[1] - x[1])) {
      if (seen.has(b) || out.length >= 14) continue; seen.add(b); const mm = S.byId.get(b); if (mm) { out.push(mm); next.push(b); }
    }
    frontier = next;
  }
  return out;
}
function startChain(m) {
  if (swapping) return;
  reel.chain = m.id; reel.region = m.region; reel.on = true;
  reel.list = chainOf(m); reel.i = 0; reel.playing = true; reel.t = 0; reel.follow = false; hideHint();
  S.mode = 'reel'; document.body.classList.add('reel', 'cinema');
  controls.autoRotate = false; $('#rot').classList.remove('on');
  card.classList.remove('show');
  flyTo(camFor(m), tgtOf(m), 1.4, { cinema: true, warp: false, done: () => { reel.follow = true; showCard(true); } });
  setReelTitle(); renderStrip(); updatePlayIcon();
}

function refreshReelList() {
  const cur = reel.list[reel.i];
  if (reel.chain) { const m = S.byId.get(reel.chain); reel.list = m ? chainOf(m) : []; }
  else reel.list = S.memories.filter(m => m.region === reel.region).sort((a, b) => sortKey(a) - sortKey(b));
  if (cur) reel.i = Math.max(0, reel.list.findIndex(m => m.id === cur.id));
  renderStrip();
}

function startReel(region, startId, { cinematic = true } = {}) {
  if (swapping) return;
  reel.region = region; reel.on = true; reel.list = []; reel.chain = null;
  refreshReelList();
  if (!reel.list.length) { reel.on = false; toast(`${S.regionBy[region].name} 里还没有记忆`, S.regionBy[region].color); return; }
  reel.i = startId ? Math.max(0, reel.list.findIndex(m => m.id === startId)) : 0;
  reel.playing = true; reel.t = 0; reel.follow = false; hideHint();
  S.mode = 'reel'; document.body.classList.add('reel', 'cinema');
  controls.autoRotate = false; $('#rot').classList.remove('on');
  renderLegend();
  const m = reel.list[reel.i];
  const go = () => { reel.follow = true; showCard(true); };
  if (cinematic) { card.classList.remove('show'); flyTo(camFor(m), tgtOf(m), S.view === 'brain' ? 1.6 : 2.6, { cinema: true, done: go }); }
  else go();
  setReelTitle(); renderStrip(); updatePlayIcon();
}

function exitReel() {
  if (!reel.on) return;
  reel.on = false; reel.follow = false; S.mode = 'explore';
  document.body.classList.remove('reel', 'cinema');
  card.classList.remove('show'); wires.innerHTML = '';
  renderLegend();
  const d = camera.position.distanceTo(controls.target);
  if (S.view === 'ring' && d < 14) flyTo(HOME.pos, HOME.target, 2.4);
  S.idleAt = performance.now() + 4000;
}

function reelGo(delta) {
  if (!reel.list.length) return;
  reel.i = (reel.i + delta + reel.list.length) % reel.list.length; reel.t = 0;
  showCard(true); renderStrip(); setReelTitle();
}

function durFor(m) { return 3.4 + m.importance * 2.6 + (m.has_image ? 1.4 : 0) + (m.content ? Math.min(m.content.length / 40, 2) : 0); }

function setReelTitle() {
  const r = S.regionBy[reel.region];
  $('#reeltitle').style.setProperty('--c', r.color);
  const head = reel.chain ? `联想 · <b>${esc(S.sealed ? '一串关联的记忆' : (S.byId.get(reel.chain)?.title || '关联记忆'))}</b>` : `走马灯 · <b>${esc(r.name)}</b>`;
  $('#reeltitle').innerHTML = `${head}<span>${reel.i + 1} / ${reel.list.length}</span>`;
  $('#reelbar').style.setProperty('--c', r.color);
}

function renderStrip() {
  const rail = $('#strip .rail');
  if (!reel.on) { rail.innerHTML = ''; return; }
  rail.innerHTML = reel.list.map((m, i) => {
    const near = Math.abs(i - reel.i) < 14;
    const src = near ? thumb(m) : null;
    return `<div class="fr ${src ? '' : 'text'} ${m.status === 'archived' ? 'arch' : ''} ${i === reel.i ? 'on' : ''}" data-i="${i}" title="${esc(fmtDate(sortKey(m)) + '  ' + (S.sealed || m.content == null ? '锁着的记忆' : (m.title || m.content.slice(0, 20))))}" style="--c:${m.color.getStyle()};${src ? `background-image:url('${src}')` : ''}"></div>`;
  }).join('');
  rail.querySelectorAll('.fr').forEach(f => f.onclick = () => { reel.i = +f.dataset.i; reel.t = 0; showCard(true); renderStrip(); setReelTitle(); });
  requestAnimationFrame(() => {
    const on = rail.querySelector('.fr.on'); if (!on) return;
    rail.style.transform = `translateX(${-(on.offsetLeft + on.offsetWidth / 2)}px)`;
  });
}

function mediaUrl(m) { return S.sealed ? null : `api/media/${m.id}`; }
function picOf(m, w, h) {
  if (m.image_kind === 'photo') return mediaUrl(m);
  if (m.image_prompt) return paint(m, w, h);
  return null;
}
function thumb(m) {
  if (S.sealed) return m.has_image ? paintSealed(m, m.color.getStyle(), 96, 96) : null;
  return picOf(m, 160, 160);
}

function fmtDate(ts) {
  const d = new Date(ts * 1000); const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()} · ${p(d.getMonth() + 1)} · ${p(d.getDate())}`;
}

function cardHTML(m) {
  const r = S.regionBy[m.region]; const c = m.color.getStyle();
  const date = fmtDate(sortKey(m));
  const no = String(m.order + 1).padStart(3, '0');
  if (S.sealed || m.content == null) {
    const pic = m.has_image ? `<div class="pic blur"><img src="${paintSealed(m, c)}" alt=""><span class="stamp">No.${no}</span></div>` : '';
    return `<div class="frame" style="--c:${c}">${pic}<div class="body">
      <div class="meta"><span class="rg">${esc(r.name)}</span><span class="sep">/</span>${esc(S.types?.[m.type] || '')}<span class="sep">/</span>${date}</div>
      <div class="sealed"><div class="seal">封</div><p>${S.key.initialized ? '这段记忆被锁着<br>超级管理员钥匙不在登记的位置' : '这段记忆已被加密封存'}</p>
      <button class="chip" data-act="key">钥 匙</button></div></div></div>`;
  }
  const src = picOf(m);
  const pic = src ? `<div class="pic"><img src="${src}" alt=""><span class="stamp">No.${no} · ${m.image_kind === 'photo' ? 'moment' : 'dream'}</span></div>` : '';
  const tags = (m.tags || []).slice(0, 4).map(t => `<span class="tag">#${esc(t)}</span>`).join('');
  return `<div class="frame" style="--c:${c}">${pic}<div class="body">
    <div class="meta"><span class="rg">${esc(r.name)}</span><span class="sep">/</span>${esc(m.type_name || '')}<span class="sep">/</span>${date}</div>
    <h3>${esc(m.title || m.content.slice(0, 12))}</h3>
    <p>${esc(m.content)}</p>
    <div class="foot">${m.emotion ? `<span class="tag emo">${esc(m.emotion)}</span>` : ''}${tags}
      ${m.superseded_by ? '<span class="archived">已被新的记忆取代</span>' : m.merged_into ? '<span class="archived">已在睡眠中整理进一段新的记忆</span>' : m.status === 'archived' ? '<span class="archived">已遗忘 · 可召回</span>' : m.forget_in_days == null ? '<span class="left">永远不会遗忘</span>' : `<span class="left">还会记得约 ${daysLeft(m)} 天</span>`}
      <span class="imp" title="重要性 ${m.importance}"><i style="width:${Math.round(m.importance * 100)}%"></i></span></div>
    ${assocHTML(m)}
    <div class="admin"><button data-act="edit">修改</button><button data-act="archive">${m.status === 'archived' ? '召回' : '遗忘'}</button><button class="danger" data-act="delete">彻底删除</button></div>
  </div></div>`;
}

// 艾宾浩斯：R = e^(-t/S)，强度降到 0.12 就遗忘；算出还剩几天。
function daysLeft(m) {
  const S_ = (m.forget_in_days || 30) / Math.log(1 / 0.12) * 1.6 ** Math.min(m.access_count || 0, 6);
  return Math.max(0, Math.round(S_ * Math.log((m.strength || 1) / 0.12)));
}
function assocHTML(m) {
  const list = (S.adj.get(m.id) || []).slice().sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id]) => S.byId.get(id)).filter(Boolean);
  if (!list.length) return '';
  return `<div class="assoc">关联 ${list.map(x => `<button data-go="${x.id}" style="--c:${x.color.getStyle()}">${esc(x.title || x.content.slice(0, 10))}</button>`).join('')}</div>`;
}

function showCard(swap) {
  const m = reel.list[reel.i]; if (!m) return;
  card.innerHTML = cardHTML(m);
  card.classList.add('show');
  if (swap) { card.classList.remove('swap'); void card.offsetWidth; card.classList.add('swap'); }
  card.querySelectorAll('[data-act]').forEach(b => b.onclick = e => { e.stopPropagation(); cardAction(b.dataset.act, m); });
  card.querySelectorAll('[data-go]').forEach(b => b.onclick = e => { e.stopPropagation(); const x = S.byId.get(b.dataset.go); if (x) startChain(x); });
  reel.dur = durFor(m);
  // 星光一闪
  for (let i = 0; i < 26; i++) {
    const a = Math.random() * TAU, b = Math.acos(2 * Math.random() - 1), sp = 0.6 + Math.random() * 1.4;
    fx.spawn({ p: tgtOf(m).clone(), v: new THREE.Vector3(Math.sin(b) * Math.cos(a), Math.cos(b), Math.sin(b) * Math.sin(a)).multiplyScalar(sp), c: m.color.clone().lerp(new THREE.Color(1, 1, 1), 0.5), size: 1.3, max: 1.2 + Math.random(), drag: 0.95 });
  }
}

function placeCard(dt) {
  const m = reel.list[reel.i];
  if (!reel.on || !m || !card.classList.contains('show')) { wires.innerHTML = ''; return; }
  const p = project(posOf(m));
  const w = card.offsetWidth || 340, h = card.offsetHeight || 300;
  let x = p.x + 90, y = p.y - h * 0.42, side = 1;
  if (x + w > innerWidth - 24) { x = p.x - 90 - w; side = -1; }
  const rb = ($('#reelbar').offsetHeight || 170) + 28;   // 给底下的放映条留出位置
  y = clamp(y, 24 + innerHeight * 0.09, innerHeight - h - rb);
  x = clamp(x, 16, innerWidth - w - 16);
  if (innerWidth < 760) { x = (innerWidth - w) / 2; y = Math.max(16 + innerHeight * 0.09, innerHeight - h - rb); side = p.x < x + w / 2 ? 1 : -1; }
  if (!cardPos.init) { cardPos.x = x; cardPos.y = y; cardPos.init = true; }
  const k = 1 - Math.exp(-dt * 6);
  cardPos.x = lerp(cardPos.x, x, k); cardPos.y = lerp(cardPos.y, y, k);
  card.style.transform = `translate(${cardPos.x}px, ${cardPos.y}px)`;
  const ex = side > 0 ? cardPos.x : cardPos.x + w, ey = cardPos.y + Math.min(h * 0.42, 120);
  const mx = (p.x + ex) / 2;
  const c = m.color.getStyle();
  wires.innerHTML = p.vis ? `
    <defs><linearGradient id="wg" x1="${p.x}" y1="${p.y}" x2="${ex}" y2="${ey}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${c}" stop-opacity=".95"/><stop offset="1" stop-color="${c}" stop-opacity=".15"/></linearGradient></defs>
    <circle cx="${p.x}" cy="${p.y}" r="16" fill="none" stroke="${c}" stroke-opacity=".35" stroke-width="1"/>
    <circle cx="${p.x}" cy="${p.y}" r="26" fill="none" stroke="${c}" stroke-opacity=".12" stroke-width="1"/>
    <path d="M${p.x + side * 16},${p.y} C${mx},${p.y} ${mx},${ey} ${ex},${ey}" fill="none" stroke="url(#wg)" stroke-width="1"/>
    <rect x="${ex - 3}" y="${ey - 3}" width="6" height="6" transform="rotate(45 ${ex} ${ey})" fill="${c}"/>` : '';
}

function updatePlayIcon() {
  $('#play').innerHTML = reel.playing
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5v14l12-7z"/></svg>';
}

$('#prev').onclick = () => reelGo(-1);
$('#next').onclick = () => reelGo(1);
$('#play').onclick = () => { reel.playing = !reel.playing; updatePlayIcon(); };
$('#exit').onclick = exitReel;
addEventListener('keydown', e => {
  if (e.key === 'Escape') { onEscape(); return; }
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (S.mode === 'intro') { finishIntro(); return; }
  if (!reel.on) return;
  if (e.key === 'ArrowRight') reelGo(1); else if (e.key === 'ArrowLeft') reelGo(-1);
  else if (e.key === ' ') { reel.playing = !reel.playing; updatePlayIcon(); e.preventDefault(); }
});

// ------------------------------------------------------------------ 全屏：Esc 才退出
function goFullscreen() {
  if (EMBED) { parent.postMessage({ type: 'fmn:fullscreen' }, location.origin); return; }
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => { });
}
function onEscape() {
  if ([...document.querySelectorAll('.modal.show')].length) { document.querySelectorAll('.modal.show').forEach(m => m.classList.remove('show')); return; }
  // 先关页面里的小面板，一层层往外退；dsh 里最后才交给外面（退出全屏）
  const mp = $('#musicpanel'), cm = $('#charmenu'), rs = $('#results');
  if (mp.classList.contains('show')) { mp.classList.remove('show'); return; }
  if (cm.classList.contains('show')) { cm.classList.remove('show'); return; }
  if (rs.classList.contains('show')) { rs.classList.remove('show'); return; }
  if (reel.on) { exitReel(); return; }
  if (S.follow || pp.classList.contains('show')) { unfollow(); return; }
  if (EMBED) { parent.postMessage({ type: 'fmn:escape' }, location.origin); return; }
  if (S.view === 'brain') exitBrain();
}
$('#fsbtn').onclick = goFullscreen;
addEventListener('message', e => { if (e.origin === location.origin && e.data?.type === 'fmn:fullscreen-state') document.body.classList.toggle('full', !!e.data.full); });

// ------------------------------------------------------------------ 多级缩放：星环 ⇄ 脑图
// 脑图的默认镜头：根据太阳系有多大来定，仰角 40°（大于不遮挡所需的最小仰角）
const BRAIN_HOME = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
function fitBrainHome() {
  const R = brain.extent(), d = R * (NARROW ? 3.3 : 1.95), el = 40 * Math.PI / 180;
  BRAIN_HOME.pos.set(-d * Math.cos(el) * 0.12, d * Math.sin(el), d * Math.cos(el));
  BRAIN_HOME.target.set(NARROW ? 0 : R * 0.12, -R * 0.06, 0);
}
let swapping = false;
const whiteEl = $('#whiteout');
function setView(v) {
  S.view = v;
  for (const o of ringObjs) o.visible = v === 'ring';
  // 莫比乌斯环不丢：在脑图里，它变成环绕整个大脑的一圈星河
  dust.visible = true;
  dust.rotation.set(v === 'brain' ? -0.32 : 0, 0, v === 'brain' ? 0.06 : 0);
  dust.position.set(v === 'brain' ? 3 : 0, v === 'brain' ? -2 : 0, 0);
  if (organs) organs.visible = v === 'ring';
  brain.group.visible = v === 'brain';
  document.body.classList.toggle('brain', v === 'brain'); setTimeout(placeLegend, 50); setTimeout(placeLegend, 1300);
  $('#brainbtn').classList.toggle('on', v === 'brain');
  renderTitle();
  fitBrainHome();
  controls.maxDistance = v === 'brain' ? brain.extent() * 4 : 110;
  // 脑图里镜头不能压得太低：仰角至少 MIN_ELEV，这样行星永远不会互相遮挡
  controls.minPolarAngle = v === 'brain' ? 0.05 : 0;
  controls.maxPolarAngle = v === 'brain' ? Math.PI / 2 - MIN_ELEV - 0.02 : Math.PI;
  const R = brain.extent();
  dust.scale.setScalar(v === 'brain' ? R * 1.18 / 13 : 1);
  renderLegend();
}
function flash(peakAt, fn) {
  const w = $('#whiteout'); w.style.transition = 'opacity .45s'; w.style.opacity = '0.9';
  setTimeout(() => { fn(); w.style.transition = 'opacity 1.1s'; w.style.opacity = '0'; }, peakAt);
}
function enterBrain() {
  if (swapping || S.view === 'brain') return; swapping = true;
  if (reel.on) exitReel();
  unfollow(); controls.autoRotate = false; $('#rot').classList.remove('on');
  // 一镜到底：先一路加速冲进星核（白光跟着亮起）→ 飞到星核的那一帧全白、换成脑图 →
  // 镜头从远处继续往前冲、慢慢减速停在太阳系前面。换场景由飞行的 done 触发，不靠定时器
  whiteEl.style.transition = 'none'; whiteEl.classList.add('full');
  const into = camera.position.clone().setLength(0.35);   // 沿「镜头→星核」这条线冲进去
  const dur = clamp(0.6 + camera.position.length() * 0.03, 0.95, 1.8);
  flyTo(into, new THREE.Vector3(), dur, { sys: true, straight: true, warp: 'in', white: 'in', easing: t => t * t * t, done: () => {
    whiteEl.style.opacity = '1'; setView('brain');
    const from = BRAIN_HOME.pos.clone().sub(BRAIN_HOME.target).multiplyScalar(2.6).add(BRAIN_HOME.target);
    camera.position.copy(from); controls.target.copy(BRAIN_HOME.target); camera.lookAt(BRAIN_HOME.target);
    camera.fov = 61; camera.updateProjectionMatrix();
    flyTo(BRAIN_HOME.pos, BRAIN_HOME.target, 2.0, { sys: true, straight: true, warp: 'out', white: 'out', easing: t => 1 - (1 - t) ** 3,
      done: () => { swapping = false; whiteEl.classList.remove('full'); whiteEl.style.opacity = '0'; S.idleAt = performance.now(); showGuide(); } });
  } });
}
function exitBrain() {
  if (swapping || S.view !== 'brain') return; swapping = true;
  if (reel.on) exitReel();
  unfollow(); $('#guide').classList.remove('show');
  // 反过来：往后退、越退越快 → 白光 → 从星核里退出来，慢慢停在星环前
  whiteEl.style.transition = 'none'; whiteEl.classList.add('full');
  const back = camera.position.clone().sub(controls.target).multiplyScalar(2.2).add(controls.target);
  flyTo(back, controls.target.clone(), 0.85, { sys: true, straight: true, warp: 'in', white: 'in', easing: t => t * t * t, done: () => {
    whiteEl.style.opacity = '1'; setView('ring');
    const dir = HOME.pos.clone().sub(HOME.target).normalize();
    camera.position.copy(dir.multiplyScalar(0.4)); controls.target.copy(HOME.target); camera.lookAt(HOME.target);
    camera.fov = 61; camera.updateProjectionMatrix();
    flyTo(HOME.pos, HOME.target, 2.2, { sys: true, straight: true, warp: 'out', white: 'out', easing: t => 1 - (1 - t) ** 3,
      done: () => { swapping = false; whiteEl.classList.remove('full'); whiteEl.style.opacity = '0'; controls.autoRotate = true; $('#rot').classList.add('on'); S.idleAt = performance.now(); } });
  } });
}

// ------------------------------------------------------------------ 人设卡（太阳 · 心核）+ 性格养成
// 名字：人设卡里的名字 → 新建角色时起的名字 → TA
// 钥匙不在时人设卡读不到：用上次记下的名字，免得界面突然变回「TA」让人以为数据没了
const NAME_KEY = 'fmn-name:' + location.pathname;
const cachedName = () => { try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; } };
const personaName = () => {
  const n = S.persona?.profile?.name;
  if (n && n !== 'TA') { try { localStorage.setItem(NAME_KEY, n); } catch { } return n.trim(); }
  return (cachedName() || (S.charName && S.charName !== '默认' ? S.charName : '') || 'TA').trim() || 'TA';
};
/** 代词随人设卡里的性别变：女→她，男→他，没写→TA */
const pronoun = () => { const g = String(S.persona?.profile?.gender || ''); return /女|female|woman|girl|^f$/i.test(g) ? '她' : /男|male|man|boy|^m$/i.test(g) ? '他' : 'TA'; };
function renderTitle() {
  const v = S.view, n = esc(personaName());
  $('#title').innerHTML = v === 'brain' ? `${n}的回忆<small>· 脑图</small>` : '勿忘我<small>Forget-me-not</small>';
  $('#poem').textContent = v === 'brain' ? `像太阳系一样：每个脑区是一颗绕着「心核 · ${personaName()}」公转的行星，记忆是它的卫星` : `把${pronoun()}留在时间里的痕迹，延长得再久一些`;
  const line = document.querySelector('#intro .line'); if (line) line.textContent = `${pronoun()}会想起，也会遗忘`;
  document.title = `勿忘我 · ${personaName() === 'TA' ? '记忆星环' : personaName() + '的记忆'}`;
}
function renderPersona() {
  const el = $('#persona');
  renderTitle();
  if (!S.persona) { el.innerHTML = `<h5>人设卡</h5><div class="sub">心核 · 性格养成中</div><div class="locked">${S.key.initialized ? '钥匙不在，人设卡也被锁着。' : '还没有任何经历。'}</div>`; return; }
  const P = S.persona.profile || {};
  const T = S.persona.traits, n = T.length, cx = 150, cy = 108, R0 = 78;
  const pt = (i, v) => { const a = -Math.PI / 2 + i * 2 * Math.PI / n; return [cx + Math.cos(a) * R0 * v, cy + Math.sin(a) * R0 * v]; };
  const poly = vals => vals.map((v, i) => pt(i, v).map(x => x.toFixed(1)).join(',')).join(' ');
  const rings = [0.25, 0.5, 0.75, 1].map(k => `<polygon points="${poly(T.map(() => k))}" fill="none" stroke="rgba(200,214,255,.10)"/>`).join('');
  const axes = T.map((t, i) => { const [x, y] = pt(i, 1); const [lx, ly] = pt(i, 1.2); return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="rgba(200,214,255,.08)"/><text x="${lx}" y="${ly + 3}" text-anchor="middle">${t.name}</text>`; }).join('');
  const hist = (S.persona.history || []).slice(0, 3).map(h => {
    const t = T.find(x => x.key === h.trait);
    return `<li><b>${t?.name || h.trait}</b><span class="${h.delta > 0 ? 'up' : 'down'}">${h.delta > 0 ? '+' : ''}${h.delta}</span> ${esc(h.reason)}</li>`;
  }).join('');
  // 没有头像时：用名字的第一个字当头像；点一下可以上传
  const initial = esc([...personaName()][0] || 'T');
  el.innerHTML = `<div class="card-head" id="pc-head"><div class="av ${P.avatar ? '' : 'empty'}" id="pc-av" title="${P.avatar ? '头像' : '点击设置头像'}">${P.avatar ? `<img src="${P.avatar}" alt="">` : `<span>${initial}</span>`}</div>
      <div><div class="nm">${esc(personaName())}</div><div class="tt">${esc(P.title || '人设卡 · 心核')}</div></div></div>
    ${P.description ? `<div class="desc">${esc(P.description)}</div>` : ''}
    <svg viewBox="0 0 300 220">${rings}${axes}
      <polygon points="${poly(T.map(t => t.baseline))}" fill="none" stroke="rgba(200,214,255,.35)" stroke-dasharray="3 3"/>
      <polygon points="${poly(T.map(t => t.value))}" fill="rgba(201,167,255,.18)" stroke="#c9a7ff" stroke-width="1.4" style="filter:drop-shadow(0 0 6px #c9a7ff)"/>
      ${T.map((t, i) => { const [x, y] = pt(i, t.value); return `<circle cx="${x}" cy="${y}" r="2.4" fill="#fff"/>`; }).join('')}
    </svg><ul>${hist}</ul>
    <div class="pbtns"><button id="pc-edit">编辑人设卡</button><label class="chip" style="padding:4px 11px;font-size:11.5px;cursor:pointer">导入角色卡<input type="file" id="pc-import" accept=".png,.json,image/png,application/json" hidden></label></div>`;
  $('#pc-edit').onclick = () => openPersonaEditor();
  $('#pc-head').onclick = e => { if (e.target.closest('#pc-av') && !P.avatar) { e.stopPropagation(); openPersonaEditor(); } else { el.classList.toggle('open'); focusSun(); } };
  $('#pc-import').onchange = e => e.target.files[0] && importCard(e.target.files[0]);
}
// 点心核：一张大卡片，直接把角色卡拖进来就是她的人设
const coreModal = $('#coremodal');
function openCore() {
  const P = S.persona?.profile || {}, nm = personaName(), has = Boolean(P.name || P.description);
  $('#cm-body').innerHTML = `
    <h4>心核 · ${esc(nm)}</h4>
    <p class="sub">${has ? `这是${esc(nm)}现在的人设卡。想换一张，把新的角色卡拖进下面的框里。` : `${esc(nm)}还没有人设卡。给${pronoun()}一张，${pronoun()}就知道自己是谁了。`}</p>
    ${has ? `<div class="cm-card">${P.avatar ? `<img src="${P.avatar}" alt="">` : `<span class="ini">${esc(nm.slice(0, 1))}</span>`}<div><b>${esc(nm)}</b><small>${esc(P.title || P.gender || '')}</small><p>${esc(String(P.description || P.personality || '').slice(0, 90))}</p></div></div>` : ''}
    <label class="cm-drop" id="cm-drop"><input type="file" id="cm-file" accept=".png,.json,image/png,application/json" hidden>
      <i>✦</i><b>把角色卡拖到这里</b><span>酒馆（SillyTavern）的 .png 或 .json 都可以 · 也可以点一下选文件</span></label>
    <div class="err" id="cm-err">${S.key.unlocked ? '' : '钥匙不在，暂时不能改人设卡。先点右下角的小钥匙找回它。'}</div>
    <div class="row"><button class="chip" id="cm-close">关闭</button><span style="flex:1"></span><button class="chip on" id="cm-write">${has ? '编辑人设卡' : '自己写一张'}</button></div>`;
  const drop = $('#cm-drop');
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('over'); hideVeil(); const f = e.dataTransfer.files[0]; if (f) { coreModal.classList.remove('show'); importCard(f); } };
  $('#cm-file').onchange = e => { const f = e.target.files[0]; if (f) { coreModal.classList.remove('show'); importCard(f); } };
  $('#cm-close').onclick = () => coreModal.classList.remove('show');
  $('#cm-write').onclick = () => { coreModal.classList.remove('show'); openPersonaEditor(); };
  coreModal.classList.add('show');
}

// 拖文件进页面时整个屏幕提示「松手就好」
let veilDepth = 0;
const hideVeil = () => { veilDepth = 0; $('#dropveil').classList.remove('show'); };
addEventListener('dragenter', e => { if ([...(e.dataTransfer?.items || [])].some(x => x.kind === 'file') && !coreModal.classList.contains('show')) { veilDepth++; $('#dropveil').classList.add('show'); } });
addEventListener('dragleave', () => { if (--veilDepth <= 0) hideVeil(); });
addEventListener('drop', hideVeil, true);
addEventListener('dragover', e => { if ([...(e.dataTransfer?.items || [])].some(x => x.kind === 'file')) e.preventDefault(); });

function focusSun() {
  if (S.view !== 'brain') return;
  if (reel.on) exitReel();
  const d = brain.extent() * 0.55;
  flyTo(new THREE.Vector3(0, d * Math.sin(0.9), d * Math.cos(0.9)), new THREE.Vector3(), 1.8, { warp: false });
  const el = $('#persona'); el.classList.add('focus'); setTimeout(() => el.classList.remove('focus'), 2600);
  corePulse = 1;
}

// ------------------------------------------------------------------ 我眼中的你（绕着心核转的小卫星）
const ptModal = $('#portraitmodal');
// 与 lib/core/portrait.js 的分区保持一致
const PT_SECTIONS = [
  ['basics', '基本信息', '称呼、年龄或生日、所在城市、职业或学业、家庭情况'], ['personality', '性格', 'TA 是个怎样的人'],
  ['people', '身边重要的人', '家人、朋友、同事、宠物'], ['likes', '喜欢的', '爱吃的、爱玩的、喜欢的音乐电影书'],
  ['dislikes', '不喜欢的', '讨厌的东西、受不了的事'], ['routine', '作息与习惯', '几点睡几点起、周末怎么过'],
  ['emotions', '情绪', '什么让 TA 开心或难过，难过时怎么陪'], ['communication', '沟通方式', '喜欢怎样被说话、暗号'],
  ['now', '最近', '最近在经历、在忙、在烦恼的事'], ['dreams', '目标与梦想', '想成为的人、想做的事'],
  ['values', '在意的事', '价值观、原则、底线'], ['us', '我们', '我们的关系、默契、共同回忆'],
];
let ptEditing = false;
function openPortrait() {
  const P = S.portrait, nm = personaName();
  $('#pt-title').textContent = `${nm}眼中的你`;
  $('#pt-sub').textContent = `绕着心核转的小卫星：${nm}对你的了解，就像对老朋友心里的那份档案。它不是封存的记忆，${nm}知道了新的事就会更新对应的那一栏；你也可以自己改。`;
  ptEditing = false; $('#pt-save').style.display = 'none'; $('#pt-err').textContent = '';
  if (S.sealed) { $('#pt-body').innerHTML = '<p class="sub">钥匙不在，看不到。</p>'; $('#pt-edit').style.display = 'none'; ptModal.classList.add('show'); return; }
  $('#pt-edit').style.display = ''; $('#pt-edit').textContent = '我来改';
  const who = b => b === 'user' || b === 'admin' ? '你' : nm;
  const sec = P?.sections || {}, known = PT_SECTIONS.filter(([k]) => sec[k]).length;
  const R = 26, C = 2 * Math.PI * R, frac = known / PT_SECTIONS.length;
  $('#pt-body').innerHTML = `
    <div class="pt-head">
      <svg class="pt-meter" viewBox="0 0 64 64"><circle cx="32" cy="32" r="${R}" fill="none" stroke="rgba(200,214,255,.12)" stroke-width="4"/>
        <circle cx="32" cy="32" r="${R}" fill="none" stroke="#cfe0ff" stroke-width="4" stroke-linecap="round" stroke-dasharray="${(C * frac).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 32 32)" style="filter:drop-shadow(0 0 4px #9fb8ff)"/>
        <text x="32" y="36" text-anchor="middle">${known}/${PT_SECTIONS.length}</text></svg>
      <div><div class="pt-name">${P?.name ? `称呼 · ${esc(P.name)}` : '了解程度'}</div>
        <div class="pt-sum">${P?.summary ? esc(P.summary) : `${nm}还在慢慢认识你。`}</div></div>
    </div>
    <div class="pt-grid">${PT_SECTIONS.map(([k, name, hint]) => `<div class="pt-sec ${sec[k] ? '' : 'empty'}"><b>${name}</b><span>${sec[k] ? esc(sec[k]) : `还不了解 · ${hint}`}</span></div>`).join('')}</div>
    ${(P?.unknowns || []).length ? `<div class="pt-unk"><b>${nm}还想知道的</b>${P.unknowns.map(u => `<span>${esc(u)}</span>`).join('')}</div>` : ''}
    ${P ? `<div class="pt-meta">最近一次：${fmtDate(P.at)} · ${esc(who(P.by))}改的${P.reason ? ` · ${esc(P.reason)}` : ''}</div>` : ''}
    ${(P?.history || []).length ? `<details><summary>改动记录（${P.history.length}）</summary>${P.history.map(h => `<div class="pt-old"><div class="pt-meta">${fmtDate(h.at)} · ${esc(who(h.by))}改的${h.reason ? ` · ${esc(h.reason)}` : ''}</div>了解程度 ${h.known}/${h.total}${h.summary ? ` · ${esc(h.summary)}` : ''}</div>`).join('')}</details>` : ''}`;
  ptModal.classList.add('show');
}
$('#pt-close').onclick = () => ptModal.classList.remove('show');
$('#pt-edit').onclick = () => {
  if (!S.key.unlocked) { ptModal.classList.remove('show'); openKey(); return; }
  if (ptEditing) { openPortrait(); return; }
  ptEditing = true;
  const P = S.portrait || {}, sec = P.sections || {};
  $('#pt-body').innerHTML = `<div class="pt-form">
    <label>称呼<input id="pf2-name" value="${esc(P.name || '')}" maxlength="40" placeholder="你喜欢被怎么叫"></label>
    <label>总体印象<textarea id="pf2-summary" placeholder="一两句话">${esc(P.summary || '')}</textarea></label>
    ${PT_SECTIONS.map(([k, name, hint]) => `<label>${name}<textarea data-sec="${k}" placeholder="${hint}">${esc(sec[k] || '')}</textarea></label>`).join('')}
    <label>还想知道的（一行一件）<textarea id="pf2-unknowns">${esc((P.unknowns || []).join('\n'))}</textarea></label></div>`;
  $('#pt-edit').textContent = '取消'; $('#pt-save').style.display = '';
};
$('#pt-save').onclick = async () => {
  const sections = Object.fromEntries([...document.querySelectorAll('#pt-body [data-sec]')].map(t => [t.dataset.sec, t.value]));
  try {
    await api('api/portrait', { method: 'POST', body: { name: $('#pf2-name').value, summary: $('#pf2-summary').value, sections,
      unknowns: $('#pf2-unknowns').value.split('\n').map(x => x.trim()).filter(Boolean) } });
    await loadBrain(); openPortrait(); toast(`<b>${esc(personaName())}眼中的你</b>已经按你写的改好了`, '#e6eeff');
  } catch (e) { $('#pt-err').textContent = e.message; }
};

// 编辑 / 导入人设卡
const pModal = $('#personamodal');
const PF = ['name', 'gender', 'title', 'description', 'personality', 'speaking_style', 'scenario', 'first_mes'];
let pfAvatar = null;
function openPersonaEditor(prefill) {
  if (!S.key.unlocked) { openKey(); return; }
  const P = { ...(S.persona?.profile || {}), ...(prefill || {}) };
  for (const k of PF) $('#pf-' + k).value = P[k] || '';
  pfAvatar = P.avatar || null; $('#pf-avatar-img').src = pfAvatar || '';
  $('#pf-err').textContent = prefill ? `已从角色卡读入「${P.name || ''}」，确认后保存` : '';
  pModal.classList.add('show');
}
$('#pf-cancel').onclick = () => pModal.classList.remove('show');
$('#pf-avatar-box').onclick = e => { if (e.target.id !== 'pf-avatar') $('#pf-avatar').click(); };
$('#pf-avatar').onchange = async e => { const f = e.target.files[0]; if (f) { pfAvatar = await shrinkImage(f); $('#pf-avatar-img').src = pfAvatar; } };
$('#pf-import').onchange = e => e.target.files[0] && importCard(e.target.files[0]);
$('#pf-ok').onclick = async () => {
  const profile = Object.fromEntries(PF.map(k => [k, $('#pf-' + k).value]));
  profile.avatar = pfAvatar;
  try { await api('api/persona', { method: 'POST', body: { profile } }); pModal.classList.remove('show'); await loadBrain(); corePulse = 1.2; toast(`<b>人设卡</b>${esc(personaName())} 的人设卡已保存`, '#cfe0ff'); }
  catch (e) { $('#pf-err').textContent = e.status === 423 ? '钥匙不在，不能修改人设卡' : e.message; }
};
/** 头像缩到 256px，存进加密的人设卡里。 */
function shrinkImage(blob, size = 256) {
  return new Promise((resolve, reject) => {
    const img = new Image(); img.onload = () => {
      const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d');
      const k = Math.max(size / img.width, size / img.height), w = img.width * k, h = img.height * k;
      g.drawImage(img, (size - w) / 2, (size - h) / 2.6, w, h); URL.revokeObjectURL(img.src); resolve(c.toDataURL('image/jpeg', 0.88));
    }; img.onerror = reject; img.src = URL.createObjectURL(blob);
  });
}
/** 读酒馆（SillyTavern / Character Card V1 V2 V3）角色卡：.json，或把 JSON 藏在 PNG 的 tEXt「chara / ccv3」里。 */
async function importCard(file) {
  try {
    let json, avatar = null;
    if (/\.json$/i.test(file.name) || file.type === 'application/json') json = JSON.parse(await file.text());
    else {
      const buf = new Uint8Array(await file.arrayBuffer()), dv = new DataView(buf.buffer);
      let off = 8, found = {};
      while (off + 8 < buf.length) {
        const len = dv.getUint32(off), type = String.fromCharCode(...buf.slice(off + 4, off + 8));
        if (type === 'tEXt' || type === 'iTXt') {
          const data = buf.slice(off + 8, off + 8 + len), z = data.indexOf(0), key = new TextDecoder('latin1').decode(data.slice(0, z));
          if (key === 'chara' || key === 'ccv3') {
            let raw = data.slice(z + 1); if (type === 'iTXt') { let n = 0, i = 0; while (n < 3 && i < raw.length) { if (raw[i] === 0) n++; i++; } raw = raw.slice(i + 1); }
            const b64 = new TextDecoder('latin1').decode(raw).trim();
            found[key] = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), ch => ch.charCodeAt(0))));
          }
        }
        if (type === 'IEND') break;
        off += 12 + len;
      }
      json = found.ccv3 || found.chara;
      if (!json) throw new Error('这张图片里没有角色卡数据');
      avatar = await shrinkImage(file);
    }
    const d = json.data || json;
    const firstLine = s => String(s || '').split('\n').map(x => x.trim()).find(Boolean) || '';
    openPersonaEditor({
      name: d.name || d.char_name || '', gender: d.gender || d.extensions?.gender || ((d.tags || []).includes('女') ? '女' : (d.tags || []).includes('男') ? '男' : ''), title: firstLine(d.creator_notes).slice(0, 60) || (d.tags || []).slice(0, 3).join(' · '),
      description: d.description || d.char_persona || '', personality: d.personality || '', scenario: d.scenario || d.world_scenario || '',
      speaking_style: [d.system_prompt, d.mes_example || d.example_dialogue].filter(Boolean).join('\n\n'), first_mes: d.first_mes || d.char_greeting || '', avatar: avatar || undefined,
    });
  } catch (e) { toast(`<b>人设卡</b>读不出这张角色卡：${esc(e.message)}`, '#ff8fa6'); }
}
// 把角色卡拖进页面
addEventListener('drop', e => {
  const f = [...(e.dataTransfer?.files || [])].find(x => /\.(json|png)$/i.test(x.name));
  if (!f) return; e.preventDefault(); importCard(f);
});

// ------------------------------------------------------------------ 跟随一颗行星公转
// 点行星：镜头飞过去跟着它公转，旁边弹出这颗行星的小窗（里面的记忆、放映按钮）
function followPlanet(k) {
  if (swapping) return;
  if (reel.on) exitReel();
  S.follow = k; controls.autoRotate = false; $('#rot').classList.remove('on');
  // 仰角要高于 OrbitControls 的 maxPolarAngle 限制（≈36°），否则飞到终点那一帧会被硬掰上去 3°，之后跟随时还会一直和限制拉扯
  const h = brain.hub(k), off = new THREE.Vector3(0, Math.sin(MIN_ELEV + 0.12), Math.cos(MIN_ELEV + 0.12)).multiplyScalar(16.6);
  flyTo(h.clone().add(off), h, 1.4, { warp: false, done: () => { S.followOff = off.clone(); } });
  showPlanetPanel(k);
}
function unfollow() { S.follow = null; S.followOff = null; hidePlanetPanel(); }

const pp = $('#planetpanel');
function showPlanetPanel(k) {
  const r = S.regionBy[k]; if (!r) return;
  const list = S.memories.filter(m => m.region === k).sort((a, b) => (b.status !== 'archived') - (a.status !== 'archived') || sortKey(b) - sortKey(a));
  const live = list.filter(m => m.status !== 'archived').length
  const locked = S.sealed || list.some(m => m.content == null);
  const st = m => m.superseded_by ? '已被新的记忆取代' : m.merged_into ? '已整理进新的记忆' : m.status === 'archived' ? '已淡忘 · 可召回' : m.forget_in_days == null ? '永远不会忘' : `还会记得约 ${daysLeft(m)} 天`;
  // 每段记忆直接把内容写出来：标题 + 正文（默认三行，点一下展开全文、配图和标签）
  const item = m => {
    if (S.sealed || m.content == null) return `<div class="mem locked"><div class="mh"><time>${fmtDate(sortKey(m))}</time></div><p>🔒 锁着的记忆</p></div>`;
    const src = picOf(m);
    return `<div class="mem ${m.status === 'archived' ? 'faded' : ''}" data-id="${m.id}">
      <div class="mh"><time>${fmtDate(sortKey(m))}</time>${m.emotion ? `<span class="emo">${esc(m.emotion)}</span>` : ''}</div>
      <b>${esc(m.title || m.content.slice(0, 14))}</b>
      <p>${esc(m.content)}</p>
      <div class="more">${src ? `<img src="${src}" alt="">` : ''}
        <div class="tags">${(m.tags || []).slice(0, 5).map(t => `<span>#${esc(t)}</span>`).join('')}<span class="st">${st(m)}</span></div>
        <button class="chip go">✦ 从这段开始联想放映</button></div>
    </div>`;
  };
  pp.style.setProperty('--c', r.color);
  pp.innerHTML = `<button class="x" title="关闭（Esc）">✕</button>
    <h4><span class="dot"></span>${esc(r.name)}</h4>
    <p class="sub">${esc(r.desc)}</p>
    ${r.kind === 'process' ? `<p class="note">这是大脑的器官，不存放记忆，只负责让记忆流动。</p>` : `
    <div class="stats"><span><b>${live}</b> 段记得</span>${list.length - live ? `<span><b>${list.length - live}</b> 段已淡忘</span>` : ''}</div>
    ${list.length ? `<p class="how">${locked ? '钥匙不在登记的位置，内容看不到。点右下角的小钥匙找回它。' : '下面就是这里的每一段记忆。点一段展开全文；想看动画就点「放映」，会一段一段播给你看。'}</p>
    <button class="chip on play">▶ 放映这里的 ${list.length} 段记忆</button>
    <div class="list">${list.map(item).join('')}</div>`
      : `<p class="note">这里还没有记忆。${esc(personaName())}以后记下相关的事，就会出现在这里。</p>`}`}`;
  pp.querySelector('.x').onclick = unfollow;
  const play = pp.querySelector('.play'); if (play) play.onclick = () => { const kk = k; hidePlanetPanel(); S.follow = null; S.followOff = null; openRegion(kk); };
  pp.querySelectorAll('.mem[data-id]').forEach(el => {
    el.onclick = () => { const open = el.classList.contains('open'); pp.querySelectorAll('.mem.open').forEach(x => x.classList.remove('open')); if (!open) el.classList.add('open'); };
    el.querySelector('.go').onclick = e => { e.stopPropagation(); const m = S.byId.get(el.dataset.id); hidePlanetPanel(); S.follow = null; S.followOff = null; if (m) startChain(m); };
  });
  tip.classList.remove('show');
  pp.classList.add('show');
}
function hidePlanetPanel() { pp.classList.remove('show'); }

// 刚进入星河时的小提示
let guideTimer;
function showGuide() {
  const g = $('#guide');
  g.innerHTML = `<span>点太阳 · 看${esc(personaName())}的人设卡</span><i>·</i><span>点行星 · 看里面的记忆</span><i>·</i><span>点星光 · 联想放映</span><i>·</i><span>拉远 · 回到星环</span>`;
  g.classList.add('show'); clearTimeout(guideTimer); guideTimer = setTimeout(() => g.classList.remove('show'), 7000);
}

function openRegion(key) {
  if (S.mode === 'intro') return;
  startReel(key, null, { cinematic: true });
}

// ------------------------------------------------------------------ 悬停 / 点击星光
const tip = $('#tooltip');
let mouse = { x: -1, y: -1, down: null };
renderer.domElement.addEventListener('pointermove', e => { mouse.x = e.clientX; mouse.y = e.clientY; });
renderer.domElement.addEventListener('pointerleave', () => { mouse.x = -1; S.hover = null; tip.classList.remove('show'); });
renderer.domElement.addEventListener('pointerdown', e => { mouse.down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
renderer.domElement.addEventListener('pointerup', e => {
  const d = mouse.down; mouse.down = null;
  if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > (e.pointerType === 'touch' ? 14 : 8) || S.mode === 'intro') return;
  mouse.x = e.clientX; mouse.y = e.clientY; pick();   // 按下去的这一刻重新看一眼鼠标下面是什么（行星一直在动）
  if (S.view === 'brain' && !S.hover) {
    if (S.hoverPlanet === 'sun') { focusSun(); openCore(); }
    else if (S.hoverPlanet === 'portrait') openPortrait();
    else if (S.hoverPlanet) followPlanet(S.hoverPlanet);
    else if (S.follow) unfollow();
    return;
  }
  if (!S.hover) return;
  if (S.view === 'brain') startChain(S.hover);
  else startReel(S.hover.region, S.hover.id, { cinematic: !(reel.on && reel.region === S.hover.region) });
});

function pick() {
  if (mouse.x < 0 || flight) { S.hover = null; return; }
  let best = null, bd = 18 * 18; const tmp = {};
  for (const m of S.memories) {
    if (!posOf(m)) continue;
    project(posOf(m), tmp); if (!tmp.vis) continue;
    const d = (tmp.x - mouse.x) ** 2 + (tmp.y - mouse.y) ** 2;
    if (d < bd) { bd = d; best = m; }
  }
  // 脑图里：行星和太阳也能指
  S.hoverPlanet = null;
  if (S.view === 'brain') {
    // 指着行星中心 → 选行星；指着周围的卫星 → 选那段记忆；周围空着 → 也算选行星
    let pd = 1e9, pk = null;
    for (const k of brain.keys()) {
      project(brain.hub(k), tmp); if (!tmp.vis) continue;
      const d = Math.hypot(tmp.x - mouse.x, tmp.y - mouse.y);
      if (d < pd) { pd = d; pk = k; }
    }
    const reach = pk ? 14 + brain.sizeOf(pk) * 260 / Math.max(20, camera.position.distanceTo(brain.hub(pk))) : 0;
    if (pk && (pd < 24 || (!best && pd < reach + 10))) { S.hoverPlanet = pk; best = null; }
    project(new THREE.Vector3(), tmp);
    if (!S.hoverPlanet && !best && tmp.vis && Math.hypot(tmp.x - mouse.x, tmp.y - mouse.y) < 44) S.hoverPlanet = 'sun';
  }
  brain.highlight(S.hoverPlanet && S.hoverPlanet !== 'sun' ? S.hoverPlanet : S.follow || (reel.on && S.view === 'brain' ? reel.region : null));
  S.hover = best;
  if (!best && S.hoverPlanet) {
    const k = S.hoverPlanet, r = S.regionBy[k];
    const n = S.memories.filter(m => m.region === k).length;
    tip.style.setProperty('--c', k === 'sun' ? '#cfe0ff' : r.color);
    tip.innerHTML = k === 'sun' ? `<b>心核 · ${esc(personaName())}</b><br>点一下，看或换${pronoun()}的人设卡（可以直接拖角色卡进来）`
      : k === 'portrait' ? `<b>我眼中的你</b><br>${esc(personaName())}对你的理解，随时会更新。点一下看看`
      : `<b>${esc(r.name)}</b> · ${r.kind === 'process' ? '大脑器官' : `${n} 段记忆`}<br>点一下，看看里面有什么`;
    tip.style.left = mouse.x + 'px'; tip.style.top = mouse.y + 'px';
    tip.classList.add('show'); renderer.domElement.style.cursor = 'pointer';
    return;
  }
  if (best) {
    const r = S.regionBy[best.region];
    tip.style.setProperty('--c', r.color);
    tip.innerHTML = `<b>${esc(r.name)}</b> · ${fmtDate(sortKey(best))}<br>${S.sealed || best.content == null ? '锁着的记忆' : esc(best.title || best.content.slice(0, 28))}${best.status === 'archived' ? ' · <span style="opacity:.6">已遗忘</span>' : ''}`;
    tip.style.left = mouse.x + 'px'; tip.style.top = mouse.y + 'px';
    tip.classList.add('show'); renderer.domElement.style.cursor = 'pointer';
  } else { tip.classList.remove('show'); renderer.domElement.style.cursor = ''; }
}

// ------------------------------------------------------------------ 缩放：拉近之后自动开始走马灯
const REEL_DIST = 8.5;
controls.addEventListener('start', () => {
  S.interacting = true;
  if (flight) return;
  if (reel.on) { reel.follow = false; }
  hideHint();
});
controls.addEventListener('end', () => { S.interacting = false; S.idleAt = performance.now(); });
renderer.domElement.addEventListener('wheel', () => { S.idleAt = performance.now(); hideHint(); }, { passive: true });

function autoReel(dist) {
  if (flight || S.mode === 'intro') return;
  const now = performance.now();
  // 多级缩放：钻进星核 → 脑图；在脑图里拉得很远 → 回到星环
  if (S.view === 'ring' && !reel.on && camera.position.length() < 4.2) { enterBrain(); return; }
  if (S.view === 'brain') { if (!reel.on && !S.follow && dist > brain.extent() * 3.6) exitBrain(); else if (reel.on && !reel.follow && now - S.idleAt > 2600 && !S.interacting) { reel.follow = true; reel.t = 0; } return; }
  if (reel.on && !reel.follow && dist > REEL_DIST * 1.9 && now - S.idleAt > 300) { exitReel(); return; }
  if (reel.on && !reel.follow && now - S.idleAt > 2600 && !S.interacting) {
    // 停下来不动一会儿 → 从视野中心最近的那颗星继续放映
    const near = nearestToTarget(); if (near && near.m.region === reel.region) { reel.i = reel.list.indexOf(near.m); }
    reel.follow = true; reel.t = 0; showCard(true); renderStrip(); setReelTitle();
    return;
  }
  if (reel.on || dist > REEL_DIST || S.interacting || now - S.idleAt < 900) return;
  const near = nearestToTarget();
  if (near && near.d < 4.5) startReel(near.m.region, near.m.id, { cinematic: false });
}
function nearestToTarget() {
  let best = null, bd = 1e9;
  for (const m of S.memories) { const d = posOf(m).distanceTo(controls.target); if (d < bd) { bd = d; best = m; } }
  return best ? { m: best, d: bd } : null;
}

function zoomBy(f) {
  const off = camera.position.clone().sub(controls.target);
  const len = clamp(off.length() * f, controls.minDistance, controls.maxDistance);
  flyTo(controls.target.clone().add(off.setLength(len)), controls.target.clone(), 0.7, { warp: false });
  S.idleAt = performance.now();
}
$('#zin').onclick = () => zoomBy(0.62);
$('#zout').onclick = () => zoomBy(1.6);
$('#ztrack').onclick = e => {
  const r = e.currentTarget.getBoundingClientRect(); const k = 1 - (e.clientY - r.top) / r.height;
  const len = Math.exp(lerp(Math.log(controls.maxDistance), Math.log(controls.minDistance), k));
  const off = camera.position.clone().sub(controls.target);
  flyTo(controls.target.clone().add(off.setLength(len)), controls.target.clone(), 0.9, { warp: false });
  S.idleAt = performance.now();
};
function updateZoomUI(dist) {
  const k = 1 - (Math.log(dist) - Math.log(controls.minDistance)) / (Math.log(controls.maxDistance) - Math.log(controls.minDistance));
  const pct = clamp(k, 0, 1) * 100;
  $('#ztrack .fill').style.height = pct + '%'; $('#ztrack .knob').style.top = (100 - pct) + '%';
}

$('#rot').onclick = e => { controls.autoRotate = !controls.autoRotate; e.currentTarget.classList.toggle('on', controls.autoRotate); };
$('#reset').onclick = () => { exitReel(); unfollow(); if (S.view === 'brain') flyTo(BRAIN_HOME.pos, BRAIN_HOME.target, 1.8); else flyTo(HOME.pos, HOME.target, 2.2); };
$('#brainbtn').onclick = () => { if (S.view === 'brain') exitBrain(); else enterBrain(); };   // 直接一路冲进星核，不先停在星核前再重新加速

const hintEl = $('#enter');
hintEl.textContent = matchMedia('(pointer: coarse)').matches ? '双指放大 · 靠近星光开始放映' : '滚轮拉近 · 靠近星光开始放映';
function hideHint() { if (S.memories.length) document.body.classList.add('entered'); }
// 还没有记忆时，提示去哪里让记忆长出来
function renderHint() {
  const empty = !S.memories.length;
  hintEl.classList.toggle('empty', empty);
  hintEl.innerHTML = empty ? `还没有记忆 · 去和${esc(personaName())}聊天，${pronoun()}记住的事会出现在这里　<u>怎么接入 →</u>`
    : (matchMedia('(pointer: coarse)').matches ? '双指放大 · 靠近星光开始放映' : '滚轮拉近 · 靠近星光开始放映');
  if (empty) document.body.classList.remove('entered');
}
hintEl.onclick = () => { if (!S.memories.length) { $('#connect').click(); return; } hideHint(); const keys = Object.keys(S.arcs); if (keys.length) openRegion(keys[0]); };

// ------------------------------------------------------------------ 事件：写入 / 回想 / 遗忘 的动画
const feed = $('#feed');
function toast(html, color, onClick) {
  const el = document.createElement('div'); el.className = 'ev'; el.style.setProperty('--c', color || '#bcd6ff'); el.innerHTML = html;
  if (onClick) { el.style.pointerEvents = 'auto'; el.style.cursor = 'pointer'; el.onclick = () => { el.remove(); onClick(); }; }
  feed.prepend(el);
  while (feed.children.length > 5) feed.lastChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 1300); }, 6500);
}

function comet(from, to, color, { delay = 0, lift = 3, dur = 1.6, trail = true, onArrive } = {}) {
  const ctrl = from.clone().lerp(to, 0.5).add(new THREE.Vector3(0, lift, 0));
  const c = new THREE.Color(color);
  const bez = (u, out) => out.set(0, 0, 0).addScaledVector(from, (1 - u) ** 2).addScaledVector(ctrl, 2 * u * (1 - u)).addScaledVector(to, u * u);
  fx.spawn({
    p: from.clone(), c: c.clone().lerp(new THREE.Color(1, 1, 1), 0.4), size: 3.2, max: dur + delay, a: 1, fade: 0, life: -0, delay,
    upd(q, dt) {
      const u = clamp((q.life - delay) / dur, 0, 1); const e = ease(u); bez(e, q.p); q.a = u > 0 ? 1 : 0;
      if (trail && u > 0 && u < 1) for (let i = 0; i < 3; i++) fx.spawn({ p: q.p.clone(), v: new THREE.Vector3((Math.random() - .5) * .3, (Math.random() - .5) * .3, (Math.random() - .5) * .3), c, size: 1.1 + Math.random(), max: 0.8 + Math.random() * 0.6, drag: 0.92 });
      if (u >= 1 && !q.arrived) { q.arrived = true; q.life = q.max; onArrive && onArrive(); }
    },
  });
}
function burst(p, color, n = 40, speed = 2) {
  const c = new THREE.Color(color);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU, b = Math.acos(2 * Math.random() - 1), s = speed * (0.4 + Math.random());
    fx.spawn({ p: p.clone(), v: new THREE.Vector3(Math.sin(b) * Math.cos(a), Math.cos(b), Math.sin(b) * Math.sin(a)).multiplyScalar(s), c: c.clone().lerp(new THREE.Color(1, 1, 1), Math.random() * 0.5), size: 1 + Math.random() * 1.4, max: 1 + Math.random() * 1.2, drag: 0.94 });
  }
}
let corePulse = 0;

const organ = k => S.view === 'brain' ? brain.hub(k) : ORGAN_POS[k];
function playEvent(ev) {
  const reg = S.regionBy;
  const mems = ev.memory_ids.map(id => S.byId.get(id)).filter(Boolean);
  if (ev.kind === 'remember') {
    const m = mems[0]; if (!m) return;
    const r = reg[m.region];
    m.appear = 0;
    comet(organ('input'), organ('hippocampus'), reg.input.color, { dur: 1.0, lift: 1.5,
      onArrive: () => { burst(organ('hippocampus'), reg.hippocampus.color, 30, 1.4);
        comet(organ('hippocampus'), tgtOf(m), r.color, { dur: 1.8, lift: 4, onArrive: () => { m.appear = 0.01; burst(tgtOf(m), r.color, 50, 1.8); } }); } });
    toast(`<b>海马体·写入</b>一段新的记忆进入「${esc(r.name)}」`, reg.hippocampus.color);
  } else if (ev.kind === 'recall') {
    corePulse = 1;
    const direct = new Set(ev.direct || ev.memory_ids);
    const heads = mems.filter(m => direct.has(m.id)), rest = mems.filter(m => !direct.has(m.id));
    // 先从检索中枢射向直接想起的记忆，再顺着关联线一串串点亮
    heads.forEach((m, i) => comet(organ('retrieval'), tgtOf(m), reg.retrieval.color, { dur: 1.3 + i * 0.12, lift: 2.5, onArrive: () => {
      m.flash = 1; burst(tgtOf(m), m.color.getStyle(), 24, 1.2);
      const near = rest.filter(x => (S.adj.get(m.id) || []).some(([b]) => b === x.id));
      near.forEach((x, j) => comet(tgtOf(m), tgtOf(x), m.color.getStyle(), { dur: 0.9 + j * 0.1, lift: 1, trail: false, onArrive: () => { x.flash = 0.8; } }));
    } }));
    rest.forEach(x => setTimeout(() => { x.flash = Math.max(x.flash || 0, 0.6); }, 2600));
    const q = ev.query && !S.sealed ? `「${esc(ev.query)}」` : '';
    toast(`<b>大脑中枢·检索</b>${q}想起了 ${heads.length} 段${rest.length ? `，顺着关联又想起 ${rest.length} 段` : ''}`, reg.retrieval.color);
  } else if (ev.kind === 'revive') {
    mems.forEach(m => { m.flash = 1.5; burst(tgtOf(m), '#f3d9a4', 60, 2.2); });
    toast(`<b>召回</b>${mems.length} 段遗忘的记忆被重新想起`, '#f3d9a4');
  } else if (ev.kind === 'archive') {
    mems.forEach(m => {
      for (let i = 0; i < 14; i++) fx.spawn({ p: tgtOf(m).clone(), v: new THREE.Vector3((Math.random() - .5) * .4, -0.3 - Math.random() * .5, (Math.random() - .5) * .4), c: new THREE.Color(0.6, 0.62, 0.75), size: 0.9, max: 2.4, drag: 0.99 });
    });
    burst(organ('metabolism'), reg.metabolism.color, 30, 1.2);
    toast(`<b>代谢·治理</b>${mems.length} 段记忆按遗忘曲线淡去（仍可召回）`, reg.metabolism.color);
  } else if (ev.kind === 'supersede') {
    mems.forEach(m => { m.flash = 0.6; });
    toast(`<b>海马体</b>${mems.length} 段旧记忆被新的取代了`, reg.hippocampus.color);
  } else if (ev.kind === 'consolidate') {
    mems.forEach(m => { burst(tgtOf(m), m.color.getStyle(), 10, 0.8); });
    toast(`<b>睡眠整理</b>把 ${mems.length} 段零碎的记忆合并成了一段`, '#c9a7ff');
  } else if (ev.kind === 'key-backup') {
    toast('<b>钥匙</b>已经拆成碎片备份，请把每一片放在不同的地方', '#f3d9a4');
  } else if (ev.kind === 'persona') {
    corePulse = 0.8;
    toast(`<b>性格养成</b>${(ev.changed || (ev.traits || []).length) ? 'TA 的性格因为经历有了一点点变化' : '性格基线被调整了'}`, '#c9a7ff');
  } else if (ev.kind === 'genesis') {
    burst(new THREE.Vector3(), '#f3d9a4', 140, 4); corePulse = 1.5;
    toast('<b>钥匙诞生</b>唯一的超级管理员钥匙已经放到了你的桌面，请备份好', '#f3d9a4');
  } else if (ev.kind === 'wake') {
    corePulse = 1.3; burst(new THREE.Vector3(), '#cfe0ff', 80, 3);
    toast(`<b>醒来</b>${esc(ev.agent || 'AI')} 睁开眼睛，看了看自己的记忆`, '#cfe0ff');
  } else if (ev.kind === 'update' || ev.kind === 'delete' || ev.kind === 'export') {
    toast(`<b>超级管理员</b>${{ update: '修改了一段记忆', delete: '删除了一段记忆', export: '导出了记忆文件' }[ev.kind]}`, '#f3d9a4');
  }
}

async function pollEvents() {
  while (true) {
    try {
      const { events } = await api(`api/events?after=${S.lastEvent}&wait=20`);
      if (events.length) {
        S.lastEvent = events[events.length - 1].id;
        await loadBrain();
        if (S.mode !== 'intro') events.forEach((e, i) => setTimeout(() => playEvent(e), i * 450));
      }
    } catch (e) { await new Promise(r => setTimeout(r, 3000)); }
  }
}

// ------------------------------------------------------------------ 搜索（需要超级管理员）
const qEl = $('#q'), resEl = $('#results');
let qTimer;
qEl.addEventListener('input', () => {
  clearTimeout(qTimer);
  qTimer = setTimeout(async () => {
    const q = qEl.value.trim(); if (!q) { resEl.classList.remove('show'); return; }
    try {
      const { memories } = await api('api/search?q=' + encodeURIComponent(q));
      resEl.innerHTML = memories.length ? memories.map(m => {
        const r = S.regionBy[m.region];
        return `<button data-id="${m.id}" style="--c:${r.color}"><small><span class="r-dot"></span>${esc(r.name)} · ${fmtDate(sortKey(m))}</small>${esc(m.title ? m.title + '：' : '')}${esc(m.content.slice(0, 50))}</button>`;
      }).join('') : '<button disabled>什么也没想起来……</button>';
      resEl.classList.add('show');
      memories.forEach((m, i) => { const mm = S.byId.get(m.id); if (mm) comet(organ('retrieval'), tgtOf(mm), S.regionBy.retrieval.color, { dur: 1.2 + i * 0.12, lift: 2.5, onArrive: () => { mm.flash = 1; } }); });
      corePulse = 0.8;
      resEl.querySelectorAll('[data-id]').forEach(b => b.onclick = () => { const m = S.byId.get(b.dataset.id); resEl.classList.remove('show'); if (m) startChain(m); });
    } catch (e) {
      resEl.innerHTML = e.status === 423 ? '<button data-key>🔒 钥匙不在，搜不到内容。点这里找回钥匙</button>' : `<button disabled>${esc(e.message)}</button>`;
      resEl.classList.add('show'); const k = resEl.querySelector('[data-key]'); if (k) k.onclick = () => { resEl.classList.remove('show'); openKey(); };
    }
  }, 280);
});
document.addEventListener('pointerdown', e => { if (!$('#search').contains(e.target)) resEl.classList.remove('show'); });

// ------------------------------------------------------------------ 超级管理员钥匙（私钥在登记的位置 = 解锁）
const keyModal = $('#keymodal');
function renderKey() {
  const k = S.key, kb = $('#keybtn');
  kb.classList.toggle('ok', !!k.unlocked); kb.classList.toggle('missing', !!(k.initialized && !k.unlocked));
  kb.querySelector('b').textContent = !k.initialized ? '钥匙' : k.unlocked ? '钥匙' : '钥匙不在';
  kb.title = !k.initialized ? '还没有钥匙：点这里生成' : k.unlocked ? '超级管理员钥匙：在' : '超级管理员钥匙：不在';
  // 钥匙不在：顶上一条说清楚发生了什么、怎么办
  const bar = $('#lockbar');
  if (k.initialized && !k.unlocked) {
    bar.innerHTML = `<span>🔒 <b>记忆被锁住了</b>：找不到钥匙文件${k.key_path ? `（原来在 <code>${esc(k.key_path)}</code>）` : ''}，可能被删除或挪走了。记忆都还在，钥匙回来就能打开。</span>
      <span class="acts"><button data-a="retry">我放回去了，再试一次</button><button data-a="path">它在别的位置</button><button data-a="shares">用碎片恢复</button></span>`;
    bar.querySelector('[data-a=retry]').onclick = async () => { await loadBrain(); if (!S.key.unlocked) toast('<b>钥匙</b>还是没找到，确认一下文件放回原来的位置了吗？', '#ff8fa6'); else toast('<b>钥匙</b>找到啦，记忆已解锁', '#7ee08a'); };
    bar.querySelector('[data-a=path]').onclick = () => { openKey(); $('#km-path').focus(); $('#km-path').select(); };
    bar.querySelector('[data-a=shares]').onclick = () => { openKey(); setTimeout(() => $('#km-restore').click(), 150); };
    bar.classList.add('show');
  } else bar.classList.remove('show');
  requestAnimationFrame(placeLegend);
}
function openKey() {
  const k = S.key;
  $('#km-sub').textContent = k.initialized
    ? '这把私钥和这份记忆一一对应。每次访问记忆，都会去下面的路径看一眼钥匙还在不在：在就自动解锁，不在谁都打不开。'
    : '还没有钥匙。点下面的「生成钥匙」一步搞定；如果你有以前导出的记忆文件，可以填上那把钥匙的路径后导入。';
  $('#km-state').innerHTML = !k.initialized ? '<span class="no">●</span><div><b>还没有钥匙</b><small>点这里一步一步生成：<button class="chip on" id="km-make" style="margin-left:6px">生成钥匙</button></small></div>'
    : `<span class="${k.unlocked ? 'ok' : 'no'}">●</span><div><b>${k.unlocked ? '钥匙在，记忆已解锁' : '找不到钥匙，记忆被锁着'}</b><small>指纹 ${esc(k.fingerprint || '')}</small></div>`;
  $('#km-path').value = k.key_path || ''; $('#km-path').placeholder = k.initialized ? '私钥文件的路径' : '导入记忆时：填上那把钥匙的路径';
  $('#km-export').disabled = !k.unlocked; $('#km-export').style.opacity = k.unlocked ? 1 : 0.4;
  $('#km-err').textContent = '';
  const mk = $('#km-make'); if (mk) mk.onclick = () => { keyModal.classList.remove('show'); try { sessionStorage.removeItem('fmn-welcome-later'); } catch { } showWelcome(); };
  keyModal.classList.add('show');
}
$('#keybtn').onclick = openKey;
$('#km-cancel').onclick = () => keyModal.classList.remove('show');
$('#km-path').addEventListener('keydown', e => { if (e.key === 'Enter') $('#km-ok').click(); });
$('#km-ok').onclick = async () => {
  try {
    S.key = await api('api/key', { method: 'POST', body: { path: $('#km-path').value } });
    await loadBrain(); openKey();
    if (S.key.unlocked) { corePulse = 1.4; burst(new THREE.Vector3(), '#f3d9a4', 120, 4); toast('<b>解锁</b>找到了超级管理员钥匙', '#f3d9a4'); if (reel.on) showCard(true); }
  } catch (e) { $('#km-err').textContent = e.message; }
};
$('#km-export').onclick = () => { if (S.key.unlocked) location.href = 'api/export'; };
// 导入记忆文件（.fmn）：只有导出它时用的那把钥匙才能导进来
async function importMemories(file) {
  try {
    const bundle = JSON.parse(await file.text());
    const r = await api('api/import', { method: 'POST', body: { bundle, key_path: $('#km-path').value.trim() || undefined } });
    await loadBrain(); if (keyModal.classList.contains('show')) openKey();
    corePulse = 1.4; burst(new THREE.Vector3(), '#f3d9a4', 120, 4);
    toast(`<b>导入</b>放回了 ${r.added} 段记忆`, '#f3d9a4');
  } catch (e) {
    const msg = e.status === 403 ? '要用导出这份记忆时的那把钥匙：先在下面填上它的路径' : e.message;
    if (keyModal.classList.contains('show')) $('#km-err').textContent = msg; else { openKey(); $('#km-err').textContent = msg; }
  }
}
$('#km-import').onchange = e => e.target.files[0] && importMemories(e.target.files[0]);

// 钥匙备份：拆成 3 片，任意 2 片拼回来。打开一张可以打印的页面（每片一个二维码），也可以存成文本
function loadQR() {
  return window.qrcode ? Promise.resolve(window.qrcode) : new Promise((ok, no) => { const sc = document.createElement('script'); sc.src = 'static/vendor/qrcode.js'; sc.onload = () => ok(window.qrcode); sc.onerror = no; document.head.appendChild(sc); });
}
$('#km-backup').onclick = async () => {
  if (!S.key.unlocked) { $('#km-err').textContent = '钥匙要在，才能拆成碎片备份'; return; }
  try {
    const { shares } = await api('api/key/backup', { method: 'POST', body: { parts: 3, need: 2 } });
    const qrcode = await loadQR();
    const card = (t, i) => {
      const line = t.split('\n').find(l => l.startsWith('FMN-SHARE-1:'));
      const q = qrcode(0, 'M'); q.addData(line); q.make();
      const href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(t);
      return `<section><h2>钥匙碎片 ${i + 1} / ${shares.length}</h2>${q.createSvgTag({ cellSize: 3, margin: 2, scalable: true })}
        <pre>${esc(t.replace(line, ''))}</pre><code>${esc(line)}</code><a download="勿忘我-钥匙碎片-${i + 1}.txt" href="${href}">存成文本</a></section>`;
    };
    const html = `<!doctype html><meta charset="utf-8"><title>勿忘我 · 钥匙碎片</title><style>
      body{font-family:"Noto Serif SC",serif;margin:24px;color:#111} h1{font-weight:400;letter-spacing:.2em} section{page-break-inside:avoid;border:1px dashed #999;border-radius:12px;padding:18px;margin:16px 0;display:grid;grid-template-columns:200px 1fr;gap:18px}
      section h2{grid-column:1/-1;margin:0;font-weight:400;letter-spacing:.2em} svg{width:200px;height:200px} pre{white-space:pre-wrap;margin:0;font:13px/1.8 inherit} code{grid-column:1/-1;font-size:10px;word-break:break-all;color:#555} a{grid-column:1/-1}
      @media print{a,.tip{display:none}}</style>
      <h1>勿忘我 · 超级管理员钥匙碎片</h1><p class="tip">打印出来，或者把每片存成文本，分别放在不同的地方。任意 2 片就能在记忆星环里「用碎片恢复」钥匙。</p>${shares.map(card).join('')}`;
    open(URL.createObjectURL(new Blob([html], { type: 'text/html' })), '_blank');
    toast('<b>钥匙</b>碎片已经生成，打印或存好后请分开保管', '#f3d9a4');
  } catch (e) { $('#km-err').textContent = e.message; }
};
$('#km-restore').onchange = async e => {
  try {
    const texts = await Promise.all([...e.target.files].map(f => f.text()));
    S.key = await api('api/key/restore', { method: 'POST', body: { shares: texts } });
    await loadBrain(); openKey(); corePulse = 1.4; burst(new THREE.Vector3(), '#f3d9a4', 120, 4);
    toast('<b>钥匙</b>用碎片拼回来了，已经放到桌面', '#f3d9a4');
  } catch (err) { $('#km-err').textContent = err.message; }
  e.target.value = '';
};
$('#km-sleep').onclick = async () => {
  try {
    const { merged } = await api('api/consolidate', { method: 'POST', body: {} });
    await loadBrain();
    toast(merged.length ? `<b>睡眠整理</b>整理了 ${merged.length} 团零碎的记忆` : '<b>睡眠整理</b>没有需要整理的零碎记忆', '#c9a7ff');
  } catch (err) { $('#km-err').textContent = err.status === 423 ? '钥匙要在，才能整理记忆' : err.message; }
};

// ------------------------------------------------------------------ 角色：一个角色一个大脑
const rootBase = location.pathname.replace(/c\/c_[a-z0-9]+\/?$/, '').replace(/[^/]*$/, '');
async function loadCharacters() {
  try {
    const { current, list } = await api('api/characters');
    const cur = list.find(c => c.id === current) || list[0];
    const cn = cur && !(cur.id === 'main' && cur.name === '默认') ? cur.name : null;
    if (cn !== S.charName) { S.charName = cn; renderTitle(); renderLegend(); buildLabels(); }
    $('#charname').textContent = cur?.id === 'main' && personaName() !== 'TA' ? personaName() : (cur?.name || '默认');
    $('#charmenu').innerHTML = list.map(c => `<button data-c="${c.id}" class="${c.id === current ? 'cur' : ''}">${esc(c.id === 'main' && c.name === '默认' && c.id === current && personaName() !== 'TA' ? personaName() : c.name)}</button>`).join('') +
      `<div class="new"><input id="charnew" placeholder="新角色的名字" maxlength="40"><button id="charadd" style="width:auto">新建</button></div>`;
    $('#charmenu').querySelectorAll('[data-c]').forEach(b => b.onclick = () => { if (b.dataset.c !== current) location.href = rootBase + (b.dataset.c === 'main' ? '' : `c/${b.dataset.c}/`) + location.search; });
    const add = async () => {
      const name = $('#charnew').value.trim(); if (!name) return;
      try { const c = await api('api/characters', { method: 'POST', body: { name } }); location.href = rootBase + `c/${c.id}/` + location.search; } catch (e) { toast(`<b>角色</b>${esc(e.message)}`, '#ff8fa6'); }
    };
    $('#charadd').onclick = add; $('#charnew').onkeydown = e => { if (e.key === 'Enter') add(); };
  } catch { }
}
$('#charbtn').onclick = e => { e.stopPropagation(); $('#charmenu').classList.toggle('show'); };
document.addEventListener('pointerdown', e => { if (!e.target.closest('.chars')) $('#charmenu').classList.remove('show'); });

// ------------------------------------------------------------------ 回忆时间线：一年的热力图、那年今天、按月份翻看
const tlModal = $('#timelinemodal');
function openTimeline() {
  const nm = personaName(), day = 86400, now = Date.now() / 1000;
  const dateOf = m => new Date(sortKey(m) * 1000);
  const key = d => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const byDay = new Map();
  for (const m of S.memories) { const k = key(dateOf(m)); (byDay.get(k) || byDay.set(k, []).get(k)).push(m); }
  // 热力图：最近 53 周，每列一周
  const start = new Date((now - 52 * 7 * day) * 1000); start.setDate(start.getDate() - start.getDay());
  let cells = '', months = [];
  for (let w = 0; w < 53; w++) for (let d = 0; d < 7; d++) {
    const t = new Date(start.getTime() + (w * 7 + d) * day * 1000);
    if (d === 0 && t.getDate() <= 7) months.push(`${t.getMonth() + 1}月`);
    const n = (byDay.get(key(t)) || []).length, lv = n ? Math.min(4, Math.ceil(n / 1.5)) : 0;
    cells += `<i class="${lv ? 'l' + lv : ''}" ${n ? `data-n="${n}" data-k="${key(t)}"` : ''} title="${t.getMonth() + 1}月${t.getDate()}日 · ${n} 段记忆"></i>`;
  }
  const label = m => S.sealed || m.content == null ? '锁着的记忆' : esc(m.title || m.content.slice(0, 40));
  const status = m => m.superseded_by ? '已被取代' : m.merged_into ? '已整理' : m.status === 'archived' ? '已遗忘' : '';
  const row = m => `<div class="row-m ${m.status === 'archived' ? 'faded' : ''}" data-id="${m.id}"><time>${fmtDate(sortKey(m))}</time><span class="d" style="--c:${m.color.getStyle()}"></span><span>${label(m)}</span><span class="st">${status(m)}</span></div>`;
  // 那年今天：往年同一天前后两天
  const today = new Date(), otd = S.memories.filter(m => { const d = dateOf(m); return d.getFullYear() < today.getFullYear() && Math.abs((new Date(today.getFullYear(), d.getMonth(), d.getDate()) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 864e5) <= 2; });
  // 按月份
  const groups = new Map();
  for (const m of [...S.memories].sort((a, b) => sortKey(b) - sortKey(a))) { const d = dateOf(m), k = `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`; (groups.get(k) || groups.set(k, []).get(k)).push(m); }
  $('#tl-title').textContent = `${nm}的时间线`;
  $('#tl-sub').textContent = `一年里每一天留下了多少记忆（越亮越多）。点格子或下面的记忆，就会飞过去放映。${S.sealed ? '钥匙不在，只能看到日期。' : ''}`;
  $('#tl-body').innerHTML = `<div class="heat">${cells}</div><div class="months">${months.slice(0, 13).map(x => `<span>${x}</span>`).join('')}</div>
    <h6>那年今天</h6><div class="onthisday">${otd.length ? otd.map(row).join('') : '<div class="empty">往年的今天还没有记忆。</div>'}</div>
    ${[...groups].map(([k, list]) => `<h6>${k} · ${list.length} 段</h6>${list.map(row).join('')}`).join('')}`;
  $('#tl-body').querySelectorAll('[data-id]').forEach(r => r.onclick = () => goMemory(S.byId.get(r.dataset.id)));
  $('#tl-body').querySelectorAll('.heat [data-k]').forEach(c => c.onclick = () => { const m = byDay.get(c.dataset.k)[0]; if (m) goMemory(m); });
  tlModal.classList.add('show');
}
function goMemory(m) {
  if (!m) return; tlModal.classList.remove('show');
  if (S.view === 'brain') startChain(m); else startReel(m.region, m.id);
}
$('#tlbtn').onclick = openTimeline;
$('#tl-close').onclick = () => tlModal.classList.remove('show');
addEventListener('drop', e => { const f = [...(e.dataTransfer?.files || [])].find(x => /\.fmn$/i.test(x.name)); if (f) { e.preventDefault(); importMemories(f); } });
// 钥匙随时可能被拿走或放回：定时看一眼
setInterval(async () => {
  try {
    const k = await api('api/key');
    if (k.unlocked !== S.key.unlocked || k.key_path !== S.key.key_path) { await loadBrain(); if (reel.on) showCard(true); if (keyModal.classList.contains('show')) openKey(); }
  } catch { }
}, 3000);

const editModal = $('#editmodal'); let editing = null;
async function cardAction(act, m) {
  if (act === 'key') return openKey();
  if (act === 'edit') { editing = m; $('#ed-text').value = m.content; $('#ed-err').textContent = ''; editModal.classList.add('show'); return; }
  try {
    if (act === 'archive') await api(`api/admin/memories/${m.id}`, { method: 'POST', body: { status: m.status === 'archived' ? 'active' : 'archived' } });
    if (act === 'delete') {
      if (!confirm('彻底删除后再也找不回来了，确定吗？')) return;
      await api(`api/admin/memories/${m.id}/delete`, { method: 'POST', body: {} });
    }
    await loadBrain(); if (reel.on) { if (!reel.list.length) exitReel(); else showCard(true); }
  } catch (e) { if (e.status === 423) openKey(); else toast(`<b>失败</b>${esc(e.message)}`, '#ff8fa6'); }
}
$('#ed-cancel').onclick = () => editModal.classList.remove('show');
$('#ed-ok').onclick = async () => {
  try {
    await api(`api/admin/memories/${editing.id}`, { method: 'POST', body: { content: $('#ed-text').value } });
    editModal.classList.remove('show'); await loadBrain(); if (reel.on) showCard(true);
  } catch (e) { $('#ed-err').textContent = e.message; }
};

// 接入说明
$('#connect').onclick = async () => {
  let info = {};
  try { info = await api('api/connect'); } catch { }
  const mcpJson = JSON.stringify({ mcpServers: { 'forget-me-not': info.mcp_stdio || { command: 'npx', args: ['-y', 'dsh-forget-me-not', 'mcp'] } } }, null, 2);
  const vals = [];
  const row = (t, v, more = '') => { if (!v) return ''; vals.push(v); return `<div class="conn-row"><p class="sub">${t}</p>${more}<pre>${esc(v)}</pre><button class="chip copy" data-i="${vals.length - 1}">复制</button></div>`; };
  $('#conn-body').innerHTML =
    row('① DeepSeek Harness（最简单）', 'dsh-forget-me-not', '<p class="hint">桌面版：设置 → 插件 → 输入这个名字安装；命令行：<code>dsh plugin --profile web add dsh-forget-me-not</code>。装好后正常聊天，TA 会自己记。</p>') +
    row('② Claude Desktop / Cursor / Cherry Studio / LangBot 等支持 MCP 的软件', mcpJson, '<p class="hint">把下面这段粘进软件的 MCP 设置里。</p>') +
    row('③ 远程 MCP（streamable HTTP）', info.mcp_http) +
    row('④ 任何能调函数的模型（OpenAI / Gemini / GPTs / Dify / Coze）', info.openapi) +
    row('给模型的使用说明（可放进 system prompt）', info.protocol);
  $('#conn-body').querySelectorAll('.copy').forEach(b => b.onclick = () => navigator.clipboard?.writeText(vals[+b.dataset.i]).then(() => { b.textContent = '已复制 ✓'; setTimeout(() => b.textContent = '复制', 1500); }, () => { }));
  $('#connmodal').classList.add('show');
};
$('#conn-ok').onclick = () => $('#connmodal').classList.remove('show');

// ------------------------------------------------------------------ 器官（过程脑区）的小星团
function buildOrgans() {
  const g = new THREE.BufferGeometry(); const pts = [], cols = [], sizes = [], phs = [];
  for (const r of S.regions.filter(r => r.kind === 'process')) {
    const c = new THREE.Color(r.color), o = ORGAN_POS[r.key];
    for (let i = 0; i < 46; i++) {
      const a = Math.random() * TAU, b = Math.acos(2 * Math.random() - 1), d = Math.random() ** 2 * 0.7;
      pts.push(o.x + d * Math.sin(b) * Math.cos(a), o.y + d * Math.cos(b), o.z + d * Math.sin(b) * Math.sin(a));
      cols.push(c.r, c.g, c.b); sizes.push(i === 0 ? 4 : 0.6 + Math.random() * 1.4); phs.push(Math.random());
    }
    // 连向星核的神经丝
    for (let i = 0; i < 40; i++) {
      const k = i / 40; const p = o.clone().multiplyScalar(1 - k);
      pts.push(p.x + (Math.random() - .5) * .08, p.y + (Math.random() - .5) * .08, p.z + (Math.random() - .5) * .08);
      cols.push(c.r * .6, c.g * .6, c.b * .6); sizes.push(0.45); phs.push(Math.random());
    }
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  g.setAttribute('aColor', new THREE.Float32BufferAttribute(cols, 3));
  g.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1));
  g.setAttribute('aAlpha', new THREE.Float32BufferAttribute(phs.map(() => 0.9), 1));
  const p = new THREE.Points(g, fx.points.material);
  scene.add(p); return p;
}

// ------------------------------------------------------------------ 开场过场：莫比乌斯星环成形
let introT = 0; const INTRO = 7.2;
const introEl = $('#intro');
function finishIntro() {
  if (S.mode !== 'intro') return;
  introT = INTRO; endIntro();
}
function endIntro() {
  S.mode = 'explore';
  $('#whiteout').style.opacity = '0';   // 跳过开场时，白光可能正停在半亮的那一帧，不清掉会一直留一层灰雾
  introEl.classList.remove('on'); introEl.classList.add('off');
  document.body.classList.remove('intro');
  dust.material.uniforms.uReveal.value = 1; stars.material.uniforms.uReveal.value = 1;
  if (!flight) flyTo(HOME.pos, HOME.target, 1.6, { warp: false });
  controls.autoRotate = true;
  S.idleAt = performance.now();
  setTimeout(() => introEl.remove(), 2000);
  setTimeout(showWelcome, 1800);
  setTimeout(showOnThisDay, 3200);
}
// 那年今天：打开的时候，往年的今天有回忆，就轻轻提一句（点一下飞过去放映）
function showOnThisDay() {
  if (S.sealed || !S.memories.length) return;
  const today = new Date();
  const hits = S.memories.filter(m => { const d = new Date(sortKey(m) * 1000); return d.getFullYear() < today.getFullYear() && d.getMonth() === today.getMonth() && Math.abs(d.getDate() - today.getDate()) <= 1 && m.content; });
  if (!hits.length) return;
  const m = hits.sort((a, b) => b.importance - a.importance)[0], y = today.getFullYear() - new Date(sortKey(m) * 1000).getFullYear();
  toast(`<b>那年今天</b>${y} 年前的这几天：${esc(m.title || m.content.slice(0, 26))}　<u>去看看 →</u>`, S.regionBy[m.region]?.color, () => goMemory(m));
}
// ------------------------------------------------------------------ 第一次来：一步一步带着生成钥匙
const wm = $('#welcomemodal');
function showWelcome() {
  if (S.key.initialized || EMBED_SKIP_WELCOME()) return;
  const nm = personaName();
  $('#wm-body').innerHTML = `
    <h4>欢迎来到勿忘我 🌸</h4>
    <p class="sub">在开始之前，先给${esc(nm)}的记忆配一把钥匙。</p>
    <div class="wm-steps">
      <div><i>1</i><p><b>钥匙是什么？</b>就是你电脑上的一个小文件。${esc(nm)}记住的每一件事都会被锁起来，<b>只有这把钥匙能打开</b>。</p></div>
      <div><i>2</i><p><b>放在哪？</b>点下面的按钮，它会出现在你的<b>桌面</b>上，名字叫「勿忘我-超级管理员钥匙.key」。</p></div>
      <div><i>3</i><p><b>要做什么？</b>把它<b>复制一份</b>到 U 盘或网盘。钥匙只有一把，<b>丢了谁都打不开</b>，包括我自己。</p></div>
    </div>
    <p class="wm-note">不想现在弄也没关系：${esc(nm)}第一次记住一件事的时候，会自动生成钥匙并提醒你。</p>
    <div class="err" id="wm-err"></div>
    <div class="row"><button class="chip" id="wm-later">以后再说</button><button class="chip" id="wm-have">我已经有钥匙了</button><span style="flex:1"></span><button class="chip on" id="wm-make">生成我的钥匙</button></div>`;
  $('#wm-later').onclick = () => { wm.classList.remove('show'); try { sessionStorage.setItem('fmn-welcome-later', '1'); } catch { } };
  $('#wm-have').onclick = () => { wm.classList.remove('show'); openKey(); };
  $('#wm-make').onclick = async () => {
    try {
      const k = await api('api/key/create', { method: 'POST', body: {} });
      S.key = k; await loadBrain();
      $('#wm-body').innerHTML = `
        <h4>钥匙做好啦 🔑</h4>
        <p class="sub">它在这里（一般就是你的桌面）：</p>
        <div class="wm-path">${esc(k.key_path)}</div>
        <div class="wm-steps">
          <div><i>✓</i><p><b>现在请做一件事：</b>把这个文件复制到 U 盘、网盘，或者发给自己的邮箱存着。</p></div>
          <div><i>✓</i><p><b>不要改名字、不要挪位置</b>（想挪的话，挪完点右下角的小钥匙，把新位置填进去）。</p></div>
          <div><i>✓</i><p><b>更保险：</b>点「拆成 3 片备份」，任意 2 片就能拼回钥匙，可以分别放在不同的地方。</p></div>
        </div>
        <div class="row"><button class="chip" id="wm-copy">复制路径</button><button class="chip" id="wm-backup">拆成 3 片备份</button><span style="flex:1"></span><button class="chip on" id="wm-done">我存好了</button></div>`;
      $('#wm-done').onclick = () => wm.classList.remove('show');
      $('#wm-copy').onclick = () => navigator.clipboard?.writeText(k.key_path).then(() => toast('<b>钥匙</b>路径已复制', '#cfe0ff'), () => { });
      $('#wm-backup').onclick = () => { wm.classList.remove('show'); openKey(); setTimeout(() => $('#km-backup').click(), 200); };
    } catch (e) { $('#wm-err').textContent = e.message; }
  };
  wm.classList.add('show');
}
function EMBED_SKIP_WELCOME() { try { return sessionStorage.getItem('fmn-welcome-later') === '1'; } catch { return false; } }

$('#skip').onclick = finishIntro;
document.querySelector('#intro .t')?.addEventListener('click', finishIntro);
renderer.domElement.addEventListener('dblclick', finishIntro);

function stepIntro(dt) {
  introT += dt;
  const t = introT;
  const ignite = smooth(0.2, 1.4, t);
  core.set(ignite * (1 + 0.5 * Math.exp(-((t - 1.1) ** 2) * 8)), t, 0.18 + 0.82 * smooth(1.6, 5.5, t));
  $('#whiteout').style.opacity = (Math.exp(-((t - 1.15) ** 2) * 30) * 0.28).toFixed(3);
  const rev = ease(clamp((t - 1.0) / 3.6, 0, 1));
  dust.material.uniforms.uReveal.value = rev; stars.material.uniforms.uReveal.value = rev;
  sky.mat.uniforms.uFade.value = smooth(0.5, 3.5, t);
  // 镜头：从星核前方缓缓后退、升起、绕行
  const k = ease(clamp((t - 0.6) / 5.6, 0, 1));
  const az = lerp(-0.6, Math.atan2(HOME.pos.x, HOME.pos.z), k), r = lerp(9, HOME.pos.length(), k), el = lerp(0.12, Math.asin(HOME.pos.y / HOME.pos.length()), k);
  camera.position.set(r * Math.cos(el) * Math.sin(az), r * Math.sin(el), r * Math.cos(el) * Math.cos(az));
  controls.target.lerpVectors(new THREE.Vector3(), HOME.target, k);
  camera.lookAt(controls.target);
  bloom.strength = 0.9 + 0.5 * Math.exp(-((t - 1.2) ** 2) * 4);
  if (t > 2.6 && !introEl.classList.contains('on') && !introEl.classList.contains('off')) introEl.classList.add('on');
  if (t > 5.8 && introEl.classList.contains('on')) { introEl.classList.remove('on'); introEl.classList.add('off'); }
  if (t >= INTRO) endIntro();
}

// ------------------------------------------------------------------ 主循环
const clock = new THREE.Clock();
let organs = null, time = 0;
function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.1); time += dt;

  if (S.mode === 'intro') stepIntro(dt);
  else {
    corePulse = Math.max(0, corePulse - dt * 0.8);
    const camCore = camera.position.length();
    core.set(1 + 0.08 * Math.sin(time * 1.6) + corePulse * 0.6, time, (reel.on ? 0.35 : 1) * smooth(2.5, 16, camCore) * 0.85 + 0.15);
  }
  stepFlight(dt);

  const dist = camera.position.distanceTo(controls.target);
  // 走马灯：镜头沿星环滑行，逐个放映
  if (reel.on && reel.follow && !flight) {
    const m = reel.list[reel.i];
    if (m) {
      const k = 1 - Math.exp(-dt * 1.6);
      camera.position.lerp(camFor(m), k); controls.target.lerp(tgtOf(m), k);
      if (reel.playing) { reel.t += dt; if (reel.t >= reel.dur) reelGo(1); }
      $('#prog').style.width = (clamp(reel.t / reel.dur, 0, 1) * 100).toFixed(1) + '%';
    }
  }
  if (S.follow && S.followOff && !flight && !reel.on && S.view === 'brain') {
    // 镜头跟着行星一起公转（保持相对位置，用户拖动时更新相对位置）
    const h = brain.hub(S.follow), k = 1 - Math.exp(-dt * 3);
    if (S.interacting) S.followOff.copy(camera.position).sub(controls.target);
    controls.target.lerp(h, k); camera.position.lerp(h.clone().add(S.followOff), k);
  }
  if (!flight && S.mode !== 'intro') { controls.enabled = true; controls.update(); }

  // 记忆星光：位置插值、出生动画、高亮
  const at = stars.geometry.attributes; const cur = reel.on ? reel.list[reel.i] : null;
  for (const m of S.memories) {
    if (m.idx == null || m.idx >= at.position.count) continue;
    m.pos.lerp(m.target, 1 - Math.exp(-dt * 3));
    if (m.appear < 1 && m.appear > 0) m.appear = Math.min(1, m.appear + dt * 0.8);
    m.flash = Math.max(0, (m.flash || 0) - dt * 0.7);
    const hi = Math.max(m === cur ? 1 : 0, m === S.hover ? 0.6 : 0, Math.min(1, m.flash));
    m.hi = lerp(m.hi || 0, hi, 1 - Math.exp(-dt * 8));
    at.position.array.set([m.pos.x, m.pos.y, m.pos.z], m.idx * 3);
    at.aHi.array[m.idx] = m.hi; at.aAppear.array[m.idx] = m.appear;
  }
  at.position.needsUpdate = at.aHi.needsUpdate = at.aAppear.needsUpdate = true;

  const tint = smooth(46, 16, dist);
  dust.material.uniforms.uTint.value = tint; stars.material.uniforms.uTint.value = tint;
  stars.material.uniforms.uDim.value = lerp(stars.material.uniforms.uDim.value, reel.on ? 1 : 0, 1 - Math.exp(-dt * 3));
  dust.material.uniforms.uBright.value = S.view === 'brain' ? 0.5 : lerp(1, 0.55, smooth(14, 4, dist));
  if (S.view === 'brain') dust.material.uniforms.uTint.value = 0.55;
  for (const m of [dust.material, stars.material, sky.mat]) m.uniforms.uTime.value = time;
  // 星河内部的群星风暴：进脑图时慢慢亮起来，回到星环时慢慢隐去
  galaxyFade = lerp(galaxyFade, S.view === 'brain' ? 1 : 0, 1 - Math.exp(-dt * 0.9));
  galaxy.update(time, galaxyFade);
  sky.mat.uniforms.uFade.value = S.mode === 'intro' ? sky.mat.uniforms.uFade.value : 1 - 0.6 * galaxyFade;
  if (S.view === 'brain') {
    // 太阳系公转；看卡片的时候放慢，方便看清
    brain.update(reel.on ? dt * 0.25 : S.hoverPlanet && S.hoverPlanet !== 'sun' ? dt * 0.08 : dt, time, m => Math.max(m === cur ? 1 : 0, m === S.hover ? 0.6 : 0, Math.min(1, m.flash || 0)), true, camera.position);
    brain.stars.material.uniforms.uDim.value = stars.material.uniforms.uDim.value;
    // 脑图里的数据流：时不时有一颗光点从输入流向海马体，再流向某个脑区
    if (!swapping && Math.random() < dt * 0.5) {
      const keys = Object.keys(S.arcs); const k = keys[Math.floor(Math.random() * keys.length)];
      if (k) comet(brain.hub('input'), brain.hub('hippocampus'), S.regionBy.input.color, { dur: 1.2, lift: 1, trail: true, onArrive: () => comet(brain.hub('hippocampus'), brain.hub(k), S.regionBy[k].color, { dur: 1.4, lift: 1.5 }) });
    }
  }
  fx.update(dt);
  if (organs) organs.material = fx.points.material;
  sky.group.rotation.y += dt * 0.004;
  sky.group.position.copy(camera.position); galaxy.group.position.copy(camera.position);   // 背景星空当成无限远：脑图尺度大（镜头离中心几百），不然镜头会飞出星空球壳、背景突然变空

  if (S.mode !== 'intro') {
    updateLabels(dist); updateZoomUI(dist); pick(); autoReel(dist);
  }
  placeCard(dt);
  composer.render();
}

// 调试：地址里带 ?debug 时，把内部状态挂到 window 上（自动化测试用）
if (new URLSearchParams(location.search).has('debug')) window.__fmn = { S, brain, camera, project, mouse, core, dust, stars, sky, galaxy, scene, bloom, limiter, flying: () => !!flight };

// ------------------------------------------------------------------ 启动
(async function boot() {
  try { await loadBrain(true); } catch (e) {
    console.error(e);
    toast('<b>连接失败</b>没有找到记忆大脑服务', '#ff8fa6');
  }
  organs = buildOrgans();
  // 先把脑图（默认隐藏）的着色器编译好：不然第一次进脑图那一帧要现编译，过场正中间会卡住一下
  try {   // 预热：把脑图和星河（默认隐藏）先画一帧，着色器和几十万个点的缓冲区都提前传上 GPU；同一个任务里紧接着 tick() 会重画，用户看不到这一帧
    brain.group.visible = true; galaxy.update(0, 0.01); composer.render();
  } catch { }
  brain.group.visible = S.view === 'brain'; galaxy.update(0, 0);
  const music = createMusic({ onToast: toast });
  music.load().then(() => music.play());
  tick();
  pollEvents();
})();
