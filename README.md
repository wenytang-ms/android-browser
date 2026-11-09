# Tango Android Share

按 [requirements.md](requirements.md) 实现的 P0 Chrome 扩展、远端查看器和 WSS 应用中继。宿主通过 WebUSB / Tango 直接连接手机，不需要安装 ADB、Node.js 或隧道程序；只有开发者构建和部署中继需要 Node.js。

## 开发者构建

需要 Node.js 22.12+（推荐 24）及 npm：

```powershell
npm ci
npm run build
```

构建结果：

| 目录             | 用途                             |
| ---------------- | -------------------------------- |
| `dist\extension` | 可加载的 Manifest V3 Chrome 扩展 |
| `dist\viewer`    | 普通 HTTPS 远端查看器            |
| `dist\relay`     | Node.js 双 WebSocket 中继        |

构建时自动下载官方 `scrcpy-server-v2.1`，验证官方 SHA-256 后放入扩展；运行时只读取扩展内的 JAR，不下载远程脚本。Tango 及播放器一起打包。第三方许可证随产物附带在 `third-party-notices.txt` 中。

固定版本：`@yume-chan/adb` 2.6.4、WebUSB / adb-scrcpy 2.3.2、scrcpy 协议包 2.3.0、credential-web 2.1.0、stream-extra 2.6.1；使用 `AdbScrcpyOptions2_1` 对接 scrcpy-server 2.1。完整依赖由 `package-lock.json` 锁定。

## GitHub Release 发布

