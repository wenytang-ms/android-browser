# Tango Android Share

按 [requirements.md](requirements.md) 实现的 Chrome 扩展、远端查看器和 WSS 应用中继，当前源码支持本地控制及同 Google 账号远程观看和控制，本地输入优先。宿主通过 WebUSB / Tango 直接连接手机，不需要安装 ADB、Node.js 或隧道程序；只有开发者构建和部署中继需要 Node.js。

`0.0.2-alpha` 包含本地及远端输入、本地优先接管和手机息屏操控。`0.0.1-alpha` 是早期只读版本，不会自动获得新功能；请下载新版 ZIP 并重新加载扩展。新版远程分享还须更新配套中继并配置 Google 登录，不兼容旧版匿名访问方式。

`0.0.3-alpha` 新增本地媒体音频转发：网页播放手机媒体声，手机停止播放被转发的媒体声，保留电话、通知和闹钟。需要 Android 11+；远端暂不传音频，实际设备音频路由仍需真机确认。

`0.0.4-alpha` 新增免 APK、按需读取的本地 UI tree 检视器、节点点击/长按、填文字和滚动，以及按包名启动应用。需要 Android 7+、ADB shell v2；手机端 Android/OEM 兼容性仍需真机确认。`0.0.3-alpha` 及更早 ZIP 不包含这些功能。

## 开发者构建

需要 Node.js 22.12+（推荐 24）、npm 及 JDK 17+（设置 `JAVA_HOME` 或加入 PATH）：

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

UI helper 使用 `android\ui-helper\UiTreeServer.java` 构建；构建脚本自动下载 `tools.json` 固定 SHA-256 的官方 Android 编译平台及 R8，缓存于 `node_modules\.cache\tango-ui-build`，无需另装 Android SDK。`npm run prepare:ui-helper` 可单独生成含 DEX 的 `extension\public\ui-helper.jar`，完整构建会将其一起打包。JDK、Node.js 和下载网络仅开发构建需要，扩展用户无需安装它们。

固定版本：`@yume-chan/adb` 2.6.4、WebUSB / adb-scrcpy 2.3.2、scrcpy 协议包 2.3.0、credential-web 2.1.0、stream-extra 2.6.1；使用 `AdbScrcpyOptions2_1` 对接 scrcpy-server 2.1。完整依赖由 `package-lock.json` 锁定。

## GitHub Release 发布

