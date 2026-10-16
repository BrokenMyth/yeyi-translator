const INPUT_EVENTS = ["wheel", "touchmove", "pointerdown", "pointermove", "keydown"];

/**
 * Discord 自行管理消息列表的滚动位置，译文改变高度后可能再次按底部距离调整 scrollTop。
 * 每批写入前记录可见消息的位置，写入后及随后两帧仅补偿该消息的偏移。
 * 用户继续滚动、拖动或按键时立即取消补偿；停在底部时交给站点继续跟随新消息。
 * 只保存当前页面的短期布局信息，不修改缓存、消息高度或网站的滚动样式。
 */
export class TranslationScrollAnchor {
  constructor() {
    this.positions = new Map();
    this.frame = null;
    this.framesLeft = 0;
    this.onInput = (event) => {
      if (event.type !== "pointermove" || event.buttons) this.cancel();
    };
  }

  /** 在存在 Discord 消息列表时，记录每个滚动容器中第一条可见消息。 */
  capture() {
    for (const list of document.querySelectorAll('[data-list-id="chat-messages"]')) {
      let scroller = list.parentElement;
      while (scroller) {
        if (
          /auto|scroll/.test(getComputedStyle(scroller).overflowY) &&
          scroller.scrollHeight > scroller.clientHeight
        )
          break;
        scroller = scroller.parentElement;
      }
      if (!scroller || this.positions.has(scroller)) continue;
      if (scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 2) continue;
      const rect = scroller.getBoundingClientRect();
      const top = Math.max(0, rect.top + scroller.clientTop);
      const bottom = Math.min(innerHeight, rect.top + scroller.clientTop + scroller.clientHeight);
      if (bottom <= top) continue;
      const anchor = [...list.querySelectorAll('[id^="chat-messages-"]')].find((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.height > 0 && bounds.bottom > top && bounds.top < bottom;
      });
      if (anchor)
        this.positions.set(scroller, {
          list,
          anchor,
          id: anchor.id,
          top: anchor.getBoundingClientRect().top - rect.top,
          height: scroller.scrollHeight,
        });
    }
  }

  /** 允许站点替换同一条消息的 DOM，已经移除的消息不再用于恢复位置。 */
  anchorOf(position) {
    const anchor = position.anchor.isConnected
      ? position.anchor
      : document.getElementById(position.id);
    return anchor?.id === position.id && position.list.contains(anchor) ? anchor : null;
  }

  /** 补偿内容的实际偏移；滚动位置不能以请求发出时或鼠标操作前的旧值为准。 */
  restore() {
    for (const [scroller, position] of this.positions) {
      const anchor = this.anchorOf(position);
      if (!scroller.isConnected || !anchor) {
        this.positions.delete(scroller);
        continue;
      }
      const delta =
        anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - position.top;
      if (Math.abs(delta) >= 0.5) scroller.scrollTop += delta;
    }
  }

  /** 批量写入使用一个布局快照；没有高度或位置变化时不注册监听或排队补偿。 */
  preserve(mutation) {
    this.capture();
    try {
      return mutation();
    } finally {
      const changed = [...this.positions].some(([scroller, position]) => {
        const anchor = this.anchorOf(position);
        return (
          anchor &&
          (scroller.scrollHeight !== position.height ||
            Math.abs(
              anchor.getBoundingClientRect().top -
                scroller.getBoundingClientRect().top -
                position.top,
            ) >= 0.5)
        );
      });
      if (changed) {
        this.restore();
        this.framesLeft = 2;
        if (this.frame === null) {
          for (const type of INPUT_EVENTS)
            document.addEventListener(type, this.onInput, { capture: true, passive: true });
          this.queueRestore();
        }
      } else if (this.frame === null) this.cancel();
    }
  }

  /** 等待站点的 ResizeObserver 完成本批布局更新，最多补偿两帧，不持续锁定滚动。 */
  queueRestore() {
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.restore();
      if (--this.framesLeft > 0 && this.positions.size) this.queueRestore();
      else this.cancel();
    });
  }

  /** 用户输入或会话停止后，旧批次不能再把页面拉回原来的位置。 */
  cancel() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.positions.clear();
    for (const type of INPUT_EVENTS) document.removeEventListener(type, this.onInput, true);
  }
}
