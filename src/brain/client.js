// 模型层：OpenAI 兼容协议的统一客户端 + 免费 provider 预设。
//
// 设计目标：换模型 = 改配置，不动代码。先用免费模型跑通，随时可切付费。
// 全部走 OpenAI 兼容的 /chat/completions，这是当下事实标准。

/** 免注册/免费额度友好的 provider 预设。 */
export const PROVIDER_PRESETS = {
  siliconflow: {
    label: '硅基流动 SiliconFlow（有免费模型）',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    note: '注册送额度，Qwen2.5-7B 等小模型免费。中文效果好，推荐先用这个。',
  },
  zhipu: {
    label: '智谱 GLM（有免费模型）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    note: 'glm-4-flash 长期免费，中文自然，适合角色扮演。',
  },
  deepseek: {
    label: 'DeepSeek 官方（便宜，非免费）',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    note: '中文拟人度很好，价格低。跑顺了建议换这个。',
  },
  moonshot: {
    label: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    note: '长上下文，适合记住更多聊天历史。',
  },
  ollama: {
    label: '本地 Ollama（完全免费，需自己装）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    keyUrl: 'https://ollama.com/download',
    note: '不花钱、不出网、隐私最好，但需要本机显卡能跑。',
  },
  custom: {
    label: '自定义 / 中转站（任何 OpenAI 兼容接口）',
    baseUrl: '',
    model: '',
    keyUrl: '',
    note: '中转站、自建网关、公司内网模型都填这里。baseUrl 一般以 /v1 结尾（智谱那类以 /v4 结尾）。'
      + '中转站通常不支持 /models，测连通会自动改用真实对话来测，不会误报失败。',
  },
};

export class BrainError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'BrainError';
    this.status = status;
    this.body = body;
  }
}

/**
 * 调用一次对话补全。
 *
 * @param {object} slot - {baseUrl, apiKey, model, temperature, maxTokens}
 * @param {Array<{role:string, content:string}>} messages
 * @returns {Promise<string>} 助手回复正文
 */
