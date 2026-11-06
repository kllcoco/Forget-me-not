// DeepSeek Harness 浏览器端：左侧栏加一个「记忆」入口，点开就是整页的记忆星环（开场就是莫比乌斯星环的过场动画）。
// dsh 用 lazy-CJS 格式加载插件的浏览器包；react 由 dsh 提供。
window.__ModuleLoader__.load({ id: "forget-me-not", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
var React = require("react");
var h = React.createElement;
var PANEL_ID = "forget-me-not";
var SRC = "/forget-me-not/";

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
  return h("div", { style: { position: "relative", flex: 1, width: "100%", height: "100%", minHeight: 0, background: "#02040a", overflow: "hidden" } },
    h("iframe", { src: SRC, title: "勿忘我 · 记忆星环", allow: "fullscreen", style: { position: "absolute", inset: 0, width: "100%", height: "100%", border: 0, display: "block" } }));
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
