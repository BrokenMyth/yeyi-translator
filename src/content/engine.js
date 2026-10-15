import { collectGroups, createChunks, viewportDistance } from "./model.js";
import { sendMessage } from "../shared/messaging.js";

/**
 * 单个 frame 的整页翻译会话。原文、译文与缓存均只存在此页面的内存中。
 * @property {Map<Element,Object>} units 段落记录；通过实际 DOM 节点识别网站重渲染。
 * @property {WeakMap<Text,Object>} ownership 文本节点及其原文、最后写入值。
 * @property {Map<string,Object[]>} cache 此页面的有限译文缓存，刷新自然清空。
 */
export class TranslationEngine {
  /** @param {Function} onChange 接收可公开的进度。 */
  constructor(onChange) {
    /** @type {Function} 当前 frame 的公开进度回调。 */
    this.onChange = onChange;
    /** @type {Map<Element,Object>} 仍可能需要恢复的段落。 */
    this.units = new Map();
    /** @type {WeakMap<Text,Object>} 节点原文与最后一次自有写入。 */
    this.ownership = new WeakMap();
    /** @type {Map<string,Object>} 当前页面的有限译文缓存。 */
    this.cache = new Map();
    /** @type {number} 缓存键及值占用的 UTF-16 字符数。 */
    this.cacheChars = 0;
    /** @type {Object|null} 当前运行的脱敏配置快照。 */
    this.config = null;
    /** @type {'idle'|'translating'|'watching'|'paused'|'error'} 可显示的会话阶段。 */
    this.phase = "idle";
    /** @type {boolean} 是否调度请求并监测动态内容。 */
    this.active = false;
    /** @type {string} 迟到结果的隔离代号，停止后立即更新。 */
    this.runId = crypto.randomUUID();
    /** @type {number} 此页面中单调递增的段落标识序号。 */
    this.sequence = 0;
    /** @type {number} 当前运行尚未结束的批次数，上限为二。 */
    this.workers = 0;
    /** @type {string} 可安全展示的最近错误。 */
    this.error = "";
    /** @type {ReturnType<typeof setTimeout>|null} 合并动态内容扫描的计时器。 */
    this.scanTimer = null;
    /** @type {ReturnType<typeof setInterval>|null} 请求期间的 worker 保活计时器。 */
    this.keepAlive = null;
    /** @type {MutationObserver} 只在会话开启时订阅页面内容。 */
    this.observer = new MutationObserver((records) => {
      if (this.active && records.some((record) => !this.isOwnedMutation(record)))
        this.scheduleScan();
    });
  }

  /** 返回可展示的进度，永远不包括原文和密钥。@returns {Object} 本 frame 状态。 */
  getState() {
    const units = [...this.units.values()].filter((unit) => unit.element.isConnected);
    return {
      phase: this.phase,
      active: this.active,
      total: units.length,
      done: units.filter((unit) => unit.chunks.every((chunk) => chunk.state === "done")).length,
      failed: units.filter((unit) => unit.chunks.some((chunk) => chunk.state === "failed")).length,
      mode: this.config?.mode || "bilingual",
      targetLanguage: this.config?.targetLanguage || "zh-CN",
      provider: this.config?.provider || "deepseek",
      error: this.error,
    };
  }

  /** 发布当前状态。@returns {void} 无返回值。 */
  publish() {
    this.onChange(this.getState());
  }

  /** 判断变更是否由扩展自己的显示节点或译文写入产生。@param {MutationRecord} record DOM 变更。@returns {boolean} 是否可忽略。 */
  isOwnedMutation(record) {
    const element =
      record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
    if (element?.closest("[data-yeyi-owned]")) return true;
    if (record.type === "characterData") {
      const entry = this.ownership.get(record.target);
      return Boolean(entry && record.target.data === entry.lastWritten);
    }
    return (
      record.type === "childList" &&
      [...record.addedNodes, ...record.removedNodes].every(
        (node) => node.nodeType === Node.ELEMENT_NODE && node.hasAttribute("data-yeyi-owned"),
      )
    );
  }

