import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { ScrcpyControlMessageWriter } from "@yume-chan/scrcpy";
import { DeviceInputController } from "../src/extension/input.js";

describe("host-side remote input boundary", () => {
  const id = "a".repeat(32);
  let input: DeviceInputController;
  let screen: { stream: number; width: number; height: number };
  let writer: {
    injectTouch: Mock<ScrcpyControlMessageWriter["injectTouch"]>;
    injectKeyCode: Mock<ScrcpyControlMessageWriter["injectKeyCode"]>;
    setClipboard: Mock<ScrcpyControlMessageWriter["setClipboard"]>;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    screen = { stream: 7, width: 720, height: 1280 };
    writer = {
      injectTouch: vi.fn(async () => {}),
      injectKeyCode: vi.fn(async () => {}),
      setClipboard: vi.fn(async () => {}),
    };
    input = new DeviceInputController(writer, () => screen);
  });
  afterEach(async () => {
    await input.setController(null);
    vi.useRealTimers();
  });
  it("requires a current controller and current screen, and maps normalized touch coordinates", async () => {
    const touch = {
      kind: "touch",
      action: "down",
      pointerId: 0,
      x: 1,
      y: 0.5,
    } as const;
    await expect(input.write(id, touch, 7)).rejects.toThrow("授权");
    await input.setController(id);
    await expect(input.write(id, touch, 6)).rejects.toThrow("画面");
    await input.write(id, touch, 7);
    expect(writer.injectTouch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 0,
        pointerX: 719,
        pointerY: 640,
        videoWidth: 720,
        videoHeight: 1280,
      }),
    );
    await input.setController(null);
    expect(writer.injectTouch).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 1, pressure: 0 }),
    );
  });
  it("cancels queued commands on revocation and releases a key already being written", async () => {
    let unblock!: () => void;
    writer.injectKeyCode.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          unblock = resolve;
        }),
    );
    await input.setController(id);
    const down = input.write(
      id,
      { kind: "key", action: "down", keyCode: 66, metaState: 0 },
      7,
    );
    await Promise.resolve();
    const text = Array.from({ length: 31 }, () =>
      input.write(id, { kind: "text", text: "should-not-be-pasted" }, 7),
    );
    await expect(
      input.write(id, { kind: "text", text: "queue-overflow" }, 7),
    ).rejects.toThrow("积压");
    const revoked = input.setController(null);
    unblock();
    await Promise.all([down, ...text, revoked]);
    expect(writer.setClipboard).not.toHaveBeenCalled();
    expect(
      writer.injectKeyCode.mock.calls.map(([event]) => event.action),
    ).toEqual([0, 1]);
  });
  it("supports bounded Unicode paste without enabling clipboard reads and releases forgotten keys", async () => {
    await input.setController(id);
    await input.write(id, { kind: "text", text: "\u4f60\u597d" }, 7);
    expect(writer.setClipboard).toHaveBeenCalledWith({
      sequence: 0n,
      paste: true,
      content: "\u4f60\u597d",
    });
    await input.write(
      id,
      { kind: "key", action: "down", keyCode: 4, metaState: 0 },
      7,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writer.injectKeyCode).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 1, keyCode: 4 }),
    );
  });

  it("releases an existing pointer using the rotated screen dimensions", async () => {
    await input.setController(id);
    await input.write(
      id,
      { kind: "touch", action: "down", pointerId: 0, x: 0.5, y: 0.5 },
      7,
    );
    screen = { stream: 8, width: 1280, height: 720 };
    await input.setController(id);
    expect(writer.injectTouch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 1,
        videoWidth: 1280,
        videoHeight: 720,
        pointerX: 640,
        pointerY: 360,
      }),
    );
    await input.write(
      id,
      { kind: "touch", action: "down", pointerId: 0, x: 0, y: 0 },
      8,
    );
  });

  it("cancels new-owner input if releasing the previous owner's held key fails", async () => {
    await input.setController(id);
    await input.write(
      id,
      { kind: "key", action: "down", keyCode: 66, metaState: 0 },
      7,
    );
    writer.injectKeyCode.mockRejectedValueOnce(new Error("USB write failed"));
    const changed = input.setController("local");
    const text = input.write(
      "local",
      { kind: "text", text: "must-not-be-pasted" },
      7,
    );
    await expect(changed).rejects.toThrow("USB write failed");
    await text;
    expect(writer.setClipboard).not.toHaveBeenCalled();
    await expect(
      input.write("local", { kind: "text", text: "still-revoked" }, 7),
    ).rejects.toThrow("授权");
  });

  it("serializes semantic actions with Tango input and releases held touches before executing", async () => {
    const operation = vi.fn<() => Promise<string>>();
    await expect(input.execute(id, 7, operation)).rejects.toThrow("授权");
    await input.setController(id);
    await expect(input.execute(id, 6, operation)).rejects.toThrow("画面");
    await input.write(
      id,
      { kind: "touch", action: "down", pointerId: 0, x: 0.5, y: 0.5 },
      7,
    );
    let finish!: (value: string) => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    operation.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          began();
        }),
    );
    const action = input.execute(id, 7, operation);
    await started;
    expect(
      writer.injectTouch.mock.calls.map(([event]) => event.action),
    ).toEqual([0, 1]);
    const text = input.write(id, { kind: "text", text: "after action" }, 7);
    expect(writer.setClipboard).not.toHaveBeenCalled();
    finish("accepted");
    await expect(action).resolves.toBe("accepted");
    await text;
    expect(writer.setClipboard).toHaveBeenCalledOnce();
  });

  it("rejects a queued semantic action explicitly when control is revoked", async () => {
    let finish!: () => void;
    writer.injectKeyCode.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await input.setController(id);
    const held = input.write(
      id,
      { kind: "key", action: "down", keyCode: 66, metaState: 0 },
      7,
    );
    await Promise.resolve();
    const operation = vi.fn(async () => {});
    const action = expect(input.execute(id, 7, operation)).rejects.toThrow(
      "已取消",
    );
    const revoked = input.setController(null);
    finish();
    await Promise.all([held, action, revoked]);
    expect(operation).not.toHaveBeenCalled();
  });

  it("revokes semantic execution and surfaces a held-input release failure", async () => {
    await input.setController(id);
    await input.write(
      id,
      { kind: "key", action: "down", keyCode: 66, metaState: 0 },
      7,
    );
    writer.injectKeyCode.mockRejectedValueOnce(new Error("release failed"));
    input.onReleaseError = vi.fn();
    const operation = vi.fn(async () => {});
    await expect(input.execute(id, 7, operation)).rejects.toThrow(
      "release failed",
    );
    expect(input.onReleaseError).toHaveBeenCalledOnce();
    expect(operation).not.toHaveBeenCalled();
    await expect(
      input.write(id, { kind: "text", text: "not authorized" }, 7),
    ).rejects.toThrow("授权");
  });
});
