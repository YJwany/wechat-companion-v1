// 常驻服务：把通道、大脑、灵魂串成一条活的链路。
//
// 生命周期：
//   启动 → 读配置 → 建记忆/世界引擎 → 开始长轮询 → 收消息 → 她回复
//                                             └→ 定时：醒着就查该不该主动找

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig, ensureDirs, DATA_DIR, INBOX_DIR, writeJsonAtomic, readJsonSafe, resolveVisionSlot } from './config.js';
import * as ilink from './channel/ilink.js';
import { extractUserMessages } from './channel/messages.js';
import { downloadMediaFromItem } from './channel/media.js';
import { MemoryStore } from './soul/memory.js';
import { PromiseLedger } from './soul/promises.js';
import { findSticker, readSticker } from './soul/stickers.js';
import { filterCommands } from './soul/commands.js';
import { listPhotos, readPhoto } from './soul/album.js';
import { longingLevel, reunionHint, ReunionLedger } from './soul/longing.js';
import { milestoneHint, MilestoneLedger } from './soul/milestones.js';
import { readPortrait, shouldUpdate, updatePortrait } from './soul/portrait.js';
import { SleepLedger, sleepHint } from './soul/sleep.js';
import { shouldBackup, runBackup, pruneBackups } from './system/backup.js';

/** 指令的中文名（日志和后台用）。 */
const CMD_LABEL = { sticker: '发表情包', image: '发照片', remember: '记件事', nudge_at: '定时提醒' };

/**
 * 按名字找相册里的照片（模糊匹配，理由同表情包：
 * 模型记不准文件名，宁可发个相近的也别让她发不出去）。
 */
function findPhoto(photos, wanted) {
  const w = String(wanted ?? '').replace(/\s+/g, '');
  if (!photos.length) return null;
  if (!w) return photos[Math.floor(Math.random() * photos.length)];
  return photos.find((p) => p.name === w)
    ?? photos.find((p) => w.includes(p.name) || p.name.includes(w))
    ?? photos.find((p) => p.name.includes(w.replace(/\.(jpg|jpeg|png|gif|webp)$/i, '')))
    ?? null;
}
import { WorldEngine } from './brain/world-engine.js';
import { Soul } from './soul/soul.js';

const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LOG_FILE = path.join(DATA_DIR, 'companion.log');

/** 简易日志：同时进标准输出和文件，后台能看历史。 */
export function createLogger(level = 'info') {
  const ranks = { debug: 0, info: 1, warn: 2, error: 3 };
  const min = ranks[level] ?? 1;

  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

  return function log(lvl, message) {
    if ((ranks[lvl] ?? 1) < min) return;
    const line = `[${new Date().toISOString()}] [${lvl.toUpperCase()}] ${message}`;
    // eslint-disable-next-line no-console
    console.log(line);
    try {
      fs.appendFileSync(LOG_FILE, `${line}\n`, 'utf8');
    } catch { /* 日志写不进去不该拖垮主流程 */ }
  };
}

/**
 * state.json 该有的形状。
 *
 * 这不是"初始化默认值"，是**迁移旧文件**用的 —— 老安装的 state.json
 * 里没有后来新增的键。缺了就用对应类型的空值补上，绝不能留 undefined：
 * 把 undefined 传进一个"期望对象"的函数里，它内部会默认成自己的 {}，
 * 于是写入的数据永远不落盘，而且不报任何错。
 */
const STATE_SHAPE = {
  cursor: '',
  pausedUntil: 0,
  dailyProactive: {},
  proactiveKinds: {},   // 今天发过哪种问候，避免重复
  proactivePlans: {},   // 每天随机抽的早安/晚安目标时刻
  recentPhotos: [],     // 最近发过的照片，避免重复
  contextTokens: {},    // peer → context_token（主动发送时需要）
  histories: {},        // peer → 对话历史（重启不丢，否则她会"断片"）
  summaries: {},        // peer → 更早对话的摘要（数组属性没法进 JSON，单独存）
  lastProactiveAt: '',
  lastUserAt: '',       // 用户最后说话的时间（主动消息判断"你多久没出现"）
  reunions: {},         // peer → 上次结算"你终于出现了"的时间
  sleepNote: {},        // peer → 她睡着时被找过的记录（醒来提一次）
  deform: null,         // 变形状态机（压力会随时间衰减，只存数值+时间点）
  metAt: '',            // 第一次说话的时间 —— 纪念日从这天算
  milestones: {},       // 已经提过哪些纪念日节点（每个只提一次）
  relations: {},        // peer → 关系状态（称呼、她最近说过的话）
  drift: {},            // 性格长期漂移
  seen: [],             // 处理过的消息 id，防重复回复
  worldTodayAttemptAt: '', // 上次"补写今天剧本"的尝试时间（失败冷却用）
};

function ensureStateShape(state) {
  for (const [key, empty] of Object.entries(STATE_SHAPE)) {
    if (state[key] === undefined || state[key] === null) {
      state[key] = Array.isArray(empty) ? [] : (typeof empty === 'object' ? {} : empty);
    }
  }
  return state;
}

