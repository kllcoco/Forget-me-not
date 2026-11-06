// DeepSeek Harness 浏览器端：左侧栏加一个「记忆」入口。
// 点开就全屏（盖住 dsh 左侧栏）播放莫比乌斯星环的过场动画；按 Esc 才退出全屏。
// dsh 用 lazy-CJS 格式加载插件的浏览器包；react 由 dsh 提供。
window.__ModuleLoader__.load({ id: "dsh-forget-me-not", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
var React = require("react");
var h = React.createElement;
var PANEL_ID = "forget-me-not";
var SRC = "/forget-me-not/?embed=dsh";

// 勿忘我小花：五片花瓣 + 花心
function MemoryIcon(props) {
  var size = (props && props.size) || 20;
  var petals = [];
  for (var i = 0; i < 5; i++) {
    var a = (i / 5) * Math.PI * 2 - Math.PI / 2;
    petals.push(h("circle", { key: i, cx: 12 + Math.cos(a) * 4.6, cy: 12 + Math.sin(a) * 4.6, r: 3.6, fill: "none", stroke: "currentColor", strokeWidth: 1.4 }));
  }
  petals.push(h("circle", { key: "c", cx: 12, cy: 12, r: 1.7, fill: "currentColor" }));
  return h("svg", { width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": true }, petals);
}

function MemoryPage() {
  var st = React.useState(true), full = st[0], setFull = st[1];
  var wrap = React.useRef(null), frame = React.useRef(null);

  React.useEffect(function () {
    function enter() {
      setFull(true);
      var el = wrap.current;
      // 刚点过侧栏，浏览器还认这次点击，可以直接进真正的全屏；不行的话也会铺满整个窗口
      if (el && el.requestFullscreen && !document.fullscreenElement) el.requestFullscreen().catch(function () {});
      setTimeout(function () { if (frame.current) frame.current.focus(); }, 60);
    }
    function leave() {
      if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
      setFull(false);
    }
    function onMsg(e) {
      if (e.origin !== location.origin || !e.data) return;
      if (e.data.type === "fmn:escape") leave();
      else if (e.data.type === "fmn:fullscreen") enter();
    }
    function onFs() { if (!document.fullscreenElement) setFull(false); }
    function onKey(e) { if (e.key === "Escape") leave(); }
    window.addEventListener("message", onMsg);
    document.addEventListener("fullscreenchange", onFs);
    window.addEventListener("keydown", onKey);
    enter();
    return function () {
      window.removeEventListener("message", onMsg);
      document.removeEventListener("fullscreenchange", onFs);
      window.removeEventListener("keydown", onKey);
      if (document.fullscreenElement && document.fullscreenElement === wrap.current) document.exitFullscreen().catch(function () {});
    };
  }, []);

  React.useEffect(function () {
    var w = frame.current && frame.current.contentWindow;
    if (w) w.postMessage({ type: "fmn:fullscreen-state", full: full }, location.origin);
  }, [full]);

  var style = full
    ? { position: "fixed", inset: 0, zIndex: 2147483000, background: "#02040a" }
    : { position: "relative", flex: 1, width: "100%", height: "100%", minHeight: 0, background: "#02040a", overflow: "hidden" };
  return h("div", { ref: wrap, style: style },
    h("iframe", { ref: frame, src: SRC, title: "勿忘我 · 记忆星环", allow: "fullscreen; autoplay", style: { position: "absolute", inset: 0, width: "100%", height: "100%", border: 0, display: "block" } }));
}

exports.name = "forget-me-not-client";
exports.inject = ["slots"];
exports.apply = function apply(ctx) {
  ctx.slots.inject("main", function () {
    return ctx.slots.register({ name: "main", key: PANEL_ID }, MemoryPage);
  });
  ctx.slots.inject("sidebar.panellist", function () {
    return ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 20, label: "记忆" }, MemoryIcon);
  });
};
return module.exports; } });
