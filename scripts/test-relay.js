// 验证模型接入能吃中转站。
//
// 方法：起一个**真的本地 HTTP 服务**，模拟各种服务商的行为，然后打过去。
// 不 mock fetch —— mock 只能证明"我按我想的调了"，证明不了真能连通。
import http from 'node:http';
import { testConnection, explainError, PROVIDER_PRESETS } from '../src/brain/client.js';

let pass = 0, fail = 0;
const check = (n, c, extra = '') => {
  if (c) { console.log(`  ✓ ${n}`); pass++; }
  else { console.log(`  ✗ ${n} ${extra}`); fail++; }
};

/** 按给定行为起一个假服务商，返回 baseUrl。 */
function fakeProvider({ modelsStatus = 404, chatStatus = 200, chatBody = '{}', delay = 0 }) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const send = () => {
        if (req.url.endsWith('/models')) {
          res.writeHead(modelsStatus, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'not supported' } }));
        }
        if (req.url.endsWith('/chat/completions')) {
          res.writeHead(chatStatus, { 'Content-Type': 'application/json' });
          return res.end(chatBody);
        }
        res.writeHead(404); res.end('{}');
      };
      if (delay) setTimeout(send, delay); else send();
    });
    srv.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${srv.address().port}/v1`, close: () => srv.close() });
    });
  });
}

console.log('一、地址拼接');
console.log('─'.repeat(64));
{
  const p = await fakeProvider({ modelsStatus: 404, chatStatus: 200, chatBody: '{"choices":[]}' });
  // 故意带尾斜杠，验证不会拼成 //chat/completions
  const r = await testConnection({ baseUrl: `${p.url}/`, model: 'x' });
  check('baseUrl 带尾斜杠也能用', r.ok, r.message);
  p.close();
}

console.log('');
console.log('二、★ 核心场景：中转站不支持 /models，但对话能用');
console.log('─'.repeat(64));
{
  const p = await fakeProvider({ modelsStatus: 404, chatStatus: 200, chatBody: '{"choices":[{"message":{"content":"在"}}]}' });
  const r = await testConnection({ baseUrl: p.url, model: 'gpt-4o-mini' });
  console.log(`   结果: ok=${r.ok} via=${r.via}`);
  console.log(`   消息: ${r.message}`);
  check('★ 不该误报失败（这是最劝退的一种错）', r.ok, r.message);
  check('说明是通过对话测出来的', r.via === 'chat');
  check('提示了 /models 不支持但没影响', /中转站常见|不影响/.test(r.message));
  p.close();
}

console.log('');
console.log('三、官方站：/models 就能过（便宜的那条路）');
console.log('─'.repeat(64));
{
  const p = await fakeProvider({ modelsStatus: 200, chatStatus: 200 });
  const r = await testConnection({ baseUrl: p.url, model: 'gpt-4o-mini' });
  check('走 /models 就返回 ok', r.ok && r.via === 'models', JSON.stringify(r));
  p.close();
}

console.log('');
console.log('四、各类失败的提示要能指导排错（给别人搭建时全靠这个）');
console.log('─'.repeat(64));
{
  const cases = [
    { modelsStatus: 401, chatStatus: 401, chatBody: '{"error":{"message":"Invalid API key"}}',
      want: /Key 无效/, label: 'Key 错了' },
    { modelsStatus: 404, chatStatus: 404, chatBody: '{"error":{"message":"Not Found"}}',
      want: /baseUrl|地址/, label: '地址不对（404）' },
    { modelsStatus: 404, chatStatus: 400, chatBody: '{"error":{"message":"model gpt-5 does not exist"}}',
      want: /模型名/, label: '模型名不对（400）' },
    { modelsStatus: 404, chatStatus: 429, chatBody: '{"error":{"message":"rate limit"}}',
      want: /限流|余额/, label: '限流/余额' },
    { modelsStatus: 404, chatStatus: 402, chatBody: '{"error":{"message":"insufficient balance"}}',
      want: /余额/, label: '余额不足（402）' },
    { modelsStatus: 404, chatStatus: 500, chatBody: '{"error":{"message":"boom"}}',
      want: /服务端出错/, label: '服务端 5xx' },
  ];
  for (const c of cases) {
    const p = await fakeProvider({ modelsStatus: c.modelsStatus, chatStatus: c.chatStatus, chatBody: c.chatBody });
    const r = await testConnection({ baseUrl: p.url, model: 'x' });
    const good = !r.ok && c.want.test(r.message);
    if (good) pass++; else fail++;
    console.log(`  ${good ? '✓' : '✗'} ${c.label.padEnd(18)} → ${r.message}${r.hint ? `\n     提示: ${r.hint}` : ''}`);
    p.close();
  }
}

console.log('');
console.log('五、连不上（服务没起）');
console.log('─'.repeat(64));
{
  const r = await testConnection({ baseUrl: 'http://127.0.0.1:1/v1', model: 'x' });
  check('返回失败而不是抛错', !r.ok);
  check('说了怎么排查', /网络|代理|baseUrl|Ollama/.test(r.hint ?? ''), r.hint);
}

console.log('');
console.log('六、填漏了要拦在前面');
console.log('─'.repeat(64));
check('没填 baseUrl', (await testConnection({ model: 'x' })).message.includes('baseUrl'));
check('没填模型名', (await testConnection({ baseUrl: 'http://x/v1' })).message.includes('模型名'));

console.log('');
console.log('七、explainError 认各种格式');
console.log('─'.repeat(64));
check('OpenAI 风格 error.message', explainError(400, '{"error":{"message":"bad"}}').includes('bad'));
check('error 是字符串', explainError(400, '{"error":"oops"}').includes('oops'));
check('顶层 message', explainError(400, '{"message":"hmm"}').includes('hmm'));
check('不是 JSON 也不炸', explainError(500, 'Internal Server Error').includes('服务端出错'));
check('空响应体不炸', explainError(418, '') === 'HTTP 418');

console.log('');
console.log('八、预设里要有一个能填中转站的入口');
console.log('─'.repeat(64));
check('有 custom 预设', !!PROVIDER_PRESETS.custom);
check('custom 说明里提到了中转站', /中转站/.test(PROVIDER_PRESETS.custom.note));
check('custom 说明里讲了 /models 的事', /\/models/.test(PROVIDER_PRESETS.custom.note));

console.log('');
console.log('═'.repeat(64));
console.log(`通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