首个版本为 `0.0.1-alpha`。在 [Releases 页面](https://github.com/wenytang-ms/android-browser/releases) 下载 `tango-android-share-0.0.1-alpha.zip`，解压后在 Chrome 加载包含 `manifest.json` 的目录；附带 `.sha256` 校验文件。该 ZIP 是用于“加载已解压的扩展”的包，不是签名 CRX，也不会自动发布到 Chrome Web Store。

`.github\workflows\release-extension.yml` 支持两种方式：

1. 推送 `v*` 标签自动打包并发布；例如 `v0.0.1-alpha`。
2. 在 GitHub **Actions → Release Chrome extension → Run workflow** 输入版本，例如 `0.0.2-alpha`，从所选分支提交构建并创建对应标签和 Release。

流程使用 Node.js 24 和 `npm ci`，先检查格式和回归测试，再构建包含 Tango、scrcpy-server 和许可证的扩展，生成 ZIP 和 SHA-256，并将附件上传到 GitHub Release。带预发布后缀的版本标记为 **Pre-release**；稳定版本正常发布。使用内置 `GITHUB_TOKEN`，无需额外发布密钥。

Chrome 的数值版本与显示版本分开：`0.0.1-alpha` 对应 manifest 的 `version: "0.0.1"` 和 `version_name: "0.0.1-alpha"`。发布脚本同时更新 package、lockfile 和 manifest。标签或 Release 已存在时不覆盖其他提交或已有附件，请使用新的版本号。

后续通过标签发布：

```powershell
npm run release:version -- 0.0.2-alpha
npm run format
git add package.json package-lock.json extension\public\manifest.json
git commit -m "Release 0.0.2-alpha"
git tag v0.0.2-alpha
git push origin main
git push origin v0.0.2-alpha
```

## 用户：本地投屏

1. 在桌面 Chrome 118+ 的 `chrome://extensions` 开启开发者模式，选择“加载已解压的扩展”，打开 Release ZIP 的解压目录或本地构建的 `dist\extension`。Chrome Web Store 正式发布后用户只需安装扩展。
2. 在手机开启开发者选项和 USB 调试，使用支持数据传输的 USB 线连接电脑，解锁手机。
3. 点击扩展图标，打开独立设备会话标签页，点击“连接 USB 设备”。完成浏览器设备选择，并在手机上允许 USB 调试。
4. 扩展自动推送和启动 scrcpy-server，开始播放。可以停止、再次开始或断开设备；重新插入手机后再次连接。

首版仅观看，不包含触摸、键盘、音频、录屏或多设备。会话页关闭会结束设备和共享连接。ADB 密钥由 Tango 保存于扩展的 IndexedDB，远端不会获得 USB / ADB 访问权。

Windows 的 ADB USB 接口必须有 WebUSB 兼容驱动，且不能被 Android Studio、其他 ADB 客户端等程序占用。如无法打开设备，请释放占用并检查 OEM USB 驱动 / WinUSB 兼容性；不要替换手机其他接口（例如 MTP）的驱动。免安装 ADB 不代表无需驱动验证。

scrcpy 2.1 上游支持 Android 5.0+；本项目实际 Android / OEM 编码器和 Windows 驱动兼容范围尚需设备实测，不能把上游范围当成已验证范围。

## 用户：远程分享

在本地投屏运行时，填写部署者提供的 HTTPS 中继源地址和“中继创建密钥”，点击“开启远程分享”，复制链接交给获准观看的人。中继地址只接受源地址，例如 `https://share.example.com`，不要添加路径。

远端使用普通浏览器打开完整链接，点击“授权并观看”。无需安装扩展，不访问远端电脑的 USB；画面来自宿主电脑连接的手机。首版只允许一个同时在线的观看者。

链接的 `session` 只是定位 ID；独立 256 位观看凭据放在 URL fragment `#token=...`，不进入 HTTP 请求和 Referrer。查看器读取后移除 fragment，只在当前标签页的 `sessionStorage` 中保留以支持刷新。持有完整链接即持有观看权，请仅向获准者发送；没有凭据、凭据错误、会话过期和撤销都会被拒绝。

分享默认有效 30 分钟。“停止并撤销分享”会关闭远端连接且让旧凭据失效，本地画面继续播放。设备断开或停止本地视频会结束分享。若撤销时宿主已经离线，页面会明确提示无法即时确认，中继按离线超时结束旧会话。分享期间保持宿主标签页、Chrome 和电脑在线，避免系统休眠或浏览器冻结该页面。

## 本机开发联调

先完成构建。在中继启动前，从 `chrome://extensions` 复制本次安装的扩展 ID：

```powershell
$env:PUBLIC_URL = "http://localhost:3000"
$env:EXTENSION_ORIGINS = "chrome-extension://你的扩展ID"
npm start
```

中继默认监听 `127.0.0.1:3000`，同时提供查看器、`/health`、`/ws/control` 和 `/ws/media`。扩展填写 `http://localhost:3000`；本机模式可以不设置创建密钥。HTTP / WS 只允许 localhost / loopback 开发，不能用于跨网络观看。

修改查看器时可以运行 `npm run dev:viewer`；使用 Vite 的 `http://localhost:5173` 时，把该源地址加入 `EXTENSION_ORIGINS` 白名单（逗号分隔），并保持中继在线。修改中继后使用 `npm run dev:relay` 重新编译启动；扩展修改后重新构建并在 Chrome 中重新加载。

## 公网部署

由项目开发者部署一个支持 HTTPS 和 WebSocket 长连接的服务，宿主用户不运行本机中继或隧道工具。查看器与两个 WSS 路径须部署在同一源下。

```powershell
$env:PUBLIC_URL = "https://share.example.com"
$env:DEPLOYMENT_TOKEN = "<由部署者生成并妥善分发的创建密钥>"
$env:EXTENSION_ORIGINS = "chrome-extension://已发布或安装的扩展ID"
$env:HOST = "127.0.0.1"
$env:PORT = "3000"
npm start
```

公网模式强制要求 `DEPLOYMENT_TOKEN`。可用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 在部署时生成密钥，不将密钥写入仓库。宿主在扩展中填写此密钥；只保存中继源地址，不保存创建密钥或会话密钥。

把 `deploy\Caddyfile` 中的域名改为实际域名，由 Caddy 或已有反向代理负责证书和 TLS，代理到中继的私有监听地址。WebSocket Upgrade 必须透传，代理空闲超时应大于心跳间隔（建议至少 60 秒）。HTTPS 终止以后，中继无需自行加载 TLS 私钥。仅在需要容器内部监听时设置 `HOST=0.0.0.0`，对外仍通过 HTTPS 代理，不公开裸 HTTP 端口。

也提供 `Dockerfile`：

```powershell
docker build -t tango-share .
docker run --rm -p 127.0.0.1:3000:3000 `
  -e PUBLIC_URL=https://share.example.com `
  -e DEPLOYMENT_TOKEN="<创建密钥>" `
  -e EXTENSION_ORIGINS="chrome-extension://扩展ID" `
  tango-share
```

`VIEWER_DIR` 可以覆盖查看器目录。默认内存单实例，不持久化分享；中继重启后旧链接失效。若增加副本，应保证同一分享的两个通道路由到同一实例；当前不提供分布式会话存储。

开发者也可以用 ngrok / Dev Tunnels 将开发中继暴露为 HTTPS，随后把 `PUBLIC_URL` 和扩展里的中继地址改成该 HTTPS 源。隧道仅部署者使用，不能变成宿主用户依赖。

## 协议和延迟策略

| 项目                | 首版固定规则                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 会话通道            | `/ws/control`，版本化 JSON：创建、授权、撤销、心跳、状态、重新同步                                                 |
| 视频通道            | `/ws/media`，授权完成后转发二进制 Annex-B H.264，不转码                                                            |
| 二进制头            | 52 字节，大端；magic `TNGO`、版本、类型、关键帧位、保留位、16 字节会话 ID、流代次、序号、64 位 PTS、宽高、负载长度 |
| 时间戳              | scrcpy 2.1 原始微秒 PTS，直接传给 `EncodedVideoChunk.timestamp`                                                    |
| 同步                | 新加入 / 重连只缓存当前配置，等待新的关键帧；每次同步增加流代次，拒绝旧代次和序列异常，不重放旧帧                  |
| 静止画面            | 1 秒 I-frame 间隔，设置重复前帧；同步等待 2.5 秒仍无关键帧时重建设备编码流，不撤销分享                             |
| 视频参数            | 最大边长 1280、最高 30 fps、4 Mbps；本地和远端共用同一原始视频配置                                                 |
| 心跳 / 离线         | 每 5 秒心跳及扫描，15 秒离线阈值；正常网络中断检测加会话失效最迟约 40 秒，已观测宿主关闭后通常约 20 秒内结束       |
| 重连                | 0.5 / 1 / 2 / 4 / 4 秒，最多 5 次连续失败；所有重连重新授权，不续期会话或恢复撤销权限                              |
| 主机 / 中继视频队列 | 2 MiB；超过上限重建视频连接，丢弃整个依赖链，等待配置与新关键帧恢复                                                |
| 播放器              | 最多 8 个待解码块；积压时重置解码器并等待关键帧；显示只保留最新已解码帧，替换后立即关闭旧 `VideoFrame`             |
| 协议限额            | 单包最多 1 MiB、配置最多 64 KiB、视频每秒最多 4 MiB、JSON 最多 4 KiB、每连接每 10 秒最多 60 个请求                 |
| 中继容量            | 默认最多 64 个会话、256 个连接；5 秒内未授权的连接关闭                                                             |

授权在 WebSocket 首条消息中完成，凭据不放在 WebSocket URL。中继检查 Origin、会话存活、角色与观看者绑定。保留的控制/RPC 通道目前不提供 Android 操作，不暴露原始 ADB。

ADB 输出日志持续读取；音频和控制通道从服务端关闭，避免未读多路复用流阻塞视频。播放器不使用 Canvas 捕获后再编码，Canvas 仅用于显示已解码帧。

## 验证和实测记录

```powershell
npm run typecheck
npm test
npm run format:check
npm run build
npm run test:browser
```

浏览器测试需要本机 Chrome / Chromium。Windows 自动查找 Chrome / Edge，其他安装位置可设置 `$env:CHROME_PATH`。测试使用独立临时浏览器 profile 和随机本机端口，结束后关闭中继、浏览器并清理 profile；需要支持 CDP `Extensions.loadUnpacked` 的现代 Chromium。运行测试的浏览器版本不替代 Chrome 118 下的设备验收。

自动化覆盖实际 WSS 协议路径（本机测试为 WS）、授权、撤销、单观看者、加入与恢复、过期、流代次、积压恢复、最新帧释放，以及 Chrome 真实 H.264 解码/渲染和 MV3 打包加载。浏览器测试使用合成 H.264 画面，不是假称已接入真实手机。

真实设备和跨网络验收尚未完成。请以如下记录表完成 [需求文档第 7 节](requirements.md) 的硬件验收，不承诺尚未测量的公网延迟或性能提升：

| 记录项          | 当前状态 / 待填写内容                                                   |
| --------------- | ----------------------------------------------------------------------- |
| 测试设备        | 待填 Android 型号、系统版本和 OEM 编码器                                |
| 宿主            | 待填 Windows / USB 驱动、Chrome 版本                                    |
| 远端            | 待填浏览器版本和解码硬件                                                |
| 网络            | 待填不同网络、RTT、带宽、丢包与中继地域                                 |
| 视频配置        | 1280 / 30 fps / 4 Mbps；记录设备实际尺寸与帧率                          |
| 本地 / 远端 fps | 页面底部显示最近 1 秒已显示帧数；真实设备数值待测                       |
| 队列和恢复      | 页面显示解码队列、恢复次数、宿主上行积压；限速实测待补                  |
| 生命周期        | 停止/重开、拔插、旋转、静止画面加入、撤销、关闭宿主、断网重连待设备验收 |
| 延迟            | 本地与远端对照测量，当前无实测结论                                      |

## 常见故障

- USB 选择器中没有设备：检查 USB 数据线、USB 调试、手机解锁状态和驱动；不支持 WebUSB 时页面会直接提示。
- ADB 授权卡住：手机上允许授权；60 秒超时会关闭 USB，可重新连接。
- scrcpy 启动失败：页面显示服务输出；检查 Android 兼容性。启动超过 30 秒会断开设备，可以重新连接。
- 黑屏或解码不支持：页面检查 WebCodecs 与实际 H.264 profile/level；检查浏览器硬件加速，不以静默空白作为成功。
- 中继连接失败 / 403：检查 HTTPS 证书、公开源地址、代理 Upgrade、扩展 ID 的 Origin 白名单及创建密钥。
- 已被其他人观看：当前仅一个在线观看者；让已有观看者结束，或撤销后重新建立分享。
- 旧链接无法恢复：会话过期、撤销、宿主超时离线或中继重启后必须使用新链接。

## 参考

- [Tango WebUSB](https://tangoadb.dev/tango/daemon/usb/)
- [Tango scrcpy 启动与输出流要求](https://tangoadb.dev/scrcpy/start-server/)
- [Tango WebCodecs / Annex-B](https://tangoadb.dev/scrcpy/video/web-codecs/)
- [Chrome 扩展 WebUSB](https://developer.chrome.com/docs/extensions/how-to/web-platform/webusb)
- [scrcpy 2.1 发布](https://github.com/Genymobile/scrcpy/releases/tag/v2.1)
