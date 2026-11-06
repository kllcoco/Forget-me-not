// 进入记忆之后的背景音乐：音乐文件夹里的每一首歌依次循环播放。
// 歌曲需要你自己放进去（例如你收藏的《可塑性记忆》OP / ED），或者直接拖进页面。
export function createMusic({ onToast }) {
  const audio = new Audio(); audio.preload = 'auto'; audio.volume = 0;
  let tracks = [], i = 0, wanted = true, fadeTimer = null;
  const btn = document.querySelector('#musicbtn'), cap = document.querySelector('#nowplaying');

  function fade(to, ms = 1800) {
    clearInterval(fadeTimer);
    const from = audio.volume, t0 = performance.now();
    fadeTimer = setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      audio.volume = from + (to - from) * k;
      if (k >= 1) { clearInterval(fadeTimer); if (to === 0) audio.pause(); }
    }, 50);
  }
  function render() {
    btn.classList.toggle('on', !audio.paused);
    btn.classList.toggle('empty', !tracks.length);
    btn.title = tracks.length ? (audio.paused ? '播放音乐' : `正在播放：${tracks[i].name}（点一下暂停）`) : '把喜欢的歌拖进页面，进入记忆时会循环播放';
  }
  function announce() {
    if (!tracks.length) return;
    cap.textContent = `♪ ${tracks[i].name}`; cap.classList.add('show');
    clearTimeout(announce.t); announce.t = setTimeout(() => cap.classList.remove('show'), 5000);
  }
  async function play() {
    if (!tracks.length) return;
    if (!audio.src || !audio.src.endsWith(encodeURIComponent(tracks[i].file))) audio.src = `api/music/${encodeURIComponent(tracks[i].file)}`;
    try { await audio.play(); fade(0.55); announce(); } catch { /* 浏览器要求先有一次点击 */ }
    render();
  }
  audio.addEventListener('ended', () => { i = (i + 1) % tracks.length; audio.src = ''; play(); });
  audio.addEventListener('play', render); audio.addEventListener('pause', render);

  async function load() {
    try { tracks = (await (await fetch('api/music')).json()).tracks || []; } catch { tracks = []; }
    if (i >= tracks.length) i = 0;
    render();
  }

  btn.onclick = () => {
    if (!tracks.length) { onToast('<b>音乐</b>把喜欢的歌（mp3 / m4a / flac…）拖进页面，进入记忆时就会循环播放', '#c9a7ff'); return; }
    if (audio.paused) { wanted = true; play(); } else { wanted = false; fade(0, 600); }
  };
  // 浏览器不允许没点过就自动出声：第一次点击 / 按键时再开始
  const kick = () => { if (wanted && audio.paused) play(); };
  addEventListener('pointerdown', kick); addEventListener('keydown', kick);

  // 拖歌进来
  addEventListener('dragover', e => { if ([...e.dataTransfer.items].some(x => x.kind === 'file')) e.preventDefault(); });
  addEventListener('drop', async e => {
    const files = [...e.dataTransfer.files].filter(f => /^audio\//.test(f.type) || /\.(mp3|m4a|aac|ogg|opus|flac|wav|webm)$/i.test(f.name));
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) {
      const r = await fetch(`api/music?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
      if (!r.ok) onToast(`<b>音乐</b>${f.name} 没有放进去`, '#ff8fa6');
    }
    await load();
    onToast(`<b>音乐</b>放进了 ${files.length} 首歌`, '#c9a7ff');
    const first = tracks.findIndex(t => t.file === files[0].name); if (first >= 0) { i = first; audio.src = ''; }
    wanted = true; play();
  });

  return { load, play };
}
