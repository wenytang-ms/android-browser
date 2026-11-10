export const MAX_UI_TREE_BYTES = 1024 * 1024;
export const MAX_UI_TREE_NODES = 2000;
export const UI_TREE_PROTOCOL_VERSION = 2;
export const UI_ACTION_TTL_MS = 30_000;
export const MAX_UI_ACTION_TEXT_BYTES = 1024;
export const UI_NODE_ACTIONS = {
  click: "点击",
  longClick: "长按",
  setText: "设置文字（空文本可清空）",
  scrollForward: "向前滚动",
  scrollBackward: "向后滚动",
  scrollUp: "向上滚动",
  scrollDown: "向下滚动",
  scrollLeft: "向左滚动",
  scrollRight: "向右滚动",
} as const;
export type UiNodeAction = keyof typeof UI_NODE_ACTIONS;
export type UiNodeActionRequest = {
  snapshotRef: string;
  nodeId: number;
} & (
  | { action: "setText"; text: string }
  | { action: Exclude<UiNodeAction, "setText">; text?: never }
);
export type LocalUiNodeActionRequest = UiNodeActionRequest & { stream: number };
export interface UiNodeActionResult {
  snapshotRef: string;
  nodeId: number;
  action: UiNodeAction;
  accepted: true;
}

function snapshotRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

export function isUiNodeAction(value: unknown): value is UiNodeAction {
  return typeof value === "string" && Object.hasOwn(UI_NODE_ACTIONS, value);
}

export function parseUiNodeAction(value: unknown): UiNodeActionRequest {
  const invalid = () => new Error("节点动作无效；文字最多 1024 UTF-8 字节。");
  if (
    !uiRecord(value) ||
    !snapshotRef(value.snapshotRef) ||
    !integer(value.nodeId, 0, MAX_UI_TREE_NODES - 1) ||
    !isUiNodeAction(value.action)
  )
    throw invalid();
  const target = { snapshotRef: value.snapshotRef, nodeId: value.nodeId };
  if (value.action === "setText") {
    if (
      typeof value.text !== "string" ||
      new TextEncoder().encode(value.text).byteLength > MAX_UI_ACTION_TEXT_BYTES
    )
      throw invalid();
    return { ...target, action: value.action, text: value.text };
  }
  if (value.text !== undefined) throw invalid();
  return { ...target, action: value.action };
}

export function parseUiNodeActionResult(value: unknown): UiNodeActionResult {
  if (
    !uiRecord(value) ||
    !snapshotRef(value.snapshotRef) ||
    !integer(value.nodeId, 0, MAX_UI_TREE_NODES - 1) ||
    !isUiNodeAction(value.action) ||
    value.accepted !== true
  )
    throw new Error("UI helper 节点动作回执无效。");
  return {
    snapshotRef: value.snapshotRef,
    nodeId: value.nodeId,
    action: value.action,
    accepted: true,
  };
}

export interface UiNode {
  id: number;
  parentId: number | null;
  windowId: number;
  resourceId: string;
  className: string;
  packageName: string;
  text: string;
  description: string;
  bounds: [number, number, number, number];
  clickable: boolean;
  enabled: boolean;
  visible: boolean;
  scrollable: boolean;
  editable: boolean;
  focused: boolean;
  checkable: boolean;
  checked: boolean;
  password: boolean;
  actions: UiNodeAction[];
}

export interface UiTreeSnapshot {
  snapshotId: number;
  snapshotRef: string;
  expiresInMs: number;
  capturedAtMs: number;
  durationMs: number;
  display: { id: 0; width: number; height: number; rotation: number };
  nodes: UiNode[];
  truncated: boolean;
}

export interface LocalUiTreeSnapshot extends UiTreeSnapshot {
  stream: number;
}

export function uiRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}

export function parseUiTree(value: unknown): UiTreeSnapshot {
  const invalid = () => new Error("UI tree 响应无效或超出限制。");
  if (
    !uiRecord(value) ||
    !uiRecord(value.display) ||
    !integer(value.snapshotId, 1, 0x7fffffff) ||
    !snapshotRef(value.snapshotRef) ||
    !integer(value.expiresInMs, 0, UI_ACTION_TTL_MS) ||
    !integer(value.capturedAtMs, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(value.durationMs, 0, 60_000) ||
    value.display.id !== 0 ||
    !integer(value.display.width, 1, 32768) ||
    !integer(value.display.height, 1, 32768) ||
    !integer(value.display.rotation, 0, 3) ||
    !Array.isArray(value.nodes) ||
    !value.nodes.length ||
    value.nodes.length > MAX_UI_TREE_NODES ||
    typeof value.truncated !== "boolean"
  )
    throw invalid();
  const depths: number[] = [];
  const nodes = value.nodes.map((item: unknown, index: number): UiNode => {
    if (
      !uiRecord(item) ||
      item.id !== index ||
      (index === 0
        ? item.parentId !== null
        : !integer(item.parentId, 0, index - 1)) ||
      !integer(item.windowId, -1, 0x7fffffff) ||
      !Array.isArray(item.actions) ||
      item.actions.length > Object.keys(UI_NODE_ACTIONS).length ||
      !item.actions.every(isUiNodeAction) ||
      new Set(item.actions).size !== item.actions.length ||
      !Array.isArray(item.bounds) ||
      item.bounds.length !== 4 ||
      !item.bounds.every((coordinate: unknown) =>
        integer(coordinate, -1_000_000, 1_000_000),
      )
    )
      throw invalid();
    const string = (key: string) => {
      const field = item[key];
      if (typeof field !== "string" || field.length > 1024) throw invalid();
      return field;
    };
    const bool = (key: string) => {
      const field = item[key];
      if (typeof field !== "boolean") throw invalid();
      return field;
    };
    const bounds: UiNode["bounds"] = [
      item.bounds[0],
      item.bounds[1],
      item.bounds[2],
      item.bounds[3],
    ];
    if (bounds[2] < bounds[0] || bounds[3] < bounds[1]) throw invalid();
    const parentId = typeof item.parentId === "number" ? item.parentId : null;
    const depth = parentId === null ? 0 : depths[parentId] + 1;
    if (depth > 64) throw invalid();
    depths.push(depth);
    const password = bool("password");
    const text = string("text");
    const description = string("description");
    return {
      id: index,
      parentId,
      windowId: item.windowId,
      resourceId: string("resourceId"),
      className: string("className"),
      packageName: string("packageName"),
      text: password ? "" : text,
      description: password ? "" : description,
      bounds,
      clickable: bool("clickable"),
      enabled: bool("enabled"),
      visible: bool("visible"),
      scrollable: bool("scrollable"),
      editable: bool("editable"),
      focused: bool("focused"),
      checkable: bool("checkable"),
      checked: bool("checked"),
      password,
      actions: [...item.actions],
    };
  });
  return {
    snapshotId: value.snapshotId,
    snapshotRef: value.snapshotRef,
    expiresInMs: value.expiresInMs,
    capturedAtMs: value.capturedAtMs,
    durationMs: value.durationMs,
    display: {
      id: 0,
      width: value.display.width,
      height: value.display.height,
      rotation: value.display.rotation,
    },
    nodes,
    truncated: value.truncated,
  };
}