export async function chat(slot, messages, { timeoutMs = 120_000, temperature, maxTokens, jsonMode = false } = {}) {
  if (!slot?.baseUrl) throw new BrainError('模型接口未配置 baseUrl');
  if (!slot?.model) throw new BrainError('模型接口未配置 model');

  const url = `${slot.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model: slot.model,
    messages,
    temperature: temperature ?? slot.temperature ?? 0.9,
    max_tokens: maxTokens ?? slot.maxTokens ?? 800,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };
  // 关掉推理模型的"思考"（只在配置了才传，兼容不认这个参数的模型）
  if (slot.reasoningEffort) body.reasoning_effort = slot.reasoningEffort;

  // 本地 Ollama 不校验 key，但某些实现会因空 Authorization 报错，故仅在有时才带。
  const headers = { 'Content-Type': 'application/json' };
  if (slot.apiKey) headers.Authorization = `Bearer ${slot.apiKey}`;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new BrainError(`模型请求超时（${timeoutMs}ms）: ${url}`);
    }
    throw new BrainError(`模型请求失败: ${err.message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let hint = '';
    if (res.status === 401) hint = ' —— API Key 无效或未填';
    else if (res.status === 404) hint = ' —— baseUrl 或模型名不对';
    else if (res.status === 429) hint = ' —— 触发限流，稍后再试或换模型';
    throw new BrainError(`模型返回 HTTP ${res.status}${hint}`, res.status, text.slice(0, 500));
  }

  const data = await res.json().catch((err) => {
    throw new BrainError(`模型返回非 JSON: ${err.message}`);
  });

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new BrainError(`模型返回结构异常: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return content;
}

/**
 * 从一段错误响应里挖出人话。
 *
 * 这一步对"给别人搭建"特别重要 —— 报错信息就是全部的排错体验。
 * 各家 API 的错误格式不完全一样，这里尽量都认。
 */
export function explainError(status, bodyText = '') {
  let msg = '';
  try {
    const j = JSON.parse(bodyText);
    msg = j?.error?.message ?? j?.error?.msg ?? j?.message ?? j?.msg ?? j?.error ?? '';
    if (typeof msg === 'object') msg = JSON.stringify(msg);
  } catch {
    msg = String(bodyText ?? '').slice(0, 200);
  }
  msg = String(msg || '').trim();

  const lower = msg.toLowerCase();

  if (status === 401) return 'API Key 无效或已过期';
  if (status === 403) return '没权限（Key 可能没开通这个模型）';
  if (status === 404) {
    return '地址或模型名不对。检查 baseUrl 是不是少/多了一层路径（多数是 /v1 结尾）';
  }
  if (status === 429) return '触发限流或余额不足';
  if (status === 402) return '余额不足，去充值';
  if (status >= 500) return `服务端出错（HTTP ${status}）${msg ? `：${msg}` : ''}`;

  if (status === 400) {
    if (/model/i.test(msg) && /(not|invalid|exist|found)/i.test(msg)) {
      return `模型名不对：${msg}`;
    }
    if (/context|token|length/i.test(lower)) return `输入太长了：${msg}`;
    return `请求被拒：${msg || 'HTTP 400'}`;
  }
  return msg ? `HTTP ${status}：${msg}` : `HTTP ${status}`;
}

/** 地址拼接：避免出现 //v1 或 /v1/ 这种。 */
function joinUrl(baseUrl, pathname) {
  return `${String(baseUrl).replace(/\/+$/, '')}${pathname}`;
}

/**
 * 连通性体检：验证地址 / key / 模型名。
 *
 * 为什么不能只打 /models：
 *   中转站（各种 API 代理）**大多不实现 /models**，官方站才实现。
 *   只打 /models 的话，中转站用户会看到"地址路径不对"——
 *   但对话其实完全能用。对"给别人搭建"来说这是最劝退的一种误报。
 *
 *   所以：/models 只当作"顺带确认密钥"，它失败不算数；
 *   真正的判据是**打一次最小对话**（反正那才是实际要用的东西）。
 *
 * @param {object} slot - {baseUrl, apiKey, model}
 * @param {object} opts - {probeChat: 是否在 /models 失败后用对话复测}
 * @returns {Promise<{ok, message, via?, hint?}>} 绝不抛错
 */
export async function testConnection(slot, { probeChat = true } = {}) {
  if (!slot?.baseUrl) return { ok: false, message: '未填 baseUrl' };
  if (!slot?.model) return { ok: false, message: '未填模型名' };

  const headers = {
    'Content-Type': 'application/json',
    ...(slot.apiKey ? { Authorization: `Bearer ${slot.apiKey}` } : {}),
  };

  // ── 第一关：/models。失败不当失败，只当线索 ──
  let modelsNote = '';
  try {
    const res = await fetch(joinUrl(slot.baseUrl, '/models'), {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      return { ok: true, message: '连接正常，密钥有效', via: 'models' };
    }
    if (res.status === 401) return { ok: false, message: 'API Key 无效（/models 拒绝了）' };
    if (res.status === 403) {
      // 有些中转站只禁 /models，对话照样能用 —— 不急着判死刑
      modelsNote = '/models 无权限';
    } else {
      modelsNote = `/models 返回 HTTP ${res.status}`;
    }
  } catch (err) {
    modelsNote = `/models 连不上（${err.message}）`;
  }

  if (!probeChat) return { ok: false, message: modelsNote };

  // ── 第二关：真打一次对话。这才是实际要用的能力 ──
  let res;
  try {
    res = await fetch(joinUrl(slot.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: slot.model,
        messages: [{ role: 'user', content: '在吗' }],
        max_tokens: 8,
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (err) {
    return {
      ok: false,
      message: `连不上：${err.message}`,
      hint: '检查①网络/代理 ②baseUrl 是否写错 ③如果本机跑 Ollama，服务起了吗',
    };
  }

  const bodyText = await res.text().catch(() => '');
  if (res.ok) {
    return {
      ok: true,
      via: 'chat',
      message: modelsNote
        ? `对话正常（${modelsNote} —— 中转站常见，不影响使用）`
        : '连接正常，对话可用',
    };
  }

  const explain = explainError(res.status, bodyText);
  const out = { ok: false, message: explain, via: 'chat', status: res.status };

  if (res.status === 404) {
    out.hint = '这个地址没有 /chat/completions。多数是 baseUrl 少了 /v1（或多了）。';
  } else if (res.status === 401) {
    out.hint = '去服务商后台重新复制一次 Key，注意别把前后空格带进来。';
  } else if (res.status === 400 && /model/i.test(bodyText)) {
    out.hint = '模型名要和你服务商后台里列出的完全一致（大小写、斜杠都算）。';
  }
  return out;
}

/**
 * 识图：让她"看得见"你发的图片。
 *
 * 为什么要独立槽位：对话模型不一定支持多模态。给她配一个独立的
 * 识图模型（如 Qwen2.5-VL），收到图片时先转成文字描述再喂给对话模型 ——
 * 这样**即使主模型没眼睛，她也能看懂图片**。
 *
 * 留空则回落到对话模型（若主模型本身支持看图，直接就能用）。
 *
 * @param {object} slot - {baseUrl, apiKey, model}
 * @param {object} opts - {imageData: Buffer, mime, prompt}
 * @returns {Promise<string>} 图片的文字描述
 */
export async function visionDescribe(slot, { imageData, mime = 'image/jpeg', prompt } = {}) {
  if (!slot?.baseUrl || !slot?.model) {
    throw new BrainError('识图接口未配置（需要 baseUrl 和模型名）');
  }
  if (!imageData || !imageData.length) {
    throw new BrainError('识图失败：图片数据为空');
  }

  const b64 = Buffer.isBuffer(imageData)
    ? imageData.toString('base64')
    : Buffer.from(imageData).toString('base64');

  const url = `${slot.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model: slot.model,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: prompt || '用一两句口语描述这张图片的内容。像跟朋友说话那样，不要用"图片中显示"这种书面语。',
        },
        {
          type: 'image_url',
          image_url: { url: `data:${mime};base64,${b64}` },
        },
      ],
    }],
    temperature: slot.temperature ?? 0.6,
    // 300 对"推理模型"太小：它先输出 reasoning_content（思考）也占 token，
    // 预算被思考吃光后 content 会是空的，看起来像"识图失败/结构异常"。
    // 给足余量，宁可多留也不让答案被挤掉。
    max_tokens: slot.maxTokens ?? 3000,
    ...(slot.reasoningEffort ? { reasoning_effort: slot.reasoningEffort } : {}),
  };

  const headers = { 'Content-Type': 'application/json' };
  if (slot.apiKey) headers.Authorization = `Bearer ${slot.apiKey}`;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new BrainError(`识图超时（90s）: ${url}`);
    }
    throw new BrainError(`识图请求失败: ${err.message}`);
  }

  const text = await res.text();
  if (!res.ok) {
    let hint = '';
    if (res.status === 401) hint = ' —— API Key 无效';
    else if (res.status === 404) hint = ' —— baseUrl 或模型名不对';
    else if (res.status === 400) hint = ' —— 这个模型可能不支持看图（换 Qwen2.5-VL 之类）';
    throw new BrainError(`识图返回 HTTP ${res.status}${hint}`, res.status, text.slice(0, 500));
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new BrainError(`识图返回非 JSON: ${err.message}`);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new BrainError(`识图返回结构异常: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return content.trim();
}

/**
 * 真跑一次：发一条最小真实请求，验证模型名可用并测耗时。
 */
export async function testRun(slot) {
  const started = Date.now();
  try {
    const reply = await chat(slot, [{ role: 'user', content: '回复两个字：在的' }], {
      timeoutMs: 60_000,
      maxTokens: 32,
      temperature: 0.3,
    });
    return {
      ok: true,
      message: `模型可用了，耗时 ${Date.now() - started}ms`,
      detail: reply.slice(0, 120),
    };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}
