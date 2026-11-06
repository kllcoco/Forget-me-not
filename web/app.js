// 勿忘我 · 记忆星环
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { A, TAU, MAX_REGIONS, frame, makeCore, makeDust, makeFx, makeSky, makeStars, ringPos } from './ring.js';
import { paint, paintSealed } from './painter.js';

const $ = s => document.querySelector(s);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, k) => a + (b - a) * k;
const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const hash = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return ((h >>> 0) % 100000) / 100000; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = { get(k) { try { return sessionStorage.getItem(k); } catch { return null; } }, set(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch { } } };

// ------------------------------------------------------------------ API
let token = store.get('fmn-token');
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (token) headers.Authorization = 'Bearer ' + token;
  let body = opts.body;
  if (body && typeof body !== 'string') { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  const r = await fetch(path, { ...opts, headers, body });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && token) { token = null; store.set('fmn-token', null); }
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

const pixelUniforms = () => {
  const px = renderer.getPixelRatio() * (innerHeight / 900);
  for (const m of [dust.material, stars.material, fx.points.material, sky.mat]) m.uniforms.uPixel.value = m === sky.mat ? renderer.getPixelRatio() : px;
};
pixelUniforms();
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight); pixelUniforms();
});

// ------------------------------------------------------------------ 数据与布局
const S = {
  regions: [], regionBy: {}, memories: [], byId: new Map(), stats: {}, sealed: true, admin: { initialized: false, unlocked: false },
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
  S.stats = data.stats; S.sealed = data.sealed; S.admin = data.admin || S.admin; S.types = data.types;
  if (first) S.lastEvent = data.last_event;
  S.memories = data.memories.map(m => {
    const old = prev.get(m.id);
    const nm = Object.assign(old || {}, m);
    if (!old && !first) nm.appear = 0;    // 新出生的星
    return nm;
  });
  S.byId = new Map(S.memories.map(m => [m.id, m]));
  layoutArcs(); layoutMemories(); writeStarBuffers();
  renderLegend(); renderStats(); buildLabels(); renderLock();
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
    labelEls.push({ el, anchor, region: r });
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
    project(L.anchor, tmp);
    const d = camera.position.distanceTo(L.anchor);
    let o = L.region.kind === 'process' ? smooth(30, 12, dist) * 0.85 : base * smooth(1.5, 5, d);
    if (reel.on) o *= L.region.key === reel.region ? 1 : 0.12;
    if (!tmp.vis) o = 0;
    const sc = clamp(26 / d, 0.55, 1.5);
    L.el.style.opacity = o.toFixed(3);
    L.el.style.transform = `translate(${tmp.x}px, ${tmp.y}px) translate(-50%, -50%) scale(${sc.toFixed(3)})`;
    L.el.style.pointerEvents = o > 0.3 ? 'auto' : 'none';
  }
}

// ------------------------------------------------------------------ 图例 / 统计
function renderLegend() {
  const el = $('#legend');
  const mem = S.regions.filter(r => r.kind === 'memory'), proc = S.regions.filter(r => r.kind === 'process');
  el.innerHTML = `<div class="head">脑 区</div>` +
    mem.map(r => `<button data-k="${r.key}" style="--c:${r.color}" class="${reel.on && reel.region === r.key ? 'on' : ''}"><span class="dot"></span><span>${esc(r.name)}</span><span class="n">${r.count}</span></button>`).join('') +
    `<div class="sep"></div>` +
    proc.map(r => `<button class="proc" data-p="${r.key}" style="--c:${r.color}"><span class="dot"></span><span>${esc(r.name)}</span><span class="n"></span></button>`).join('');
  el.querySelectorAll('[data-k]').forEach(b => b.onclick = () => openRegion(b.dataset.k));
  el.querySelectorAll('[data-p]').forEach(b => b.onclick = () => flyTo(ORGAN_POS[b.dataset.p].clone().add(new THREE.Vector3(6, 3, 8)), ORGAN_POS[b.dataset.p], 2.2));
}

