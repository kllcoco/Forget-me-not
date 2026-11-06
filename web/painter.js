// 记忆画师：没有真实图片的记忆，根据 image_prompt 的意象画一幅"记忆的样子"。
// 完全离线、确定性（同一段记忆永远画出同一幅画）。

const cache = new Map();

function rng(seed) {
  let h = 2166136261 >>> 0;
  for (const ch of String(seed)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const has = (s, re) => re.test(s);

function palette(text) {
  if (has(text, /雪|冬|冰/)) return { sky: ['#1c2a44', '#5a7398', '#c9d6e8'], light: '#eef4ff', mood: 'snow' };
  if (has(text, /黄昏|夕阳|日落|傍晚|晚霞|落日/)) return { sky: ['#1b1638', '#a3476b', '#f4a261', '#ffd9a0'], light: '#ffe2b0', mood: 'dusk' };
  if (has(text, /雨|阴/)) return { sky: ['#0d1420', '#26364a', '#4d5f74'], light: '#ffcf8a', mood: 'rain' };
  if (has(text, /火锅|饭|咖啡|灯|家|厨房|蛋糕|生日|电影|房间|被窝|酒/)) return { sky: ['#140b08', '#3a1d12', '#7a3a1c'], light: '#ffb36b', mood: 'warm' };
  if (has(text, /清晨|早晨|日出|阳光|白天|午后|春|花|樱/)) return { sky: ['#4b6fa8', '#9cc0e6', '#ffe3c2'], light: '#fff3d6', mood: 'day' };
  return { sky: ['#03050f', '#0c1638', '#283a78'], light: '#dbe7ff', mood: 'night' };
}

function grad(ctx, w, h, stops) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
}

function glow(ctx, x, y, r, color, a = 1) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color); g.addColorStop(1, 'transparent');
  ctx.globalAlpha = a; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
}

function ridge(ctx, w, h, base, amp, color, R, rough = 0.5) {
  ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(0, h);
  let y = base;
  for (let x = 0; x <= w; x += 8) { y += (R() - 0.5) * amp * rough; y += (base - y) * 0.08; ctx.lineTo(x, y + Math.sin(x * 0.01 + R()) * amp * 0.3); }
  ctx.lineTo(w, h); ctx.fill();
}

