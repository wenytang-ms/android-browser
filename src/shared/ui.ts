import type { PlayerStats } from "./player.js";

export function element<T extends HTMLElement>(
  id: string,
  type: { new (): T },
): T {
  const result = document.getElementById(id);
  if (!(result instanceof type)) throw new Error(`Missing UI element: ${id}`);
  return result;
}

export function trackStats(
  target: HTMLElement,
  stats: PlayerStats,
  extra: () => string = () => "",
): () => void {
  let rendered = 0;
  const timer = setInterval(() => {
    const fps = stats.rendered - rendered;
    rendered = stats.rendered;
    target.textContent = `${stats.width} × ${stats.height} | ${fps} fps | 解码队列 ${stats.decodeQueue} / 8 | 恢复 ${stats.recoveries}${extra()}`;
  }, 1_000);
  return () => clearInterval(timer);
}
