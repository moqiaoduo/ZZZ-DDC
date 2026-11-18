#!/usr/bin/env node
/**
 * tools/dev-server.mjs 的自测。
 *
 *   node tools/test-dev-server.mjs
 *
 * 静态服务器最容易出错的地方不是「能不能返回文件」，而是：
 *   - .mjs 的 MIME 给错了，浏览器静默不执行 module；
 *   - 改了文件刷新还是旧的（缓存头）；
 *   - 路径穿越到仓库外，或软链把 /etc/passwd 递出去；
 *   - 端口占用时启动逻辑崩掉或监听在不该监听的地址上。
 * 这几条都真起服务来验，不靠读代码推断。
 *
 * 端口纪律：每个用例都必须落在它预期的端口上。dev-server 自己会在端口被占时
 * 自动后移（这是它的功能），但测试若也被带着后移，就会「对着另一个服务做断言」
 * ——连上了、状态码对、内容却来自别的根目录，失败信息还指向被删的文件。
 * 所以启动前先确认真空闲，占着就直接报错，不静默换端口。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = path.join(ROOT, '.dsh', 'tmp', 'test-dev-server');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

/* ── 起服务的工具 ─────────────────────────────────────────────────── */

/** 端口是否已被占用。探测用 127.0.0.1，与服务默认监听地址一致。 */
async function portBusy(port) {
  try {
    await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(500) });
    return true;               // 有响应，说明有人在那
  } catch (e) {
    // ECONNREFUSED 才是「空」；超时/其他错误说明有东西在但不响应，也当作占用
    return e.name !== 'TypeError' && !/ECONNREFUSED|fetch failed/i.test(String(e.cause?.code || e.message));
  }
}

/**
 * @param opts.allowBusy 端口本来就该被占（E 段测的就是「占用后自动后移」），跳过探测。
 */
async function startServer(args, port, opts = {}) {
  if (!opts.allowBusy && await portBusy(port)) {
    throw new Error(`端口 ${port} 已被占用。测试要求每个用例落在固定端口上，` +
      `请先腾出来（lsof -ti tcp:${port} | xargs kill），否则会对着别的服务做断言。`);
  }
  const srv = spawn('node', [path.join(ROOT, 'tools', 'dev-server.mjs'), '--port', String(port), '--quiet', ...args], {
    stdio: 'pipe',
  });
  let out = '';
  const collect = (d) => { out += String(d); };
  srv.stdout.on('data', collect);
  srv.stderr.on('data', collect);

  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(base + '/');
      if (r.status < 500) return { srv, base, getOut: () => out, up: true };
    } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 100));
  }
  return { srv, base, getOut: () => out, up: false };
}

function stopServer(srv) {
  try { srv.kill('SIGTERM'); } catch { /* 已经没了 */ }
}

/** 发一个「不让 fetch 自动解码百分号」的请求，专门测穿越 */
function rawGet(port, rawPath) {
  return fetch('http://127.0.0.1:' + port + rawPath, { redirect: 'manual' });
}

/* ── A. 仓库根 ───────────────────────────────────────────────────── */

console.log('A. 仓库根（默认 --root）');
{
  const { srv, base, up } = await startServer([], 8901);
  try {
    check('服务能起来', up);
    if (up) {
      const r = await fetch(base + '/');
      const html = await r.text();
      check('/ 返回 200', r.status === 200);
      check('/ 是 HTML', r.headers.get('content-type').startsWith('text/html'));
      check('返回的是真页面（含项目标题）', html.includes('<title>'), '拿到 ' + html.length + ' 字节');

      const css = await fetch(base + '/index.html');
      check('Cache-Control 为 no-store',
        (css.headers.get('cache-control') || '').includes('no-store'),
        '实际 ' + css.headers.get('cache-control') + '——开发时带缓存会让人以为改动没生效');

      check('X-Content-Type-Options: nosniff', r.headers.get('x-content-type-options') === 'nosniff');

      // .mjs 的 MIME 是最容易错的一条：给成 application/octet-stream，
      // <script type="module"> 会被静默拒绝执行，页面看着正常但功能全无。
      const mjs = await fetch(base + '/tools/dev-server.mjs');
      check('.mjs 返回 text/javascript',
        (mjs.headers.get('content-type') || '').startsWith('text/javascript'),
        '实际 ' + mjs.headers.get('content-type'));

      const png = await fetch(base + '/assets/site/logo.jpg');
      check('改名后的图片能取到', png.status === 200 && png.headers.get('content-type') === 'image/jpeg',
        '实际 ' + png.status + ' ' + png.headers.get('content-type'));


      const miss = await fetch(base + '/definitely-not-here');
      check('不存在的路径返回 404', miss.status === 404);

      const post = await fetch(base + '/', { method: 'POST' });
      check('POST 返回 405', post.status === 405);

      const head = await fetch(base + '/', { method: 'HEAD' });
      check('HEAD 返回 200 且无 body', head.status === 200 && (await head.text()) === '');
    }
  } finally { stopServer(srv); }
}