function ago(ts) {
  if (!ts) return '—';
  const s = Date.now() / 1000 - ts;
  if (s < 60) return '刚刚'; if (s < 3600) return `${Math.floor(s / 60)} 分钟前`; if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}
function renderStats() {
  const s = S.stats;
  $('#stats').innerHTML = `记忆 <b>${s.active}</b><i>·</i>归档 <b>${s.archived}</b><i>·</i>配图 <b>${s.with_image}</b><i>·</i>最近回想 <b>${ago(s.last_recall)}</b>`;
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

function camFor(m) {
  const { T, N } = frame(m.t);
  const out = N.clone(); if (out.dot(new THREE.Vector3(m.target.x, 0, m.target.z)) < 0) out.negate();
  return m.target.clone().addScaledVector(out, 4.6).addScaledVector(T, -1.2).add(new THREE.Vector3(0, 2.1, 0));
}

function refreshReelList() {
  const cur = reel.list[reel.i];
  reel.list = S.memories.filter(m => m.region === reel.region).sort((a, b) => sortKey(a) - sortKey(b));
  if (cur) reel.i = Math.max(0, reel.list.findIndex(m => m.id === cur.id));
  renderStrip();
}

function startReel(region, startId, { cinematic = true } = {}) {
  reel.region = region; reel.on = true; reel.list = [];
  refreshReelList();
  if (!reel.list.length) { reel.on = false; toast(`${S.regionBy[region].name} 里还没有记忆`, S.regionBy[region].color); return; }
  reel.i = startId ? Math.max(0, reel.list.findIndex(m => m.id === startId)) : 0;
  reel.playing = true; reel.t = 0; reel.follow = false; hideHint();
  S.mode = 'reel'; document.body.classList.add('reel', 'cinema');
  controls.autoRotate = false; $('#rot').classList.remove('on');
  renderLegend();
  const m = reel.list[reel.i];
  const go = () => { reel.follow = true; showCard(true); };
  if (cinematic) { card.classList.remove('show'); flyTo(camFor(m), m.target, 2.6, { cinema: true, done: go }); }
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
  if (d < 14) flyTo(HOME.pos, HOME.target, 2.4);
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
  $('#reeltitle').innerHTML = `走马灯 · <b>${esc(r.name)}</b><span>${reel.i + 1} / ${reel.list.length}</span>`;
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

function mediaUrl(m) { return token ? `api/media/${m.id}?token=${encodeURIComponent(token)}` : null; }
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
      <div class="sealed"><div class="seal">封</div><p>这段记忆已被加密封存<br>只有超级管理员凭密码可以打开</p>
      <button class="chip" data-act="unlock">解 封</button></div></div></div>`;
  }
  const src = picOf(m);
  const pic = src ? `<div class="pic"><img src="${src}" alt=""><span class="stamp">No.${no} · ${m.image_kind === 'photo' ? 'moment' : 'dream'}</span></div>` : '';
  const tags = (m.tags || []).slice(0, 4).map(t => `<span class="tag">#${esc(t)}</span>`).join('');
  return `<div class="frame" style="--c:${c}">${pic}<div class="body">
    <div class="meta"><span class="rg">${esc(r.name)}</span><span class="sep">/</span>${esc(m.type_name || '')}<span class="sep">/</span>${date}</div>
    <h3>${esc(m.title || m.content.slice(0, 12))}</h3>
    <p>${esc(m.content)}</p>
    <div class="foot">${m.emotion ? `<span class="tag emo">${esc(m.emotion)}</span>` : ''}${tags}
      ${m.status === 'archived' ? '<span class="archived">已淡忘</span>' : ''}
      <span class="imp" title="重要性 ${m.importance}"><i style="width:${Math.round(m.importance * 100)}%"></i></span></div>
    ${S.admin.unlocked ? `<div class="admin"><button data-act="edit">修改</button><button data-act="archive">${m.status === 'archived' ? '唤醒' : '淡忘'}</button><button class="danger" data-act="delete">彻底删除</button></div>` : ''}
  </div></div>`;
}

function showCard(swap) {
  const m = reel.list[reel.i]; if (!m) return;
  card.innerHTML = cardHTML(m);
  card.classList.add('show');
  if (swap) { card.classList.remove('swap'); void card.offsetWidth; card.classList.add('swap'); }
  card.querySelectorAll('[data-act]').forEach(b => b.onclick = e => { e.stopPropagation(); cardAction(b.dataset.act, m); });
  reel.dur = durFor(m);
  // 星光一闪
  for (let i = 0; i < 26; i++) {
    const a = Math.random() * TAU, b = Math.acos(2 * Math.random() - 1), sp = 0.6 + Math.random() * 1.4;
    fx.spawn({ p: m.target.clone(), v: new THREE.Vector3(Math.sin(b) * Math.cos(a), Math.cos(b), Math.sin(b) * Math.sin(a)).multiplyScalar(sp), c: m.color.clone().lerp(new THREE.Color(1, 1, 1), 0.5), size: 1.3, max: 1.2 + Math.random(), drag: 0.95 });
  }
}

function placeCard(dt) {
  const m = reel.list[reel.i];
  if (!reel.on || !m || !card.classList.contains('show')) { wires.innerHTML = ''; return; }
  const p = project(m.pos);
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
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (S.mode === 'intro') { finishIntro(); return; }
  if (!reel.on) return;
  if (e.key === 'ArrowRight') reelGo(1); else if (e.key === 'ArrowLeft') reelGo(-1);
  else if (e.key === ' ') { reel.playing = !reel.playing; updatePlayIcon(); e.preventDefault(); }
  else if (e.key === 'Escape') exitReel();
});

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
  if (S.hover) startReel(S.hover.region, S.hover.id, { cinematic: !(reel.on && reel.region === S.hover.region) });
});