  /** 开始观察网页真实内容的变化。@returns {void} 无返回值。 */
  observe() {
    if (this.active && document.body)
      this.observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: [
          "hidden",
          "class",
          "style",
          "aria-hidden",
          "translate",
          "contenteditable",
        ],
      });
  }

  /** 批量写入时暂时停止观察，避免把自己的译文重新送去翻译。@param {Function} mutation 同步 DOM 操作。@returns {void} 无返回值。 */
  mutate(mutation) {
    const pending = this.observer.takeRecords();
    if (pending.some((record) => !this.isOwnedMutation(record))) this.scheduleScan();
    this.observer.disconnect();
    try {
      mutation();
    } finally {
      this.observe();
    }
  }

  /** 把频繁的 DOM 更新合并到一次扫描。@returns {void} 无返回值。 */
  scheduleScan() {
    if (this.scanTimer || !this.active) return;
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      if (this.active) {
        this.scan();
        this.pump();
      }
    }, 400);
  }

  /** 撤回段落的自有写入；网站后来修改的文字绝不会被旧原文覆盖。@param {Object} unit 段落。@returns {void} 无返回值。 */
  restoreUnit(unit) {
    unit.anchor?.remove();
    unit.anchor = null;
    for (const record of unit.nodes) {
      if (record.node.isConnected && record.node.data === record.lastWritten)
        record.node.data = record.original;
      record.lastWritten = record.original;
    }
  }

  /** 按模式渲染完整段落；译文仅通过 textContent / Text.data 写入。@param {Object} unit 段落。@returns {void} 无返回值。 */
  renderUnit(unit) {
    if (!unit.element.isConnected || !unit.chunks.every((chunk) => chunk.state === "done")) return;
    if (
      unit.nodes.some(
        (record) =>
          !record.node.isConnected ||
          (record.node.data !== record.original && record.node.data !== record.lastWritten),
      )
    ) {
      this.scheduleScan();
      return;
    }
    const translated = unit.nodes.map(() => "");
    for (const chunk of unit.chunks)
      chunk.translated.forEach((part, index) => {
        translated[chunk.locations[index]] += part;
      });
    this.restoreUnit(unit);
    if (this.config.mode === "replace") {
      unit.nodes.forEach((record, index) => {
        record.node.data = translated[index];
        record.lastWritten = translated[index];
      });
    } else if (
      translated.join("").trim() !==
      unit.nodes
        .map((record) => record.original)
        .join("")
        .trim()
    ) {
      const anchor = document.createElement("span");
      anchor.dataset.yeyiOwned = "translation";
      anchor.lang = this.config.targetLanguage;
      anchor.setAttribute("dir", "auto");
      anchor.style.cssText =
        "display:block!important;position:static!important;font-size:0.95em!important;line-height:1.65!important;margin:0.35em 0 0!important;padding:0.28em 0 0!important;border:0!important;border-top:1px dashed color-mix(in srgb,currentColor 24%,transparent)!important;opacity:0.88!important;white-space:pre-wrap!important;overflow-wrap:anywhere!important;text-align:inherit!important;font-family:inherit!important;color:inherit!important;background:transparent!important;";
      anchor.textContent = translated.join("");
      unit.element.append(anchor);
      unit.anchor = anchor;
    }
  }

  /** 缓存键包含服务、模型、目标语言及完整节点原文。@param {Object} unit 段落。@returns {string} 内存键。 */
  cacheKey(unit) {
    return `${this.config.signature}\n${JSON.stringify(unit.nodes.map((record) => record.original))}`;
  }

  /** 保存有限缓存，避免无限滚动页面持续占用内存。@param {Object} unit 完成的段落。@returns {void} 无返回值。 */
  remember(unit) {
    const key = this.cacheKey(unit);
    if (this.cache.has(key)) return;
    const value = unit.chunks.map((chunk) => [...chunk.translated]);
    const size = key.length + JSON.stringify(value).length;
    if (size > 200_000) return;
    this.cache.set(key, { value, size });
    this.cacheChars += size;
    while (this.cacheChars > 2_000_000 || this.cache.size > 1500) {
      const oldest = this.cache.keys().next().value;
      this.cacheChars -= this.cache.get(oldest).size;
      this.cache.delete(oldest);
    }
  }

  /** 重新协调可见 DOM 和记录；失效段落的迟到结果会被忽略。@returns {void} 无返回值。 */
  scan() {
    const groups = collectGroups(document, this.ownership);
    this.mutate(() => {
      for (const [element, unit] of this.units) {
        const nodes = groups.get(element);
        const unchanged =
          nodes &&
          nodes.length === unit.nodes.length &&
          nodes.every(
            (record, index) =>
              record.node === unit.nodes[index].node &&
              record.original === unit.nodes[index].original,
          );
        if (!unchanged) {
          this.restoreUnit(unit);
          this.units.delete(element);
        }
      }
      for (const [element, records] of groups) {
        if (this.units.has(element)) {
          const unit = this.units.get(element);
          if (
            unit.chunks.every((chunk) => chunk.state === "done") &&
            this.config.mode === "bilingual" &&
            unit.anchor &&
            !unit.anchor.isConnected
          )
            this.renderUnit(unit);
          continue;
        }
        const unit = {
          id: `u${++this.sequence}`,
          element,
          anchor: null,
          nodes: records.map((record) => ({ ...record, lastWritten: record.original })),
          chunks: [],
        };
        unit.chunks = createChunks(unit);
        unit.nodes.forEach((record) => this.ownership.set(record.node, record));
        const cached = this.cache.get(this.cacheKey(unit));
        if (cached && cached.value.length === unit.chunks.length) {
          unit.chunks.forEach((chunk, index) => {
            chunk.translated = cached.value[index];
            chunk.state = "done";
          });
          this.renderUnit(unit);
        }
        this.units.set(element, unit);
      }
    });
    this.publish();
  }

  /** 开始或继续整页翻译。@param {Object} config 后台提供的脱敏配置。@param {boolean} [retry] 是否重新排队失败片段。@returns {void} 无返回值。 */
  start(config, retry = true) {
    const changed = this.config?.signature !== config.signature;
    this.stop(false);
    if (changed) {
      this.mutate(() => {
        for (const unit of this.units.values()) this.restoreUnit(unit);
      });
      this.units.clear();
      this.ownership = new WeakMap();
    }
    this.config = { ...config };
    this.runId = crypto.randomUUID();
    this.active = true;
    this.phase = "translating";
    this.error = "";
    this.workers = 0;
    for (const unit of this.units.values()) {
      for (const chunk of unit.chunks)
        if (chunk.state === "inflight" || (retry && chunk.state === "failed"))
          chunk.state = "pending";
    }
    this.mutate(() => {
      for (const unit of this.units.values()) this.renderUnit(unit);
    });
    this.observe();
    // Chrome MV3 的空闲计时由扩展消息重置；只在有网络请求时维持会话。
    this.keepAlive = setInterval(() => {
      if (this.workers) sendMessage({ type: "PING" }).catch(() => {});
    }, 20_000);
    this.scan();
    this.pump();
  }

  /** 停止请求和新内容监测，保留已完成的译文。@param {boolean} [notify] 是否发布暂停状态。@returns {void} 无返回值。 */
  stop(notify = true) {
    const oldRun = this.runId;
    this.active = false;
    this.runId = crypto.randomUUID();
    this.observer.disconnect();
    clearTimeout(this.scanTimer);
    this.scanTimer = null;
    clearInterval(this.keepAlive);
    this.keepAlive = null;
    for (const unit of this.units.values())
      for (const chunk of unit.chunks) if (chunk.state === "inflight") chunk.state = "pending";
    sendMessage({ type: "CANCEL_RUN", runId: oldRun }).catch(() => {});
    if (notify) {
      this.phase = "paused";
      this.publish();
    }
  }

  /** 恢复原文并停止监测；保留仅当前页有效的缓存供再次使用。@returns {void} 无返回值。 */
  restore() {
    this.stop(false);
    this.mutate(() => {
      for (const unit of this.units.values()) this.restoreUnit(unit);
    });
    this.units.clear();
    this.ownership = new WeakMap();
    this.phase = "idle";
    this.error = "";
    this.publish();
  }

  /** 即时切换排版，使用同一批译文。@param {'bilingual'|'replace'} mode 新模式。@returns {void} 无返回值。 */
  setMode(mode) {
    if (!this.config) return;
    this.config.mode = mode === "replace" ? "replace" : "bilingual";
    this.mutate(() => {
      for (const unit of this.units.values()) this.renderUnit(unit);
    });
    this.publish();
  }

  /** 以当前视口优先的顺序选择一个有界批次。@returns {Object[]} 段落与片段任务。 */
  nextBatch() {
    const candidates = [...this.units.values()]
      .filter(
        (unit) =>
          unit.element.isConnected && unit.chunks.some((chunk) => chunk.state === "pending"),
      )
      .sort((a, b) => viewportDistance(a.element) - viewportDistance(b.element));
    const tasks = [];
    let length = 0;
    for (const unit of candidates) {
      for (const chunk of unit.chunks) {
        if (chunk.state !== "pending") continue;
        const size = chunk.parts.reduce((sum, part) => sum + part.length, 0);
        if (tasks.length && (length + size > 4800 || tasks.length >= 18)) return tasks;
        chunk.state = "inflight";
        tasks.push({ unit, chunk });
        length += size;
      }
    }
    return tasks;
  }

  /** 运行最多两个批次，完成后继续调度整页剩余内容。@returns {void} 无返回值。 */
  pump() {
    if (!this.active) return;
    while (this.workers < 2) {
      const tasks = this.nextBatch();
      if (!tasks.length) break;
      this.workers++;
      this.phase = "translating";
      void this.runBatch(tasks, this.runId);
    }
    if (!this.workers) this.phase = "watching";
    this.publish();
  }

  /** 请求批次；输出不完整时二分缩小失败范围，单片段失败仍保留原文供手动重试。@param {Object[]} tasks 片段任务。@param {string} runId 运行代号。@param {boolean} [subBatch] 是否共用父批次的并发名额。@returns {Promise<void>} 批次及其补译结束。 */
  async runBatch(tasks, runId, subBatch = false) {
    if (!this.active || runId !== this.runId) return;
    try {
      const translated = await sendMessage({
        type: "TRANSLATE_BATCH",
        runId,
        signature: this.config.signature,
        segments: tasks.map(({ chunk }) => ({ id: chunk.id, parts: chunk.parts })),
      });
      if (!this.active || runId !== this.runId) return;
      const results = new Map(translated.map((item) => [item.id, item.parts]));
      this.mutate(() => {
        for (const { unit, chunk } of tasks) {
          if (this.units.get(unit.element) !== unit) continue;
          chunk.translated = results.get(chunk.id);
          chunk.state = "done";
          if (unit.chunks.every((item) => item.state === "done")) {
            this.remember(unit);
            this.renderUnit(unit);
          }
        }
      });
    } catch (error) {
      if (!this.active || runId !== this.runId) return;
      // 格式错误只说明当前响应不可用；缩小批次后，其他段落仍可能正常返回。
      // 每次任务数减半，最小到单片段即停止，避免坏响应触发无限重试。
      if (["OUTPUT_INVALID", "OUTPUT_INCOMPLETE"].includes(error.code) && tasks.length > 1) {
        const middle = Math.ceil(tasks.length / 2);
        await this.runBatch(tasks.slice(0, middle), runId, true);
        await this.runBatch(tasks.slice(middle), runId, true);
        return;
      }
      for (const { unit, chunk } of tasks)
        if (this.units.get(unit.element) === unit) chunk.state = "failed";
      this.error = error.message;
      if (error.fatal) {
        this.stop(false);
        this.phase = "error";
        this.publish();
      }
    } finally {
      // 停止后开始的新会话有独立计数，旧请求不能递减新会话的并发量。
      if (!subBatch && runId === this.runId) {
        this.workers--;
        this.pump();
      }
    }
  }
}