export class Companion {
  constructor({ config } = {}) {
    this.cfg = config ?? loadConfig();
    ensureDirs();

    this.log = createLogger(this.cfg.system.logLevel);
    this.memory = new MemoryStore({ maxEntries: this.cfg.memory.maxEntries });
    this.promises = new PromiseLedger();
    this.world = new WorldEngine({ cfg: this.cfg, memory: this.memory });
    this.soul = new Soul({ cfg: this.cfg, memory: this.memory, world: this.world, logger: this.log });

    this.state = readJsonSafe(STATE_FILE, {});
    // 补齐后来新增的状态键。
    // readJsonSafe 只在**文件不存在**时才用默认值 —— 老安装的 state.json
    // 里没有新键，于是新加的账本会拿到 undefined。更阴的是：如果直接把
    // undefined 传给一个对象参数，它会得到自己的 {}，写进去也永远不落盘
    // （重逢账本就这样踩过一次）。
    ensureStateShape(this.state);

    // 把持久化的关系状态、性格漂移、变形状态装回 Soul ——
    // 少传一个，她就每次重启都"消气"或者"失忆"。
    this.soul.hydrate({
      relations: this.state.relations,
      drift: this.state.drift,
      deform: this.state.deform,
    });

    this.running = false;
    this.histories = new Map(); // peerId → [{role, content}]
    // peerId → context_token。入站消息带来，主动发送时复用。
    this.contextTokens = new Map(Object.entries(this.state.contextTokens ?? {}));
    this.lastPeer = '';
    this.timers = [];

    // 重逢账本：保证"你终于出现了"这类话只说一次
    this.reunion = new ReunionLedger(this.state.reunions);
    // 纪念日账本：每个节点只提一次
    this.milestones = new MilestoneLedger(this.state.milestones);
    // 睡梦账本：她睡着时谁来找过，醒来提一次
    this.sleep = new SleepLedger(this.state.sleepNote);
  }

  /**
   * 距用户上次说话过了多久（小时）。
   * 没有记录（第一次说话）时返回 Infinity —— 那不算"重逢"，是初次见面。
   */
  silentHours() {
    if (!this.state.lastUserAt) return Infinity;
    const last = new Date(this.state.lastUserAt).getTime();
    if (!Number.isFinite(last)) return Infinity;
    return (Date.now() - last) / 3_600_000;
  }

  saveState() {
    // seen 数组不必无限增长
    if (this.state.seen.length > 500) this.state.seen = this.state.seen.slice(-200);
    // 关系状态、性格漂移、变形状态由 Soul 持有，落盘时同步过来
    if (this.soul) {
      const snap = this.soul.serialize();
      this.state.relations = snap.relations;
      this.state.drift = snap.drift;
      this.state.deform = snap.deform;
    }
    writeJsonAtomic(STATE_FILE, this.state);
  }

  get creds() {
    return {
      botToken: this.cfg.channel.botToken,
      baseUrl: this.cfg.channel.apiBase,
    };
  }

  /** 是否已经绑定过微信号。 */
  isBound() {
    return Boolean(this.cfg.channel.botToken);
  }

  /** 启动常驻服务。 */
  async start() {
    if (!this.isBound()) {
      throw new Error('尚未绑定微信号。请先运行 npm run login 扫码绑定。');
    }
    if (this.running) return;
    this.running = true;

    this.log('info', `启动中… 她叫 ${this.cfg.persona.name}，模型 ${this.cfg.brain.model}`);

    // 世界引擎降级提醒（如实告知，不静默）
    const slot = this.world.resolveSlot();
    if (slot.degraded && this.cfg.world.enabled) {
      this.log('warn', '世界引擎未配独立模型，正在复用对话模型（功能可用但会与聊天互相干扰）');
    }

    this.pollLoop();
    this.scheduleTimers();

    this.log('info', `已就绪，等待消息。控制台: http://127.0.0.1:${this.cfg.system.consolePort}/`);
  }

  stop() {
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.log('info', '已停止');
  }

  /** 长轮询主循环。 */
  async pollLoop() {
    while (this.running) {
      try {
        // 会话过期后暂停一段时间再试，避免打爆服务端
        if (this.state.pausedUntil && Date.now() < this.state.pausedUntil) {
          await sleep(30_000);
          continue;
        }

        const updates = await ilink.getUpdates(this.creds, this.state.cursor);

        if (updates?.errcode === ilink.ERR_SESSION_EXPIRED) {
          this.log('warn', '会话已过期（errcode -14），暂停 60 分钟后重试。可能需要重新扫码绑定。');
          this.state.pausedUntil = Date.now() + 60 * 60_000;
          this.saveState();
          continue;
        }

        if (updates?.get_updates_buf) {
          this.state.cursor = updates.get_updates_buf;
          this.saveState();
        }

        const messages = extractUserMessages(updates);
        for (const msg of messages) {
          // 幂等：同一条消息处理一次
          if (msg.clientId && this.state.seen.includes(msg.clientId)) continue;
          if (msg.clientId) this.state.seen.push(msg.clientId);

          // 不阻塞轮询循环
          this.handleMessage(msg).catch((err) => {
            this.log('error', `处理消息异常: ${err.stack ?? err.message}`);
          });
        }
        if (messages.length) this.saveState();
      } catch (err) {
        this.log('error', `轮询异常: ${err.message}`);
        await sleep(5000);
      }
    }
  }

