// 每条内容下面加三个按钮：牛逼 / 收到 / 无聊，外加一行 AI 的判断（档位、分数、理由）。
// 没有用户反馈时，AI 选的那个按钮用虚线框标出来当建议；用户点任何按钮就是最终反馈，实心显示。
// 靠一段启动脚本在页面上找 /items/<id> 的卡片链接，不改引擎的组件；页面内跳转后由 MutationObserver 补上。
import type { WebModule } from "@aihot/web/modules";

const BOOT = String.raw`(function () {
  if (window.__markBoot) return; window.__markBoot = 1;
  var LABELS = [["niubi", "牛逼"], ["received", "收到"], ["boring", "无聊"]];
  var ZH = { niubi: "牛逼", received: "收到", boring: "无聊" };
  var ON = { niubi: "#16a34a", received: "#6b7280", boring: "#dc2626" };
  // 卡片亮度跟档位走：无聊最暗、收到中等、牛逼最亮并带绿色左边。用户反馈优先于 AI 判断。
  var DIM = { niubi: "1", received: "0.72", boring: "0.4" };
  // 只给列表里的卡片上色；详情页标题下那一条（data-detail）不动页面，否则整篇正文会被调暗、整列加绿线。
  function shade(bar, label) {
    if (bar.getAttribute("data-detail")) return;
    var host = bar.parentElement;
    if (!host) return;
    if (host.getAttribute("data-mark-pad") === null) host.setAttribute("data-mark-pad", host.style.paddingLeft || "");
    host.style.transition = "opacity .2s";
    host.style.opacity = label ? DIM[label] : "1";
    var green = label === "niubi";
    host.style.boxShadow = green ? "inset 3px 0 0 " + ON.niubi : "";
    // 卡片本身没有左内边距时，绿线会压住文字，补一点
    var pad = parseFloat(getComputedStyle(host).paddingLeft) || 0;
    host.style.paddingLeft = green && pad < 8 ? "10px" : host.getAttribute("data-mark-pad");
  }
  function idOf(a) { var m = /^\/items\/([a-z0-9]+)/.exec(a.getAttribute("href") || ""); return m && m[1]; }
  function onlyThis(el, id) {
    if (el.querySelector("h1")) return false;
    var links = el.querySelectorAll('a[href^="/items/"]');
    for (var k = 0; k < links.length; k++) { if (idOf(links[k]) !== id) return false; }
    return true;
  }
  // 卡片：列表页用卡片自己的 article（按钮放在卡片框里面）。
  // 详情页正文也是 article（含 h1），里面「事件后续」的链接不能把整篇正文当卡片：
  // 这时从链接往上找只包含这一篇文章链接的最大块。
  function hostFor(a, id) {
    var art = a.closest("article");
    if (art && onlyThis(art, id)) return art;
    var el = a;
    while (el.parentElement && el.parentElement !== document.body && onlyThis(el.parentElement, id)) el = el.parentElement;
    return el === a ? a.parentElement : el;
  }
  function paint(bar, userLabel, ai) {
    var buttons = bar.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i], l = b.getAttribute("data-label");
      var on = userLabel && l === userLabel;
      var hint = !userLabel && ai && l === ai.label;
      b.style.background = on ? ON[l] : "transparent";
      b.style.color = on ? "#fff" : (hint ? ON[l] : "inherit");
      b.style.borderColor = (on || hint) ? ON[l] : "rgba(128,128,128,.45)";
      b.style.borderStyle = hint ? "dashed" : "solid";
      b.style.fontWeight = hint ? "600" : "400";
    }
    shade(bar, userLabel || (ai && ai.label) || null);
    var line = bar.querySelector(".mark-ai");
    if (line) {
      if (ai) {
        line.textContent = "";
        // 详情页：理由已经出现在页面上（没中文摘要时「AI 导读」退回用的就是这句理由），就只写档位和分数
        var dup = bar.getAttribute("data-detail") && ai.reason && (document.querySelector("main") || document.body).textContent.indexOf(ai.reason) >= 0;
        line.textContent = "AI：" + ZH[ai.label] + " " + Math.round(ai.score) + (ai.reason && !dup ? " · " + ai.reason : "");
        line.title = (ai.fact ? "触发事实：" + ai.fact : "") + (ai.version ? "\n版本：" + ai.version : "");
        line.hidden = false;
      } else { line.hidden = true; }
    }
  }
  var STATE = {};
  function send(id, label) {
    fetch("/api/mark", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: id, label: label }) })
      .then(function (r) { if (r.status === 401 && !STATE.__askedLogin) { STATE.__askedLogin = 1; if (window.confirm("记反馈要先登录后台。现在去 /admin 登录？")) location.href = "/admin"; } if (r.ok) { STATE[id] = STATE[id] || {}; STATE[id].user = label; var all = document.querySelectorAll('.mark-bar[data-mark-id="' + id + '"]'); for (var i = 0; i < all.length; i++) paint(all[i], label, STATE[id].ai); } })
      .catch(function () {});
  }
  function bar(id) {
    var d = document.createElement("div");
    d.className = "mark-bar"; d.setAttribute("data-mark-id", id);
    d.style.cssText = "position:relative;z-index:5;margin-top:8px;font-size:12px;line-height:1.4;";
    var line = document.createElement("div");
    line.className = "mark-ai"; line.hidden = true;
    // 卡片上默认收成一行，点一下展开全文（详情页始终全文）
    line.addEventListener("click", function (e) { if (d.getAttribute("data-detail")) return; e.preventDefault(); e.stopPropagation(); line.classList.toggle("open"); });
    d.appendChild(line);
    var row = document.createElement("div");
    row.className = "mark-row";
    LABELS.forEach(function (p) {
      var b = document.createElement("button");
      b.type = "button"; b.textContent = p[1]; b.setAttribute("data-label", p[0]);
      b.style.cssText = "border:1px solid rgba(128,128,128,.45);border-radius:999px;background:transparent;color:inherit;cursor:pointer;font:inherit;";
      b.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); send(id, p[0]); });
      row.appendChild(b);
    });
    d.appendChild(row);
    return d;
  }
  function scan() {
    var ids = [], seen = {};
    var anchors = document.querySelectorAll('a[href^="/items/"]');
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i], id = idOf(a);
      if (!id || seen[id]) continue;
      var host = hostFor(a, id);
      if (!host || host.querySelector(".mark-bar")) { seen[id] = 1; continue; }
      seen[id] = 1; host.appendChild(bar(id)); ids.push(id);
    }
    var m = /^\/items\/([a-z0-9]+)/.exec(location.pathname);
    if (m && !document.querySelector('.mark-bar[data-mark-id="' + m[1] + '"]')) {
      var h = document.querySelector("main h1") || document.querySelector("h1");
      if (h) { var db = bar(m[1]); db.setAttribute("data-detail", "1"); db.style.margin = "10px 0 14px"; h.insertAdjacentElement("afterend", db); ids.push(m[1]); }
    }
    if (!ids.length) return;
    fetch("/api/mark?ids=" + ids.join(","))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var marks = (j && j.marks) || {}, ai = (j && j.ai) || {};
        for (var k = 0; k < ids.length; k++) {
          var id = ids[k];
          STATE[id] = { user: marks[id] || null, ai: ai[id] || null };
          var bars = document.querySelectorAll('.mark-bar[data-mark-id="' + id + '"]');
          for (var q = 0; q < bars.length; q++) paint(bars[q], STATE[id].user, STATE[id].ai);
        }
      })
      .catch(function () {});
  }
  // 样式放一处：按钮在触屏上放大到 44px 高；AI 那一行用正文色加透明度，深浅主题下对比度都够（以前写死 #6b7280，深色下只有 3.67）
  var CSS = ".mark-row{display:flex;gap:6px;line-height:1}" +
    ".mark-row button{padding:4px 10px;font-size:12px;min-height:24px}" +
    "@media (pointer:coarse){.mark-row{gap:10px}.mark-row button{padding:0 18px;font-size:14px;min-height:44px}}" +
    ".mark-ai{margin-bottom:6px;font-size:12px;opacity:.78;white-space:normal;cursor:pointer}" +
    ".mark-ai[hidden]{display:none}" +
    ".mark-bar:not([data-detail]) .mark-ai:not(.open){display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}" +
    ".mark-bar[data-detail] .mark-ai{cursor:auto}";
  function boot() {
    var st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
    scan();
    new MutationObserver(function () { clearTimeout(window.__markTimer); window.__markTimer = setTimeout(scan, 200); })
      .observe(document.body, { childList: true, subtree: true });
  }
  // 等页面 hydration 完成再动 DOM，否则 React 会报 hydration 不一致。
  if (document.readyState === "complete") setTimeout(boot, 400); else window.addEventListener("load", function () { setTimeout(boot, 400); });
})();`;

export const web: WebModule = {
  name: "mark",
  root: { bootScript: BOOT },
};
