export interface AppLaunchResult {
  packageName: string;
  component: string;
  accepted: true;
}

export function parsePackageName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 255 ||
    !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(value)
  )
    throw new Error(
      "请输入有效的 Android 包名，例如 com.android.settings；不接受命令、Activity 或链接。",
    );
  return value;
}