  /** 处理一条消息：判断该不该回 → 生成 → 按节奏发出。 */
  async handleMessage(msg) {
    this.lastPeer = msg.fromUserId;

    // 记住这个会话的 context_token。
    // 参考实现把 token 按 peer 存起来，发媒体时必须有 —— 主动消息和
    // 发照片都不在"回复"上下文里，拿不到 token 就只能靠通道兜底。
    if (msg.contextToken) {
      this.rememberContextToken(msg.fromUserId, msg.contextToken);
    }

    // 先算"他隔了多久才说话" —— 必须在覆盖 lastUserAt **之前**算，
    // 否则永远是 0，重逢永远不触发。
    const silentHours = this.silentHours(msg.fromUserId);

    // 第一次说话就是"认识的那天"，纪念日从这天开始算
    if (!this.state.metAt) {
      this.state.metAt = new Date().toISOString();
      this.log('info', '记下认识的日子，以后算纪念日用');
    }

    // 记下"用户最后说话的时间" —— 主动消息靠它判断你多久没出现
    this.state.lastUserAt = new Date().toISOString();
    this.saveState();

    // 重逢结算：他隔了很久回来，这句话**只说一次**。
    // 不记账的话，他回来之后每聊一句她都会提"你好久没理我"——
    // 第一句是撒娇，第三句就是折磨。
    const hints = [];

    // 睡着时被找过 → 醒来第一轮补一句"昨晚我睡过去了"。
    // 之前这段提示词写在 persona.js 里，但 shouldReply 在她睡着时提前 return，
    // 那段提示词永远拼不进 prompt —— 提示词和代码没接上。
    // 现在改成：睡着时记账，醒来时消费一次。
    if (this.soul.isAsleep()) {
      this.sleep.note(msg.fromUserId);
      this.saveState();
    } else {
      const pending = this.sleep.pending(msg.fromUserId);
      if (pending) {
        hints.push(sleepHint(pending));
        this.sleep.clear(msg.fromUserId);
        this.saveState();
        this.log('info', `她昨晚睡着他找过 ${pending.times} 次，让她提一句`);
      }
    }

    const reunion = this.reunion.check(msg.fromUserId, silentHours);
    if (reunion.settle) {
      hints.push(reunionHint(reunion.tone, silentHours));
      this.reunion.settle(msg.fromUserId);
      // 消失太久会在她心里留下压力（但她不会为此发火，只是状态会变）
      if (silentHours >= 36) {
        const d = this.soul.deform.apply('reunion', new Date(), this.soul.thresholdsFor());
        if (d.changed) this.log('info', `消失 ${silentHours.toFixed(0)}h，她的状态变成「${d.label}」`);
      }
      this.log('info', `他隔了 ${silentHours.toFixed(1)}h 回来（${reunion.tone}），让她提一句`);
    }

    // 纪念日：认识满整百天/整年的时候，她该记得
    const mile = this.milestones.check(this.state.metAt, new Date());
    if (mile.fire) {
      hints.push(milestoneHint(mile.milestone, { relation: this.soul.relationFor(msg.fromUserId) }));
      this.milestones.mark(mile.milestone.days);
      this.log('info', `今天是${mile.milestone.label}，让她提一句`);
      this.saveState();
    }

    if (hints.filter(Boolean).length) msg.hint = hints.filter(Boolean).join('\n\n');

    // 先把入站媒体落盘（她"看得到"图片的路径，阶段二接入识图）
    await this.persistInboundMedia(msg);

    const verdict = this.soul.shouldReply(msg);
    if (!verdict.reply) {
      this.log('debug', `不回 ${short(msg.fromUserId)}: ${verdict.reason}`);
      return;
    }

    this.log('info', `收到 ${short(msg.fromUserId)}: ${truncate(msg.text, 60)}`);

    const history = this.getHistory(msg.fromUserId);
    const result = await this.soul.respond(msg, history);
    if (!result) {
      this.log('warn', '生成回复失败，跳过（她没有说话）');
      return;
    }

    await this.deliver(msg.fromUserId, msg.contextToken, result);

    // 她说要发表情包/发照片 —— 真的发出去
    await this.runCommands(msg.fromUserId, result.commands ?? []);

    // 更新历史并落盘
    history.push({ role: 'user', content: msg.text });
    history.push({ role: 'assistant', content: result.raw });
    this.setHistory(msg.fromUserId, history);

    // 聊得够久了，她可能会自己想个称呼 —— 放在回复之后，不阻塞她说话
    this.soul.maybeRename(msg.fromUserId, history).then((term) => {
      if (term) this.saveState();
    }).catch(() => { /* 改不了就保持原样 */ });

    // 她刚说出口的承诺要记下来，否则"我明天告诉你"就是一句空话
    const recorded = this.promises.record(result.raw, msg.fromUserId);
    if (recorded) this.log('info', `记下她答应的事 ${recorded} 条（到点会提）`);

    // 提炼记忆（会多花一次模型调用，失败不影响已发出的回复）
    this.soul.extractMemories(msg, result.raw).catch((err) => {
      this.log('debug', `记忆提炼异常: ${err.message}`);
    });
  }

  /**
   * 取某个会话的对话历史。
   *
   * 为什么必须持久化：历史原来只存在内存 Map 里，**进程一重启她就"失忆"**，
   * 而"断片"是对"像真人"最致命的伤害 —— 她会问你已经说过的事。
   * 现在写进 state.json，重启后接着聊。
   *
   * 返回的数组上挂了 `summary` 属性供 Soul 使用。注意：JSON 不序列化数组的
   * 自定义属性，所以磁盘上摘要单独存在 `summaries[peer]` 里，读的时候再接回去。
   */
  getHistory(peer) {
    if (this.histories.has(peer)) return this.histories.get(peer);
    const loaded = this.state.histories?.[peer] ?? [];
    if (this.state.summaries?.[peer]) loaded.summary = this.state.summaries[peer];
    this.histories.set(peer, loaded);
    return loaded;
  }

  /**
   * 存对话历史，并做上下文治理。
   *
   * 治理策略（照搬参考项目"总结没好就绝不裁"的原则）：
   *   - 超过 SOFT 条时，把最老的一段压成摘要留着
   *   - 超过 HARD 条时裁掉最老的（此时早有摘要兜底，不会真断片）
   *   - 摘要用本地文本压缩，**不调模型**，保证不会因为网络失败而丢历史
   */
  setHistory(peer, history) {
    const SOFT = 24;
    const HARD = 40;

    let list = history;
    let summary = history.summary ?? this.state.summaries?.[peer] ?? '';

    if (list.length > SOFT) {
      const overflow = list.slice(0, list.length - SOFT);
      list = list.slice(-SOFT);
      if (overflow.length) {
        // 保留最新的内容（越近的事越要紧）
        summary = summarizeText(`${summary}${overflow.map((m) => m.content).join(' ')}`, 300);
      }
    }
    if (list.length > HARD) list = list.slice(-HARD);

    // 摘要挂在数组上给 Soul 用
    if (summary) list.summary = summary;

    this.histories.set(peer, list);

    this.state.histories = this.state.histories ?? {};
    this.state.histories[peer] = list;
    // 摘要单独存 —— JSON 不会序列化数组上的自定义属性
    this.state.summaries = this.state.summaries ?? {};
    if (summary) this.state.summaries[peer] = summary;
    this.saveState();
  }

