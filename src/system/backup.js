// 自动备份：她的全部数据，每天存一份，只留最近 N 天。
//
// 为什么必须有：她把记忆、日记、画像、关系都存在 data/ 里。
// 这些是**攒出来的**——丢了不是重装能恢复的东西。
// 之前 config 里有个 backupKeepDays 但没有任何代码读它，等于没有备份。
//
// 设计取舍：
//   - 备份**整个 data/**，不做增量。数据量小（几百 KB ~ 几十 MB），
//     增量备份换来的是"恢复时缺文件"的风险，不值。
//   - 备份放在项目内的 backups/，跟着文件夹一起搬走 —— 她是可携带的。
//   - 只复制，不删除源。失败不影响她运行。

import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR, DATA_DIR } from '../config.js';

/**
 * 备份根目录。默认项目内的 `backups/`，跟着文件夹一起搬走。
 * 测试时会指到别处（`COMPANION_BACKUP_ROOT`），免得污染真实备份。
 */
export const BACKUP_ROOT = process.env.COMPANION_BACKUP_ROOT
  ? path.resolve(process.env.COMPANION_BACKUP_ROOT)
  : path.join(ROOT_DIR, 'backups');

/** 目录名形如 2026-09-19_0315。用本地时间，你翻的时候才对得上。 */
export function stamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
    + `_${p(now.getHours())}${p(now.getMinutes())}`;
}

/** 列出已有的备份，最新的在前。 */
export function listBackups() {
  try {
    if (!fs.existsSync(BACKUP_ROOT)) return [];
    return fs.readdirSync(BACKUP_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => {
        const full = path.join(BACKUP_ROOT, e.name);
        let bytes = 0;
        let files = 0;
        const walk = (dir) => {
          for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, f.name);
            if (f.isDirectory()) walk(p);
            else { files++; try { bytes += fs.statSync(p).size; } catch { /* 可能刚好被删 */ } }
          }
        };
        try { walk(full); } catch { /* 目录可能刚好没了 */ }
        let at = 0;
        try { at = fs.statSync(full).mtimeMs; } catch { /* 同上 */ }
        return { name: e.name, path: full, bytes, files, at: new Date(at).toISOString() };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  } catch {
    return [];
  }
}

/**
 * 今天该不该备份。
 *
 * 判断依据是"最近一次备份是哪天"，不是内存里的标记 ——
 * 内存标记重启就没了，会导致一天备份好几次（或者重启一次就再也不备份）。
 */
export function shouldBackup(now = new Date()) {
  const all = listBackups();
  if (!all.length) return { due: true, reason: '还没有任何备份' };

  const today = stamp(now).slice(0, 10);
  const latestDay = all[0].name.slice(0, 10);
  if (latestDay === today) return { due: false, reason: `今天已经备份过（${all[0].name}）` };
  return { due: true, reason: `上次备份是 ${latestDay}` };
}

/**
 * 跑一次备份。
 *
 * @returns {{ok:boolean, target?:string, files?:number, reason?:string}}
 */
export function runBackup({ now = new Date(), logger } = {}) {
  if (!fs.existsSync(DATA_DIR)) return { ok: false, reason: 'data 目录不存在' };

  const target = path.join(BACKUP_ROOT, stamp(now));
  // 同一分钟重复触发就跳过，别覆盖正在写的备份
  if (fs.existsSync(target)) return { ok: false, reason: `这一分钟已经备份过（${path.basename(target)}）` };

  try {
    fs.mkdirSync(BACKUP_ROOT, { recursive: true });
    // 先写临时目录再改名 —— 中途挂掉不会留下一个"看起来完整其实缺文件"的备份
    const tmp = `${target}.partial`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.cpSync(DATA_DIR, tmp, { recursive: true });
    fs.renameSync(tmp, target);

    let files = 0;
    const count = (dir) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        if (f.isDirectory()) count(path.join(dir, f.name));
        else files++;
      }
    };
    count(target);

    logger?.('info', `已备份她的数据：${path.basename(target)}（${files} 个文件）`);
    return { ok: true, target, files };
  } catch (err) {
    logger?.('warn', `备份失败: ${err.message}`);
    // 清掉半成品，避免它被当成一个可恢复的备份
    try { fs.rmSync(`${target}.partial`, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ }
    return { ok: false, reason: err.message };
  }
}

/**
 * 删掉超过保留天数的备份。
 *
 * @returns {{removed: string[]}}
 */
export function pruneBackups(keepDays = 7, now = new Date()) {
  const removed = [];
  if (!Number.isFinite(keepDays) || keepDays <= 0) return { removed };

  const cutoff = new Date(now).getTime() - keepDays * 86_400_000;
  for (const b of listBackups()) {
    // 用目录名里的日期判断，不用 mtime —— mtime 会被"复制整个文件夹"改掉
    const day = b.name.slice(0, 10);
    const t = new Date(`${day}T00:00:00`).getTime();
    if (!Number.isFinite(t)) continue;
    if (t < cutoff) {
      try {
        fs.rmSync(b.path, { recursive: true, force: true });
        removed.push(b.name);
      } catch { /* 删不掉就留着，不影响 */ }
    }
  }
  return { removed };
}

/** 后台展示用。 */
export function backupStats(keepDays = 7) {
  const all = listBackups();
  return {
    dir: BACKUP_ROOT,
    keepDays,
    count: all.length,
    totalMB: +(all.reduce((n, b) => n + b.bytes, 0) / 1048576).toFixed(2),
    latest: all[0] ? { name: all[0].name, files: all[0].files, at: all[0].at } : null,
    items: all.slice(0, 10).map((b) => ({ name: b.name, files: b.files, mb: +(b.bytes / 1048576).toFixed(2) })),
  };
}
