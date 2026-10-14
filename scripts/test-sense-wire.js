// 接线验证：常识块真的进了提示词吗？发前自检真的会改口吗？
//
// 方法：起一个假模型服务记下所有请求，然后跑一次**真实的 respond()**。
// 不用 mock —— mock 只能证明"我按我想的调了"。
import http from 'node:http';
import fs from 'node:fs';
import { Companion } from '../src/companion.js';
import { loadConfig, STATE_FILE } from '../src/config.js';

let pass = 0, fail = 0;
const check = (n, c, extra = '') => {
  if (c) { console.log(`  ✓ ${n}`); pass++; }
  else { console.log(`  ✗ ${n} ${extra}`); fail++; }
};

const BAD = '我昨晚睡在公司了';
const GOOD = '在家呢，怎么了';

const seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* 忽略 */ }
    seen.push(parsed);

    const all = JSON.stringify(parsed.messages ?? []);
    // 自检请求独有的标记。"常识问题"只在"没查出问题"那个分支才出现，
    // 真有问题时用的是"你刚才想说" —— 用它才靠谱。
    const isSelfCheck = all.includes('你刚才想说') || all.includes('只输出那句话本身');
    const content = isSelfCheck ? GOOD : BAD;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { total_tokens: 10 },
    }));
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// 备份真实 state，测完还原
const backup = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, 'utf8') : null;

const cfg = loadConfig();
cfg.brain.baseUrl = `http://127.0.0.1:${port}/v1`;
cfg.brain.apiKey = 'test-key';
cfg.brain.model = 'fake-model';
cfg.memory.enabled = false;
cfg.behavior.commonSenseCheck = true;

const PEER = 'peer-sense-wire';
const c = new Companion({ config: cfg });
c.soul.relations.delete(PEER);
c.histories.delete(PEER);

console.log('一、常识块有没有进提示词');
console.log('─'.repeat(64));
{
  const history = [];
  const r = await c.soul.respond(
    { fromUserId: PEER, text: '你在干嘛', items: [], contextToken: '' },
    history,
  );

  check('模型被调用了', seen.length >= 1, `${seen.length} 次`);

  const first = JSON.stringify(seen[0]?.messages ?? []);
  check('★ 提示词里有常识块', first.includes('这个世界怎么运转'),
    '—— 这行不在的话，约束等于没写');
  check('常识块里写明了银行营业时间', first.includes('9:00-17:00'));
  check('常识块里说了不能同时出现在两个地方', first.includes('不能同时出现在两个地方'));
  check('常识块带了当前时间', /\d{2}:\d{2}/.test(first));

  console.log('');
  console.log('二、发前自检真的触发了吗');
  console.log('─'.repeat(64));
  check('★ 模型被调用了两次（原创 + 自检复核）', seen.length === 2, `实际 ${seen.length} 次`);

  const second = JSON.stringify(seen[1]?.messages ?? []);
  check('第二次请求是自检（带了原句和改法要求）',
    second.includes('你刚才想说') && second.includes('只输出那句话本身'), second.slice(0, 120));
  check('自检请求里带了原句', second.includes(BAD) || second.includes('睡在公司'));

  console.log('');
  console.log('三、最终发出去的是改过的话吗（这才是重点）');
  console.log('─'.repeat(64));
  const joined = (r?.chunks ?? []).join(' / ');
  console.log(`  原句（模型先想说的）: ${BAD}`);
  console.log(`  改后（最终发出的）  : ${joined}`);
  check('★ 穿帮的那句没有流出去', !(r?.chunks ?? []).join('').includes('睡在公司'),
    `实际发出了: ${joined}`);
  check('★ 发出去的是改好的那句', joined.includes('在家'), `实际: ${joined}`);
}

console.log('');
console.log('四、关掉自检开关就该不查');
console.log('─'.repeat(64));
{
  seen.length = 0;
  const cfg2 = loadConfig();
  cfg2.brain.baseUrl = `http://127.0.0.1:${port}/v1`;
  cfg2.brain.apiKey = 'test-key';
  cfg2.brain.model = 'fake-model';
  cfg2.memory.enabled = false;
  cfg2.behavior.commonSenseCheck = false;

  const c2 = new Companion({ config: cfg2 });
  c2.soul.relations.delete('peer-sense-off');
  c2.histories.delete('peer-sense-off');
  const r2 = await c2.soul.respond(
    { fromUserId: 'peer-sense-off', text: '你在干嘛', items: [], contextToken: '' },
    [],
  );
  check('★ 关掉后只调用一次（不自检）', seen.length === 1, `实际 ${seen.length} 次`);
  check('关掉后穿帮的话原样发出（符合预期）',
    (r2?.chunks ?? []).join('').includes('睡在公司'));

  c2.soul.relations.delete('peer-sense-off');
  c2.histories.delete('peer-sense-off');
}

console.log('');
console.log('五、正常的话不该触发自检（不浪费调用）');
console.log('─'.repeat(64));
{
  seen.length = 0;
  server.removeAllListeners('request');
  const okServer = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      let p = {}; try { p = JSON.parse(b); } catch { /* */ }
      seen.push(p);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '在家看书呢' } }] }));
    });
  });
  await new Promise((r) => okServer.listen(0, '127.0.0.1', r));

  const cfg3 = loadConfig();
  cfg3.brain.baseUrl = `http://127.0.0.1:${okServer.address().port}/v1`;
  cfg3.brain.apiKey = 'k'; cfg3.brain.model = 'm';
  cfg3.memory.enabled = false;
  const c3 = new Companion({ config: cfg3 });
  c3.soul.relations.delete('peer-ok');
  await c3.soul.respond({ fromUserId: 'peer-ok', text: '在吗', items: [], contextToken: '' }, []);
  check('★ 正常回复只调用一次，不白花自检的钱', seen.length === 1, `实际 ${seen.length} 次`);
  c3.soul.relations.delete('peer-ok');
  okServer.close();
}

// ── 清理 ──
server.close();
c.soul.relations.delete(PEER);
c.histories.delete(PEER);
c.state.sleepNote = {}; c.reunion.state = {}; c.milestones.state = {};
delete c.state.histories?.[PEER];
if (backup !== null) fs.writeFileSync(STATE_FILE, backup);
else { try { fs.unlinkSync(STATE_FILE); } catch { /* 本来就没有 */ } }

console.log('');
console.log('═'.repeat(64));
console.log(`通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
