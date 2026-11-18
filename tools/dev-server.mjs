#!/usr/bin/env node
/**
 * 本地开发服务。
 *
 *   node tools/dev-server.mjs                 # 服务仓库根，http://127.0.0.1:5173
 *   node tools/dev-server.mjs --root build    # 服务 tools/split-index.mjs 的产物
 *   node tools/dev-server.mjs --port 9000 --no-reload
 *
 * 为什么不用 python3 -m http.server：
 *   1. .mjs / .js 的 MIME 必须正确，否则 <script type="module"> 直接不执行；
 *   2. 开发时要保证「改了刷新就能看到」，python 的 http.server 在某些版本上
 *      会带缓存头，改完看见旧的很难查；
 *   3. build/ 里的图片是符号链接（split-index.mjs 故意不复制 4MB 图片），
 *      需要一个会跟随软链、并且能限制在仓库内的静态服务。
 *
 * 自动刷新：往 HTML 响应末尾注入一小段脚本，监听 SSE /__reload，文件一变就让
 * 页面 location.reload()。注入只发生在 HTML，不影响 src/ 下的 js/css。
 * 不想要就加 --no-reload——注入会让「浏览器拿到的 HTML」与磁盘上的不完全一致，
 * 做逐字节比对时要用 --no-reload。
 *
 * 安全边界：默认只监听 127.0.0.1（本机）。能读的范围限定在「--root 目录」和
 * 「仓库根」两棵树内（后者是软链目标所在），越界返回 403；.git/、node_modules/、
 * .dsh/ 一律不服务。
 *
 * 依赖：只用 node 内置模块。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

/* ------------------------------------------------------------------ *
 * 参数
 * ------------------------------------------------------------------ */
