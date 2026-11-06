// 进入记忆之后的背景音乐：音乐文件夹里的每一首歌依次循环播放。
// 歌曲需要你自己放进去（例如你收藏的《可塑性记忆》OP / ED）：点「添加音乐」选文件、拖进页面，或直接复制进音乐文件夹。
const AUDIO_RE = /\.(mp3|m4a|aac|ogg|opus|flac|wav|webm)$/i
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

export function createMusic({ onToast }) {
  const audio = new Audio(); audio.preload = 'auto'; audio.volume = 0
  let tracks = [], dir = '', i = 0, wanted = true, fadeTimer = null, level = 0.55
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
    btn.classList.toggle('empty', !tracks.length)
    btn.querySelector('b').textContent = tracks.length ? '音乐' : '添加音乐'
    btn.title = tracks.length ? (playing() ? `正在播放：${tracks[i].name}` : '背景音乐') : '还没有歌：点这里添加'
    if (!panel.classList.contains('show')) return
    panel.innerHTML = `
      <button class="x" title="关闭">✕</button>
      <h5>背景音乐 <small>${tracks.length ? `${tracks.length} 首 · 循环播放` : ''}</small></h5>
      ${tracks.length ? `<div class="tracks">${tracks.map((t, k) => `<button class="${k === i ? 'cur' : ''}" data-k="${k}"><span>${k === i && playing() ? '♪' : String(k + 1).padStart(2, '0')}</span>${esc(t.name)}</button>`).join('')}</div>
      <div class="ctl"><button data-a="prev" title="上一首">⏮</button><button data-a="toggle" class="main" title="播放 / 暂停">${playing() ? '⏸' : '▶'}</button><button data-a="next" title="下一首">⏭</button>
        <input type="range" min="0" max="1" step="0.01" value="${level}" title="音量"></div>`
        : `<p class="empty">还没有歌。点下面的「添加音乐」选几首喜欢的歌，或者把 mp3 / flac 直接拖进页面。进入记忆时会一首接一首循环播放。</p>`}
      <label class="chip on add">＋ 添加音乐<input type="file" accept="audio/*,.mp3,.m4a,.aac,.ogg,.opus,.flac,.wav,.webm" multiple hidden></label>
      ${dir ? `<div class="dir"><span>也可以直接把歌复制进这个文件夹：</span><code>${esc(dir)}</code><div><button data-a="copy">复制路径</button><button data-a="reload">刷新列表</button></div></div>` : ''}`
    panel.querySelector('.x').onclick = () => togglePanel(false)
    panel.querySelectorAll('[data-k]').forEach(b => b.onclick = () => { i = +b.dataset.k; audio.src = ''; wanted = true; play() })
    panel.querySelectorAll('[data-a]').forEach(b => b.onclick = () => act(b.dataset.a))
    const vol = panel.querySelector('input[type=range]')
    if (vol) vol.oninput = () => { level = +vol.value; clearInterval(fadeTimer); audio.volume = level; try { localStorage.setItem('fmn-volume', String(level)) } catch { } }
    panel.querySelector('.add input').onchange = e => { upload([...e.target.files]); e.target.value = '' }
  }
  function announce() {
    if (!tracks.length) return
    cap.textContent = `♪ ${tracks[i].name}`; cap.classList.add('show')
    clearTimeout(announce.t); announce.t = setTimeout(() => cap.classList.remove('show'), 5000)
  }
  async function play() {
    if (!tracks.length) return
    if (!audio.src || !audio.src.endsWith(encodeURIComponent(tracks[i].file))) audio.src = `api/music/${encodeURIComponent(tracks[i].file)}`
    try { await audio.play(); fade(level); announce() } catch { /* 浏览器要求先有一次点击 */ }
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
  const kick = e => { if (btn.contains(e.target) || panel.contains(e.target)) return; if (wanted && audio.paused && tracks.length) play() }
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