当前预发布版本为 `0.0.4-alpha`。在 [Releases 页面](https://github.com/wenytang-ms/android-browser/releases) 下载 `tango-android-share-0.0.4-alpha.zip`，解压后在 Chrome 加载包含 `manifest.json` 的目录；附带 `.sha256` 校验文件。该 ZIP 是用于“加载已解压的扩展”的包，不是签名 CRX，也不会自动发布到 Chrome Web Store。

`.github\workflows\release-extension.yml` 支持两种方式：

1. 推送 `v*` 标签自动打包并发布；例如 `v0.0.1-alpha`。
2. 在 GitHub **Actions → Release Chrome extension → Run workflow** 输入版本，例如 `0.0.4-alpha`，从所选分支提交构建并创建对应标签和 Release。

流程使用 Node.js 24、JDK 17 和 `npm ci`，先检查格式和回归测试，再构建包含 Tango、scrcpy-server、UI helper 和许可证的扩展，生成 ZIP 和 SHA-256，并将附件上传到 GitHub Release。带预发布后缀的版本标记为 **Pre-release**；稳定版本正常发布。使用内置 `GITHUB_TOKEN`，无需额外发布密钥。

Chrome 的数值版本与显示版本分开：`0.0.1-alpha` 对应 manifest 的 `version: "0.0.1"` 和 `version_name: "0.0.1-alpha"`。发布脚本同时更新 package、lockfile 和 manifest。标签或 Release 已存在时不覆盖其他提交或已有附件，请使用新的版本号。

后续通过标签发布：

```powershell
npm run release:version -- 0.0.4-alpha
npm run format
git add package.json package-lock.json extension\public\manifest.json
git commit -m "Release 0.0.4-alpha"
git tag v0.0.4-alpha
git push origin main
git push origin v0.0.4-alpha
```

## 用户：本地投屏

1. 在桌面 Chrome 118+ 的 `chrome://extensions` 开启开发者模式，选择“加载已解压的扩展”，打开 Release ZIP 的解压目录或本地构建的 `dist\extension`。Chrome Web Store 正式发布后用户只需安装扩展。
2. 在手机开启开发者选项和 USB 调试，使用支持数据传输的 USB 线连接电脑，解锁手机。
3. 点击扩展图标，打开独立设备会话标签页，点击“连接 USB 设备”。完成浏览器设备选择，并在手机上允许 USB 调试。
4. 扩展自动推送和启动 scrcpy-server，开始播放。可以停止、再次开始或断开设备；重新插入手机后再次连接。
5. 画面显示后，点击可触摸，拖动或单指触摸可滑动；点击画面取得焦点后，可使用字母、数字、方向键、回车及常用编辑键。画面下方提供返回、主页、最近应用和文本输入；中文通过文本框发送。

本地观看及控制均无需 Google 登录、中继或网络。文本粘贴最多 1024 UTF-8 字节，会覆盖手机剪贴板；不读取手机剪贴板。断线、停止及画面尺寸改变时禁用输入，待新画面显示后恢复。不包含录屏或多设备。会话页关闭会结束设备和共享连接。ADB 密钥由 Tango 保存于扩展的 IndexedDB，远端不会获得原始 USB / ADB 访问权。

**本地操作自动接管。** 开启共享后，只要在本地画面点击、拖动、使用键盘、发送文本、执行节点动作或启动应用，远端立即变为只读，视频继续播放；正在按下的远端按键和触点会释放，旧输入队列被取消。宿主重新勾选“允许远端控制”后，远端等待新配置和画面，再恢复操作。断线重连不会绕过宿主设置；远端不能自行开启控制权限。

Windows 的 ADB USB 接口必须有 WebUSB 兼容驱动，且不能被 Android Studio、其他 ADB 客户端等程序占用。如无法打开设备，请释放占用并检查 OEM USB 驱动 / WinUSB 兼容性；不要替换手机其他接口（例如 MTP）的驱动。免安装 ADB 不代表无需驱动验证。

scrcpy 2.1 上游支持 Android 5.0+；本项目实际 Android / OEM 编码器和 Windows 驱动兼容范围尚需设备实测，不能把上游范围当成已验证范围。

## 用户：按需读取 UI tree（0.0.4-alpha）

开始投屏并显示画面后，点击 **“读取当前 UI tree”**。首次调用将随扩展打包的辅助 JAR 推送至手机 `/data/local/tmp`，通过当前已授权的 ADB shell v2 启动 `app_process` / `UiAutomation`。之后复用该进程，只有点击读取才采集当前活动窗口；不会主动刷新 UI 树，也不订阅用于业务刷新的无障碍事件。无需安装 APK 或手动启用 AccessibilityService，不占用新的手机监听端口，不要求电脑运行额外程序。

节点可以按文字、描述、资源 ID 或类名筛选。选择节点只显示 JSON 属性，并按手机屏幕坐标在视频上近似高亮，不会点击手机，也不影响画面触控；只有点击 **“执行节点动作”** 才操作手机。每次读取返回独立快照；操作手机后需重新读取，快照与视频不是原子同步。画面流变化时清除旧快照，屏幕比例不匹配时不显示高亮。当前仅支持默认显示屏的活动窗口，不是完整 View 树、HTML DOM 或所有窗口；自绘、合并语义及受保护界面可能没有完整节点。

内部入口为 `DeviceSession.getUiTree()`，返回带画面流代次的 `LocalUiTreeSnapshot`：采集序号、随机 `snapshotRef`、动作剩余有效期 `expiresInMs`、手机单调时钟 `capturedAtMs`、耗时、显示尺寸/旋转、扁平父子节点与 `truncated` 标记。节点含资源 ID、类名、包名、文本、描述、边界、可点击/可编辑等状态及声明支持的 `actions`。最多 2000 节点、深度 64、每个文本字段 1024 字符；数量/大小/深度/文本超限会明确标记截断，遍历超时或无活动根节点则返回错误，不回退旧树。helper 启动限时 20 秒、单次读取或动作限时 8 秒，同一时刻只允许一个请求。

节点动作通过现有免 APK helper 调用 `AccessibilityNodeInfo.performAction()`，不需要另装 AccessibilityService。内部入口为 `DeviceSession.performUiAction({ stream, snapshotRef, nodeId, action, ... })`；支持 `click`、`longClick`、`setText`、`scrollForward` / `scrollBackward` 及节点声明支持的 `scrollUp` / `scrollDown` / `scrollLeft` / `scrollRight`。`setText` 需附 `text`，最多 1024 UTF-8 字节，允许空字符串清空；不修改剪贴板，密码节点的输入框会隐藏文字，执行后清空输入。只有启用、可见且声明支持相应动作的节点可执行，不自动选择父节点或用坐标点击兜底。任意坐标点击、滑动和拖拽仍使用原有 Tango 输入。

每次快照在手机仅保留一组有界节点引用，最长 30 秒，超时自动释放；新读取替换旧引用，动作尝试后整组引用释放。手机执行前检查活动根窗口、显示尺寸/旋转、节点刷新及关键属性是否一致，并重新检查动作支持情况。本地或远端的普通输入使浏览器引用失效，读取期间有输入则拒绝该快照用于动作。执行节点动作遵守本地优先接管，与 Tango 共用有界输入队列并先释放按下的触点/按键。界面只列出该节点支持的动作；过期或动作后需重新读取，不自动刷新、重试或回退坐标触控。

`accepted: true` 仅表示 Android 节点动作返回已处理，不保证页面已完成业务目标，仍需按需读取确认。动作超时、断线或执行中关闭 helper 时结果可能未知，不能直接重试以免重复操作。失败和节点变化会独立显示错误，不停止正常媒体或输入；输入释放本身失败则沿用原有停止/恢复流程。helper RPC 为协议 2，旧协议或回执不匹配时关闭 helper，不接受旧节点序号。

密码节点的文本和描述在手机与浏览器两端清除；其他普通文本仍可能包含隐私，请勿将真实树粘贴到公开 issue。快照只在宿主页内存展示，不写入存储、不记录原始树或手机 stderr，不传给远端或中继。**“关闭 helper 并清除快照”** 会结束辅助进程并删除本次临时 JAR，投屏、声音和触控继续；手动停止投屏或断开设备也会清理，自动重建视频则保留 helper。断连/强制关闭时依赖 shell 标准输入关闭使进程退出，无法保证删除断连手机上的临时 JAR；错误会明确提示，清理不会无限阻塞投屏资源释放。

需要 **Android 7+、ADB shell v2**。该方案使用 Android 的隐藏引导接口，Android/OEM 兼容性及其他 UI 自动化工具占用可能导致失败；浏览器会独立显示错误，不停止正常投屏/控制。Redmi K40 手机端尚未实测，不能把编译及浏览器模拟测试当作真机验证。此阶段不提供 XML/XPath、Accessibility 手势、外部扩展消息、远程 UI tree/节点动作、HTTP 桥或 MCP。

## 用户：按包名启动应用（0.0.4-alpha）

开始投屏并显示画面后，在 **“启动应用（仅本地）”** 输入包名，例如 `com.android.settings`，点击 **“启动应用”**。内部入口为 `DeviceSession.launchApp(packageName)`，复用已授权的 Tango ADB shell v2，无需启动 UI helper，也不安装 APK 或额外桌面程序。

只接受最长 255 字符、点分隔的 Android 包名，不接受命令、Activity、链接或额外参数。查询当前 Android 用户下的 `MAIN` / `LAUNCHER` 入口，选择系统返回的第一个组件，以 `NEW_TASK | RESET_TASK_IF_NEEDED` 启动或返回已有任务；不强制停止、清数据或安装应用。没有桌面入口、未安装/已停用、权限拒绝、命令不兼容或未获成功回执时明确报错，不用 `monkey` 或坐标点击兜底。

启动与 Tango 输入共用队列，先释放已有触点/按键并按本地优先规则撤销远端控制，使旧 UI 节点引用失效。进行中暂停本地输入及 UI tree 读取，但保留停止、断开和媒体播放。总限时 15 秒，输出合计上限 64 KiB；停止、断开或重建视频会取消等待，不自动重试。超时/中断可能已启动手机应用，须确认当前页面。

返回 `{ packageName, component, accepted: true }` 仅表示 Android `am start -W` 报告成功，不表示首页加载完成、目标应用已解锁或广告已跳过。之后应按需 `getUiTree()`，再执行当前节点动作并重新读取确认。启动不绕过锁屏、登录、广告限制或工作资料策略，不提供应用枚举、多用户选择、深链、外部 Agent 接口或 MCP。需要 Android 7+、ADB shell v2；手机端实际权限和 OEM 行为仍需真机确认。

## 用户：本地网页声音

在连接或开始投屏前，保持 **“转发手机媒体声音”** 勾选。连接后，手机媒体输出由 scrcpy `output` / Android `REMOTE_SUBMIX` 转发到本地网页，手机不再从扬声器或耳机播放被转发的媒体声；电话、铃声、通知和闹钟不在此范围，不修改手机各类音量。不采集麦克风，不录音或保存音频，也不向远端或中继发送音频。

需要 **Android 11+**。Android 11 启动采集前需要先解锁手机，Android 12+ 通常可直接使用；OEM 和应用的受保护音频仍需实测。不支持或采集失败时会明确提示，继续提供视频及输入控制。若网页未能自动播放，点击 **“启用网页声音”**。

点击 **“网页静音”** 只静音本网页，手机媒体声仍处于转发状态；再次启用只播放新的声音，不补播积压音频。停止投屏或断开设备会结束采集，手机恢复原有媒体输出。若希望投屏时仍由手机发声，先停止投屏，取消音频勾选，再开始投屏；不需要重新授权 USB。

本地 USB 音频使用 48 kHz 双声道 16-bit PCM，约 192 KB/s，避免额外编解码；使用 Web Audio 播放。目标调度缓冲 40 ms，排队约超过 120 ms 时丢弃积压并重新同步，不把缓冲值当作端到端延迟。视频和音频各自低延迟播放，当前未加入以音频为主时钟的严格唇形同步，实际同步效果需真机测量。

## 用户：手机息屏继续操作

开始投屏后，在宿主页点击 **“手机息屏（继续投屏）”**。扩展通过 Tango 的 scrcpy 屏幕电源模式关闭手机实体屏幕，继续采集视频；本地浏览器仍可点击、拖动、使用键盘和粘贴文本，已授权远端也可继续操作。点击 **“恢复手机屏幕显示”** 可发送恢复请求。这两个按钮仅管理实体屏幕，不改变远端控制权限；本地画面输入仍按接管规则处理。远端网页不提供修改实体屏幕模式的权限。

此模式不同于按电源键让 Android 休眠或锁屏，也不会绕过解锁。投屏期间启用 scrcpy `stayAwake`，在手机接入 USB 电源时防止超时休眠；停止后由 scrcpy 清理进程恢复原有设置。若手机本来已锁屏、被电源键锁屏或受 OEM 安全策略限制，仍需正常唤醒和解锁；部分设备还需要额外的 USB 调试安全/输入授权。

停止投屏、断开设备和正常关闭会话页时请求恢复正常屏幕模式；只停止远程共享不会改变息屏模式。自动重建编码流会重新应用息屏请求，重建期间可能短暂亮屏；手动停止后再次开始不沿用息屏模式。USB 突然断开或浏览器进程被强制结束时，依赖手机端 scrcpy 清理进程尽力恢复；必要时可用手机实体电源键恢复显示。

页面状态仅表示最近成功发送的请求，不是手机硬件回执；OEM 是否执行、是否真正熄灭面板以及锁屏行为需要真机确认。Redmi K40 的首轮测试使用旧版，尚未验证此功能；再次测试只记录是否灭屏、浏览器画面/操作是否继续以及恢复是否成功，不上传私人画面。

## 用户：远程分享

在本地投屏运行时，填写部署者提供的 HTTPS 中继源地址和“中继创建密钥”，点击“Google 登录并开启共享”，选择自己的 Google 账号。中继地址只接受源地址，例如 `https://share.example.com`，不要添加路径。登录使用独立 Chrome 授权窗口，不会导航离开承载 USB 的宿主标签页。

在远端普通浏览器打开链接，点击“Google 登录并连接”，登录创建共享的同一 Google 账号。登录会跳转至 Google 后返回查看器；不要求远端安装扩展、登录 Chrome 配置或开启 Chrome 同步。仅允许一个当前远端连接，不能分享给其他 Google 账号。

链接只有定位用的 `session`，不包含访问令牌；仅持有链接不能观看或控制。中继验证 Google ID token 的签名、issuer、audience、有效期和 nonce，以稳定的 `sub` 绑定共享归属，不相信客户端自报的邮箱或账号 ID。控制和媒体连接每次加入、重连都必须通过登录与归属校验，没有匿名或旧版链接凭据回退。

**开启共享即授权同账号远端控制，不逐次要求宿主确认；本地输入始终优先。** 远端操作方式与本地一致。宿主接管或取消“允许远端控制”时，远端输入按钮禁用并提示只读，不停止观看；只能等待宿主重新允许。浏览器保留的快捷键可能无法转发。不提供 Shell、文件访问、设备枚举或原始 ADB 代理，也不读取或同步手机剪贴板。

共享默认有效 30 分钟，登录凭据有效 1 小时；不会自动续期。凭据仅保存在页面内存，登录过程的 PKCE 校验材料和一次性回传码短暂保存在当前标签页 `sessionStorage`，消费后删除，刷新后需重新登录。“停止并撤销分享”关闭远端连接、注销宿主本次应用登录并释放按下的触点和按键，本地画面继续播放。设备断开或停止本地视频会结束共享。若宿主离线无法确认撤销，按离线超时结束旧会话。共享期间保持宿主标签页、Chrome 和电脑在线。

## 部署前：配置 Google 登录

1. 在 Google Cloud 配置 OAuth 同意屏幕，创建 **Web application** 类型的 OAuth Client。测试状态下将需要使用的 Google 账号加入测试用户。
2. 将公开中继的 `https://你的域名/auth/callback` 加入 Authorized redirect URIs；本机开发可另外加入 `http://localhost:3000/auth/callback`。地址必须与 `PUBLIC_URL` 完全对应。
3. 把 Client ID 和 Client Secret 分别配置为服务端环境变量 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`。不要写入仓库、插件或查看器，也不要向项目提供真实密钥。
4. 在 `EXTENSION_ORIGINS` 中允许实际安装的扩展 ID。Chrome 授权窗口最后由中继跳转到该扩展的 `chromiumapp.org` 回调；Google 控制台登记的仍是中继的 `/auth/callback`，不是扩展回调。

只请求 `openid`，不请求 Gmail、Drive、Chrome 同步或邮箱权限。服务端用 Google 官方公钥验证 ID token；Google access token 不能直接当作 ID token。OAuth state、nonce、两段 PKCE 校验和一次性登录票据防止回调串用；凭据不进入共享链接或 WebSocket URL。配置缺失时中继启动失败，不降级到匿名访问。

不要公开 OAuth 回调 URL、账号标识、令牌、密钥或完整网络日志；反向代理也应避免记录 `/auth/*` 的查询串和请求体。认证不提供视频端到端加密，中继仍是可信服务。

## 本机开发联调

先完成构建。在中继启动前，从 `chrome://extensions` 复制本次安装的扩展 ID：

```powershell
$env:PUBLIC_URL = "http://localhost:3000"
$env:EXTENSION_ORIGINS = "chrome-extension://你的扩展ID"
$env:GOOGLE_CLIENT_ID = "<Web OAuth Client ID>"
$env:GOOGLE_CLIENT_SECRET = "<仅部署端持有的 Client Secret>"
npm start
```

中继默认监听 `127.0.0.1:3000`，同时提供查看器、`/auth/*`、`/health`、`/ws/control` 和 `/ws/media`。扩展填写 `http://localhost:3000`；本机模式可以不设置创建密钥，但远程共享仍必须配置并完成 Google 登录。HTTP / WS 只允许 localhost / loopback 开发，不能用于跨网络观看。本地 USB 投屏不依赖中继或 Google。

修改查看器时可以运行 `npm run dev:viewer`。此时将中继的 `PUBLIC_URL` 和扩展中的中继地址设为 `http://localhost:5173`，在 Google 控制台另外登记 `http://localhost:5173/auth/callback`；Vite 会把 `/auth`、`/ws` 代理到监听 3000 端口的中继。修改中继后使用 `npm run dev:relay` 重新编译启动；扩展修改后重新构建并在 Chrome 中重新加载。

## 公网部署

由项目开发者部署一个支持 HTTPS 和 WebSocket 长连接的服务，宿主用户不运行本机中继或隧道工具。查看器与两个 WSS 路径须部署在同一源下。

```powershell
$env:PUBLIC_URL = "https://share.example.com"
$env:DEPLOYMENT_TOKEN = "<由部署者生成并妥善分发的创建密钥>"
$env:EXTENSION_ORIGINS = "chrome-extension://已发布或安装的扩展ID"
$env:GOOGLE_CLIENT_ID = "<Web OAuth Client ID>"
$env:GOOGLE_CLIENT_SECRET = "<仅部署端持有的 Client Secret>"
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
  -e GOOGLE_CLIENT_ID="<Web OAuth Client ID>" `
  -e GOOGLE_CLIENT_SECRET="<Client Secret>" `
  tango-share
```

`VIEWER_DIR` 可以覆盖查看器目录。默认内存单实例，不持久化分享；中继重启后旧链接失效。若增加副本，应保证同一分享的两个通道路由到同一实例；当前不提供分布式会话存储。

开发者也可以用 ngrok / Dev Tunnels 将开发中继暴露为 HTTPS，随后把 `PUBLIC_URL` 和扩展里的中继地址改成该 HTTPS 源。隧道仅部署者使用，不能变成宿主用户依赖。

## 协议和延迟策略

| 项目                | 首版固定规则                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 会话通道            | `/ws/control`，版本化 JSON：创建、账号授权、撤销、心跳、状态、重新同步及白名单输入                                    |
| 视频通道            | `/ws/media`，授权完成后转发二进制 Annex-B H.264，不转码                                                               |
| 二进制头            | 52 字节，大端；magic `TNGO`、版本、类型、关键帧位、保留位、16 字节会话 ID、流代次、序号、64 位 PTS、宽高、负载长度    |
| 时间戳              | scrcpy 2.1 原始微秒 PTS，直接传给 `EncodedVideoChunk.timestamp`                                                       |
| 同步                | 新加入 / 重连只缓存当前配置，等待新的关键帧；每次同步增加流代次，拒绝旧代次和序列异常，不重放旧帧                     |
| 静止画面            | 1 秒 I-frame 间隔，设置重复前帧；同步等待 2.5 秒仍无关键帧时重建设备编码流，不撤销分享                                |
| 视频参数            | 最大边长 1280、最高 30 fps、4 Mbps；本地和远端共用同一原始视频配置                                                    |
| 心跳 / 离线         | 每 5 秒心跳及扫描，15 秒离线阈值；正常网络中断检测加会话失效最迟约 40 秒，已观测宿主关闭后通常约 20 秒内结束          |
| 重连                | 0.5 / 1 / 2 / 4 / 4 秒，最多 5 次连续失败；所有重连重新授权，不续期会话或恢复撤销权限                                 |
| 主机 / 中继视频队列 | 2 MiB；超过上限重建视频连接，丢弃整个依赖链，等待配置与新关键帧恢复                                                   |
| 播放器              | 最多 8 个待解码块；积压时重置解码器并等待关键帧；显示只保留最新已解码帧，替换后立即关闭旧 `VideoFrame`                |
| 协议限额            | 单包最多 1 MiB、配置最多 64 KiB、视频每秒最多 4 MiB、JSON 最多 4 KiB；普通请求每 10 秒最多 60 个，输入每秒最多 120 个 |
| 输入隔离            | 每次控制连接签发新控制代次，校验当前画面代次及连续序号；宿主再次校验白名单；输入队列最多 32 条                        |
| 输入优先级          | 本地操作立即接管，远端只读但视频继续；只有宿主能重新允许远端输入，并签发新的控制代次及画面同步                        |
| 按键释放            | 断线、撤销、旋转/重建和失去焦点时释放触点/按键；连续 5 秒无新输入时释放未抬起操作                                     |
| 中继容量            | 默认最多 64 个会话、256 个连接；5 秒内未授权的连接关闭                                                                |

授权在 WebSocket 首条消息中完成，凭据不放在 WebSocket URL。中继检查 Origin、已验证的 Google 账号、会话归属、存活、角色和当前控制连接。只允许触摸、白名单按键、限长文本粘贴和释放输入；旧画面输入会被丢弃并触发重新同步，重复序号被拒绝。登录资料、共享和一次性登录状态均为内存单实例数据，中继重启后失效。

ADB 日志与所有启用的音频流持续读取；本地媒体音频与远端视频通道隔离，不传输麦克风或远端音频。控制通道由 Tango 持续解析，关闭剪贴板自动同步。没有当前共享的有效控制者时，宿主拒绝远程输入。播放器不使用 Canvas 捕获后再编码，Canvas 仅用于显示已解码帧。

## 验证和实测记录

```powershell
npm run typecheck
npm test
npm run format:check
npm run build
npm run test:browser
```

浏览器测试需要本机 Chrome / Chromium。Windows 自动查找 Chrome / Edge，其他安装位置可设置 `$env:CHROME_PATH`。测试使用独立临时浏览器 profile 和随机本机端口，结束后关闭中继、浏览器并清理 profile；需要支持 CDP `Extensions.loadUnpacked` 的现代 Chromium。运行测试的浏览器版本不替代 Chrome 118 下的设备验收。

自动化覆盖实际 WSS 协议路径（本机测试为 WS）、Google 签名/声明及 PKCE 校验、跨账号拒绝、注销、撤销、单控制者、输入回放拒绝、触点/按键释放、加入恢复、过期、流代次、积压恢复，以及 Chrome 真实 H.264 解码/渲染和 MV3 打包加载。设备单测覆盖息屏/恢复命令、息屏时本地与远端输入、编码流重建、失败反馈及退出恢复。浏览器测试另构建一个仅测试用的合成设备会话，运行实际宿主 UI、共享和查看器，覆盖本地免登录点击/拖动/键盘/文本、息屏按钮与失败提示、本地接管、只读视频持续播放、手动恢复远端控制及停止/重开；该替身不进入正式产物。Google 授权响应、临时 RSA 密钥和 H.264 均为测试数据，不代表已接入真实 Google 项目或真实手机。

本地音频自动化还覆盖真实 Web Audio 合成 PCM 输出、静音/恢复、缓冲限制、捕获不可用、停止清理及禁用转发；不验证真实手机面板、扬声器或耳机的状态。新增功能的真实设备和跨网络验收尚未完成。请以如下记录表完成 [需求文档第 7 节](requirements.md) 的硬件验收，不承诺尚未测量的公网延迟或性能提升：

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
- Google 登录失败：检查 OAuth Client 类型、同意屏幕测试用户、`PUBLIC_URL` 对应的精确回调地址及服务端 Client ID/Secret；远端必须选择共享创建者的同一账号。
- 输入暂不可用：等待新画面完成显示；断线、旋转和重新同步期间禁用输入。中文使用文本框粘贴；部分 OEM 还要求在手机开启额外的 USB 调试安全/输入授权。
- 网页没有声音：检查是否启用媒体转发和网页声音、Chrome/Windows 的输出音量及设备是否 Android 11+；Android 11 先解锁再开始。手机音量不能设为零来实现音频转发。若捕获不可用或应用限制捕获，查看页面音频提示；恢复手机发声可停止投屏或停止后禁用音频再开始。
- UI tree 读取失败：先等待画面、正常解锁手机并重试；关闭其他 UiAutomator/Instrumentation 工具。无活动根节点、读取超时及 Android/OEM 隐藏接口不兼容均有独立提示；可关闭 helper 后重新读取，投屏和输入不受影响。
- 已被其他人观看：当前仅一个在线观看者；让已有观看者结束，或撤销后重新建立分享。
- 旧链接无法恢复：会话过期、撤销、宿主超时离线或中继重启后必须使用新链接。

## 参考

- [Tango WebUSB](https://tangoadb.dev/tango/daemon/usb/)
- [Tango scrcpy 启动与输出流要求](https://tangoadb.dev/scrcpy/start-server/)
- [Tango WebCodecs / Annex-B](https://tangoadb.dev/scrcpy/video/web-codecs/)
- [Chrome 扩展 WebUSB](https://developer.chrome.com/docs/extensions/how-to/web-platform/webusb)
- [scrcpy 2.1 发布](https://github.com/Genymobile/scrcpy/releases/tag/v2.1)
