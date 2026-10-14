#!/usr/bin/env node
// 程序入口。
//
//   node src/main.js            启动她（常驻）
//   node src/main.js --login    扫码绑定微信号
//   node src/main.js --console  只启动后台控制台
//   node src/main.js --once     干跑一次（不连微信，只验证模型与人格）

import { Companion } from './companion.js';
import { runLogin } from './login.js';
import { loadConfig } from './config.js';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

async function main() {
  if (has('--help') || has('-h')) {
    printHelp();
    return;
  }

  // 扫码绑定
  if (has('--login')) {
    const r = await runLogin({ logger: console.log });
    process.exit(r.ok ? 0 : 1);
  }

  // 干跑：不连微信，直接看她的提示词与一次回复
  if (has('--once')) {
    await dryRun();
    return;
  }

  const cfg = loadConfig();

  // 只起控制台
  if (has('--console')) {
    const { startConsole } = await import('./console/server.js');
    await startConsole({ cfg });
    return;
  }

  // 常驻
  const companion = new Companion({ config: cfg });

  if (!companion.isBound()) {
    console.error('');
    console.error('✗ 还没有绑定微信号。');
    console.error('');
    console.error('  请先运行：  npm run login');
    console.error('');
    process.exit(1);
  }

  // 顺便起控制台
  const { startConsole } = await import('./console/server.js');
  await startConsole({ cfg, companion });

  await companion.start();

  // 优雅退出
  const shutdown = () => {
    console.log('\n正在停止…');
    companion.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** 干跑：验证配置、人格、模型是否都通，不需要微信。 */
async function dryRun() {
  const { MemoryStore } = await import('./soul/memory.js');
  const { WorldEngine } = await import('./brain/world-engine.js');
  const { Soul } = await import('./soul/soul.js');
  const { buildSystemPrompt, deriveTraits } = await import('./soul/persona.js');

  const cfg = loadConfig();
  const memory = new MemoryStore({ maxEntries: cfg.memory.maxEntries });
  const world = new WorldEngine({ cfg, memory });
  const soul = new Soul({ cfg, memory, world, logger: (l, m) => console.log(`[${l}] ${m}`) });

  console.log('');
  console.log('══ 干跑检查（不连微信）══');
  console.log('');
  console.log(`她叫：${cfg.persona.name}，${cfg.persona.age}岁，${cfg.persona.city}`);
  console.log(`职业：${cfg.persona.job}`);
  console.log(`性格：${cfg.persona.mbti} → ${JSON.stringify(deriveTraits(cfg.persona.mbti))}`);
  console.log('');

  const daily = soul.todayFor();
  console.log(`今天的她：${daily.fromWorld ? '（来自世界引擎剧本）' : '（随机兜底，世界引擎还没跑过）'}`);
  console.log(`  作息 ${daily.wakeAt} 起 / ${daily.sleepAt} 睡，心情「${daily.mood}」`);
  console.log('');

  console.log('── 系统提示词预览（前 40 行）──');
  const prompt = buildSystemPrompt({
    persona: cfg.persona,
    traits: deriveTraits(cfg.persona.mbti),
    daily,
    world: {},
    memories: [],
    relation: {},
    now: new Date(),
  });
  console.log(prompt.split('\n').slice(0, 40).join('\n'));
  console.log('  …（共 ' + prompt.split('\n').length + ' 行）');
  console.log('');

  if (!cfg.brain.apiKey) {
    console.log('⚠️  没填 API Key，跳过真实对话测试。');
    console.log('   去 data/config.json 里填 brain.apiKey，或运行 npm run doctor 看指引。');
    return;
  }

  console.log('── 真实对话测试 ──');
  const fake = { fromUserId: 'dry-run', text: '在吗，今天过得怎么样', messageType: 1, items: [], kinds: [] };
  const result = await soul.respond(fake);
  if (!result) {
    console.log('✗ 生成失败，检查模型配置');
    return;
  }
  console.log(`模型返回（拆成 ${result.chunks.length} 条，拟人延迟 ${result.rhythm.beforeFirst}ms 后发第一条）：`);
  result.chunks.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
  console.log('');
  console.log('✓ 链路通了。接下来运行 npm run login 绑定微信。');
}

function printHelp() {
  console.log(`
微信伴侣 —— 一个有性格、有生活的 AI 微信伴侣

用法：
  npm run login      扫码绑定微信号（第一次必须做）
  npm start          启动她（常驻）
  npm run doctor     体检：检查配置、模型、网络
  npm run once       干跑：不连微信，只看她的提示词和一次回复

选项：
  --login            扫码绑定
  --console          只启动后台控制台（默认端口 43121）
  --once             干跑一次
  --help             显示帮助

数据目录：./data/
  config.json      配置（她的设定、模型、通道）
  memory.json      她记得的事
  world.json       世界引擎写的剧本
  diary/           她的日记（按天，记事本能打开）
  inbox/           收到你的图片/文件
  companion.log    运行日志
`);
}

main().catch((err) => {
  console.error('启动失败:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
