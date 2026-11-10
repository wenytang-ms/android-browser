import type { ScrcpyControlMessageWriter } from "@yume-chan/scrcpy";
import type { AndroidKeyCode, AndroidKeyEventMeta } from "@yume-chan/scrcpy";
import { parseRemoteInput } from "../shared/protocol.js";
import type { RemoteInput } from "../shared/protocol.js";

type Writer = Pick<
  ScrcpyControlMessageWriter,
  "injectTouch" | "injectKeyCode" | "setClipboard"
>;
type Touch = Extract<RemoteInput, { kind: "touch" }>;
interface Screen {
  stream: number;
  width: number;
  height: number;
}

export class DeviceInputController {
  private controller: string | null = null;
  private generation = 0;
  private pending = 0;
  private tail = Promise.resolve();
  private touches = new Map<number, { event: Touch; screen: Screen }>();
  private keys = new Map<
    AndroidKeyCode,
    { metaState: AndroidKeyEventMeta; repeat: number }
  >();
  private releaseTimer?: ReturnType<typeof setTimeout>;
  private latestScreen?: Screen;

  constructor(
    private readonly writer: Writer,
    private readonly screen: () => Screen | undefined,
  ) {}

  setController(id: string | null): Promise<void> {
    this.latestScreen = this.screen() ?? this.latestScreen;
    this.controller = id;
    const generation = ++this.generation;
    clearTimeout(this.releaseTimer);
    return this.enqueue(async () => {
      try {
        await this.releaseHeld();
      } catch (error) {
        if (generation === this.generation) {
          this.controller = null;
          ++this.generation;
        }
        throw error;
      }
    });
  }

  write(id: string, value: RemoteInput, stream: number): Promise<void> {
    const event = parseRemoteInput(value);
    if (!this.controller || id !== this.controller)
      return Promise.reject(new Error("输入控制授权已失效。"));
    if (this.pending >= 32)
      return Promise.reject(
        new Error("设备输入积压，请停止操作并重新开始投屏。"),
      );
    const generation = this.generation;
    return this.enqueue(async () => {
      if (generation !== this.generation) return;
      const screen = this.screen();
      if (!screen || screen.stream !== stream)
        throw new Error("输入对应的画面已经改变，请等待新画面。");
      this.latestScreen = screen;
      switch (event.kind) {
        case "release":
          await this.releaseHeld();
          break;
        case "touch": {
          const previous = this.touches.get(event.pointerId);
          if (event.action === "down" && previous)
            throw new Error("重复触点。");
          if (event.action !== "down" && !previous) {
            if (event.action === "up") break;
            throw new Error("触点尚未按下。");
          }
          this.touches.set(event.pointerId, { event, screen });
          await this.touch(event, screen);
          if (event.action === "up") this.touches.delete(event.pointerId);
          break;
        }
        case "key":
          if (event.action === "up" && !this.keys.has(event.keyCode)) break;
          const previousKey = this.keys.get(event.keyCode);
          const repeat =
            event.action === "down" && previousKey
              ? Math.min(previousKey.repeat + 1, 65535)
              : 0;
          if (event.action === "down")
            this.keys.set(event.keyCode, {
              metaState: event.metaState,
              repeat,
            });
          await this.writer.injectKeyCode({
            action: event.action === "down" ? 0 : 1,
            keyCode: event.keyCode,
            repeat,
            metaState: event.metaState,
          });
          if (event.action === "up") this.keys.delete(event.keyCode);
          break;
        case "text":
          await this.writer.setClipboard({
            sequence: 0n,
            paste: true,
            content: event.text,
          });
          break;
      }
      clearTimeout(this.releaseTimer);
      if (this.touches.size || this.keys.size)
        this.releaseTimer = setTimeout(() => {
          // A lost key-up must not leave the phone holding a key indefinitely.
          void this.enqueue(() => this.releaseHeld()).catch(
            this.onReleaseError,
          );
        }, 5_000);
    });
  }

  onReleaseError: (error: unknown) => void = (error) =>
    console.error("Device input release failed:", error);

  private enqueue(operation: () => Promise<void>): Promise<void> {
    ++this.pending;
    const result = this.tail.then(operation).finally(() => {
      --this.pending;
    });
    this.tail = result.catch(() => {});
    return result;
  }

  private touch(event: Touch, screen: Screen): Promise<void> {
    return this.writer.injectTouch({
      action: event.action === "down" ? 0 : event.action === "up" ? 1 : 2,
      pointerId: BigInt(event.pointerId),
      pointerX: Math.round(event.x * (screen.width - 1)),
      pointerY: Math.round(event.y * (screen.height - 1)),
      videoWidth: screen.width,
      videoHeight: screen.height,
      pressure: event.action === "up" ? 0 : 1,
      actionButton: event.action === "move" ? 0 : 1,
      buttons: event.action === "up" ? 0 : 1,
    });
  }

  private async releaseHeld() {
    clearTimeout(this.releaseTimer);
    const currentScreen = this.screen() ?? this.latestScreen;
    for (const [pointerId, { event, screen }] of this.touches) {
      await this.touch({ ...event, action: "up" }, currentScreen ?? screen);
      this.touches.delete(pointerId);
    }
    for (const [keyCode, { metaState }] of this.keys) {
      await this.writer.injectKeyCode({
        action: 1,
        keyCode,
        repeat: 0,
        metaState,
      });
      this.keys.delete(keyCode);
    }
  }
}
