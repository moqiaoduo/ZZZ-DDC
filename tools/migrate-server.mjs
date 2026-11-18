#!/usr/bin/env node
/**
 * 本地存档迁移小工具页。
 *
 *   node tools/migrate-server.mjs            # 默认 http://127.0.0.1:8788
 *   node tools/migrate-server.mjs --port 9000
 *
 * 为什么需要「本地起个服务」而不是纯前端双击打开 html：
 * 浏览器里 file:// 页面不能 fetch 本地文件做二次处理，而旧站导出的 JSON 需要
 * 逐条归一角色名、合并改名前后两份键。这一步必须有个能跑 JS 的地方，
 * 又不该把用户的存档上传到任何服务器——所以起在 127.0.0.1，只监听本机。
 *
 * 它做不到什么（重要）：
 *   localStorage 按 origin 隔离。旧站的档在 qfmyqqx.github.io 下，新站的档要在
 *   新站 origin 下写入。node 读不到浏览器存储，所以「导出」必须在旧站页面里做
 *   （tools/export-legacy-saves.js），「回写」必须在新站页面里做（本页生成的
 *   apply-in-console.js）。这个工具只负责中间那段「转换 + 预览」。
 *
 * 依赖：只用 node 内置模块 + 本仓库 tools/lib/ 下的两个文件。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRoleTablesFromHtml } from './lib/html-tables.mjs';
import {
  buildRoleTables,
  migrateLegacyExport,
  buildApplyScript,
  buildReportMarkdown,
  LEGACY_FORMAT,
} from './lib/legacy-migration-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function parseArgs(argv) {
  const out = { port: 8788, html: path.join(ROOT, 'index.html') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') out.port = Number(argv[++i]);
    else if (argv[i] === '--html') out.html = path.resolve(argv[++i]);
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`用法：node tools/migrate-server.mjs [--port 8788] [--html index.html]`);
  process.exit(0);
}

// 角色表在启动时读一次：如果三张表对不上（有角色归不到 ID、或有孤儿 ID），
// 宁可起不来，也不要在转换时静默认错角色。
let tables;
try {
  const raw = loadRoleTablesFromHtml(args.html);
  tables = buildRoleTables(raw);
} catch (e) {
  console.error('读取角色表失败：' + e.message);
  process.exit(1);
}
if (!tables.ok) {
  console.error('角色表自检未通过，已中止（避免写出错误的存档键）：');
  if (tables.unresolvedNames.length) console.error('  归不到 ID 的角色：' + tables.unresolvedNames.join('、'));
  if (tables.orphanIds.length) console.error('  ENKA_ID_MAP 里没有对应角色的 ID：' + tables.orphanIds.join('、'));
  process.exit(1);
}

const ROLE_COUNT = Object.keys(tables.ID_TO_NAME).length;

/**
 * 演示数据：地址后加 ?sample=1 时用它跑一遍完整路径。
 * 刻意覆盖五种情况——正常、改名前后两份键合并、缺别名角色、已删除角色、坏数据，
 * 这样预览里每一块（已搬运 / 名字不一致 / 隔离）都能被看见。
 */
const SAMPLE = {
  format: LEGACY_FORMAT,
  version: 1,
  exportedAt: '2026-11-18T05:00:00.000Z',
  source: 'qfmyqqx.github.io/ZZZ-DDC',
  origin: 'https://qfmyqqx.github.io',
  characters: {
    '艾莲': { saves: [{ name: '1号存档,速刷', data: { charName: '艾莲', positions: [1, 0, 1, 0, 0, 0] } }] },
    '扳机': { saves: [{ name: '改名前的档', data: { charName: '扳机', positions: [1, 1, 0, 0, 0, 0] } }] },
    '「扳机」': { saves: [{ name: '改名后的档', data: { charName: '「扳机」', positions: [0, 0, 1, 1, 0, 0] } }] },
    '猫又': { saves: [{ name: '缺别名的角色', data: { charName: '猫又', positions: [1, 0, 0, 0, 0, 0] } }] },
    '已删除角色': { saves: [{ name: '孤儿存档', data: { charName: '已删除角色' } }] },
    '坏掉的键': { broken: true, raw: '{not json' },
    '空角色': { saves: [] },
  },
  settings: { autoCollapseImport: true, autoCollapseOutput: false, someUnknownKey: 1 },
  warnings: [],
  stats: { saveKeys: 7, charactersWithSaves: 5, totalSaves: 5 },
  otherKeys: ['some-other-app'],
};

