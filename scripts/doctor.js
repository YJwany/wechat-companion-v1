#!/usr/bin/env node
// 体检：一次性检查所有可能出问题的地方，给出明确指引。
//
// 设计意图：出问题时不要让用户猜。每一项都告诉他人话的结论和下一步。

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, DATA_DIR, ROOT_DIR, ensureDirs } from '../src/config.js';
import { testConnection } from '../src/brain/client.js';
import { PROVIDER_PRESETS } from '../src/brain/client.js';

const ok = (m) => `  \x1b[32m✓\x1b[0m ${m}`;
const bad = (m) => `  \x1b[31m✗\x1b[0m ${m}`;
const warn = (m) => `  \x1b[33m!\x1b[0m ${m}`;
const info = (m) => `    \x1b[90m${m}\x1b[0m`;

let failures = 0;

async function main() {
  console.log('');
  console.log('═══ 微信伴侣 · 体检 ═══');
  console.log('');

  // 1. 运行环境
  console.log('【运行环境】');
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) console.log(ok(`Node ${process.versions.node}`));
  else { console.log(bad(`Node ${process.versions.node} 版本过低，需要 >= 20`)); failures++; }

  if (typeof fetch === 'function') console.log(ok('内置 fetch 可用（零依赖运行）'));
  else { console.log(bad('缺少 fetch，Node 版本可能过旧')); failures++; }

  // 2. 目录
  console.log('');
  console.log('【目录】');
  try {
    ensureDirs();
    console.log(ok(`项目目录 ${ROOT_DIR}`));
    console.log(ok(`数据目录 ${DATA_DIR}`));
  } catch (err) {
    console.log(bad(`目录创建失败: ${err.message}`)); failures++;
  }

  // 3. 配置
  console.log('');
  console.log('【配置】');
  let cfg;
  try {
    cfg = loadConfig();
    console.log(ok('config.json 可读（不存在时自动用默认值）'));
  } catch (err) {
    console.log(bad(`配置读取失败: ${err.message}`)); failures++;
    return summary();
  }

  const cfgPath = path.join(DATA_DIR, 'config.json');
  if (fs.existsSync(cfgPath)) console.log(info(cfgPath));
  else console.log(info('还没有 config.json，首次保存设置时会自动创建'));

  // 4. 微信绑定
  console.log('');
  console.log('【微信通道】');
  if (cfg.channel.botToken) {
    console.log(ok('已绑定微信号'));
    console.log(info(`绑定时间: ${cfg.channel.boundAt || '未知'}`));
  } else {
    console.log(warn('还没绑定微信 —— 运行 npm run login 扫码绑定'));
  }

  // 5. 网络
  console.log('');
  console.log('【网络】');
  try {
    const res = await fetch(`${cfg.channel.apiBase}/ilink/bot/get_bot_qrcode?bot_type=3`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot_type: 3 }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) console.log(ok(`iLink 服务可达 (${cfg.channel.apiBase})`));
    else console.log(warn(`iLink 返回 HTTP ${res.status}（可能正常，登录时再验证）`));
  } catch (err) {
    console.log(bad(`连不上 iLink 服务: ${err.message}`));
    console.log(info('检查网络/代理；这个地址必须能访问才能绑定微信'));
    failures++;
  }

  // 6. 模型
  console.log('');
  console.log('【对话模型】');
  const preset = PROVIDER_PRESETS[cfg.brain.provider];
  console.log(info(`服务商: ${preset?.label ?? cfg.brain.provider}`));
  console.log(info(`模型: ${cfg.brain.model}`));
  console.log(info(`地址: ${cfg.brain.baseUrl}`));

  if (!cfg.brain.apiKey) {
    console.log(warn('还没填 API Key —— 去控制台「大脑」页填，或直接编辑 data/config.json'));
    if (preset?.keyUrl) console.log(info(`申请地址: ${preset.keyUrl}`));
    failures++;
  } else {
    const r = await testConnection(cfg.brain);
    if (r.ok) console.log(ok(`连接正常 (${r.message})`));
    else { console.log(bad(`连接失败: ${r.message}`)); failures++; }
  }

  // 7. 世界引擎
  console.log('');
  console.log('【世界引擎】');
  if (!cfg.world.enabled) {
    console.log(warn('已关闭 —— 她不会有自己的日子（建议开启）'));
  } else if (cfg.world.baseUrl && cfg.world.model) {
    console.log(ok('已配独立模型'));
  } else {
    console.log(warn('未配独立模型，正在复用对话模型'));
    console.log(info('功能可用，但会跟聊天互相干扰。建议在「大脑」页单独配一个'));
  }

  // 8. 人格与记忆
  console.log('');
  console.log('【她】');
  console.log(ok(`${cfg.persona.name}，${cfg.persona.age}岁，${cfg.persona.city}，${cfg.persona.mbti}`));
  console.log(info(`职业: ${cfg.persona.job}`));
  const memFile = path.join(DATA_DIR, 'memory.json');
  if (fs.existsSync(memFile)) {
    const mem = JSON.parse(fs.readFileSync(memFile, 'utf8'));
    console.log(ok(`记忆 ${mem.entries?.length ?? 0} 条`));
  } else {
    console.log(info('还没有记忆，聊过之后会产生'));
  }

  // 9. 安全开关
  console.log('');
  console.log('【安全】');
  if (cfg.behavior.paused) console.log(warn('急停已开启，她不会回复任何消息'));
  else console.log(ok('急停未开启'));
  console.log(info(`每日主动消息上限: ${cfg.behavior.proactiveDailyLimit}`));
  console.log(info(`安静时段: ${cfg.behavior.quietHours.start} - ${cfg.behavior.quietHours.end}`));

  summary();
}

function summary() {
  console.log('');
  console.log('═══ 结论 ═══');
  if (failures === 0) {
    console.log('  \x1b[32m全部通过，可以运行 npm start 了\x1b[0m');
  } else {
    console.log(`  \x1b[33m有 ${failures} 项需要处理（见上面 ✗ 和 ! 的说明）\x1b[0m`);
  }
  console.log('');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('体检脚本自身出错:', err);
  process.exit(1);
});
