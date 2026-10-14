// 后台控制台：本地 HTTP 服务 + 单文件页面。
//
// 为什么需要它：她的行为（人格、记忆、日记、主动消息）必须是**可见可控**的，
// 否则就是黑盒。这条是硬约束 —— 做了的功能必须在后台有体现。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, sanitizeConfig, DATA_DIR, ROOT_DIR } from '../config.js';
import { PROVIDER_PRESETS, testConnection, testRun } from '../brain/client.js';
import { MBTI_LIST } from '../soul/mbti.js';
import { PromiseLedger } from '../soul/promises.js';
import { stickerStats, findSticker, readSticker } from '../soul/stickers.js';
import { backupStats, shouldBackup, runBackup, pruneBackups } from '../system/backup.js';
import { forgePersona, detectOverrides } from '../soul/forge.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, 'page.html');

/**
 * 启动控制台。
 * @param {{cfg: object, companion?: object}} opts
 */
export async function startConsole({ cfg, companion }) {
  const port = cfg.system.consolePort || 43121;

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res, { companion });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`端口 ${port} 已被占用。改 data/config.json 里的 system.consolePort`));
      } else reject(err);
    });
    server.listen(port, '127.0.0.1', resolve);
  });

  if (companion) companion.log('info', `控制台已启动: http://127.0.0.1:${port}/`);
  else console.log(`控制台已启动: http://127.0.0.1:${port}/`);

  return server;
}