function pick() {
  if (mouse.x < 0 || flight) { S.hover = null; return; }
  let best = null, bd = 18 * 18; const tmp = {};
  for (const m of S.memories) {
    project(m.pos, tmp); if (!tmp.vis) continue;
    const d = (tmp.x - mouse.x) ** 2 + (tmp.y - mouse.y) ** 2;
    if (d < bd) { bd = d; best = m; }
  }
  S.hover = best;
  if (best) {
    const r = S.regionBy[best.region];
    tip.style.setProperty('--c', r.color);
    tip.innerHTML = `<b>${esc(r.name)}</b> · ${fmtDate(sortKey(best))}<br>${S.sealed || best.content == null ? '封存的记忆' : esc(best.title || best.content.slice(0, 28))}${best.status === 'archived' ? ' · <span style="opacity:.6">已淡忘</span>' : ''}`;
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
  for (const m of S.memories) { const d = m.pos.distanceTo(controls.target); if (d < bd) { bd = d; best = m; } }
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
$('#reset').onclick = () => { exitReel(); flyTo(HOME.pos, HOME.target, 2.2); };

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

function playEvent(ev) {
  const reg = S.regionBy;
  const mems = ev.memory_ids.map(id => S.byId.get(id)).filter(Boolean);
  if (ev.kind === 'remember') {
    const m = mems[0]; if (!m) return;
    const r = reg[m.region];
    m.appear = 0;
    comet(ORGAN_POS.input, ORGAN_POS.hippocampus, reg.input.color, { dur: 1.0, lift: 1.5,
      onArrive: () => { burst(ORGAN_POS.hippocampus, reg.hippocampus.color, 30, 1.4);
        comet(ORGAN_POS.hippocampus, m.target, r.color, { dur: 1.8, lift: 4, onArrive: () => { m.appear = 0.01; burst(m.target, r.color, 50, 1.8); } }); } });
    toast(`<b>海马体·写入</b>一段新的记忆进入「${esc(r.name)}」`, reg.hippocampus.color);
  } else if (ev.kind === 'recall') {
    corePulse = 1;
    mems.forEach((m, i) => {
      comet(ORGAN_POS.retrieval, m.target, reg.retrieval.color, { dur: 1.4 + i * 0.15, lift: 2.5, onArrive: () => { m.flash = 1; burst(m.target, m.color.getStyle(), 24, 1.2); } });
    });
    const q = ev.query && !S.sealed ? `「${esc(ev.query)}」` : '';
    toast(`<b>大脑中枢·检索</b>${q}想起了 ${mems.length} 段记忆`, reg.retrieval.color);
  } else if (ev.kind === 'revive') {
    mems.forEach(m => { m.flash = 1.5; burst(m.target, '#f3d9a4', 60, 2.2); });
    toast(`<b>复苏</b>${mems.length} 段遗忘的记忆被重新想起`, '#f3d9a4');
  } else if (ev.kind === 'archive') {
    mems.forEach(m => {
      for (let i = 0; i < 14; i++) fx.spawn({ p: m.target.clone(), v: new THREE.Vector3((Math.random() - .5) * .4, -0.3 - Math.random() * .5, (Math.random() - .5) * .4), c: new THREE.Color(0.6, 0.62, 0.75), size: 0.9, max: 2.4, drag: 0.99 });
    });
    burst(ORGAN_POS.metabolism, reg.metabolism.color, 30, 1.2);
    toast(`<b>代谢·治理</b>${mems.length} 段记忆渐渐淡去`, reg.metabolism.color);
  } else if (ev.kind === 'merge') {
    mems.forEach(m => { m.flash = 1; burst(m.target, m.color.getStyle(), 20, 1); });
    toast(`<b>海马体</b>把相似的记忆合并在了一起`, reg.hippocampus.color);
  } else if (ev.kind === 'wake') {
    corePulse = 1.3; burst(new THREE.Vector3(), '#cfe0ff', 80, 3);
    toast(`<b>醒来</b>${esc(ev.agent || 'AI')} 睁开眼睛，看了看自己的记忆`, '#cfe0ff');
  } else if (ev.kind === 'update' || ev.kind === 'delete') {
    toast(`<b>超级管理员</b>${ev.kind === 'update' ? '修改' : '删除'}了一段记忆`, '#f3d9a4');
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
qEl.addEventListener('focus', () => { if (S.sealed) { qEl.blur(); openLock(); } });
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
      memories.forEach((m, i) => { const mm = S.byId.get(m.id); if (mm) comet(ORGAN_POS.retrieval, mm.target, S.regionBy.retrieval.color, { dur: 1.2 + i * 0.12, lift: 2.5, onArrive: () => { mm.flash = 1; } }); });
      corePulse = 0.8;
      resEl.querySelectorAll('[data-id]').forEach(b => b.onclick = () => { const m = S.byId.get(b.dataset.id); resEl.classList.remove('show'); if (m) startReel(m.region, m.id); });
    } catch (e) { if (e.status === 401) openLock(); }
  }, 280);
});
document.addEventListener('pointerdown', e => { if (!$('#search').contains(e.target)) resEl.classList.remove('show'); });