  /**
   * 记住某个会话的 context_token。
   *
   * 为什么需要：主动消息、发照片这些场景**不在"回复"上下文里**，
   * 拿不到入站消息携带的 token。参考实现是按 peer 存起来复用。
   * token 会过期，所以只保留最近 20 个，且发出失败时会自动清掉重来。
   */
  rememberContextToken(peer, token) {
    if (!peer || !token) return;
    this.contextTokens.set(peer, token);
    // 只保留最近 20 个会话，防止无限增长
    if (this.contextTokens.size > 20) {
      const first = this.contextTokens.keys().next().value;
      this.contextTokens.delete(first);
    }
    this.state.contextTokens = Object.fromEntries(this.contextTokens);
    this.saveState();
  }

  /** 取某个会话的 context_token（可能为空，通道能兜底）。 */
  getContextToken(peer) {
    return this.contextTokens.get(peer) ?? this.state.contextTokens?.[peer] ?? '';
  }

  /**
   * 执行她自己夹带的指令（发表情包 / 发照片 / 记一件事）。
   *
   * 为什么要这一步：她不是在"调用工具"，而是**说话时顺手写了个标记**。
   * 标记已经从文字里剥掉了（见 Soul.respond），这里负责真的去做。
   *
   * 每个"没做"都要写明原因 —— 不然调参就是盲调，你不知道她是没想发还是发失败了。
   */
  async runCommands(peer, commands) {
    if (!commands?.length) return;

    const dayKey = dateKey(new Date());
    this.state.commandUsage = this.state.commandUsage ?? {};
    const { ok, dropped, usage } = filterCommands(
      commands, this.state.commandUsage[dayKey], dayKey,
    );
    this.state.commandUsage[dayKey] = usage;
    if (Object.keys(this.state.commandUsage).length > 7) {
      // 只留最近 7 天，防止无限增长
      const keys = Object.keys(this.state.commandUsage).sort();
      for (const k of keys.slice(0, keys.length - 7)) delete this.state.commandUsage[k];
    }
    this.saveState();

    for (const d of dropped) {
      this.log('info', `她想${CMD_LABEL[d.kind] ?? d.kind}但没做：${d.why}`);
    }

    for (const c of ok) {
      try {
        if (c.kind === 'sticker') {
          const spec = findSticker(c.arg);
          const data = spec ? readSticker(spec) : null;
          if (!data) {
            this.log('warn', `她想发表情包「${c.arg}」但库里没有相近的`);
            continue;
          }
          await this.sendImageBuffer(peer, data.data);
          this.log('info', `她发了个表情包：${spec.name}`);
        } else if (c.kind === 'image') {
          const photos = listPhotos();
          const target = findPhoto(photos, c.arg);
          if (!target) {
            this.log('warn', `她想发照片「${c.arg}」但相册里没有`);
            continue;
          }
          await this.sendImageBuffer(peer, readPhoto(target.path));
          this.log('info', `她发了张照片：${target.name}`);
        } else if (c.kind === 'remember') {
          if (c.arg) {
            this.memory.add(c.arg, { bucket: 'fade', who: peer, source: 'her-command' });
            this.log('info', `她主动记下一件事：${truncate(c.arg, 40)}`);
          }
        }
      } catch (err) {
        this.log('warn', `执行她的指令失败（${c.kind}）: ${err.message}`);
      }
    }
  }

  /** 把一段图片字节发到微信（表情包和照片共用）。 */
  async sendImageBuffer(peer, bytes) {
    const { uploadMediaToCdn, buildImageItem } = await import('./channel/media.js');
    const uploaded = await uploadMediaToCdn(this.creds, bytes, peer, 'image');
    const item = buildImageItem(uploaded);
    await ilink.sendMessage(this.creds, peer, [item], this.getContextToken(peer));
  }

  /** 按拟人节奏把回复发出去（含"正在输入"状态）。 */  async deliver(peerId, contextToken, result) {
    const { chunks, rhythm } = result;
    const useTyping = this.cfg.behavior.typingIndicator;

    // 拿 typing_ticket（拿不到就跳过"正在输入"，不影响发消息）
    let typingTicket = '';
    if (useTyping) {
      try {
        const cfgResp = await ilink.getConfig(this.creds, peerId, contextToken);
        typingTicket = cfgResp?.typing_ticket ?? '';
      } catch { /* 尽力而为 */ }
    }

    const typingOn = async () => {
      if (typingTicket) await ilink.sendTyping(this.creds, peerId, typingTicket, 1);
    };
    const typingOff = async () => {
      if (typingTicket) await ilink.sendTyping(this.creds, peerId, typingTicket, 2);
    };

    // 第一条前的"看到消息再打字"
    await typingOn();
    await sleep(rhythm.beforeFirst);
    await typingOff();

    for (let i = 0; i < chunks.length; i++) {
      try {
        await ilink.sendTextMessage(this.creds, peerId, chunks[i], contextToken);
        this.log('info', `发给 ${short(peerId)}: ${truncate(chunks[i], 60)}`);
      } catch (err) {
        this.log('error', `发送失败: ${err.message}`);
        return;
      }
      if (i < chunks.length - 1) {
        await typingOn();
        await sleep(rhythm.between[i] ?? 800);
        await typingOff();
      }
    }

    this.state.lastProactiveAt = new Date().toISOString();
    this.saveState();
  }

