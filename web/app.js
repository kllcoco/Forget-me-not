// 勿忘我 · 记忆星环
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { A, TAU, MAX_REGIONS, frame, makeCore, makeDust, makeFx, makeSky, makeStars, ringPos } from './ring.js';
import { paint, paintSealed } from './painter.js';
import { createBrainMap, hubPos } from './brainmap.js';
import { createMusic } from './music.js';

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
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 1.1, 0.75, 0.08);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const sky = makeSky(); scene.add(sky.group);
const dust = makeDust(innerWidth < 760 ? 15000 : 26000); scene.add(dust);
const stars = makeStars(); scene.add(stars);
const fx = makeFx(); scene.add(fx.points);
const core = makeCore(); scene.add(core.group);
const brain = createBrainMap(scene);
const ringObjs = [dust, stars, core.group];

const pixelUniforms = () => {
  const px = renderer.getPixelRatio() * (innerHeight / 900);
  for (const m of [dust.material, stars.material, fx.points.material, sky.mat, brain.stars.material]) m.uniforms.uPixel.value = m === sky.mat ? renderer.getPixelRatio() : px;
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
  S.links = data.links || []; S.persona = data.persona;
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
  renderLegend(); renderStats(); buildLabels(); renderKey(); renderPersona();
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
    } else {
      anchor = ORGAN_POS[r.key].clone().add(new THREE.Vector3(0, 0.75, 0));
    }
    labelsEl.appendChild(el);
    labelEls.push({ el, anchor, region: r, view: 'ring' });
    // 脑图里的大字标签
    const bel = el.cloneNode(true); bel.classList.remove('organ'); bel.classList.add('big');
    bel.onclick = () => openRegion(r.key);
    labelsEl.appendChild(bel);
    labelEls.push({ el: bel, anchor: hubPos(r.key).add(new THREE.Vector3(0, r.key === 'longterm' ? 3.2 : 2.6, 0)), region: r, view: 'brain' });
  }
}

const _v = new THREE.Vector3();
function project(p, out = {}) {
  _v.copy(p).project(camera);
  out.x = (_v.x * 0.5 + 0.5) * innerWidth; out.y = (-_v.y * 0.5 + 0.5) * innerHeight; out.z = _v.z; out.vis = _v.z < 1 && _v.z > -1;
  return out;
}

function updateLabels(dist) {
  const base = smooth(80, 34, dist) * 0.9 + 0.1;
  const tmp = {};
  for (const L of labelEls) {
    if (L.view !== S.view) { L.el.style.opacity = '0'; L.el.style.pointerEvents = 'none'; continue; }
    project(L.anchor, tmp);
    const d = camera.position.distanceTo(L.anchor);
    let o = L.view === 'brain' ? smooth(2, 8, d) * (L.region.kind === 'process' ? 0.8 : 1)
      : L.region.kind === 'process' ? smooth(30, 12, dist) * 0.85 : base * smooth(1.5, 5, d);
    if (reel.on) o *= L.region.key === reel.region ? 1 : 0.12;
    if (!tmp.vis) o = 0;
    const sc = clamp((L.view === 'brain' ? 46 : 26) / d, 0.55, 1.5);
    L.el.style.opacity = o.toFixed(3);
    L.el.style.transform = `translate(${tmp.x}px, ${tmp.y}px) translate(-50%, -50%) scale(${sc.toFixed(3)})`;
    L.el.style.pointerEvents = o > 0.3 ? 'auto' : 'none';
  }
}