/* ── B. 越界防护 ─────────────────────────────────────────────────── */

console.log('\nB. 越界防护');
{
  const { srv, base, up } = await startServer(['--no-reload'], 8902);
  try {
    check('服务能起来', up);
    if (up) {
      const cases = [
        ['/.git/config', '仓库元数据'],
        ['/node_modules/x', '依赖目录'],
        ['/.dsh/tmp/test-dev-server', '会话临时目录'],
      ];
      for (const [p, label] of cases) {
        const r = await rawGet(8902, p);
        check('挡掉 ' + label + '（' + p + '）', r.status === 403, '实际 ' + r.status);
      }

      // 手工拼一个编码过的 ..，fetch 可能帮我规范化，所以用裸 socket 更准
      const net = await import('node:net');
      const rawStatus = await new Promise((resolve) => {
        const s = net.connect(8902, '127.0.0.1', () => {
          s.write('GET /%2e%2e/%2e%2e/etc/passwd HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
        });
        let buf = '';
        s.on('data', d => { buf += d; });
        s.on('end', () => resolve(Number((buf.match(/^HTTP\/1\.1 (\d+)/) || [])[1] || 0)));
        s.on('error', () => resolve(0));
      });
      check('编码过的 ../ 穿越被拒', rawStatus === 403 || rawStatus === 404, '实际 ' + rawStatus);

      // 软链指向仓库外
      const link = path.join(TMP, 'escape');
      try { fs.symlinkSync('/etc/hosts', link); } catch { /* 已存在 */ }
      const escape = await startServer(['--root', TMP, '--no-reload'], 8903);
      try {
        if (escape.up) {
          const r = await rawGet(8903, '/escape');
          check('软链指向仓库外被拒', r.status === 403, '实际 ' + r.status);
        } else {
          check('软链指向仓库外被拒', false, '服务没起来');
        }
      } finally { stopServer(escape.srv); }
    }
  } finally { stopServer(srv); }
}

/* ── C. --root dist（自包含产物） ───────────────────────────────── */

console.log('\nC. --root 指向子目录（自包含产物）');
{
  const buildDir = path.join(ROOT, 'dist');
  if (!fs.existsSync(path.join(buildDir, 'index.html'))) {
    check('dist/ 存在（先跑 tools/build.mjs）', false, 'dist/index.html 不存在');
  } else {
    // 产物必须自包含：图片是拷进来的真文件，不是指向仓库根的软链。
    // 软链在 zip / rsync / 对象存储上传 / Pages 部署里都可能不被跟随。
    const links = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isSymbolicLink()) links.push(path.relative(buildDir, p));
        else if (e.isDirectory()) walk(p);
      }
    })(buildDir);
    check('dist/ 下没有符号链接', links.length === 0, '发现 ' + links.slice(0, 3).join(', '));

    const { srv, base, up } = await startServer(['--root', buildDir, '--no-reload'], 8904);
    try {
      check('服务能起来', up);
      if (up) {
        const r = await fetch(base + '/');
        check('dist 首页 200', r.status === 200);

        const js = await fetch(base + '/src/main.js');
        check('main.js 的 MIME 正确',
          (js.headers.get('content-type') || '').startsWith('text/javascript'),
          '实际 ' + js.headers.get('content-type'));

        const json = await fetch(base + '/src/data/characters.js');
        check('data 模块的 MIME 正确',
          (json.headers.get('content-type') || '').startsWith('text/javascript'),
          '实际 ' + json.headers.get('content-type'));

        const png = await fetch(base + '/assets/site/logo.jpg');
        const buf = Buffer.from(await png.arrayBuffer());
        check('图片能取到且非空', png.status === 200 && buf.length > 1000,
          '实际 ' + png.status + ' / ' + buf.length + ' 字节');

        const dirNoIndex = await fetch(base + '/src/data');
        check('目录无 index.html 时 404 而不是目录列表',
          dirNoIndex.status === 404, '实际 ' + dirNoIndex.status);
      }
    } finally { stopServer(srv); }
  }
}

/* ── D. 自动刷新 ─────────────────────────────────────────────────── */

