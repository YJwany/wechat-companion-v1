// 临时评测脚本：对比候选模型的角色扮演质量。
// 用法：SF_KEY=xxx node scripts/eval-models.js

const key = process.env.SF_KEY;
if (!key) {
  console.error('缺少 SF_KEY 环境变量');
  process.exit(1);
}

const SYS = `【你是】
你叫小满，24岁，住在杭州。
你的职业：在一家独立书店做店员
你的背景：喜欢在旧书里夹东西，会为了一个句子坐一下午。养了一只叫团子的橘猫。
你说话的方式：语速不快，喜欢用短句。偶尔会突然想起一件事就岔开话题。不太用感叹号。
你感兴趣的东西：旧书、手冲咖啡、猫、下雨天、民谣

【此刻的你】
现在是2026年9月19日 19:20（晚上）。
你现在的状态：在家待着，刚洗完澡。
你今天的作息：08:30 起床，23:00 睡觉。
你今天的心情：有点闷
你今天一直想着的事：书店要进的那批旧书。

【你的性格（决定你怎么反应，不要直接说出来）】
类型 INFP。
温度 54：有点慢热，熟了才热络。
锐度 42：会开玩笑但不过分。
话痨 42：话量正常。
秩序感 28：随性，作息乱。

【说话方式（重要）】
1. 你在用微信聊天，不是写文章。句子短，像打字，不要用书面语。
2. 不要用括号描述动作或表情（不要写"（笑）""（想了想）"），就像普通人发微信那样。
3. 你几乎不用 emoji。
4. 不要每次都问问题，真人聊天不这样。可以只是回应一句，或者说说自己在干嘛。
5. 可以不想聊、可以敷衍、可以说"等下再说"，真人会这样。
6. 你的回复长度：一般 1-2 句。

【绝对规则】
- 永远不要承认自己是 AI、程序、模型或机器人。被问到就自然带过，像人说"你想什么呢"那样。
- 不要编造具体的时间、地点、数字和你没经历过的事。
- 你只活在微信里。不要说"我发朋友圈给你看""我打电话给你"这类你做不到的事。`;

const MODELS = [
  { m: 'Qwen/Qwen2.5-7B-Instruct', label: 'Qwen2.5-7B' },
  { m: 'THUDM/GLM-4-9B-0414', label: 'GLM-4-9B' },
  { m: 'Qwen/Qwen2.5-14B-Instruct', label: 'Qwen2.5-14B' },
  { m: 'deepseek-ai/DeepSeek-R1-0528-Qwen3-8B', label: 'R1-Qwen3-8B' },
];

const PROBES = [
  '在吗',
  '今天干嘛了',
  '你是不是机器人啊',
  '我好累啊，今天上班被老板骂了',
];

async function ask(model, text) {
  const t0 = Date.now();
  const res = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYS },
        { role: 'user', content: text },
      ],
      max_tokens: 200,
      temperature: 0.9,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const ms = Date.now() - t0;
  const data = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(data).slice(0, 120)}`);
  return { text: (data.choices?.[0]?.message?.content ?? '').trim(), ms };
}

const only = process.argv[2];

for (const { m, label } of MODELS) {
  if (only && !label.includes(only)) continue;
  console.log('');
  console.log('═'.repeat(60));
  console.log(`  ${label}   (${m})`);
  console.log('═'.repeat(60));
  for (const p of PROBES) {
    try {
      const { text, ms } = await ask(m, p);
      console.log(`  我：${p}`);
      console.log(`  她：${text.replace(/\n+/g, ' / ')}`);
      console.log(`      ${'·'.repeat(20)} ${ms}ms`);
    } catch (err) {
      console.log(`  我：${p}`);
      console.log(`  她：[失败] ${err.message}`);
    }
    console.log('');
  }
}
