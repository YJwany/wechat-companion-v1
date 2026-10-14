// 跑核心单元测试（test/core.test.js），但用一份**临时数据目录**，不碰真实 data/。
//
// 为什么需要这个壳：
//   core.test.js 里 `new MemoryStore()`（freshMemory 等）走的是 config.js 的
//   DATA_DIR 默认值 —— 也就是真实的 `data/`。而 `npm test` 原来只是
//   `node --test test/core.test.js`，没有设 COMPANION_DATA_DIR。
//   结果：跑一次 npm test，7 条测试夹具（他叫陈默 / 他住在南京 /
//   他养了一只叫豆豆的柯基 / 他不吃辣 / 他是做建筑设计的 / 他老家在东北 /
//   他常熬夜到两三点，who:"p1"）就被写进真实的 data/memory.json，
//   把她的真实记忆冲掉。2026-09-21 00:02 就是这么丢的。
//
// 做法与 scripts/run-all-tests.js 一致：
//   把真实 data/ 拷一份到 .test-data-core/，测试全在那上面跑，跑完删掉。
//   拷一份而不是建空的，是为了让测试拿到真实的配置和素材（表情包库等），
//   与 `npm run test:all` 的行为保持一致。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const SCRATCH = path.join(ROOT, '.test-data-core');
const SCRATCH_BACKUP = path.join(ROOT, '.test-backups-core');
const REAL_DATA = path.join(ROOT, 'data');
const TEST_FILE = path.join('test', 'core.test.js');

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

setupScratch();
process.on('exit', teardownScratch);
process.on('SIGINT', () => { teardownScratch(); process.exit(130); });

console.log('');
console.log('  核心单元测试');
console.log(`  数据目录: ${path.relative(ROOT, SCRATCH)}（真实 data/ 不受影响）`);
console.log('');

const r = spawnSync(process.execPath, ['--test', TEST_FILE, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: ROOT,
  env: {
    ...process.env,
    COMPANION_DATA_DIR: SCRATCH,
    COMPANION_BACKUP_ROOT: SCRATCH_BACKUP,
  },
});

process.exit(r.status ?? 1);