console.log('\nD. 自动刷新');
{
  const probe = path.join(TMP, 'reload');
  fs.mkdirSync(probe, { recursive: true });
  fs.writeFileSync(path.join(probe, 'index.html'), '<!DOCTYPE html><html><body><h1>x</h1></body></html>');

  const { srv, base, up } = await startServer(['--root', probe], 8905);
  try {
    check('服务能起来', up);
    if (up) {
      const html = await (await fetch(base + '/')).text();
      check('HTML 被注入刷新脚本', html.includes('data-dev-reload'));
      check('注入在 </body> 之前', html.indexOf('data-dev-reload') < html.indexOf('</body>'));
      check('注入后原内容仍在', html.includes('<h1>x</h1>'));

      // 真连 SSE，然后改文件，看是否收到 reload
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      let got = '';
      const readerPromise = (async () => {
        try {
          const r = await fetch(base + '/__reload', { signal: ctrl.signal });
          const reader = r.body.getReader();
          const dec = new TextDecoder();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            got += dec.decode(value, { stream: true });
            if (got.includes('reload')) break;
          }
        } catch { /* abort 属正常结束 */ }
      })();

      await new Promise(r => setTimeout(r, 400));
      fs.writeFileSync(path.join(probe, 'index.html'), '<!DOCTYPE html><html><body><h1>y</h1></body></html>');
      await Promise.race([readerPromise, new Promise(r => setTimeout(r, 2000))]);
      clearTimeout(timer);
      ctrl.abort();

      check('改文件后 SSE 收到 reload', got.includes('data: reload'),
        '实际收到：' + JSON.stringify(got.slice(0, 120)));

      // 不注入时字节必须与磁盘一致（做逐字节比对时要用这个模式）
      const plain = await startServer(['--root', probe, '--no-reload'], 8906);
      try {
        if (plain.up) {
          const served = Buffer.from(await (await fetch(plain.base + '/')).arrayBuffer());
          const onDisk = fs.readFileSync(path.join(probe, 'index.html'));
          check('--no-reload 时响应与磁盘逐字节一致', served.equals(onDisk),
            '响应 ' + served.length + ' 字节 / 磁盘 ' + onDisk.length + ' 字节');
        } else {
          check('--no-reload 时响应与磁盘逐字节一致', false, '服务没起来');
        }
      } finally { stopServer(plain.srv); }
    }
  } finally { stopServer(srv); }
}

/* ── E. 端口重试 ─────────────────────────────────────────────────── */

console.log('\nE. 端口占用时自动后移');
{
  const first = await startServer(['--root', TMP, '--no-reload'], 8907);
  try {
    check('第一个实例起来', first.up);
    if (first.up) {
      // 这个用例的意图就是「端口被占 → 自动后移到 8908」，不能要求端口空闲。
      const second = await startServer(['--root', TMP, '--no-reload'], 8907, { allowBusy: true });
      try {
        check('第二个实例在下一个端口起来', second.up);
        if (second.up) {
          // 地址是 listening 回调里 console.log 的，pipe 到读端有一拍延迟，
          // 刚 fetch 通就读可能还没到。
          await new Promise(r => setTimeout(r, 300));
          const out = second.getOut();
          const hits = out.match(/地址\s+http:\/\/127\.0\.0\.1:(\d+)/g) || [];
          check('只打印一次地址（重试时清掉了旧回调）', hits.length === 1,
            '打印了 ' + hits.length + ' 次：' + hits.join(' / '));
          check('打印的是真正在用的端口', hits[0] && hits[0].includes('8908'), '实际 ' + hits[0]);
        }
      } finally { stopServer(second.srv); }
    }
  } finally { stopServer(first.srv); }
}

/* ── F. 只监听本机 ───────────────────────────────────────────────── */

console.log('\nF. 默认只监听本机');
{
  const { srv, up } = await startServer(['--root', TMP, '--no-reload'], 8909);
  try {
    check('服务能起来', up);
    if (up) {
      const { execFileSync } = await import('node:child_process');
      let lsof = '';
      try {
        lsof = execFileSync('lsof', ['-nP', '-iTCP:8909', '-sTCP:LISTEN'], { encoding: 'utf8' });
      } catch { /* lsof 不可用就跳过 */ }
      if (lsof) {
        check('监听地址是 127.0.0.1 而不是 *', lsof.includes('127.0.0.1:8909') && !/\*:8909/.test(lsof),
          '实际 ' + lsof.split('\n')[1]);
      } else {
        console.log('  - 跳过（lsof 不可用）');
      }
    }
  } finally { stopServer(srv); }
}

console.log('\n' + '─'.repeat(56));
if (fail === 0) {
  console.log('全部通过：' + pass + ' 项断言');
  process.exit(0);
} else {
  console.log('失败 ' + fail + ' / ' + (pass + fail) + ' 项：');
  failures.forEach(f => console.log('  · ' + f));
  process.exit(1);
}