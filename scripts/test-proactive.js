// 验证主动消息调度的随机性：不该每天准点发，且时间点应有浮动。
import { loadConfig } from '../src/config.js';
import { Companion } from '../src/companion.js';

const cfg = loadConfig();
const c = Object.create(Companion.prototype);
c.cfg = cfg;
c.state = { proactiveKinds: {}, proactivePlans: {} };

const DAYS = 14;
let morningCount = 0;
let nightCount = 0;
let noneCount = 0;

console.log('模拟 ' + DAYS + ' 天：');
for (let day = 0; day < DAYS; day++) {
  const key = '2026-09-' + String(day + 1).padStart(2, '0');
  c.state.proactiveKinds[key] = {};
  const hits = [];

  // 一整天扫一遍，步长与真实定时器一致（5 分钟）
  for (let m = 0; m < 24 * 60; m += 5) {
    const t = new Date(2026, 8, 1 + day, Math.floor(m / 60), m % 60);
    const k = c.pickProactiveKind(t, 8, key);
    if (k && !hits.some((h) => h.kind === k)) {
      const at = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
      hits.push({ kind: k, at });
      c.state.proactiveKinds[key][k] = true;
      if (k === 'morning') morningCount++;
      if (k === 'night') nightCount++;
    }
  }

  if (!hits.length) noneCount++;
  console.log('  第' + String(day + 1).padStart(2) + '天: '
    + (hits.length ? hits.map((h) => h.kind + '@' + h.at).join('  ') : '(没发)'));
}

console.log('');
console.log(`早安 ${morningCount}/${DAYS} 天，晚安 ${nightCount}/${DAYS} 天，完全没发 ${noneCount}/${DAYS} 天`);
console.log(`（配置期望：早安约 60%，晚安约 50%，不该每天都发）`);
console.log('state 里保留的计划条目: ' + Object.keys(c.state.proactivePlans).length + '（应 ≤ 7，自动清理）');
