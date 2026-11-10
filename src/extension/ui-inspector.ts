import { element } from "../shared/ui.js";
import { errorText } from "../shared/protocol.js";
import {
  isUiNodeAction,
  parseUiNodeAction,
  UI_NODE_ACTIONS,
} from "../shared/ui-tree.js";
import type {
  LocalUiTreeSnapshot,
  LocalUiNodeActionRequest,
  UiNode,
  UiNodeActionResult,
} from "../shared/ui-tree.js";

export class UiInspector {
  private readonly read = element("ui-read", HTMLButtonElement);
  private readonly stop = element("ui-stop", HTMLButtonElement);
  private readonly status = element("ui-status", HTMLParagraphElement);
  private readonly search = element("ui-search", HTMLInputElement);
  private readonly list = element("ui-tree", HTMLUListElement);
  private readonly details = element("ui-details", HTMLPreElement);
  private readonly highlight = element("ui-highlight", HTMLDivElement);
  private readonly controls = element("ui-node-controls", HTMLFieldSetElement);
  private readonly action = element("ui-node-action", HTMLSelectElement);
  private readonly text = element("ui-node-text", HTMLInputElement);
  private readonly execute = element("ui-node-execute", HTMLButtonElement);
  private readonly observer: ResizeObserver;
  private snapshot?: LocalUiTreeSnapshot;
  private selected?: UiNode;
  private stream = 0;
  private available = false;
  private reading = false;
  private stopping = false;
  private started = false;
  private acting = false;
  private actionsValid = false;
  private actionExpires = 0;
  private expiryTimer?: number;
  private epoch = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly capture: () => Promise<LocalUiTreeSnapshot>,
    private readonly close: () => Promise<void>,
    private readonly perform: (
      request: LocalUiNodeActionRequest,
    ) => Promise<UiNodeActionResult>,
  ) {
    this.read.onclick = () => {
      void this.refresh();
    };
    this.stop.onclick = () => {
      const uncertain = this.acting;
      this.clear();
      const epoch = this.epoch;
      this.stopping = true;
      this.started = false;
      this.buttons();
      this.status.textContent = "正在关闭 UI helper…";
      void this.close()
        .then(
          () => {
            if (epoch === this.epoch)
              this.status.textContent = `UI helper 已关闭，快照已清除；投屏和触控继续。${uncertain ? "正在执行的节点动作结果未知，请重新读取确认。" : ""}`;
          },
          (error: unknown) => {
            if (epoch === this.epoch)
              this.status.textContent = `UI helper 关闭失败：${errorText(error)}`;
          },
        )
        .finally(() => {
          this.stopping = false;
          this.buttons();
        });
    };
    this.search.oninput = () => this.render();
    this.action.onchange = () => this.buttons();
    this.execute.onclick = () => {
      void this.performSelected();
    };
    this.observer = new ResizeObserver(() => this.drawHighlight());
    this.observer.observe(canvas);
  }

  update(available: boolean, stream: number, helperActive: boolean) {
    if (available !== this.available || stream !== this.stream) {
      this.clear();
      this.status.textContent = available
        ? "按需读取当前活动窗口；不会自动刷新。"
        : "等待投屏画面。";
    }
    this.available = available;
    this.stream = stream;
    this.started = helperActive || this.reading;
    this.buttons();
  }

  private buttons() {
    this.read.disabled =
      !this.available || this.reading || this.stopping || this.acting;
    this.stop.disabled = !this.started || this.stopping;
    this.controls.disabled =
      !this.available ||
      !this.actionsValid ||
      !this.selected?.enabled ||
      !this.selected.visible ||
      !this.selected.actions.length ||
      this.reading ||
      this.stopping ||
      this.acting ||
      performance.now() >= this.actionExpires;
    this.text.disabled =
      this.controls.disabled || this.action.value !== "setText";
    this.text.hidden = this.action.value !== "setText";
  }

  invalidateActions(message?: string) {
    window.clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.actionsValid = false;
    this.text.value = "";
    if (message && this.snapshot) this.status.textContent = message;
    this.buttons();
  }

  private clear() {
    ++this.epoch;
    this.reading = false;
    this.snapshot = undefined;
    this.selected = undefined;
    this.list.replaceChildren();
    this.details.textContent = "选择树节点查看属性，不会操作手机。";
    this.highlight.hidden = true;
    this.action.replaceChildren();
    this.invalidateActions();
  }

  private async refresh() {
    this.clear();
    const epoch = this.epoch;
    this.reading = true;
    this.started = true;
    this.buttons();
    this.status.textContent = "正在按需读取 UI tree…";
    try {
      const snapshot = await this.capture();
      if (epoch !== this.epoch) return;
      if (snapshot.stream !== this.stream)
        throw new Error("画面已变化，请重新读取。");
      this.snapshot = snapshot;
      this.actionsValid = true;
      this.actionExpires = performance.now() + snapshot.expiresInMs;
      this.expiryTimer = window.setTimeout(
        () =>
          this.invalidateActions(
            "节点动作引用已过期，请重新读取 UI tree；旧快照仅供查看。",
          ),
        snapshot.expiresInMs,
      );
      this.render();
      this.status.textContent = `${snapshot.nodes.length} 个节点 | 采集 ${snapshot.durationMs} ms | ${new Date().toLocaleTimeString()}${snapshot.truncated ? " | 已截断，树不完整" : ""}。快照不会自动更新，操作手机后请重新读取。`;
    } catch (error) {
      if (epoch === this.epoch)
        this.status.textContent = `UI tree 读取失败：${errorText(error)}。投屏和触控不受影响。`;
    } finally {
      if (epoch === this.epoch) {
        this.reading = false;
        this.buttons();
      }
    }
  }

  private async performSelected() {
    const snapshot = this.snapshot;
    const node = this.selected;
    let request: LocalUiNodeActionRequest;
    try {
      if (
        !snapshot ||
        !node ||
        !this.actionsValid ||
        performance.now() >= this.actionExpires ||
        !isUiNodeAction(this.action.value)
      )
        throw new Error("请重新读取 UI tree 并选择支持动作的节点。");
      request = {
        ...parseUiNodeAction({
          snapshotRef: snapshot.snapshotRef,
          nodeId: node.id,
          action: this.action.value,
          ...(this.action.value === "setText" ? { text: this.text.value } : {}),
        }),
        stream: snapshot.stream,
      };
    } catch (error) {
      this.status.textContent = `节点动作未发送：${errorText(error)}`;
      return;
    }
    this.clear();
    const epoch = this.epoch;
    this.acting = true;
    this.buttons();
    this.status.textContent = "正在执行节点动作…";
    try {
      const result = await this.perform(request);
      if (epoch === this.epoch)
        this.status.textContent = `Android 已接受“${UI_NODE_ACTIONS[result.action]}”；请重新读取确认页面结果。快照引用已失效，不会自动重试或改为坐标触控。`;
    } catch (error) {
      if (epoch === this.epoch)
        this.status.textContent = `节点动作失败：${errorText(error)}。请重新读取确认；不会自动重试。`;
    } finally {
      this.acting = false;
      this.buttons();
    }
  }

  private render() {
    this.list.replaceChildren();
    if (!this.snapshot) return;
    const query = this.search.value.trim().toLocaleLowerCase();
    const depths: number[] = [];
    const fragment = document.createDocumentFragment();
    for (const node of this.snapshot.nodes) {
      const depth = node.parentId === null ? 0 : depths[node.parentId] + 1;
      depths.push(depth);
      const label = `${node.className} ${node.resourceId} ${node.text} ${node.description}`;
      if (query && !label.toLocaleLowerCase().includes(query)) continue;
      const item = document.createElement("li");
      item.style.paddingLeft = `${Math.min(depth, 12) * 12}px`;
      const button = document.createElement("button");
      button.dataset.uiNode = String(node.id);
      button.textContent = `${node.id} · ${node.text || node.description || node.resourceId || node.className}${node.password ? " [password]" : ""}`;
      button.onclick = () => {
        this.selected = node;
        this.text.value = "";
        this.text.type = node.password ? "password" : "text";
        this.action.replaceChildren(
          ...node.actions.map((action) => {
            const option = document.createElement("option");
            option.value = action;
            option.textContent = UI_NODE_ACTIONS[action];
            return option;
          }),
        );
        this.details.textContent = JSON.stringify(node, null, 2);
        this.drawHighlight();
        this.buttons();
      };
      item.append(button);
      fragment.append(item);
    }
    this.list.append(fragment);
  }

  private drawHighlight() {
    const node = this.selected;
    const snapshot = this.snapshot;
    this.highlight.hidden = true;
    if (!node || !snapshot || snapshot.stream !== this.stream || !node.visible)
      return;
    const { width, height } = snapshot.display;
    if (
      Math.abs(this.canvas.width / this.canvas.height / (width / height) - 1) >
      0.02
    )
      return;
    const bounds = this.canvas.getBoundingClientRect();
    const parent = this.highlight.parentElement!;
    const origin = parent.getBoundingClientRect();
    const [left, top, right, bottom] = node.bounds;
    const x = Math.max(0, Math.min(width, left));
    const y = Math.max(0, Math.min(height, top));
    const endX = Math.max(x, Math.min(width, right));
    const endY = Math.max(y, Math.min(height, bottom));
    if (endX === x || endY === y) return;
    Object.assign(this.highlight.style, {
      left: `${bounds.left - origin.left - parent.clientLeft + (x / width) * bounds.width}px`,
      top: `${bounds.top - origin.top - parent.clientTop + (y / height) * bounds.height}px`,
      width: `${((endX - x) / width) * bounds.width}px`,
      height: `${((endY - y) / height) * bounds.height}px`,
    });
    this.highlight.hidden = false;
  }

  dispose() {
    this.clear();
    this.observer.disconnect();
  }
}