export function paint(memory, w = 640, h = 400) {
  const key = memory.id + ':' + w;
  if (cache.has(key)) return cache.get(key);
  const text = `${memory.image_prompt || ''} ${memory.title || ''} ${memory.content || ''}`;
  const R = rng(memory.id);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const pal = palette(text);
  grad(ctx, w, h, pal.sky);
  const horizon = h * (0.58 + R() * 0.12);

  // 星空
  if (pal.mood === 'night' || pal.mood === 'dusk' || has(text, /星|银河/)) {
    const n = pal.mood === 'night' ? 260 : 70;
    for (let i = 0; i < n; i++) {
      const x = R() * w, y = R() * horizon * 0.9, r = R() ** 3 * 1.6 + 0.3;
      ctx.globalAlpha = 0.3 + R() * 0.7; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (has(text, /银河|星空|星星/)) for (let i = 0; i < 900; i++) {
      const t = R(); const x = t * w; const y = horizon * (0.15 + t * 0.5) + (R() - 0.5) * 60 * (1 - Math.abs(t - 0.5));
      ctx.globalAlpha = R() * 0.5; ctx.fillStyle = R() > 0.5 ? '#cfe0ff' : '#ffd9f0'; ctx.fillRect(x, y, 1, 1);
    }
    ctx.globalAlpha = 1;
  }
  // 日 / 月
  const sx = w * (0.25 + R() * 0.5), sy = horizon * (0.35 + R() * 0.35);
  if (pal.mood === 'night') { glow(ctx, sx, sy, 90, 'rgba(200,220,255,.35)'); ctx.fillStyle = '#f2f6ff'; ctx.beginPath(); ctx.arc(sx, sy, 16, 0, 7); ctx.fill(); }
  if (pal.mood === 'dusk' || pal.mood === 'day') { glow(ctx, sx, horizon - 10, 260, pal.mood === 'dusk' ? 'rgba(255,190,120,.75)' : 'rgba(255,245,220,.6)'); }

  // 远景
  if (has(text, /山|峰|徒步|爬/)) {
    ridge(ctx, w, h, horizon - 80, 60, 'rgba(40,50,90,.55)', R, 1.2);
    ridge(ctx, w, h, horizon - 30, 50, 'rgba(20,26,50,.8)', R, 1.0);
  }
  if (has(text, /城|街|楼|地铁|路灯|窗|公司|加班/)) {
    for (let x = 0; x < w;) {
      const bw = 24 + R() * 50, bh = 40 + R() * 150; ctx.fillStyle = 'rgba(8,10,22,.92)'; ctx.fillRect(x, horizon - bh, bw, bh + h);
      for (let wy = horizon - bh + 8; wy < horizon - 6; wy += 9) for (let wx = x + 4; wx < x + bw - 4; wx += 7)
        if (R() > 0.62) { ctx.fillStyle = R() > 0.3 ? 'rgba(255,214,150,.85)' : 'rgba(170,210,255,.7)'; ctx.fillRect(wx, wy, 3, 4); }
      x += bw + 2;
    }
  }
  // 海 / 湖
  if (has(text, /海|湖|江|河|岸|浪|水/)) {
    const g = ctx.createLinearGradient(0, horizon, 0, h); g.addColorStop(0, pal.sky[pal.sky.length - 1]); g.addColorStop(1, pal.sky[0]);
    ctx.fillStyle = g; ctx.fillRect(0, horizon, w, h - horizon);
    for (let y = horizon + 2; y < h; y += 3) {
      const spread = (y - horizon) * 0.9 + 6; ctx.globalAlpha = 0.5 * (1 - (y - horizon) / (h - horizon));
      ctx.fillStyle = pal.light; ctx.fillRect(sx - spread * (0.3 + R() * 0.7), y, spread * (0.4 + R()), 1);
    }
    ctx.globalAlpha = 1;
  } else if (!has(text, /城|街|楼/)) {
    ridge(ctx, w, h, horizon + 20, 26, 'rgba(4,6,14,.88)', R, 0.6);
  }
  // 温暖的灯火散景
  if (pal.mood === 'warm' || pal.mood === 'rain' || has(text, /灯|烟花|跨年|夜市|火锅/)) {
    for (let i = 0; i < 46; i++) {
      const x = R() * w, y = h * (0.25 + R() * 0.7), r = 8 + R() * 34;
      const col = R() > 0.25 ? pal.light : '#ff7a59';
      glow(ctx, x, y, r, col, 0.18 + R() * 0.25);
    }
  }
  if (has(text, /烟花|跨年|新年/)) {
    for (let k = 0; k < 4; k++) {
      const fx = w * (0.15 + R() * 0.7), fy = h * (0.15 + R() * 0.3), col = ['#ffd27a', '#ff8fb8', '#9fd2ff', '#c9a7ff'][k];
      for (let i = 0; i < 60; i++) { const a = R() * 7, d = 10 + R() * 60; ctx.globalAlpha = 0.6; ctx.fillStyle = col; ctx.fillRect(fx + Math.cos(a) * d, fy + Math.sin(a) * d, 2, 2); }
      glow(ctx, fx, fy, 70, col, 0.25);
    }
    ctx.globalAlpha = 1;
  }
  // 雨 / 雪 / 花瓣
  if (pal.mood === 'rain') { ctx.strokeStyle = 'rgba(200,220,255,.22)'; ctx.lineWidth = 1; for (let i = 0; i < 260; i++) { const x = R() * w, y = R() * h; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 4, y + 16); ctx.stroke(); } }
  if (pal.mood === 'snow') for (let i = 0; i < 220; i++) { ctx.globalAlpha = 0.4 + R() * 0.6; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(R() * w, R() * h, R() * 2.4, 0, 7); ctx.fill(); }
  if (has(text, /花|樱|春|勿忘我/)) for (let i = 0; i < 90; i++) {
    ctx.globalAlpha = 0.5 + R() * 0.5; ctx.fillStyle = has(text, /勿忘我/) ? '#8fb4ff' : '#ffc4d8';
    ctx.save(); ctx.translate(R() * w, R() * h); ctx.rotate(R() * 7); ctx.beginPath(); ctx.ellipse(0, 0, 4 + R() * 3, 2 + R() * 1.5, 0, 0, 7); ctx.fill(); ctx.restore();
  }
  ctx.globalAlpha = 1;

  // 胶片质感：漏光 + 颗粒 + 暗角
  glow(ctx, w * (R() > 0.5 ? 0.05 : 0.95), h * 0.2, w * 0.5, 'rgba(255,150,90,.22)');
  const img = ctx.getImageData(0, 0, w, h); const d = img.data;
  for (let i = 0; i < d.length; i += 4) { const n = (R() - 0.5) * 18; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  ctx.putImageData(img, 0, 0);
  const v = ctx.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, w * 0.75);
  v.addColorStop(0, 'transparent'); v.addColorStop(1, 'rgba(0,0,0,.6)'); ctx.fillStyle = v; ctx.fillRect(0, 0, w, h);

  const url = c.toDataURL('image/jpeg', 0.86);
  cache.set(key, url);
  return url;
}

// 封存状态下的抽象画：只用 id 和颜色，不泄露任何内容
export function paintSealed(memory, color, w = 640, h = 400) {
  const key = 'sealed:' + memory.id;
  if (cache.has(key)) return cache.get(key);
  const R = rng(memory.id);
  const c = document.createElement('canvas'); c.width = w; c.height = h; const ctx = c.getContext('2d');
  grad(ctx, w, h, ['#03050c', '#0b1226', '#141c3a']);
  for (let i = 0; i < 18; i++) glow(ctx, R() * w, R() * h, 40 + R() * 160, color, 0.12 + R() * 0.2);
  for (let i = 0; i < 300; i++) { ctx.globalAlpha = R(); ctx.fillStyle = '#fff'; ctx.fillRect(R() * w, R() * h, 1, 1); }
  ctx.globalAlpha = 1;
  const url = c.toDataURL('image/jpeg', 0.8); cache.set(key, url); return url;
}