  /**
   * 入站媒体落盘到 data/inbox/<日期>/，图片顺便"看懂"。
   *
   * 识图这一步是关键：主模型不一定支持多模态，但配了识图模型之后
   * 她会把图片转成文字描述挂到 msg.text 上，后面的对话流程自然就能引用。
   */
  async persistInboundMedia(msg) {
    let sawImage = false;

    for (const item of msg.items) {
      if (![2, 3, 4, 5].includes(item.type)) continue;
      try {
        const media = await downloadMediaFromItem(item);
        if (!media) continue;

        const dateDir = path.join(INBOX_DIR, dateKey(new Date()));
        fs.mkdirSync(dateDir, { recursive: true });

        const ext = { image: '.jpg', voice: '.silk', video: '.mp4', file: '' }[media.kind] ?? '.bin';
        const name = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}${ext}`;
        const dest = path.join(dateDir, name);
        fs.writeFileSync(dest, media.data);
        this.log('info', `收到媒体已保存: ${dest}`);

        // ── 让她"看得见"这张图 ──
        if (media.kind === 'image' && this.cfg.vision?.enabled !== false) {
          const desc = await this.describeImage(media.data);
          const note = desc
            ? `[对方发来一张图片，内容是：${desc}]`
            : '[对方发来一张图片，但她没看清]';
          msg.text = msg.text ? `${msg.text}\n${note}` : note;
          if (desc) msg.imageDescription = desc;
          sawImage = true;
        }
      } catch (err) {
        this.log('warn', `媒体下载失败: ${err.message}`);
      }
    }
    return sawImage;
  }

  /**
   * 识图：把图片转成文字描述。
   *
   * 未配独立识图模型时回落到对话模型 —— 对话模型本身支持多模态就直接能用，
   * 不支持会报错，这时明确记一条日志（不静默失败），控制台也看得到。
   */
  async describeImage(imageData) {
    const { visionDescribe } = await import('./brain/client.js');
    const slot = this.resolveVisionSlot();
    if (!slot.baseUrl || !slot.model) return '';

    try {
      const desc = await visionDescribe(slot, {
        imageData,
        mime: 'image/jpeg',
        prompt: '用一两句口语描述这张图片。像跟朋友说话那样，别用"图片中显示"这种书面语。说重点就行。',
      });
      this.log('info', `识图结果: ${truncate(desc, 60)}`);
      return desc;
    } catch (err) {
      this.log('warn', `识图失败（她会当没看见这张图）: ${err.message}`);
      return '';
    }
  }

  /**
   * 解析识图槽位（用共享的纯函数，避免和配置层两份实现漂移）。
   */
  resolveVisionSlot() {
    return resolveVisionSlot(this.cfg);
  }

  /** 定时任务：世界引擎 + 主动消息。 */  scheduleTimers() {
    // 每 5 分钟检查一次
    const tick = () => {
      if (!this.running) return;
      this.tick().catch((err) => this.log('error', `定时任务异常: ${err.message}`));
      this.timers.push(setTimeout(tick, 5 * 60_000));
    };
    this.timers.push(setTimeout(tick, 20_000));
  }

  async tick() {
    const now = new Date();

    // 1) 世界引擎：睡眠窗口内为明天写剧本
    if (this.world.shouldGenerate(now)) {
      this.log('info', '世界引擎开始为明天写剧本…');
      const r = await this.world.generateForTomorrow(now);
      if (r.ok) {
        this.log('info', `世界引擎完成：明天 ${r.script.wakeAt} 起，心情「${r.script.mood}」`);
      } else {
        this.log('warn', `世界引擎跳过: ${r.reason}`);
      }
    }

    // 2) 自检：今天还没有生活就补一份。
    //    世界引擎的正常节奏是"每晚为明天写"，所以程序停过几天、或者今天刚启动时，
    //    今天会是空的 —— 她聊起来没有生活可说。这里补上，有就不动。
    await this.ensureTodayScript(now);

    // 3) 主动消息
    if (this.cfg.proactive.enabled && !this.cfg.behavior.paused) {
      await this.maybeProactive(now);
    }

    // 4) 她对他的印象：聊得够多了就重新认识一下他
    await this.maybeUpdatePortrait(now).catch((err) => {
      this.log('debug', `印象更新异常: ${err.message}`);
    });

    // 5) 自动备份：每天一份，超过保留天数就删
    this.maybeBackup(now);
  }

  /**
   * 自检：今天没有剧本就自动补一份。
   *
   * 为什么需要：世界引擎只负责"每晚为明天写"。如果程序中途停过、或今天刚启动，
   * 今天就没有生活可聊。这里补写一次：**今天已有剧本就直接用，什么都不做**。
   *
   * 三个护栏（不然会出问题）：
   *   - 已有剧本 → 立即返回，绝不覆盖（今天已经过了一半，不能重写）
   *   - 深夜（>= 23 点）不补今天的 —— 这天快过完了，晚上的自动任务会写明天
   *   - 失败冷却 30 分钟 —— 模型挂了不能每 5 分钟重试一次（一天 288 次）
   */
  async ensureTodayScript(now = new Date()) {
    if (!this.cfg.world?.enabled) return;

    const todayKey = dateKey(now);
    if (this.world.scriptFor(todayKey)) return; // 今天已有 → 直接用

    if (now.getHours() >= 23) return; // 太晚，不补今天的

    const lastAt = this.state.worldTodayAttemptAt
      ? new Date(this.state.worldTodayAttemptAt).getTime()
      : 0;
    if (Number.isFinite(lastAt) && lastAt > 0 && now.getTime() - lastAt < 30 * 60_000) {
      return; // 刚试过，冷却中
    }

    this.state.worldTodayAttemptAt = now.toISOString();
    this.saveState();

    this.log('info', '今天还没有剧本，自动补写一次…');
    const r = await this.world.generateForTomorrow(now, { forDate: todayKey });
    if (r.ok) {
      this.log('info', `今天的生活已生成：${r.script.wakeAt} 起，心情「${r.script.mood}」`);
    } else {
      this.log('warn', `今天剧本自动补写失败（30 分钟后重试）: ${r.reason}`);
    }
  }

  /**
   * 每天自动备份她的数据。
   *
   * 判断依据是"最近一次备份是哪天"（看目录名），不是内存里的标记 ——
   * 内存标记重启就没了，会导致一天备份好几次。
   */
  maybeBackup(now = new Date()) {
    const keepDays = this.cfg.system?.backupKeepDays ?? 7;
    if (keepDays <= 0) return; // 0 = 用户关掉了自动备份

    const verdict = shouldBackup(now);
    if (!verdict.due) return;

    const r = runBackup({ now, logger: this.log });
    if (r.ok) {
      const { removed } = pruneBackups(keepDays, now);
      if (removed.length) this.log('info', `清理了 ${removed.length} 个过期备份（保留 ${keepDays} 天）`);
    }
  }

  /**
   * 更新"她眼中的他"。
   *
   * 之所以放在 tick 里而不是每轮回复后：印象是慢变量。
   * 每天最多一次，而且要攒够新对话 —— 聊两句就重写一遍，
   * 那不是了解，那是神经质。
   */
  async maybeUpdatePortrait(now = new Date()) {
    const peer = this.lastPeer;
    if (!peer) return;

    const history = this.getHistory(peer);
    const total = this.msgCount(peer);
    const current = readPortrait();

    const verdict = shouldUpdate(current, total, now);
    if (!verdict.update) return;

    // 给 history 挂上 peer/summary，让印象更新知道"这是跟谁聊的"
    const view = Object.assign([...history], {
      peer,
      summary: history.summary ?? '',
    });

    const r = await updatePortrait({
      cfg: this.cfg,
      persona: this.cfg.persona,
      history: view,
      messageCount: total,
      now,
      logger: this.log,
    });
    if (r.ok) this.soul.reloadPortrait();
  }

  /** 她跟这个人一共聊过多少轮（用来判断印象该不该更新）。 */
  msgCount(peer) {
    // 必须用 relation.messageCount，不能用 history.length ——
    // history 有 24/40 条的窗口上限，涨到顶就不动了，
    // 那样"新增够不够 8 条"永远算不出来，印象一次都不会更新。
    return this.soul.relationFor(peer).messageCount ?? 0;
  }

  /** 判断此刻是否该主动找对方。 */
  async maybeProactive(now) {
    const peer = this.cfg.moments.autoSendTo || this.lastPeer;
    if (!peer) return; // 还没人跟她说过话，不知道找谁

    const daily = this.soul.todayFor(now);
    const situation = (await import('./soul/persona.js')).currentSituation(now, daily);
    if (situation.asleep) return;

    const todayKey = dateKey(now);
    const used = this.state.dailyProactive[todayKey] ?? 0;
    if (used >= this.cfg.behavior.proactiveDailyLimit) return;

    // 先看有没有"她答应过、现在到期了"的事。这比随机问候更该先做 ——
    // 一个真人会先兑现承诺，再想别的。
    this.promises.expireStale(now);
    const duePromises = this.promises.due(peer, now);
    if (duePromises.length) {
      const p = duePromises[0];
      const text = await this.composeProactive('promise', daily, { promise: p.text });
      if (text) {
        const { humanize, suppressQuestions, polishChunks } = await import('./soul/persona.js');
        const cleaned = polishChunks(suppressQuestions([humanize(text)], 1).chunks);
        if (cleaned.length) {
          const finalText = cleaned.join('\n');
          await ilink.sendTextMessage(this.creds, peer, finalText, this.getContextToken(peer));
          this.promises.markMentioned(p.id, now);
          this.state.dailyProactive[todayKey] = used + 1;
          this.state.lastProactiveAt = now.toISOString();
          this.saveState();

          const h = this.getHistory(peer);
          h.push({ role: 'assistant', content: finalText });
          this.setHistory(peer, h);

          this.log('info', `她想起了答应过的事并提起: ${truncate(p.text, 40)}`);
          return;
        }
      }
    }

    // 距**用户上次说话**多久。她只在乎你多久没出现，
    // 而不是她自己多久没发消息（后者会导致"刚聊完又来问你在吗"）。
    const lastUser = this.state.lastUserAt ? new Date(this.state.lastUserAt) : null;
    const silentHours = lastUser ? (now - lastUser) / 3_600_000 : Infinity;

    const kind = this.pickProactiveKind(now, silentHours, todayKey);
    if (!kind) return;

    const text = await this.composeProactive(kind, daily);
    if (!text) return;

    // 主动消息也要过一遍"去 AI 味"流水线 ——
    // 早期版本直接发原文，导致主动消息保留句号和问号，跟聊天风格不一致。
    const { humanize, suppressQuestions, polishChunks } = await import('./soul/persona.js');
    const cleaned = polishChunks(suppressQuestions([humanize(text)], 1).chunks);
    if (!cleaned.length) return;
    const finalText = cleaned.join('\n');

    try {
      await ilink.sendTextMessage(this.creds, peer, finalText, this.getContextToken(peer));
      this.state.dailyProactive[todayKey] = used + 1;
      this.state.lastProactiveAt = now.toISOString();
      // 记录今天发过哪种，避免同一种问候一天重复
      this.state.proactiveKinds = this.state.proactiveKinds ?? {};
      this.state.proactiveKinds[todayKey] = {
        ...(this.state.proactiveKinds[todayKey] ?? {}),
        [kind]: true,
      };
      this.saveState();
      this.log('info', `主动消息(${kind}) 发给 ${short(peer)}: ${truncate(finalText, 60)}`);
      const h2 = this.getHistory(peer);
      h2.push({ role: 'assistant', content: finalText });
      this.setHistory(peer, h2);
    } catch (err) {
      this.log('error', `主动消息发送失败: ${err.message}`);
    }
  }

  /**
   * 决定这次该发哪种主动消息，以及**今天要不要发**。
   *
   * 四个修正（都是实测发现的问题）：
   *   1. 时间窗放宽：定时器每 5 分钟跑一次，原来 `h === 8` 要求恰好落进
   *      08:00-08:04 才算，经常整天都不触发。
   *   2. 目标时刻随机：真人不会每天 8:00 准点发消息。每天为早安/晚安
   *      各抽一个随机目标分钟，只有当前时间越过它才触发。
   *   3. 今天发不发随机：早安约 60%、晚安约 50%。
   *   4. 去重：同一种问候一天最多一次。
   */
  /**
   * 挑今天该发哪种主动消息。
   *
   * `silentHours` = 距**用户上次说话**过了多久。注意这里刻意不用
   * "距她上次主动发消息"—— 那个值是错的：她早上 8 点说过早安，你 9 点到
   * 12 点一直在聊，到下午 1 点她会以为自己"已经 5 小时没人理"，然后发一句
   * "好久没听到你说话了"。所以她只在乎**你**多久没出现。
   */
  pickProactiveKind(now, silentHours, todayKey) {
    const h = now.getHours();
    const minutes = h * 60 + now.getMinutes();
    const sent = this.state.proactiveKinds?.[todayKey] ?? {};

    // 每天抽一次目标时刻（存在 state 里，同一天内稳定）
    const plans = this.getDailyPlans(todayKey);

    // 刚聊过就别打扰 —— 这是"像真人"最基本的分寸。
    // 早安其实不需要这条（早上本来就隔了一夜），晚安需要。
    const quietEnough = silentHours >= 3;

    // 早安：目标时刻在 07:00-09:30 之间随机
    if (this.cfg.proactive.morningGreeting && !sent.morning
        && plans.morning && minutes >= plans.morning && minutes <= 11 * 60
        && silentHours > 5) {
      return 'morning';
    }

    // 晚安：目标时刻在 21:00-23:00 之间随机
    if (this.cfg.proactive.nightGreeting && !sent.night
        && plans.night && minutes >= plans.night && minutes <= 23 * 60 + 30
        && silentHours > 5) {
      return 'night';
    }

    // 思念：用**想念曲线**决定概率，而不是固定一个数。
    //
    // 关键点一：曲线过了峰值会回落 —— 你消失一星期后她不该比消失一天时更黏，
    //   那样听着像订阅提醒，不像人。峰值在 14 小时左右。
    //
    // 关键点二：这是**每次 tick** 的概率，而 tick 每 5 分钟一次（一天 288 次）。
    //   原来写的 0.25 看着像"四分之一"，实际上连续 288 次里几乎必然触发，
    //   等于"一到点就发"。这里按"每天想发的意愿"倒推单次概率：
    //     level 1.00 → 每次 0.002 → 一天约 44% 会发
    //     level 0.50 → 每次 0.001 → 一天约 25%
    //     level 0.15 → 每次 0.0003 → 一天约 8%（她基本在过自己的日子了）
    const level = longingLevel(silentHours);
    if (this.cfg.proactive.longing && !sent.longing
        && silentHours >= this.cfg.proactive.longingAfterHours
        && level >= 0.05
        && quietEnough
        && Math.random() < level * 0.002) {
      return 'longing';
    }

    return null;
  }

  /**
   * 每天为早安/晚安抽一个随机的目标时刻（分钟数）。
   * 抽签结果存在 state 里，保证同一天内反复调用结果一致 ——
   * 否则每次 tick 都重抽，会导致永远不触发或立刻触发。
   */
  getDailyPlans(todayKey) {
    this.state.proactivePlans = this.state.proactivePlans ?? {};
    if (this.state.proactivePlans[todayKey]) return this.state.proactivePlans[todayKey];

    const rand = (min, max) => min + Math.floor(Math.random() * (max - min));
    const plans = {
      // 今天发不发 + 几点发
      morning: Math.random() < 0.6 ? rand(7 * 60, 9 * 60 + 30) : null,
      night: Math.random() < 0.5 ? rand(21 * 60, 23 * 60) : null,
    };
    this.state.proactivePlans[todayKey] = plans;

    // 只保留最近 7 天的计划，防止 state 无限增长
    const keys = Object.keys(this.state.proactivePlans).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 7))) {
      delete this.state.proactivePlans[k];
    }

    return plans;
  }

  /** 生成一条主动消息的内容。 */
  async composeProactive(kind, daily, opts = {}) {
    const { chat } = await import('./brain/client.js');
    const { currentSituation } = await import('./soul/persona.js');
    const p = this.cfg.persona;
    const now = new Date();
    const script = this.world.scriptFor(dateKey(now));
    // 用"此刻"而不是全天流水，否则早安消息里会冒出晚上的事
    const situation = currentSituation(now, daily);

    const intent = {
      morning: '现在是早上，你想起了他，发一条早安。不要每天都一样，可以只是说说你今天早上干了什么。',
      night: '现在是晚上，你想跟他说声晚安。可以顺口提一句今天的事。',
      longing: '你好久没跟他说话了，有点想他。主动开个话头，但别显得黏人或抱怨他不理你。',
      // 兑现承诺：不是"想起来找他"，而是"我说过要告诉他"
      promise: `你之前跟他说过"${opts.promise ?? ''}"。现在到时候了，顺口把它说了 —— `
        + '就像你一直记着这件事一样。别道歉说"忘了"，也别特意强调你在兑现。',
    }[kind];

    const prompt = `你是${p.name}，${p.age}岁，${p.job}，住在${p.city}。
${script ? `你今天大致：${script.flow}` : ''}
${situation?.asleep ? '' : `你现在：${situation?.activity ?? '在家里'}`}
${intent}

要求：像真人发微信那样，1-2 句，短。不要问"你在干嘛"这种套路话。不要用括号描述动作。不用句号，别用问号。直接输出要发的话，不要任何解释。`;

    try {
      const text = await chat(this.cfg.brain, [{ role: 'user', content: prompt }], {
        temperature: 1.0, maxTokens: 150,
      });
      return String(text).trim().replace(/^["'「]|["'」]$/g, '');
    } catch (err) {
      this.log('error', `主动消息生成失败: ${err.message}`);
      return null;
    }
  }

  /** 让"她"写一条朋友圈文案并发给你（内容下发，不做真实发布）。 */
  async sendMomentToOwner(topic = '') {
    const peer = this.cfg.moments.autoSendTo || this.lastPeer;
    if (!peer) throw new Error('还没有可以发送的对象（先跟她聊一句，或在配置里指定 autoSendTo）');

    const text = await this.soul.composeMoment(topic);
    if (!text) throw new Error('文案生成失败（检查模型配置）');

    await ilink.sendTextMessage(this.creds, peer, `【今天想发个朋友圈】\n${text}`, '');
    this.log('info', `朋友圈文案已私聊发给 ${short(peer)}`);
    return text;
  }

  /**
   * 她主动发一张照片给你，并配一句话。
   *
   * 照片来自本地相册 data/photos/（真实照片比 AI 生成的更有生活感）。
   * 配文由模型根据文件名提示 + 她此刻的状态生成 ——
   * 所以叫"团子在窗台.jpg"的照片，她会配"团子又霸占窗台了"这种话。
   *
   * @param {object} opts
   * @param {string} opts.prefer 优先挑含该关键词的照片
   * @param {string} opts.note   指定配文（不给就让她自己想）
   */
  async sendPhotoToOwner({ prefer = '', note = '' } = {}) {
    const peer = this.cfg.moments.autoSendTo || this.lastPeer;
    if (!peer) throw new Error('还没有可以发送的对象（先跟她聊一句）');

    const { listPhotos, pickPhoto, readPhoto } = await import('./soul/album.js');
    if (!listPhotos().length) {
      throw new Error('相册是空的。把照片放进 data/photos/ 就能让她发给你了');
    }

    const recent = this.state.recentPhotos ?? [];
    const photo = pickPhoto({ prefer, exclude: recent });
    if (!photo) throw new Error('没有可用的照片');

    // 配文：让她看着照片名想一句话
    let caption = String(note ?? '').trim();
    if (!caption) {
      caption = await this.composePhotoCaption(photo);
    }

    // 上传并发送
    const { uploadMediaToCdn, buildImageItem } = await import('./channel/media.js');
    const bytes = readPhoto(photo.path);
    const uploaded = await uploadMediaToCdn(this.creds, bytes, peer, 'image');
    const item = buildImageItem(uploaded);

    const items = [item];
    if (caption) {
      items.push({ type: 1, text_item: { text: caption } });
    }
    // 用记住的 context_token —— 发媒体时对端更依赖它
    await ilink.sendMessage(this.creds, peer, items, this.getContextToken(peer));

    // 记录最近发过的，避免连续重复
    this.state.recentPhotos = [photo.name, ...recent].slice(0, 10);
    this.saveState();

    this.log('info', `发出照片 ${photo.name} 给 ${short(peer)}，配文: ${truncate(caption, 40)}`);
    return { photo: photo.name, caption };
  }

  /** 让她看着照片想一句配文。 */
  async composePhotoCaption(photo) {
    const { chat } = await import('./brain/client.js');
    const { currentSituation } = await import('./soul/persona.js');
    const p = this.cfg.persona;
    const now = new Date();
    const daily = this.soul.todayFor(now);
    const situation = currentSituation(now, daily);

    const prompt = `你是${p.name}，${p.age}岁，${p.job}，住在${p.city}。
你现在：${situation.activity}
你刚拍了一张照片，照片里大概是「${photo.hint}」。
你要把这张照片发给一个熟人，配一句话。

要求：像真人发微信那样，1 句，短。可以是随口一句、可以带点情绪。
不用句号，别用问号，不要用括号描述动作。直接输出那句话，不要解释。`;

    try {
      const raw = await chat(this.cfg.brain, [{ role: 'user', content: prompt }], {
        temperature: 1.0, maxTokens: 100,
      });
      const { humanize, suppressQuestions, polishChunks } = await import('./soul/persona.js');
      const cleaned = polishChunks(suppressQuestions([humanize(String(raw).trim())], 1).chunks);
      return cleaned.join('\n');
    } catch (err) {
      this.log('warn', `配文生成失败，改成不配文: ${err.message}`);
      return '';
    }
  }

  /** 热更新配置（后台保存后调用）。 */  reload(cfg) {
    this.cfg = cfg;
    this.soul.cfg = cfg;
    this.world.cfg = cfg;
    saveConfig(cfg);
    this.log('info', '配置已热更新');
  }
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function short(id) {
  return String(id ?? '').slice(0, 10);
}

function truncate(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * 把一段对话压成简短摘要（纯本地，不调模型）。
 *
 * 刻意不调模型的原因：这一步的失败代价是"她失忆"，而网络请求一定会失败。
 * 本地做保证 100% 成功，宁可摘要粗糙也不要断片。
 * 保留越靠后（越新）的内容，因为近期的事更要紧。
 */
function summarizeText(text, maxLen = 300) {
  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\[对方发来一张图片[^\]]*\]/g, '[图片]')
    .trim();
  if (clean.length <= maxLen) return clean;
  return `…${clean.slice(-maxLen)}`;
}
