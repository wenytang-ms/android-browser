import { parseRemoteInput } from "./protocol.js";
import type { RemoteInput } from "./protocol.js";

const KEYS: Record<string, number> = {
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Enter: 66,
  NumpadEnter: 66,
  Backspace: 67,
  Delete: 112,
  Tab: 61,
  Escape: 111,
  Space: 62,
  Home: 122,
  End: 123,
  PageUp: 92,
  PageDown: 93,
  Comma: 55,
  Period: 56,
  Backquote: 68,
  Minus: 69,
  Equal: 70,
  BracketLeft: 71,
  BracketRight: 72,
  Backslash: 73,
  Semicolon: 74,
  Quote: 75,
  Slash: 76,
};

export class CanvasInput {
  private enabled = false;
  private pointer?: number;
  private keys = new Map<string, number>();
  private move?: { x: number; y: number };
  private animation?: number;
  private readonly abort = new AbortController();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly send: (event: RemoteInput) => void,
  ) {
    const options = { signal: this.abort.signal };
    canvas.addEventListener(
      "pointerdown",
      (event) => {
        if (
          !this.enabled ||
          !event.isPrimary ||
          event.button !== 0 ||
          this.pointer !== undefined
        )
          return;
        event.preventDefault();
        canvas.focus();
        canvas.setPointerCapture(event.pointerId);
        this.pointer = event.pointerId;
        this.send({
          kind: "touch",
          action: "down",
          pointerId: 0,
          ...this.position(event),
        });
      },
      options,
    );
    canvas.addEventListener(
      "pointermove",
      (event) => {
        if (!this.enabled || event.pointerId !== this.pointer) return;
        this.move = this.position(event);
        if (this.animation === undefined)
          this.animation = requestAnimationFrame(() => {
            this.animation = undefined;
            if (this.move && this.enabled && this.pointer !== undefined)
              this.send({
                kind: "touch",
                action: "move",
                pointerId: 0,
                ...this.move,
              });
            this.move = undefined;
          });
      },
      options,
    );
    const up = (event: PointerEvent) => {
      if (event.pointerId !== this.pointer) return;
      if (this.enabled)
        this.send({
          kind: "touch",
          action: "up",
          pointerId: 0,
          ...this.position(event),
        });
      this.clearPointer();
    };
    canvas.addEventListener("pointerup", up, options);
    canvas.addEventListener("pointercancel", () => this.release(), options);
    canvas.addEventListener(
      "lostpointercapture",
      () => this.release(),
      options,
    );
    canvas.addEventListener(
      "keydown",
      (event) => this.key(event, "down"),
      options,
    );
    canvas.addEventListener("keyup", (event) => this.key(event, "up"), options);
    canvas.addEventListener("blur", () => this.release(), options);
    window.addEventListener("blur", () => this.release(), options);
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.hidden) this.release();
      },
      options,
    );
    canvas.addEventListener(
      "contextmenu",
      (event) => {
        if (this.enabled) event.preventDefault();
      },
      options,
    );
  }

  setEnabled(enabled: boolean, notify = true) {
    if (!enabled) {
      if (notify) this.release();
      else {
        this.clearPointer();
        this.keys.clear();
      }
    }
    this.enabled = enabled;
    this.canvas.setAttribute("aria-disabled", String(!enabled));
  }

  press(keyCode: number) {
    if (!this.enabled) return;
    this.send(
      parseRemoteInput({ kind: "key", action: "down", keyCode, metaState: 0 }),
    );
    this.send(
      parseRemoteInput({ kind: "key", action: "up", keyCode, metaState: 0 }),
    );
  }

  text(text: string) {
    if (this.enabled) this.send(parseRemoteInput({ kind: "text", text }));
  }

  private key(event: KeyboardEvent, action: "down" | "up") {
    if (!this.enabled || event.isComposing) return;
    let keyCode = KEYS[event.code];
    if (/^Key[A-Z]$/.test(event.code))
      keyCode = event.code.charCodeAt(3) - 65 + 29;
    else if (/^Digit[0-9]$/.test(event.code))
      keyCode = Number(event.code[5]) + 7;
    if (keyCode === undefined) return;
    event.preventDefault();
    if (action === "down" && this.keys.has(event.code) && !event.repeat) return;
    if (action === "up" && !this.keys.has(event.code)) return;
    if (action === "down") this.keys.set(event.code, keyCode);
    else this.keys.delete(event.code);
    this.send(
      parseRemoteInput({
        kind: "key",
        action,
        keyCode,
        metaState:
          (event.shiftKey ? 1 : 0) |
          (event.altKey ? 2 : 0) |
          (event.ctrlKey ? 4096 : 0) |
          (event.metaKey ? 65536 : 0),
      }),
    );
  }

  private position(event: PointerEvent) {
    const bounds = this.canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
  }

  private clearPointer() {
    if (this.animation !== undefined) cancelAnimationFrame(this.animation);
    this.animation = undefined;
    this.move = undefined;
    const pointer = this.pointer;
    this.pointer = undefined;
    if (pointer !== undefined && this.canvas.hasPointerCapture(pointer))
      this.canvas.releasePointerCapture(pointer);
  }

  private release() {
    if (this.enabled && (this.pointer !== undefined || this.keys.size))
      this.send({ kind: "release" });
    this.clearPointer();
    this.keys.clear();
  }

  dispose() {
    this.setEnabled(false);
    this.abort.abort();
  }
}
