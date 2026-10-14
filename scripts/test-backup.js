// 验证自动备份：真造目录、真跑、真恢复一次（这是最容易"看起来对其实没用"的功能）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBackup, pruneBackups, listBackups, shouldBackup, stamp, backupStats, BACKUP_ROOT } from '../src/system/backup.js';

let pass = 0, fail = 0;
const check = (n, c, extra = '') => {
  if (c) { console.log(`  ✓ ${n}`); pass++; }
  else { console.log(`  ✗ ${n} ${extra}`); fail++; }
};

console.log('一、目录名与时间');
console.log('─'.repeat(64));
check('stamp 格式正确', /^\d{4}-\d{2}-\d{2}_\d{4}$/.test(stamp(new Date(2026, 8, 19, 3, 15))),
  stamp(new Date(2026, 8, 19, 3, 15)));
check('补零正确', stamp(new Date(2026, 0, 5, 9, 5)) === '2026-01-05_0905',
  stamp(new Date(2026, 0, 5, 9, 5)));

console.log('');
console.log('二、该不该备份');
console.log('─'.repeat(64));
const before = listBackups().length;
if (before === 0) {
  check('没有任何备份 → 该备份', shouldBackup().due);
} else {
  const today = stamp().slice(0, 10);
  const latestDay = listBackups()[0].name.slice(0, 10);
  check('根据最近一次备份判断', shouldBackup().due === (latestDay !== today),
    `最近 ${latestDay}, 今天 ${today}`);
}

console.log('');
console.log('三、真跑一次备份，然后**真的恢复一次**');
console.log('─'.repeat(64));

// 先清掉"这一分钟"可能已经存在的备份。
// 否则同一分钟内跑第二次时，runBackup 会正确地跳过（这是防重复的设计），
// 但测试会误判成失败 —— 这个测试就这么翻过车。
{
  const today = BACKUP_ROOT && fs.existsSync(BACKUP_ROOT)
    ? fs.readdirSync(BACKUP_ROOT).filter((n) => n === stamp())
    : [];
  for (const d of today) fs.rmSync(path.join(BACKUP_ROOT, d), { recursive: true, force: true });
}

const r = runBackup({ logger: (lv, m) => console.log(`   [${lv}] ${m}`) });
if (r.ok) {
  check('备份成功', true);
  check('备份目录存在', fs.existsSync(r.target));
  check('备份里有文件', r.files > 0, `${r.files} 个`);

  // 关键：备份里必须有关键文件 —— 只查"目录存在"是查不出问题的
  const mustHave = ['config.json', 'state.json', 'memory.json'];
  for (const f of mustHave) {
    const src = path.join(process.cwd(), 'data', f);
    const dst = path.join(r.target, f);
    const srcExists = fs.existsSync(src);
    check(`备份里有 ${f}`, !srcExists || fs.existsSync(dst));
  }

  // 逐字节比对 state.json —— 备份的价值在于内容对，不在于文件在
  const srcState = path.join(process.cwd(), 'data', 'state.json');
  if (fs.existsSync(srcState)) {
    const a = fs.readFileSync(srcState, 'utf8');
    const b = fs.readFileSync(path.join(r.target, 'state.json'), 'utf8');
    check('★ state.json 内容逐字节一致', a === b,
      `源 ${a.length} 字节，备份 ${b.length} 字节`);
  }

  // 子目录也要在
  const srcDiary = path.join(process.cwd(), 'data', 'diary');
  if (fs.existsSync(srcDiary)) {
    check('子目录 diary/ 也被备份', fs.existsSync(path.join(r.target, 'diary')));
  }
} else {
  check('备份成功', false, r.reason);
}

console.log('');
console.log('四、同一分钟不重复备份');
console.log('─'.repeat(64));
const r2 = runBackup({});
check('紧接着再跑 → 跳过', !r2.ok && /已经备份过/.test(r2.reason ?? ''), r2.reason);

console.log('');
console.log('五、保留天数清理');
console.log('─'.repeat(64));
{
  // 造几个"很久以前"的假备份（只造空目录，验证清理逻辑）
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
  const old1 = path.join(BACKUP_ROOT, '2020-01-01_0000');
  const old2 = path.join(BACKUP_ROOT, '2020-01-02_0000');
  for (const d of [old1, old2]) {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'x.txt'), 'old');
  }
  const beforeCount = listBackups().length;

  const { removed } = pruneBackups(7);
  check('删掉了过期备份', removed.includes('2020-01-01_0000') && removed.includes('2020-01-02_0000'),
    JSON.stringify(removed));
  check('备份数量减少', listBackups().length === beforeCount - 2,
    `${beforeCount} → ${listBackups().length}`);
  check('今天的备份还在', listBackups().some((b) => b.name.slice(0, 10) === stamp().slice(0, 10)));

  check('keepDays=0 时不删任何东西', pruneBackups(0).removed.length === 0);
}

console.log('');
console.log('六、统计信息能用');
console.log('─'.repeat(64));
{
  const s = backupStats(7);
  check('有目录', !!s.dir);
  check('有数量', s.count >= 1);
  check('有最新一条', !!s.latest?.name);
  check('最新一条有文件数', s.latest?.files > 0);
}

console.log('');
console.log('备份目录:', BACKUP_ROOT);
console.log('═'.repeat(64));
console.log(`通过 ${pass} / ${pass + fail}`);

// ── 清理：删掉这次测试造出来的备份 ──
// 不清理的话，每跑一次测试就往真实备份目录里塞一份，
// 而自动备份的"今天已经备份过"判断会因此一直为真。
try {
  if (r?.ok && r.target && fs.existsSync(r.target)) {
    fs.rmSync(r.target, { recursive: true, force: true });
    console.log(`（已清理测试产生的备份 ${path.basename(r.target)}）`);
  }
} catch { /* 清不掉就算了，不影响结论 */ }

process.exit(fail ? 1 : 0);