// ------------------------------------------------------------------ 图例 / 统计
function renderLegend() {
  const el = $('#legend');
  const mem = S.regions.filter(r => r.kind === 'memory'), proc = S.regions.filter(r => r.kind === 'process');
  el.innerHTML = `<div class="head">TA 的回忆</div>` +
    mem.map(r => `<button data-k="${r.key}" style="--c:${r.color}" class="${reel.on && reel.region === r.key ? 'on' : ''}"><span class="dot"></span><span>${esc(r.name)}</span><span class="n">${r.count}</span></button>`).join('') +
    `<div class="sep"></div>` +
    proc.map(r => `<button class="proc" data-p="${r.key}" style="--c:${r.color}"><span class="dot"></span><span>${esc(r.name)}</span><span class="n"></span></button>`).join('');
  el.querySelectorAll('[data-k]').forEach(b => b.onclick = () => openRegion(b.dataset.k));
  el.querySelectorAll('[data-p]').forEach(b => b.onclick = () => {
    if (S.view === 'brain') { const h = hubPos(b.dataset.p); flyTo(h.clone().add(new THREE.Vector3(4, 3, 16)), h, 1.8); }
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
  $('#stats').innerHTML = `还记得 <b>${s.active}</b><i>·</i>已遗忘 <b>${s.archived}</b><i>·</i>关联 <b>${S.links.length}</b><i>·</i>最近回想 <b>${ago(s.last_recall)}</b>`;
}

// ------------------------------------------------------------------ 镜头飞行（过场）
let flight = null;
function flyTo(pos, target, dur = 2.4, { warp = true, cinema = false, done } = {}) {
  const p0 = camera.position.clone(), t0 = controls.target.clone();
  const dir = new THREE.Vector3().subVectors(pos, target).normalize();
  const c1 = p0.clone().lerp(target, 0.15).add(new THREE.Vector3(0, 3, 0));
  const c2 = pos.clone().addScaledVector(dir, 5).add(new THREE.Vector3(0, 2.5, 0));
  flight = { p0, c1, c2, p1: pos.clone(), t0, t1: target.clone(), dur, k: 0, warp, done };
  if (cinema) document.body.classList.add('cinema');
  controls.enabled = false;
}
function stepFlight(dt) {
  if (!flight) return;
  const f = flight; f.k = Math.min(1, f.k + dt / f.dur); const e = ease(f.k), u = 1 - e;
  camera.position.set(0, 0, 0)
    .addScaledVector(f.p0, u * u * u).addScaledVector(f.c1, 3 * u * u * e).addScaledVector(f.c2, 3 * u * e * e).addScaledVector(f.p1, e * e * e);
  controls.target.lerpVectors(f.t0, f.t1, ease(Math.min(1, f.k * 1.15)));
  const w = f.warp ? Math.sin(Math.PI * f.k) : 0;
  camera.fov = 45 + 16 * w; camera.updateProjectionMatrix();
  bloom.strength = 1.1 + 0.9 * w; dust.material.uniforms.uWarp.value = w;
  camera.lookAt(controls.target);
  if (f.k >= 1) {
    flight = null; controls.enabled = S.mode !== 'intro'; camera.fov = 45; camera.updateProjectionMatrix(); bloom.strength = 1.1;
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
    const dir = camera.position.clone().sub(controls.target); dir.y = Math.max(dir.y, 2); dir.setLength(15);
    return m.bpos.clone().add(dir);
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
    return `<div class="fr ${src ? '' : 'text'} ${m.status === 'archived' ? 'arch' : ''} ${i === reel.i ? 'on' : ''}" data-i="${i}" style="--c:${m.color.getStyle()};${src ? `background-image:url('${src}')` : ''}"></div>`;
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
      ${m.status === 'archived' ? '<span class="archived">已遗忘 · 可召回</span>' : `<span class="left">还会记得约 ${daysLeft(m)} 天</span>`}
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
  y = clamp(y, 24 + innerHeight * 0.09, innerHeight - h - 150);
  x = clamp(x, 16, innerWidth - w - 16);
  if (innerWidth < 760) { x = (innerWidth - w) / 2; y = Math.max(16 + innerHeight * 0.09, innerHeight - h - 150); side = p.x < x + w / 2 ? 1 : -1; }
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
  if (EMBED) { parent.postMessage({ type: 'fmn:escape' }, location.origin); return; }
  // 独立页面：浏览器自己会用 Esc 退出全屏；不在全屏时，Esc 一层层往外退
  if (reel.on) exitReel(); else if (S.view === 'brain') exitBrain();
}
$('#fsbtn').onclick = goFullscreen;
if (!EMBED) addEventListener('pointerdown', function once() { removeEventListener('pointerdown', once); goFullscreen(); });
addEventListener('message', e => { if (e.origin === location.origin && e.data?.type === 'fmn:fullscreen-state') document.body.classList.toggle('full', !!e.data.full); });

// ------------------------------------------------------------------ 多级缩放：星环 ⇄ 脑图
const BRAIN_HOME = { pos: new THREE.Vector3(0, 8, 64), target: new THREE.Vector3(3, -1, 0) };
let swapping = false;
function setView(v) {
  S.view = v;
  for (const o of ringObjs) o.visible = v === 'ring';
  // 莫比乌斯环不丢：在脑图里，它变成环绕整个大脑的一圈星河
  dust.visible = true;
  dust.scale.setScalar(v === 'brain' ? 3.3 : 1);
  dust.rotation.set(v === 'brain' ? -0.32 : 0, 0, v === 'brain' ? 0.06 : 0);
  dust.position.set(v === 'brain' ? 3 : 0, v === 'brain' ? -2 : 0, 0);
  if (organs) organs.visible = v === 'ring';
  brain.group.visible = v === 'brain';
  document.body.classList.toggle('brain', v === 'brain');
  $('#brainbtn').classList.toggle('on', v === 'brain');
  $('#title').innerHTML = v === 'brain' ? 'TA的回忆<small>· 脑图</small>' : '勿忘我<small>Forget-me-not</small>';
  $('#poem').textContent = v === 'brain' ? '多层记忆架构：每一团星是一个脑区，线是记忆之间的关联与数据流' : '把她留在时间里的痕迹，延长得再久一些';
  controls.maxDistance = v === 'brain' ? 140 : 110;
  renderLegend();
}
function flash(peakAt, fn) {
  const w = $('#whiteout'); w.style.transition = 'opacity .45s'; w.style.opacity = '0.9';
  setTimeout(() => { fn(); w.style.transition = 'opacity 1.1s'; w.style.opacity = '0'; }, peakAt);
}
function enterBrain() {
  if (swapping || S.view === 'brain') return; swapping = true;
  if (reel.on) exitReel();
  controls.autoRotate = false; $('#rot').classList.remove('on');
  flash(420, () => {
    setView('brain');
    camera.position.set(0, 2, 6); controls.target.set(0, 0, 0); camera.lookAt(0, 0, 0);
    flyTo(BRAIN_HOME.pos, BRAIN_HOME.target, 2.2, { warp: true, done: () => { swapping = false; S.idleAt = performance.now(); } });
  });
}
function exitBrain() {
  if (swapping || S.view !== 'brain') return; swapping = true;
  if (reel.on) exitReel();
  flyTo(new THREE.Vector3(0, 4, 150), BRAIN_HOME.target, 0.9, { warp: true });
  flash(520, () => {
    flight = null; setView('ring');
    camera.position.set(0.5, 0.5, 2.6); controls.target.set(0, 0, 0); camera.lookAt(0, 0, 0);
    flyTo(HOME.pos, HOME.target, 2.4, { warp: true, done: () => { swapping = false; controls.autoRotate = true; $('#rot').classList.add('on'); S.idleAt = performance.now(); } });
  });
}

// ------------------------------------------------------------------ 性格养成面板（脑图里）
function renderPersona() {
  const el = $('#persona');
  if (!S.persona) { el.innerHTML = `<h5>TA 的性格</h5><div class="sub">可塑 · 养成中</div><div class="locked">${S.key.initialized ? '钥匙不在，性格也被锁着。' : '还没有任何经历。'}</div>`; return; }
  const T = S.persona.traits, n = T.length, cx = 150, cy = 108, R0 = 78;
  const pt = (i, v) => { const a = -Math.PI / 2 + i * 2 * Math.PI / n; return [cx + Math.cos(a) * R0 * v, cy + Math.sin(a) * R0 * v]; };
  const poly = vals => vals.map((v, i) => pt(i, v).map(x => x.toFixed(1)).join(',')).join(' ');
  const rings = [0.25, 0.5, 0.75, 1].map(k => `<polygon points="${poly(T.map(() => k))}" fill="none" stroke="rgba(200,214,255,.10)"/>`).join('');
  const axes = T.map((t, i) => { const [x, y] = pt(i, 1); const [lx, ly] = pt(i, 1.2); return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="rgba(200,214,255,.08)"/><text x="${lx}" y="${ly + 3}" text-anchor="middle">${t.name}</text>`; }).join('');
  const hist = (S.persona.history || []).slice(0, 3).map(h => {
    const t = T.find(x => x.key === h.trait);
    return `<li><b>${t?.name || h.trait}</b><span class="${h.delta > 0 ? 'up' : 'down'}">${h.delta > 0 ? '+' : ''}${h.delta}</span> ${esc(h.reason)}</li>`;
  }).join('');
  el.innerHTML = `<h5>TA 的性格</h5><div class="sub">可塑 · 被经历慢慢塑造</div>
    <svg viewBox="0 0 300 220">${rings}${axes}
      <polygon points="${poly(T.map(t => t.baseline))}" fill="none" stroke="rgba(200,214,255,.35)" stroke-dasharray="3 3"/>
      <polygon points="${poly(T.map(t => t.value))}" fill="rgba(201,167,255,.18)" stroke="#c9a7ff" stroke-width="1.4" style="filter:drop-shadow(0 0 6px #c9a7ff)"/>
      ${T.map((t, i) => { const [x, y] = pt(i, t.value); return `<circle cx="${x}" cy="${y}" r="2.4" fill="#fff"/>`; }).join('')}
    </svg><ul>${hist}</ul>`;
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
  if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || S.mode === 'intro') return;
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
  S.hover = best;
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
  if (S.view === 'brain') { if (!reel.on && dist > 92) exitBrain(); else if (reel.on && !reel.follow && now - S.idleAt > 2600 && !S.interacting) { reel.follow = true; reel.t = 0; } return; }
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
$('#reset').onclick = () => { exitReel(); if (S.view === 'brain') flyTo(BRAIN_HOME.pos, BRAIN_HOME.target, 1.8); else flyTo(HOME.pos, HOME.target, 2.2); };
$('#brainbtn').onclick = () => { if (S.view === 'brain') exitBrain(); else { exitReel(); flyTo(new THREE.Vector3(0.6, 0.6, 3), new THREE.Vector3(0, 0, 0), 2.0, { done: enterBrain }); } };

const hintEl = $('#enter');
hintEl.textContent = matchMedia('(pointer: coarse)').matches ? '双指放大 · 靠近星光开始放映' : '滚轮拉近 · 靠近星光开始放映';
function hideHint() { document.body.classList.add('entered'); }
hintEl.onclick = () => { hideHint(); const keys = Object.keys(S.arcs); if (keys.length) openRegion(keys[0]); };

// ------------------------------------------------------------------ 事件：写入 / 回想 / 遗忘 的动画
const feed = $('#feed');
function toast(html, color) {
  const el = document.createElement('div'); el.className = 'ev'; el.style.setProperty('--c', color || '#bcd6ff'); el.innerHTML = html;
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

const organ = k => S.view === 'brain' ? hubPos(k) : ORGAN_POS[k];
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
  } else if (ev.kind === 'persona') {
    corePulse = 0.8;
    toast(`<b>性格养成</b>${(ev.traits || []).length ? 'TA 的性格因为经历有了一点点变化' : '性格基线被调整了'}`, '#c9a7ff');
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
qEl.addEventListener('focus', () => { if (S.sealed) { qEl.blur(); openKey(); } });
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
    } catch (e) { if (e.status === 423) openKey(); }
  }, 280);
});
document.addEventListener('pointerdown', e => { if (!$('#search').contains(e.target)) resEl.classList.remove('show'); });

// ------------------------------------------------------------------ 超级管理员钥匙（私钥在登记的位置 = 解锁）
const keyModal = $('#keymodal');
function renderKey() {
  $('#keybtn').classList.toggle('ok', !!S.key.unlocked);
  $('#keybtn').title = S.key.unlocked ? '超级管理员钥匙：在' : '超级管理员钥匙：不在';
}
function openKey() {
  const k = S.key;
  $('#km-sub').textContent = k.initialized
    ? '这把私钥和这份记忆一一对应。每次访问记忆，都会去下面的路径看一眼钥匙还在不在：在就自动解锁，不在谁都打不开。'
    : '还没有记忆。模型第一次写入记忆时，会在你电脑的桌面上生成唯一的超级管理员钥匙。';
  $('#km-state').innerHTML = !k.initialized ? '<span>尚未生成</span>'
    : `<span class="${k.unlocked ? 'ok' : 'no'}">●</span><div><b>${k.unlocked ? '钥匙在，记忆已解锁' : '找不到钥匙，记忆被锁着'}</b><small>指纹 ${esc(k.fingerprint || '')}</small></div>`;
  $('#km-path').value = k.key_path || ''; $('#km-path').disabled = !k.initialized;
  $('#km-export').disabled = !k.unlocked; $('#km-export').style.opacity = k.unlocked ? 1 : 0.4;
  $('#km-err').textContent = '';
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
  const row = (t, v) => v ? `<p class="sub" style="margin:0 0 8px">${t}</p><pre>${esc(v)}</pre>` : '';
  $('#conn-body').innerHTML =
    row('① DeepSeek Harness：', 'dsh plugin --profile web add dsh-forget-me-not') +
    row('② Claude / Cursor / Cherry Studio 等支持 MCP 的客户端：', mcpJson) +
    row('③ 远程 MCP（streamable HTTP）：', info.mcp_http) +
    row('④ 任何能调函数的模型（OpenAI / Gemini / GPTs / Dify / Coze）：', info.openapi) +
    row('给模型的使用说明（可放进 system prompt）：', info.protocol);
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
  introEl.classList.remove('on'); introEl.classList.add('off');
  document.body.classList.remove('intro');
  dust.material.uniforms.uReveal.value = 1; stars.material.uniforms.uReveal.value = 1;
  if (!flight) flyTo(HOME.pos, HOME.target, 1.6, { warp: false });
  controls.autoRotate = true;
  S.idleAt = performance.now();
  setTimeout(() => introEl.remove(), 2000);
}
$('#skip').onclick = finishIntro;
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
  bloom.strength = 1.1 + 0.5 * Math.exp(-((t - 1.2) ** 2) * 4);
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
  if (S.view === 'brain') {
    brain.update(time, S.memories, m => Math.max(m === cur ? 1 : 0, m === S.hover ? 0.6 : 0, Math.min(1, m.flash || 0)));
    brain.stars.material.uniforms.uDim.value = stars.material.uniforms.uDim.value;
    // 脑图里的数据流：时不时有一颗光点从输入流向海马体，再流向某个脑区
    if (!swapping && Math.random() < dt * 0.5) {
      const keys = Object.keys(S.arcs); const k = keys[Math.floor(Math.random() * keys.length)];
      if (k) comet(hubPos('input'), hubPos('hippocampus'), S.regionBy.input.color, { dur: 1.2, lift: 1, trail: true, onArrive: () => comet(hubPos('hippocampus'), hubPos(k), S.regionBy[k].color, { dur: 1.4, lift: 1.5 }) });
    }
  }
  fx.update(dt);
  if (organs) organs.material = fx.points.material;
  sky.group.rotation.y += dt * 0.004;

  if (S.mode !== 'intro') {
    updateLabels(dist); updateZoomUI(dist); pick(); autoReel(dist);
  }
  placeCard(dt);
  composer.render();
}

// ------------------------------------------------------------------ 启动
(async function boot() {
  try { await loadBrain(true); } catch (e) {
    console.error(e);
    toast('<b>连接失败</b>没有找到记忆大脑服务', '#ff8fa6');
  }
  organs = buildOrgans();
  const music = createMusic({ onToast: toast });
  music.load().then(() => music.play());
  tick();
  pollEvents();
})();