// ------------------------------------------------------------------ 超级管理员
const lockModal = $('#lockmodal');
function renderLock() {
  const b = $('#lockbtn');
  b.classList.toggle('on', S.admin.unlocked);
  b.querySelector('span').textContent = !S.admin.initialized ? '设定密码' : S.admin.unlocked ? '已解封' : S.admin.awake ? '封存中' : '沉睡中';
}
function openLock() {
  const setup = !S.admin.initialized;
  $('#lk-title').textContent = setup ? '设定超级管理员' : '超级管理员';
  $('#lk-sub').textContent = setup ? '第一次使用，请设定超级管理员密码。AI 写进来的记忆会用它加密封存；查看、修改、删除都需要它。'
    : S.admin.awake ? '记忆已被封存。输入超级管理员密码，才能查看它们。' : '记忆大脑在沉睡。输入超级管理员密码唤醒她：唤醒后 AI 才能回想，你也能查看记忆。';
  $('#lk-pass2').style.display = setup ? '' : 'none';
  $('#lk-warn').style.display = setup ? '' : 'none';
  $('#lk-ok').textContent = setup ? '设 定' : S.admin.awake ? '解 封' : '唤 醒';
  $('#lk-err').textContent = ''; $('#lk-pass').value = ''; $('#lk-pass2').value = '';
  lockModal.classList.add('show'); setTimeout(() => $('#lk-pass').focus(), 60);
}
$('#lk-cancel').onclick = () => lockModal.classList.remove('show');
$('#lk-pass').addEventListener('keydown', e => { if (e.key === 'Enter') $('#lk-ok').click(); });
$('#lk-pass2').addEventListener('keydown', e => { if (e.key === 'Enter') $('#lk-ok').click(); });
$('#lk-ok').onclick = async () => {
  const p = $('#lk-pass').value, setup = !S.admin.initialized;
  if (setup) {
    if (p.length < 8) return ($('#lk-err').textContent = '密码至少 8 位');
    if (p !== $('#lk-pass2').value) return ($('#lk-err').textContent = '两次输入的密码不一样');
  }
  try {
    const r = await api(setup ? 'api/admin/setup' : 'api/admin/unlock', { method: 'POST', body: { password: p } });
    token = r.token; store.set('fmn-token', token);
    lockModal.classList.remove('show');
    await loadBrain();
    corePulse = 1.4; burst(new THREE.Vector3(), '#f3d9a4', 120, 4);
    toast('<b>解封</b>超级管理员打开了记忆', '#f3d9a4');
    if (reel.on) showCard(true);
  } catch (e) { $('#lk-err').textContent = e.message || '出错了'; }
};
$('#lockbtn').onclick = async () => {
  if (!S.admin.unlocked) return openLock();
  try { await api('api/admin/lock', { method: 'POST', body: {} }); } catch { }
  token = null; store.set('fmn-token', null);
  await loadBrain(); if (reel.on) showCard(true);
  toast('<b>封存</b>记忆重新被锁上了', '#f3d9a4');
};

