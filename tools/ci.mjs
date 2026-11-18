#!/usr/bin/env node
/**
 * 一条命令跑完全套校验，本地与 CI 用的是同一份清单。
 *
 * 为什么需要一个统一入口而不是在 workflow 里写七个 step：
 *   清单只写一遍。CI 里跑什么、本地应该跑什么，不应该有两份会漂移的答案。
 *   写 workflow 的 step 列表，本地就会有人说「我跑过 test 了」但实际只跑了两个；
 *   写在这里，本地 `node tools/ci.mjs` 与 CI 里跑的是逐字相同的序列。
 *
 * 为什么零依赖（不用 npm scripts / vitest / playwright）：
 *   项目本身没有 node_modules，`clone 下来就能改`是它的核心约束。
 *   所有校验脚本都已经存在且各自 `process.exit(1)`，这里只负责编排。
 *
 * 顺序按「快 → 慢」排，前面失败能尽早看到：
 *   check-imports        0.02s  模块图连通性
 *   check-assets         0.03s  资源引用与死资源
 *   golden               0.21s  算法数值快照（223 项）
 *   build                0.03s  产物可构建且自包含
 *   test-probability     3.6s   概率引擎对独立真值
 *   test-legacy-migration 0.3s  存档迁移链路
 *   test-dev-server      1.8s   dev server 行为（会自己构建 dist）
 *
 * 用法：
 *   node tools/ci.mjs                跑全套
 *   node tools/ci.mjs --fail-fast    第一处失败就停（默认跑完，看全貌）
 *   node tools/ci.mjs --only golden,check-assets
 *   node tools/ci.mjs --list         列出步骤名
 *
 * 环境变量：
 *   CI=true 时（GitHub Actions 自动设置）额外打印分组标记，便于在日志里折叠。
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const FAIL_FAST = argv.includes('--fail-fast');
const IS_CI = process.env.CI === 'true' || process.env.CI === '1';

/** 步骤清单：name 是 CLI 里用的短名，file 是相对仓库根的脚本。 */
const STEPS = [
  { name: 'check-imports', file: 'tools/check-imports.mjs', what: '模块图连通性' },
  { name: 'check-assets', file: 'tools/check-assets.mjs', what: '资源引用与死资源' },
  { name: 'golden', file: 'tools/golden.mjs', what: '算法数值快照' },
  { name: 'build', file: 'tools/build.mjs', what: '产物可构建且自包含', args: ['--quiet'] },
  { name: 'test-probability', file: 'tools/test-probability.mjs', what: '概率引擎对独立真值' },
  { name: 'test-legacy-migration', file: 'tools/test-legacy-migration.mjs', what: '存档迁移链路' },
  { name: 'test-dev-server', file: 'tools/test-dev-server.mjs', what: 'dev server 行为' },
];

if (argv.includes('--list')) {
  for (const s of STEPS) console.log(`${s.name.padEnd(24)} ${s.what}`);
  process.exit(0);
}

const onlyArg = argv.indexOf('--only');
let steps = STEPS;
if (onlyArg >= 0) {
  const wanted = (argv[onlyArg + 1] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((w) => !STEPS.some((s) => s.name === w));
  if (unknown.length) {
    console.error(`--only 里有不认识的步骤：${unknown.join('、')}`);
    console.error(`可用：${STEPS.map((s) => s.name).join('、')}`);
    process.exit(2);
  }
  steps = STEPS.filter((s) => wanted.includes(s.name));
  if (!steps.length) {
    console.error('--only 未选中任何步骤');
    process.exit(2);
  }
}

const group = (title) => { if (IS_CI) console.log(`::group::${title}`); };
const endGroup = () => { if (IS_CI) console.log('::endgroup::'); };

console.log(`跑 ${steps.length} 个步骤${IS_CI ? '（CI）' : ''}\n`);

const results = [];
for (const [i, step] of steps.entries()) {
  const label = `[${i + 1}/${steps.length}] ${step.name}`;
  console.log(`${label} — ${step.what}`);
  group(step.name);

  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, step.file), ...(step.args || [])], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  const ms = Date.now() - started;

  // 被信号杀掉时 status 是 null，不能当成 0。
  const ok = r.status === 0;
  endGroup();

  results.push({ name: step.name, ok, ms, code: r.status, signal: r.signal });
  console.log(`${ok ? '✓' : '✗'} ${step.name} ${(ms / 1000).toFixed(2)}s\n`);

  if (!ok && FAIL_FAST) {
    console.log('--fail-fast：中止后续步骤');
    break;
  }
}

const failed = results.filter((r) => !r.ok);
const skipped = steps.length - results.length;

console.log('─'.repeat(56));
for (const r of results) {
  const status = r.ok ? '✓' : `✗ (${r.signal ? 'signal ' + r.signal : 'exit ' + r.code})`;
  console.log(`${r.name.padEnd(24)} ${status.padEnd(16)} ${(r.ms / 1000).toFixed(2)}s`);
}
if (skipped > 0) console.log(`（因 --fail-fast 跳过 ${skipped} 个）`);

if (failed.length) {
  console.error(`\n失败 ${failed.length} / ${results.length}：${failed.map((r) => r.name).join('、')}`);
  process.exit(1);
}
console.log(`\n全部通过：${results.length} 个步骤`);