/* ------------------------------------------------------------------ *
 * 页面本体（单文件，内嵌在服务端，避免多一个静态目录要管）
 * ------------------------------------------------------------------ */
const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>旧站存档迁移 · 本地工具</title>
<style>
  :root { --bg:#12141a; --card:#1b1e26; --line:#2b303c; --fg:#e6e8ee; --dim:#9aa3b2; --ok:#4ade80; --warn:#fbbf24; --err:#f87171; --accent:#60a5fa; }
  * { box-sizing: border-box; }
  body { margin:0; padding:32px 20px 64px; background:var(--bg); color:var(--fg);
         font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif; }
  .wrap { max-width: 880px; margin: 0 auto; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:var(--dim); margin-bottom:24px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:20px; margin-bottom:16px; }
  .card h2 { font-size:14px; margin:0 0 12px; color:var(--dim); font-weight:600; letter-spacing:.4px; }
  #drop { border:2px dashed var(--line); border-radius:10px; padding:36px 20px; text-align:center;
          color:var(--dim); cursor:pointer; transition:.15s; }
  #drop.hot { border-color:var(--accent); color:var(--accent); background:rgba(96,165,250,.06); }
  #drop.done { border-style:solid; border-color:var(--ok); color:var(--ok); }
  .steps { counter-reset:s; padding:0; margin:0; list-style:none; }
  .steps li { counter-increment:s; position:relative; padding-left:28px; margin-bottom:8px; color:var(--dim); }
  .steps li::before { content:counter(s); position:absolute; left:0; top:1px; width:18px; height:18px;
      border-radius:50%; background:var(--line); color:var(--fg); font-size:11px; text-align:center; line-height:18px; }
  .steps code { background:#0d0f14; padding:1px 5px; border-radius:4px; color:var(--fg); font-size:12px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); }
  th { color:var(--dim); font-weight:500; }
  .num { color:var(--ok); font-weight:600; }
  .warn { color:var(--warn); } .err { color:var(--err); }
  .btns { display:flex; gap:10px; flex-wrap:wrap; margin-top:16px; }
  button { background:var(--accent); color:#0b1220; border:0; border-radius:7px; padding:9px 16px;
           font:inherit; font-weight:600; cursor:pointer; }
  button.ghost { background:transparent; color:var(--fg); border:1px solid var(--line); }
  button:hover { filter:brightness(1.1); }
  button:disabled { opacity:.4; cursor:not-allowed; }
  .msg { margin-top:12px; white-space:pre-wrap; font-size:13px; }
  .hide { display:none; }
  ul.plain { margin:6px 0 0; padding-left:18px; color:var(--dim); }
</style>
</head>
<body>
<div class="wrap">
  <h1>旧站存档迁移</h1>
  <div class="sub">本地处理，文件不离开这台电脑。角色表已从 index.html 加载（${ROLE_COUNT} 个角色）。</div>

  <div class="card">
    <h2>准备工作</h2>
    <ol class="steps">
      <li>打开<b>旧站</b>，F12 → Console，粘贴 <code>tools/export-legacy-saves.js</code> 全文并回车，会下载一个 json。</li>
      <li>把这个 json 拖到下面的框里。</li>
      <li>下载生成的 <code>apply-in-console.js</code>，到<b>新站</b>的 Console 里粘贴执行。</li>
    </ol>
  </div>

  <div class="card">
    <h2>1 · 拖入旧站导出的 json</h2>
    <div id="drop">把 json 拖到这里，或点击选择文件</div>
    <input type="file" id="file" accept=".json,application/json" class="hide">
    <div class="msg" id="msg"></div>
  </div>

  <div class="card hide" id="result">
    <h2>2 · 预览</h2>
    <div id="summary"></div>
    <div id="tables"></div>
    <div class="btns">
      <button id="dlApply">下载 apply-in-console.js</button>
      <button class="ghost" id="dlJson">下载 migrated.json</button>
      <button class="ghost" id="dlReport">下载 report.md</button>
    </div>
  </div>
</div>

<script>
(function () {
  'use strict';
  var drop = document.getElementById('drop');
  var fileInput = document.getElementById('file');
  var msg = document.getElementById('msg');
  var result = document.getElementById('result');
  var state = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function esc(s) { return String(s == null ? '' : s); }
  // 旧键名里常带「」书名号，报告里再包一层就成「「扳机」」了
  function bare(s) { return esc(s).replace(/^[「『]+|[」』]+$/g, ''); }

  drop.addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () { if (fileInput.files[0]) handleFile(fileInput.files[0]); });

  ['dragenter', 'dragover'].forEach(function (e) {
    drop.addEventListener(e, function (ev) { ev.preventDefault(); drop.classList.add('hot'); });
  });
  ['dragleave', 'drop'].forEach(function (e) {
    drop.addEventListener(e, function (ev) { ev.preventDefault(); drop.classList.remove('hot'); });
  });
  drop.addEventListener('drop', function (ev) {
    var f = ev.dataTransfer.files[0];
    if (f) handleFile(f);
  });

  function handleFile(file) {
    msg.className = 'msg';
    msg.textContent = '正在读取 ' + file.name + ' …';
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try {
        parsed = JSON.parse(reader.result);
      } catch (e) {
        msg.className = 'msg err';
        msg.textContent = '这个文件不是合法 JSON：' + e.message;
        return;
      }
      send(parsed, file.name);
    };
    reader.onerror = function () {
      msg.className = 'msg err';
      msg.textContent = '读文件失败。';
    };
    reader.readAsText(file, 'utf-8');
  }

  function send(legacy, fileName) {
    msg.className = 'msg';
    msg.textContent = '正在转换…';
    fetch('/api/migrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ legacy: legacy })
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (!res.ok) {
        msg.className = 'msg err';
        msg.textContent = res.error || '转换失败。';
        result.classList.add('hide');
        return;
      }
      state = { res: res, fileName: fileName };
      drop.classList.add('done');
      drop.textContent = '已转换：' + fileName;
      msg.textContent = '';
      render(res);
    }).catch(function (e) {
      msg.className = 'msg err';
      msg.textContent = '请求失败：' + e.message;
    });
  }

  function render(res) {
    result.classList.remove('hide');
    var rep = res.report;
    var summary = document.getElementById('summary');
    summary.innerHTML = '';

    var totalSaves = rep.ok.reduce(function (s, x) { return s + x.count; }, 0);
    var line = el('div');
    line.innerHTML = '成功搬运 <span class="num">' + totalSaves + '</span> 条存档，覆盖 <span class="num">' +
      rep.ok.length + '</span> 个角色';
    if (rep.quarantined.length) line.innerHTML += '；<span class="warn">' + rep.quarantined.length + ' 个角色被隔离</span>';
    if (rep.skipped.length) line.innerHTML += '；跳过 ' + rep.skipped.length + ' 个空键';
    summary.appendChild(line);

    var tables = document.getElementById('tables');
    tables.innerHTML = '';

    if (rep.ok.length) {
      tables.appendChild(el('h2', null, '已搬运'));
      var t = el('table');
      var head = el('tr');
      ['角色', '稳定 ID', '旧键名', '存档数'].forEach(function (h) { head.appendChild(el('th', null, h)); });
      t.appendChild(head);
      rep.ok.forEach(function (x) {
        var tr = el('tr');
        tr.appendChild(el('td', null, esc(x.charName)));
        tr.appendChild(el('td', 'num', String(x.charId)));
        tr.appendChild(el('td', null, esc(x.legacyName)));
        tr.appendChild(el('td', null, String(x.count)));
        t.appendChild(tr);
      });
      tables.appendChild(t);
    }

    if (rep.renamed.length) {
      tables.appendChild(el('h2', null, '键名与记录内名字不一致（已按键名归一）'));
      var ul = el('ul', 'plain');
      rep.renamed.forEach(function (x) {
        var li;
        if (x.mergedInto) li = '「' + bare(x.legacyName) + '」→ ' + x.mergedInto + '（' + x.note + '）';
        else li = '存档「' + x.saveName + '」记录内写「' + bare(x.insideCharName) + '」，键名「' + bare(x.legacyName) + '」→ ' + x.resolvedTo + '(' + x.charId + ')';
        ul.appendChild(el('li', null, li));
      });
      tables.appendChild(ul);
    }

    if (rep.quarantined.length) {
      tables.appendChild(el('h2', 'warn', '隔离（未写入，原始数据仍在 migrated.json 里）'));
      var ul2 = el('ul', 'plain');
      rep.quarantined.forEach(function (x) {
        ul2.appendChild(el('li', 'err', x.charName + '：' + x.reason));
      });
      tables.appendChild(ul2);
    }

    if (rep.settings && rep.settings.droppedUnknown.length) {
      tables.appendChild(el('h2', null, '设置项'));
      tables.appendChild(el('div', 'plain', '已迁移：' + (Object.keys(rep.settings.migrated).join('、') || '无') +
        '；不认识未迁移：' + rep.settings.droppedUnknown.join('、')));
    }
  }

  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  document.getElementById('dlApply').addEventListener('click', function () {
    if (!state) return;
    download('apply-in-console.js', state.res.applyScript, 'text/javascript;charset=utf-8');
  });
  document.getElementById('dlJson').addEventListener('click', function () {
    if (!state) return;
    download('migrated.json', JSON.stringify(state.res.payload, null, 2), 'application/json');
  });
  document.getElementById('dlReport').addEventListener('click', function () {
    if (!state) return;
    download('migrated.md', state.res.reportMarkdown, 'text/markdown;charset=utf-8');
  });

  // 调试口：不想拖文件时，可以在 Console 里直接
  //   __migrateTool.send(<旧站导出对象>)
  // 走一遍和拖拽完全相同的转换与渲染路径。
  window.__migrateTool = { send: send, render: render };

  // 演示/自检模式：地址后面加 ?sample=1，用一份假数据跑一遍，
  // 确认页面、转换、预览三处都正常，不需要真的去旧站导一份。
  if (/[?&]sample=1/.test(location.search)) {
    send(${JSON.stringify(SAMPLE)}, '(示例数据)');
  }
})();
</script>
</body>
</html>`;

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */
const MAX_BODY = 32 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大（上限 32MB）')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(PAGE);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/migrate') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      sendJson(res, 413, { ok: false, error: e.message });
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: '请求不是合法 JSON：' + e.message });
      return;
    }
    const legacy = parsed && parsed.legacy;
    const out = migrateLegacyExport(legacy, tables);
    if (!out.ok) {
      sendJson(res, 400, { ok: false, error: out.error });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      payload: out.payload,
      report: out.report,
      applyScript: buildApplyScript(out.payload.keys),
      reportMarkdown: buildReportMarkdown(out.payload, out.report, new Date().toISOString()),
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: '没有这个路径：' + url.pathname });
});

let port = args.port;
let attempts = 0;
server.on('error', err => {
  if (err.code === 'EADDRINUSE' && attempts < 10) {
    attempts++;
    port++;
    server.listen(port, '127.0.0.1');
    return;
  }
  console.error('服务启动失败：' + err.message);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  console.log('');
  console.log('  旧站存档迁移工具已启动');
  console.log('  打开：http://127.0.0.1:' + port + '/');
  console.log('');
  console.log('  角色表：' + ROLE_COUNT + ' 个（自检通过，无孤儿 ID）');
  console.log('  旧站导出格式：' + LEGACY_FORMAT);
  console.log('');
  console.log('  只监听 127.0.0.1，文件不离开这台电脑。Ctrl-C 结束。');
  console.log('');
});