async function route(req, res, { companion }) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  // 页面
  if (p === '/' || p === '/index.html') {
    const html = fs.readFileSync(PAGE, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // ── API ──
  if (p === '/api/status') return sendJson(res, 200, statusOf(companion));

  if (p === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, { config: loadConfig(), presets: PROVIDER_PRESETS, mbti: MBTI_LIST });
  }

  if (p === '/api/config' && req.method === 'POST') {
    const body = await readBody(req);
    const incoming = JSON.parse(body);
    const current = loadConfig();
    // 只接受默认配置骨架里存在的键，避免写入永不生效的值
    const clean = sanitizeConfig(incoming);
    // botToken 不允许从后台改（防误清空导致掉线）
    if (current.channel?.botToken) clean.channel = { ...clean.channel, botToken: current.channel.botToken };
    const merged = { ...current, ...clean };
    if (companion) companion.reload(merged);
    else saveConfig(merged);
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/test/connection' && req.method === 'POST') {
    const { slot } = JSON.parse(await readBody(req));
    return sendJson(res, 200, await testConnection(slot));
  }

  if (p === '/api/test/run' && req.method === 'POST') {
    const { slot } = JSON.parse(await readBody(req));
    return sendJson(res, 200, await testRun(slot));
  }

  if (p === '/api/memory') {
    if (!companion) return sendJson(res, 200, { entries: [], stats: { total: 0, byBucket: {} } });
    return sendJson(res, 200, {
      entries: companion.memory.recent(100),
      stats: companion.memory.stats(),
    });
  }

  if (p === '/api/diary') {
    if (!companion) return sendJson(res, 200, { diaries: [], scripts: {} });
    return sendJson(res, 200, {
      diaries: companion.world.listDiaries(30),
      scripts: companion.world.state.scripts ?? {},
    });
  }

  if (p === '/api/moment' && req.method === 'POST') {
    if (!companion) return sendJson(res, 400, { error: '服务未运行' });
    try {
      const { topic } = JSON.parse(await readBody(req).catch(() => '{}'));
      const text = await companion.sendMomentToOwner(topic ?? '');
      return sendJson(res, 200, { ok: true, text });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (p === '/api/say' && req.method === 'POST') {
    if (!companion) return sendJson(res, 400, { error: '服务未运行' });
    const { text } = JSON.parse(await readBody(req));
    if (!text?.trim()) return sendJson(res, 400, { error: '内容为空' });
    try {
      const peer = companion.cfg.moments.autoSendTo || companion.lastPeer;
      if (!peer) return sendJson(res, 400, { error: '还没有聊天对象，先让微信发她一句话' });
      const ilink = await import('../channel/ilink.js');
      await ilink.sendTextMessage(companion.creds, peer, text.trim(), '');
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // ── 自动备份 ──
  if (p === '/api/backup') {
    const keep = loadConfig().system?.backupKeepDays ?? 7;
    return sendJson(res, 200, { ...backupStats(keep), due: shouldBackup() });
  }

  // 手动立刻备份一次（控制台按钮）
  if (p === '/api/backup/run' && req.method === 'POST') {
    const keep = loadConfig().system?.backupKeepDays ?? 7;
    const r = runBackup({ logger: (lv, m) => console.log(`[${lv}] ${m}`) });
    if (r.ok) pruneBackups(keep);
    return sendJson(res, r.ok ? 200 : 400,
      r.ok ? { ok: true, ...r, ...backupStats(keep) } : r);
  }

  // ── 人设贴合：给一段模板 → 自动生成完整人设 ──
  // 只**预览**，不直接写入配置 —— 生成结果会填进表单，用户改完再自己点保存。
  // 自动覆盖人设是越权的事，哪怕生成得再好。
  if (p === '/api/persona/forge' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: '请求格式不对' }); }
    const template = body?.template ?? '';
    const c = loadConfig();
    try {
      const r = await forgePersona({ cfg: c, template, current: c.persona ?? {} });
      if (!r.ok) return sendJson(res, 400, r);
      return sendJson(res, 200, {
        ...r,
        overrides: detectOverrides(template, r.persona, c.persona ?? {}),
      });
    } catch (err) {
      return sendJson(res, 400, { ok: false, reason: `生成失败：${err.message}` });
    }
  }

  // ── 表情包库 ──
  if (p === '/api/stickers') {
    return sendJson(res, 200, stickerStats());
  }

  // ── 让她现在发个表情包（测试用）──
  if (p === '/api/stickers/send' && req.method === 'POST') {
    if (!companion) return sendJson(res, 400, { error: '服务未运行' });
    const { name } = JSON.parse(await readBody(req));
    // 发送对象：优先配置的 autoSendTo，其次最近说过话的人，最后回退到自己的 ilink 身份。
    // 回退这一层是为了让"重启后还没人说话就点按钮"也能用，而不是报一句没头没脑的错。
    const peer = companion.cfg.moments.autoSendTo
      || companion.lastPeer
      || companion.cfg.channel.ilinkUserId;
    if (!peer) return sendJson(res, 400, { error: '还没有发送对象（先扫码绑定，或在配置里指定 autoSendTo）' });
    try {
      const spec = findSticker(name ?? '');
      if (!spec) return sendJson(res, 400, { error: '库里没有表情包（先往 data/stickers/ 放几张图）' });
      const data = readSticker(spec);
      if (!data) return sendJson(res, 400, { error: `读不到「${spec.name}」的文件` });
      await companion.sendImageBuffer(peer, data.data);
      return sendJson(res, 200, { ok: true, sent: spec.name });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // ── 她答应过的事（承诺账本）──
  if (p === '/api/promises') {
    const led = new PromiseLedger();
    return sendJson(res, 200, { stats: led.stats(), items: led.recent(30) });
  }

  // ── 识图：真跑一次（拿她相册里的图试）──
  if (p === '/api/vision/test' && req.method === 'POST') {
    const cfg = loadConfig();
    const v = cfg.vision ?? {};
    const slot = {
      baseUrl: v.baseUrl || cfg.brain.baseUrl,
      apiKey: v.apiKey || cfg.brain.apiKey,
      model: v.model || cfg.brain.model,
    };
    if (!slot.model) return sendJson(res, 400, { error: '没有可用的识图模型（先填模型名）' });

    const { listPhotos, readPhoto } = await import('../soul/album.js');
    const photos = listPhotos();
    if (!photos.length) {
      return sendJson(res, 400, {
        error: '相册是空的，没法测。先往 data/photos/ 放一张图',
      });
    }

    const photo = photos.sort((a, b) => b.size - a.size)[0];
    try {
      const { visionDescribe } = await import('../brain/client.js');
      const description = await visionDescribe(slot, {
        imageData: readPhoto(photo.path),
        mime: 'image/jpeg',
        prompt: '用一两句口语描述这张图片。像跟朋友说话那样。',
      });
      return sendJson(res, 200, {
        ok: true,
        model: slot.model,
        usedFallback: !v.model,
        testedOn: photo.name,
        description,
      });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message, model: slot.model });
    }
  }

  // ── 相册：她发照片给你 ──
  if (p === '/api/album' && req.method === 'GET') {
    const { photoStats } = await import('../soul/album.js');
    return sendJson(res, 200, photoStats());
  }

  if (p === '/api/album/send' && req.method === 'POST') {
    if (!companion) return sendJson(res, 400, { error: '服务未运行' });
    const body = await readBody(req).catch(() => '{}');
    let prefer = '';
    let note = '';
    try {
      const o = JSON.parse(body || '{}');
      prefer = o.prefer ?? '';
      note = o.note ?? '';
    } catch { /* 用默认值 */ }

    try {
      const r = await companion.sendPhotoToOwner({ prefer, note });
      return sendJson(res, 200, { ok: true, ...r });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (p === '/api/world/run' && req.method === 'POST') {    if (!companion) return sendJson(res, 400, { error: '服务未运行' });
    // 手动触发默认给**今天**写 —— 否则今天她仍然没有生活可分享
    // （当晚自动跑时才写明天，那是"昨晚写今天"的正常节奏）
    const body = await readBody(req).catch(() => '{}');
    let target = 'today';
    try { target = JSON.parse(body || '{}').target ?? 'today'; } catch { /* 默认今天 */ }

    const now = new Date();
    const forDate = target === 'tomorrow'
      ? dateKey(new Date(now.getTime() + 86_400_000))
      : dateKey(now);

    const r = await companion.world.generateForTomorrow(now, { forDate });
    return sendJson(res, r.ok ? 200 : 400, r);
  }

  if (p === '/api/log') {
    const logFile = path.join(DATA_DIR, 'companion.log');
    if (!fs.existsSync(logFile)) return sendJson(res, 200, { lines: [] });
    const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-200);
    return sendJson(res, 200, { lines });
  }

  if (p === '/api/restart-hint') {
    return sendJson(res, 200, { root: ROOT_DIR, data: DATA_DIR });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404');
}

function statusOf(companion) {
  if (!companion) {
    return { running: false, bound: false, note: '控制台以独立模式运行，未启动她' };
  }
  const cfg = companion.cfg;
  const daily = companion.soul.todayFor();
  const slot = companion.world.resolveSlot();
  return {
    running: companion.running,
    bound: companion.isBound(),
    name: cfg.persona.name,
    model: cfg.brain.model,
    daily,
    worldDegraded: slot.degraded === true && cfg.world.enabled,
    memory: companion.memory.stats(),
    paused: cfg.behavior.paused,
    lastPeer: companion.lastPeer,
    proactiveUsedToday: companion.state.dailyProactive[dateKey(new Date())] ?? 0,
    proactiveLimit: cfg.behavior.proactiveDailyLimit,
    // 她此刻的状态（平静/抓紧/反复/收起）+ 压力值。
    // 压力会随时间衰减，所以这里是"读的时候算"的实时值。
    deform: companion.soul.deform.stats(companion.soul.thresholdsFor()),
    portrait: companion.soul.portrait ?? null,
    sleepNote: (() => {
      const s = companion.state.sleepNote ?? {};
      const keys = Object.keys(s);
      return keys.length ? { count: keys.length } : null;
    })(),
  };
}

function sendJson(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1_000_000) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