function parseArgs(argv) {
  const out = {
    port: 5173,
    host: '127.0.0.1',
    root: REPO_ROOT,
    reload: true,
    open: false,
    quiet: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--root') out.root = path.resolve(argv[++i]);
    else if (a === '--no-reload') out.reload = false;
    else if (a === '--open') out.open = true;
    else if (a === '--quiet' || a === '-q') out.quiet = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else {
      console.error(`不认识的参数：${a}`);
      process.exit(1);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`用法：node tools/dev-server.mjs [选项]

  --port <n>      端口，默认 5173（被占用时自动往后找，vite 也是这个习惯）
  --host <addr>   监听地址，默认 127.0.0.1（只本机）
  --root <dir>    服务哪个目录，默认仓库根；看拆分产物用 --root build
  --no-reload     关闭自动刷新（注入脚本会让 HTML 与磁盘不完全一致）
  --open          起来后用系统浏览器打开
  --quiet, -q     不打印每条请求`);
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * MIME：.mjs 必须是 text/javascript，否则 type="module" 不执行
 * ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const TEXT_EXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.txt', '.md', '.svg', '.webmanifest']);

/* ------------------------------------------------------------------ *
 * 路径解析：限制在允许的目录树里，跟随符号链接但不得越界
 * ------------------------------------------------------------------ */
const DENY_SEGMENTS = new Set(['.git', 'node_modules', '.dsh']);

if (!fs.existsSync(args.root) || !fs.statSync(args.root).isDirectory()) {
  console.error(`根目录不存在或不是目录：${args.root}`);
  console.error('提示：看拆分产物要加 --root build，且得先跑过 node tools/split-index.mjs');
  process.exit(1);
}

const ALLOW_ROOTS = [args.root, REPO_ROOT].map((d) => fs.realpathSync(d));

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isDenied(realPath) {
  // 用「最窄的那个包含它的允许根」来算相对路径，再看其中有没有敏感段。
  // 不能拿所有根逐个算——--root 指到 .dsh/tmp 时，相对 args.root 是干净的，
  // 相对 REPO_ROOT 却含 .dsh，逐个算会把用户主动指定的根也否掉。
  // 反过来也不能只看字面绝对路径：那样 --root 指到 .dsh/tmp 时连根目录都拒绝。
  const containing = ALLOW_ROOTS
    .filter((r) => isInside(realPath, r))
    .sort((a, b) => b.length - a.length)[0];
  if (!containing) return true;
  const rel = path.relative(containing, realPath);
  if (rel === '') return false;
  return rel.split(path.sep).some((seg) => DENY_SEGMENTS.has(seg));
}

/** 返回 { ok:true, file } 或 { ok:false, status, reason } */
function resolveTarget(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return { ok: false, status: 400, reason: 'URL 编码不合法' };
  }
  if (decoded.includes('\0')) return { ok: false, status: 400, reason: '路径含空字节' };

  // 先按「未跟随软链」拼出候选，挡掉 ../ 穿越
  const raw = path.normalize(path.join(args.root, decoded));
  if (!isInside(raw, args.root)) {
    return { ok: false, status: 403, reason: '越出服务根目录' };
  }

  // 先挡敏感目录再看文件是否存在：否则 /node_modules/x 会返回 404，
  // 变成「不存在」而不是「不提供」，等于把目录存在性透出去了。
  if (isDenied(raw)) {
    return { ok: false, status: 403, reason: '该路径不对外提供' };
  }

  let stat;
  try {
    stat = fs.statSync(raw); // 会跟随软链
  } catch {
    return { ok: false, status: 404, reason: '文件不存在' };
  }

  // 跟随软链后的真实路径必须仍落在允许的树内（build/ 的图片链到仓库根）
  let real;
  try {
    real = fs.realpathSync(raw);
  } catch {
    return { ok: false, status: 404, reason: '符号链接指向的目标不存在' };
  }
  if (!ALLOW_ROOTS.some((r) => isInside(real, r))) {
    return { ok: false, status: 403, reason: '符号链接指向仓库外' };
  }
  if (isDenied(real)) {
    return { ok: false, status: 403, reason: '该路径不对外提供' };
  }

  if (stat.isDirectory()) {
    // 拼 real 而不是 raw：raw 本身可能是软链目录，real 才是校验过的那个。
    const idx = path.join(real, 'index.html');
    try {
      const st2 = fs.statSync(idx);
      if (st2.isFile()) return { ok: true, file: idx, size: st2.size };
    } catch { /* 落到下面 */ }
    return { ok: false, status: 404, reason: '目录下没有 index.html' };
  }

  if (!stat.isFile()) return { ok: false, status: 404, reason: '不是普通文件' };
  return { ok: true, file: real, size: stat.size };
}

/* ------------------------------------------------------------------ *
 * 自动刷新：SSE + HTML 注入
 * ------------------------------------------------------------------ */
const clients = new Set();

function broadcast(msg) {
  let n = 0;
  for (const res of clients) {
    try {
      res.write(`data: ${msg}\n\n`);
      n++;
    } catch {
      clients.delete(res);
    }
  }
  return n;
}

const RELOAD_SNIPPET = `<script data-dev-reload>
(function () {
  if (window.__devReload) return;
  window.__devReload = true;
  var es = new EventSource('/__reload');
  es.onmessage = function (e) { if (e.data === 'reload') location.reload(); };
})();
</script>
`;

function injectReload(html) {
  const i = html.lastIndexOf('</body>');
  if (i >= 0) return html.slice(0, i) + RELOAD_SNIPPET + html.slice(i);
  return html + RELOAD_SNIPPET;
}

/* ------------------------------------------------------------------ *
 * 响应
 * ------------------------------------------------------------------ */
function log(...parts) {
  if (!args.quiet) console.log(...parts);
}

function sendError(res, status, reason, urlPath) {
  const body = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${status}</title>
<style>body{margin:0;padding:48px 24px;background:#12141a;color:#e6e8ee;font:14px/1.7 -apple-system,"PingFang SC",sans-serif}
.w{max-width:640px;margin:0 auto}code{background:#1b1e26;padding:2px 6px;border-radius:4px;color:#60a5fa}
.d{color:#9aa3b2;margin-top:16px}</style></head>
<body><div class="w"><h1 style="font-size:18px;margin:0 0 12px">${status} · ${reason}</h1>
<p>请求路径：<code>${escapeHtml(urlPath)}</code></p>
<p>服务根目录：<code>${escapeHtml(args.root)}</code></p>
<p class="d">404 常见原因：路径写错、目录下没有 index.html、或者起服务的目录不对。<br>
想先看清单就 <code>ls</code> 一下服务根目录。</p></div></body></html>`;
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function serveFile(req, res, target, urlPath) {
  const ext = path.extname(target.file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const isHtml = ext === '.html' || ext === '.htm';

  // 开发环境一律不缓存：改完刷新必须立刻看到新内容，
  // 「改了没生效」是这类工具最容易浪费时间的坑。
  const baseHeaders = {
    'Content-Type': type,
    'Cache-Control': 'no-store, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
  };

  if (isHtml && args.reload) {
    fs.readFile(target.file, 'utf8', (err, html) => {
      if (err) return sendError(res, 500, '读取失败', urlPath);
      const body = Buffer.from(injectReload(html), 'utf8');
      res.writeHead(200, { ...baseHeaders, 'Content-Length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
      log(`200  ${req.method} ${urlPath}  (html + reload)`);
    });
    return;
  }

  fs.stat(target.file, (err, st) => {
    if (err) return sendError(res, 500, '读取失败', urlPath);
    res.writeHead(200, { ...baseHeaders, 'Content-Length': st.size });
    if (req.method === 'HEAD') {
      res.end();
      log(`200  HEAD ${urlPath}`);
      return;
    }
    const stream = fs.createReadStream(target.file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    log(`200  ${req.method} ${urlPath}`);
  });
}

/* ------------------------------------------------------------------ *
 * 服务
 * ------------------------------------------------------------------ */
const server = http.createServer((req, res) => {
  const urlPath = req.url || '/';

  if (req.method === 'GET' && urlPath.split('?')[0] === '/__reload') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    clients.add(res);
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* 下面 close 会清 */ }
    }, 25000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendError(res, 405, '只支持 GET / HEAD', urlPath);
  }

  const target = resolveTarget(urlPath);
  if (!target.ok) return sendError(res, target.status, target.reason, urlPath);
  serveFile(req, res, target, urlPath);
});

/* ------------------------------------------------------------------ *
 * 文件监听 → 通知页面重载
 * ------------------------------------------------------------------ */
let pending = null;
let watcher = null;

const WATCH_EXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.png', '.jpg', '.jpeg', '.svg']);

function startWatcher() {
  if (!args.reload) return;
  try {
    watcher = fs.watch(args.root, { recursive: true }, (_evt, filename) => {
      if (!filename) return;
      const name = String(filename);
      if (name.split(path.sep).some((seg) => seg === '.git' || seg === 'node_modules' || seg === '.dsh')) return;
      if (!WATCH_EXT.has(path.extname(name).toLowerCase())) return;

      // 编辑器保存常常一次触发多个事件，合并成一次重载
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        const n = broadcast('reload');
        if (n > 0) log(`变更 ${name} → 已通知 ${n} 个页面重载`);
      }, 120);
    });
  } catch (e) {
    console.warn(`自动刷新不可用（${e.message}），继续以 --no-reload 方式运行`);
    args.reload = false;
  }
}

/* ------------------------------------------------------------------ *
 * 启动：端口占用自动往后找
 * ------------------------------------------------------------------ */
const MAX_TRIES = 10;

function listen(port, triesLeft) {
  // 重试时必须先摘掉上一轮挂的回调：listen 失败后那些回调仍留在 server 上，
  // 否则最终成功时会一次性触发所有轮次的 listening，打印出一串错误地址。
  server.removeAllListeners('error');
  server.removeAllListeners('listening');

  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && triesLeft > 0) {
      listen(port + 1, triesLeft - 1);
      return;
    }
    console.error(`启动失败：${err.message}`);
    process.exit(1);
  });
  server.once('listening', () => {
    const url = `http://${args.host === '0.0.0.0' ? '127.0.0.1' : args.host}:${port}/`;
    console.log('');
    console.log('  ZZZ-DDC 本地开发服务');
    console.log('');
    console.log(`  地址      ${url}`);
    console.log(`  根目录    ${args.root}`);
    console.log(`  自动刷新  ${args.reload ? '开（改文件后页面自动重载）' : '关'}`);
    if (args.host === '0.0.0.0') {
      console.log('  监听      0.0.0.0 —— 同一局域网内的设备也能访问');
    } else {
      console.log(`  监听      ${args.host}（仅本机）`);
    }
    console.log('');
    if (args.root !== REPO_ROOT) {
      console.log(`  提示：正在服务 ${path.relative(REPO_ROOT, args.root) || '.'}/，不是仓库根的 index.html。`);
    } else {
      console.log('  提示：看 tools/split-index.mjs 的拆分产物，加 --root build');
    }
    console.log('  停止：Ctrl+C');
    console.log('');

    startWatcher();

    if (args.open) {
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      execFile(cmd, [url], () => { /* 打不开就算了，地址已经打印出来 */ });
    }
  });

  server.listen(port, args.host);
}

listen(args.port, MAX_TRIES);

function shutdown() {
  if (watcher) try { watcher.close(); } catch { /* 无所谓 */ }
  for (const res of clients) try { res.end(); } catch { /* 无所谓 */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);