const editModal = $('#editmodal'); let editing = null;
async function cardAction(act, m) {
  if (act === 'unlock') return openLock();
  if (act === 'edit') { editing = m; $('#ed-text').value = m.content; $('#ed-err').textContent = ''; editModal.classList.add('show'); return; }
  try {
    if (act === 'archive') await api(`api/admin/memories/${m.id}`, { method: 'POST', body: { status: m.status === 'archived' ? 'active' : 'archived' } });
    if (act === 'delete') {
      if (!confirm('彻底删除后再也找不回来了，确定吗？')) return;
      await api(`api/admin/memories/${m.id}/delete`, { method: 'POST', body: {} });
    }
    await loadBrain(); if (reel.on) { if (!reel.list.length) exitReel(); else showCard(true); }
  } catch (e) { toast(`<b>失败</b>${esc(e.message)}`, '#ff8fa6'); }
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
  const mcpJson = JSON.stringify({ mcpServers: { 'forget-me-not': info.mcp_stdio || { command: 'npx', args: ['-y', 'forget-me-not', 'mcp'] } } }, null, 2);
  const row = (t, v) => v ? `<p class="sub" style="margin:0 0 8px">${t}</p><pre>${esc(v)}</pre>` : '';
  $('#conn-body').innerHTML =
    row('① DeepSeek Harness：', 'dsh plugin add forget-me-not') +
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
    core.set(1 + 0.08 * Math.sin(time * 1.6) + corePulse * 0.6, time, (reel.on ? 0.35 : 1) * smooth(3, 16, camCore) * 0.85 + 0.15);
  }
  stepFlight(dt);

  const dist = camera.position.distanceTo(controls.target);
  // 走马灯：镜头沿星环滑行，逐个放映
  if (reel.on && reel.follow && !flight) {
    const m = reel.list[reel.i];
    if (m) {
      const k = 1 - Math.exp(-dt * 1.6);
      camera.position.lerp(camFor(m), k); controls.target.lerp(m.target, k);
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
  dust.material.uniforms.uBright.value = lerp(1, 0.55, smooth(14, 4, dist));
  for (const m of [dust.material, stars.material, sky.mat]) m.uniforms.uTime.value = time;
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
  tick();
  pollEvents();
})();
