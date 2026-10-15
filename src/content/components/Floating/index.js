/** 网页上的入口及控制面板；使用 Shadow DOM 隔离网页样式。 */
export class FloatingControl {
  /** @param {Function} onAction 执行整页命令。@param {Function} onSettings 打开设置。 */
  constructor(onAction, onSettings) {
    /** @type {Function} 执行用户明确发起的全页操作。 */
    this.onAction = onAction;
    /** @type {Function} 打开扩展设置页。 */
    this.onSettings = onSettings;
    /** @type {HTMLDivElement} 受原文收集器排除的控件宿主。 */
    this.host = document.createElement("div");
    this.host.dataset.yeyiOwned = "control";
    this.host.style.cssText =
      "all:initial!important;position:fixed!important;right:20px!important;bottom:28px!important;z-index:2147483647!important;display:block!important;";
    /** @type {ShadowRoot} 隔离网页和扩展样式的渲染入口。 */
    this.root = this.host.attachShadow({ mode: "open" });
    this.root.innerHTML = `<style>
      :host{color-scheme:light}*{box-sizing:border-box}button{font:inherit;cursor:pointer}button:disabled{opacity:.4;cursor:default}button:focus-visible{outline:3px solid #beb8ff;outline-offset:3px}
      .wrap{font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#24273d;text-align:left}
      .toggle{display:flex;align-items:center;gap:8px;float:right;border:1px solid #6e62e9;border-radius:28px;padding:12px 17px;background:#5648d9;color:white;box-shadow:0 5px 22px #38308030;font-weight:700}
      .panel{clear:both;width:278px;margin-bottom:12px;padding:17px;background:#fff;border:1px solid #e9e7f2;border-radius:18px;box-shadow:0 12px 48px #17132e25}
      .panel[hidden]{display:none}.head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.title{font-size:16px;font-weight:750}.close{background:none;border:0;color:#76778a;font-size:19px;padding:0 4px}.sub{color:#77768a;font-size:11px}.status{margin:12px 0;color:#626277;overflow-wrap:anywhere}
      .modes{display:grid;grid-template-columns:1fr 1fr;gap:5px;padding:4px;border-radius:11px;background:#f2f1f8}.modes button{border:0;border-radius:8px;padding:8px 4px;background:none;color:#68657e}.modes button[aria-pressed=true]{background:white;color:#5344ce;box-shadow:0 1px 4px #23203212}
      .actions{display:flex;gap:7px}.actions button{border:1px solid #e5e3ed;border-radius:10px;padding:9px 10px;background:#fff;color:#625d7b;flex:1}.actions .primary{background:#5748db;border-color:#5748db;color:#fff}.settings{display:block;margin:12px auto 0;border:0;background:none;color:#817c98;font-size:11px}
    </style><div class="wrap"><div class="panel" hidden><div class="head"><div><span class="title">页译</span><span class="sub"> · 整页 AI 翻译</span></div><button class="close" aria-label="收起面板">×</button></div><div class="modes"><button data-mode="bilingual" aria-pressed="true">原文 / 译文</button><button data-mode="replace" aria-pressed="false">替换原文</button></div><div class="status" role="status">点击翻译，开始阅读。</div><div class="actions"><button class="primary" data-action="start">翻译此页</button><button data-action="restore">恢复原文</button></div><button class="settings">API 与插件设置 ↗</button></div><button class="toggle" aria-label="打开页译控制面板" aria-expanded="false"><span style="font-size:17px">译</span><span>页译</span></button></div>`;
    this.root.querySelector(".toggle").addEventListener("click", () => this.toggle());
    this.root.querySelector(".close").addEventListener("click", () => this.toggle(false));
    this.root.querySelector(".settings").addEventListener("click", () => this.onSettings());
    this.root
      .querySelectorAll("[data-action]")
      .forEach((button) =>
        button.addEventListener("click", () => this.perform(button.dataset.action)),
      );
    this.root
      .querySelectorAll("[data-mode]")
      .forEach((button) =>
        button.addEventListener("click", () => this.perform("set-mode", button.dataset.mode)),
      );
    document.documentElement.append(this.host);
    /** @type {Object} 最近一次公开进度，不包括原文或密钥。 */
    this.state = { active: false, total: 0, done: 0, failed: 0, phase: "idle", mode: "bilingual" };
  }

  /** 展开或收起面板。@param {boolean} [open] 指定状态，省略则切换。@returns {void} 无返回值。 */
  toggle(open = this.root.querySelector(".panel").hidden) {
    this.root.querySelector(".panel").hidden = !open;
    this.root.querySelector(".toggle").setAttribute("aria-expanded", String(open));
  }

  /** 发起用户操作并在面板展示错误。@param {string} action 命令。@param {string} [mode] 排版。@returns {Promise<void>} 操作结束。 */
  async perform(action, mode) {
    try {
      await this.onAction(action === "start" && this.state.active ? "stop" : action, mode);
    } catch (error) {
      this.root.querySelector(".status").textContent = error.message;
      this.toggle(true);
    }
  }

  /** 更新按钮及进度。@param {Object} state 聚合状态。@returns {void} 无返回值。 */
  update(state) {
    this.state = state;
    this.root.querySelector(".status").textContent =
      state.error ||
      (state.phase === "idle"
        ? "点击翻译，开始阅读。"
        : `${state.done} / ${state.total} 段已完成${state.failed ? ` · ${state.failed} 段失败，可再次翻译重试` : state.phase === "watching" ? " · 监测新内容" : state.phase === "paused" ? " · 已暂停" : ""}`);
    this.root.querySelector('[data-action="start"]').textContent = state.active
      ? "暂停翻译"
      : state.total
        ? "继续翻译"
        : "翻译此页";
    this.root.querySelector('[data-action="restore"]').disabled = !state.total;
    this.root
      .querySelectorAll("[data-mode]")
      .forEach((button) =>
        button.setAttribute("aria-pressed", String(button.dataset.mode === state.mode)),
      );
  }

  /** 应用悬浮按钮偏好。@param {boolean} visible 是否显示。@returns {void} 无返回值。 */
  setVisible(visible) {
    this.host.style.setProperty("display", visible ? "block" : "none", "important");
  }
}
