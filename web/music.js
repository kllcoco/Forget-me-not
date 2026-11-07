// 进入记忆之后的背景音乐：音乐文件夹里的每一首歌依次循环播放。
// 歌曲需要你自己放进去（例如你收藏的《可塑性记忆》OP / ED）：点「添加音乐」选文件、拖进页面，或直接复制进音乐文件夹。
const AUDIO_RE = /\.(mp3|m4a|aac|ogg|opus|flac|wav|webm)$/i
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

export function createMusic({ onToast }) {
  const audio = new Audio(); audio.preload = 'auto'; audio.volume = 0
  let tracks = [], dir = '', i = 0, wanted = true, fadeTimer = null, level = 0.55, blocked = false
  const fmt = t => !isFinite(t) || t < 0 ? '0:00' : `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`
  try { const v = Number(localStorage.getItem('fmn-volume')); if (v >= 0 && v <= 1 && localStorage.getItem('fmn-volume') !== null) level = v } catch { }
  const btn = document.querySelector('#musicbtn'), cap = document.querySelector('#nowplaying'), panel = document.querySelector('#musicpanel')

  function fade(to, ms = 1800) {
    clearInterval(fadeTimer)
    const from = audio.volume, t0 = performance.now()
    fadeTimer = setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / ms)
      audio.volume = from + (to - from) * k
      if (k >= 1) { clearInterval(fadeTimer); if (to === 0) audio.pause() }
    }, 50)
  }
  const playing = () => !audio.paused && wanted

  function render() {
    btn.classList.toggle('on', playing())
    btn.classList.toggle('blocked', blocked && tracks.length > 0)
    btn.classList.toggle('empty', !tracks.length)
    btn.querySelector('b').textContent = tracks.length ? '音乐' : '添加音乐'
    btn.title = tracks.length ? (blocked ? '浏览器拦住了自动播放：点一下开始' : playing() ? `正在播放：${tracks[i].name}` : '背景音乐') : '还没有歌：点这里添加'
    if (!panel.classList.contains('show')) return
    panel.innerHTML = `
      <button class="x" title="关闭">✕</button>
      <h5>背景音乐 <small>${tracks.length ? `${tracks.length} 首 · 循环播放` : ''}</small></h5>
      ${tracks.length ? `<div class="tracks">${tracks.map((t, k) => `<button class="${k === i ? 'cur' : ''}" data-k="${k}"><span>${k === i && playing() ? '♪' : String(k + 1).padStart(2, '0')}</span>${esc(t.name)}</button>`).join('')}</div>
      <div class="seek"><span class="t cur">${fmt(audio.currentTime)}</span><input type="range" class="pos" min="0" max="1000" step="1" value="${audio.duration ? Math.round(audio.currentTime / audio.duration * 1000) : 0}" title="拖动跳到这首歌的任意位置"><span class="t dur">${fmt(audio.duration)}</span></div>
      <div class="ctl"><button data-a="prev" title="上一首">⏮</button><button data-a="toggle" class="main" title="播放 / 暂停">${playing() ? '⏸' : '▶'}</button><button data-a="next" title="下一首">⏭</button>
        <span class="vol" title="音量">🔈</span><input type="range" class="volume" min="0" max="1" step="0.01" value="${level}" title="音量"></div>
      ${blocked ? '<p class="blocked">浏览器拦住了自动播放，点一下 ▶ 就开始</p>' : ''}`
        : `<p class="empty">还没有歌。点下面的「添加音乐」选几首喜欢的歌，或者把 mp3 / flac 直接拖进页面。进入记忆时会一首接一首循环播放。</p>`}
      <label class="chip on add">＋ 添加音乐<input type="file" accept="audio/*,.mp3,.m4a,.aac,.ogg,.opus,.flac,.wav,.webm" multiple hidden></label>
      ${dir ? `<div class="dir"><span>也可以直接把歌复制进这个文件夹：</span><code>${esc(dir)}</code><div><button data-a="copy">复制路径</button><button data-a="reload">刷新列表</button></div></div>` : ''}`
    panel.querySelector('.x').onclick = () => togglePanel(false)
    panel.querySelectorAll('[data-k]').forEach(b => b.onclick = () => { i = +b.dataset.k; audio.src = ''; wanted = true; play() })
    panel.querySelectorAll('[data-a]').forEach(b => b.onclick = () => act(b.dataset.a))
    const vol = panel.querySelector('input.volume')
    const pos = panel.querySelector('input.pos')
    if (pos) {
      // 拖进度条：拖的时候先不跟着播放进度跳，松手再跳过去
      pos.oninput = () => { seeking = true; const c = panel.querySelector('.seek .cur'); if (c && audio.duration) c.textContent = fmt(pos.value / 1000 * audio.duration) }
      pos.onchange = () => { seeking = false; if (!audio.duration) return; audio.currentTime = pos.value / 1000 * audio.duration; if (audio.paused) { wanted = true; play() } }
    }
    if (vol) vol.oninput = () => { level = +vol.value; clearInterval(fadeTimer); audio.volume = level; try { localStorage.setItem('fmn-volume', String(level)) } catch { } }
    panel.querySelector('.add input').onchange = e => { upload([...e.target.files]); e.target.value = '' }
  }
  let seeking = false
  // 播放进度：只更新进度条和时间，不整块重画（不然拖不动）
  audio.addEventListener('timeupdate', () => {
    if (!panel.classList.contains('show') || seeking) return
    const pos = panel.querySelector('input.pos'), c = panel.querySelector('.seek .cur'), d = panel.querySelector('.seek .dur')
    if (pos && audio.duration) pos.value = Math.round(audio.currentTime / audio.duration * 1000)
    if (c) c.textContent = fmt(audio.currentTime); if (d) d.textContent = fmt(audio.duration)
  })
  audio.addEventListener('loadedmetadata', () => { const d = panel.querySelector('.seek .dur'); if (d) d.textContent = fmt(audio.duration) })
  function announce() {
    if (!tracks.length) return
    cap.textContent = `♪ ${tracks[i].name}`; cap.classList.add('show')
    clearTimeout(announce.t); announce.t = setTimeout(() => cap.classList.remove('show'), 5000)
  }
  async function play() {
    if (!tracks.length) return
    if (!audio.src || !audio.src.endsWith(encodeURIComponent(tracks[i].file))) audio.src = `api/music/${encodeURIComponent(tracks[i].file)}`
    // 从一点点音量开始淡入：就算淡入的计时器被浏览器放慢，也不会一直没声音
    audio.volume = Math.min(level, Math.max(audio.volume, level * 0.35))
    try { await audio.play(); blocked = false; fade(level, 1200); announce() }
    catch (e) {
      // 浏览器不允许没点过就出声（拖文件进来不算「点过」）：记下来，下一次点任何地方就开始放
      if (e?.name === 'NotAllowedError') { blocked = true; onToast('<b>音乐</b>浏览器拦住了自动播放，点一下页面任意地方就开始放', '#c9a7ff') }
    }
    render()
  }
  function act(a) {
    if (a === 'toggle') { if (playing()) { wanted = false; fade(0, 600); setTimeout(render, 650) } else { wanted = true; play() } }
    if (a === 'next' || a === 'prev') { i = (i + (a === 'next' ? 1 : -1) + tracks.length) % tracks.length; audio.src = ''; wanted = true; play() }
    if (a === 'copy') navigator.clipboard?.writeText(dir).then(() => onToast('<b>音乐</b>文件夹路径已复制', '#c9a7ff'), () => { })
    if (a === 'reload') load()
  }
  audio.addEventListener('ended', () => { i = (i + 1) % tracks.length; audio.src = ''; play() })
  audio.addEventListener('play', render); audio.addEventListener('pause', render)

  async function load() {
    try { const j = await (await fetch('api/music')).json(); tracks = j.tracks || []; dir = j.dir || '' } catch { tracks = [] }
    if (i >= tracks.length) i = 0
    render()
  }
  async function upload(files) {
    files = files.filter(f => /^audio\//.test(f.type) || AUDIO_RE.test(f.name))
    if (!files.length) { onToast('<b>音乐</b>只支持 mp3 / m4a / aac / ogg / opus / flac / wav', '#ff8fa6'); return }
    let ok = 0, first = null
    for (const f of files) {
      try {
        const r = await fetch(`api/music?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f })
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status)
        const j = await r.json(); ok++; first = first || j.file
      } catch (e) { onToast(`<b>音乐</b>${esc(f.name)} 没有放进去：${esc(e.message)}`, '#ff8fa6') }
    }
    await load()
    if (!ok) return
    onToast(`<b>音乐</b>放进了 ${ok} 首歌`, '#c9a7ff')
    const k = tracks.findIndex(t => t.file === first); if (k >= 0) { i = k; audio.src = '' }
    wanted = true; play()
  }
  function togglePanel(show = !panel.classList.contains('show')) {
    panel.classList.toggle('show', show)
    if (show) load(); else render()
  }

  btn.onclick = e => { e.stopPropagation(); togglePanel() }
  document.addEventListener('pointerdown', e => { if (panel.classList.contains('show') && !panel.contains(e.target) && !btn.contains(e.target)) togglePanel(false) })
  // 浏览器不允许没点过就自动出声：第一次点击 / 按键时再开始（点音乐按钮本身不算，交给它自己）
  const kick = e => {
    if (!blocked && (btn.contains(e.target) || panel.contains(e.target))) return   // 点音乐按钮 / 面板本身交给它们自己
    if (wanted && audio.paused && tracks.length) play()
  }
  addEventListener('pointerdown', kick); addEventListener('keydown', kick)

  // 拖歌进来
  addEventListener('drop', e => {
    const files = [...(e.dataTransfer?.files || [])]
    if (!files.length) return
    e.preventDefault()   // 任何文件都不让浏览器自己打开（那样会离开页面）
    const songs = files.filter(f => /^audio\//.test(f.type) || AUDIO_RE.test(f.name))
    if (songs.length) upload(songs)
  })

  return { load, play }
}
