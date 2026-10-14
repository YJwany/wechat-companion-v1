// 跑齐所有测试套件，末尾给一个总账。
//
// 零依赖，所以这里手写一个 runner —— 不引测试框架，就不用带 node_modules。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

// 顺序大致按"底层 → 上层"，读起来顺
const SUITES = [
  ['test-qrcode.js', '二维码编码'],
  ['test-image-item.js', '图片消息字段'],
  ['test-commands.js', '指令协议'],
  ['test-stickers.js', '表情包库'],
  ['test-stickers-live.js', '表情包（实库）'],
  ['test-stickers-wire.js', '表情包（端到端）'],
  ['test-repeat.js', '复读止血'],
  ['test-longing.js', '想念曲线'],
  ['test-milestones.js', '纪念日'],
  ['test-forge.js', '人设贴合'],
  ['test-portrait.js', '她眼中的你'],
  ['test-sleep.js', '睡着被打扰'],
  ['test-sense.js', '常识（本地规则）'],
  ['test-sense-wire.js', '常识（接线端到端）'],
  ['test-deform.js', '变形状态机'],
  ['test-deform-wire.js', '变形（端到端）'],
  ['test-backup.js', '自动备份'],
  ['test-relay.js', '中转站接入'],
  ['test-promises.js', '承诺闭环'],
  ['test-drift.js', '性格漂移'],
  ['test-history-persist.js', '历史落盘'],
  ['test-state-migrate.js', '状态迁移'],
  ['test-roundtrip.js', '落盘往返守卫'],
  ['test-repeat-wire.js', '复读接线'],
  ['test-hints-combo.js', '提示合并'],
];

let totalPass = 0;
let totalAll = 0;
const failed = [];

// --repeat N：每个套件连跑 N 次。
// 为什么需要：测试里最容易出的不是"错"，而是"时而对时而不对"。
// 这一轮就抓到两个 —— 一个用真实 now 算衰减（下午跑就红），
// 一个在同一分钟内重复备份被正确地跳过（但测试误判成失败）。
const repeatArg = process.argv.indexOf('--repeat');
const REPEAT = repeatArg >= 0 ? Math.max(1, Number(process.argv[repeatArg + 1]) || 1) : 1;

/**
 * 用一份**临时数据目录**跑测试，不碰真实的 data/。
 *
 * 为什么必须这样：测试会读写 state.json。如果她正开着（`npm start`），
 * 两个进程抢同一个文件 —— 测试刚清掉的假数据会被服务端内存里的旧状态
 * 写回来，看起来像"清理没生效"。这事真发生过。
 *
 * 做法：把真实 data/ 拷一份到 .test-data/，测试全在那上面跑，跑完删掉。
 * 拷一份而不是建空的，是为了让测试拿到真实的配置和素材。
 */
const SCRATCH = path.join(ROOT, '.test-data');
const SCRATCH_BACKUP = path.join(ROOT, '.test-backups');
const REAL_DATA = path.join(ROOT, 'data');

function setupScratch() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.rmSync(SCRATCH_BACKUP, { recursive: true, force: true });
  if (fs.existsSync(REAL_DATA)) {
    fs.cpSync(REAL_DATA, SCRATCH, { recursive: true });
  } else {
    fs.mkdirSync(SCRATCH, { recursive: true });
  }
  // 日志和锁不需要带过来
  fs.rmSync(path.join(SCRATCH, 'companion.log'), { force: true });
}

function teardownScratch() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.rmSync(SCRATCH_BACKUP, { recursive: true, force: true });
}

const CHILD_ENV = {
  ...process.env,
  COMPANION_DATA_DIR: SCRATCH,
  COMPANION_BACKUP_ROOT: SCRATCH_BACKUP,
};

setupScratch();
process.on('exit', teardownScratch);
process.on('SIGINT', () => { teardownScratch(); process.exit(130); });

console.log('');
console.log('  她 的 全 套 测 试' + (REPEAT > 1 ? `（每个跑 ${REPEAT} 次，专抓 flaky）` : ''));
console.log(`  数据目录: ${path.relative(ROOT, SCRATCH)}（真实 data/ 不受影响）`);
console.log('  ' + '─'.repeat(60));

for (const [file, label] of SUITES) {
  const full = path.join(HERE, file);
  if (!fs.existsSync(full)) { console.log(`  ?  ${label.padEnd(20)} (文件不存在)`); continue; }

  let worst = null;   // 这一套里最差的一次
  for (let i = 0; i < REPEAT; i++) {
    const r = spawnSync(process.execPath, [full], { encoding: 'utf8', cwd: ROOT, env: CHILD_ENV });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const m = out.match(/通过 (\d+) \/ (\d+)/);
    const cur = m
      ? { p: Number(m[1]), a: Number(m[2]), demo: false, code: r.status }
      : { p: 0, a: 0, demo: true, code: r.status };
    if (!worst
      || (cur.demo ? cur.code !== 0 : cur.p !== cur.a)
      || (!worst.demo && cur.a - cur.p > worst.a - worst.p)) {
      worst = cur;
    }
  }

  if (worst.demo) {
    const ok = worst.code === 0;
    if (!ok) failed.push(label);
    console.log(`  ${ok ? '·' : '✗'}  ${label.padEnd(20)} ${ok ? '(演示脚本，正常结束)' : '(异常退出)'}`);
  } else {
    totalPass += worst.p;
    totalAll += worst.a;
    const ok = worst.p === worst.a;
    if (!ok) failed.push(label);
    console.log(`  ${ok ? '✓' : '✗'}  ${label.padEnd(20)} ${String(worst.p).padStart(4)} / ${worst.a}`
      + (REPEAT > 1 && ok ? `   (${REPEAT} 次全绿)` : ''));
  }
}

console.log('  ' + '─'.repeat(60));
console.log(`  合计 ${totalPass} / ${totalAll} 项断言通过`);
if (failed.length) {
  console.log(`  ✗ 有问题的套件: ${failed.join('、')}`);
} else {
  console.log('  ✓ 全部通过');
}
console.log('');

process.exit(failed.length ? 1 : 0);
