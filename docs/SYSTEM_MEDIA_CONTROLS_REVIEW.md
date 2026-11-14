# macOS 系统媒体控制与 Seek 修正

> 当前系统控制与会话生命周期修正见 [0.1.8 记录](SYSTEM_SYNC_0.1.8.md)。以下保留历史排查结论与各自验收范围。

日期：2026-11-14。网易云 3.1.12（3444），BetterNCM-mac 0.1.7。这是 0.1.5 实验及原生对照的历史记录。0.1.6 已恢复无缝核心；后续 0.1.7 接入最小系统同步并修正系统 Seek，用户确认常规按钮与声音一致，但拖动时按钮闪烁仍未解决。最新结果见 [0.1.7 同步记录](SYSTEM_SYNC_0.1.7.md)。

## 确认的副作用与接口机制

0.1.4 在 Web Audio 接管前暂停原生后端，JS 播放状态不能更新 macOS Now Playing 状态。原生 `YYYTouchBarManager.updateNowPlayingCenter:status:` 依据 streamer 更新播放速率和 `MPNowPlayingInfoCenter.playbackState`。Mac SDK 的 `setMiniPlayerState`、`setSMTCEnable` 是空实现，旧版 `player.play` 会真实启动原生音频，不能用于修图标。

用户已确认全零 HTMLAudio 探针的标题及暂停按钮出现在控制中心。这证明该客户端的 Chromium Media Session 确实能发布系统媒体状态；只赋值 playbackState 而没有持久媒体播放器，不足以建立可控制会话。

第一轮真实播放探针保留原生系统命令，同时注册 Media Session Seek。日志中一次拖动出现两次近似 Seek，间隔约 8–12 ms。离线读取原生 `YYYHotKeyManager.seekWithEvent:` 证实系统 Seek 直接调用原生播放管理器 `setCurrentTime:`，绕过插件 SDK 拦截，因而可能覆盖真实 Web Audio 进度。原生 Now Playing 及 Chromium 写入同一系统信息中心，不能假定双写安全。

## 原生对照结果

用户确认：关闭无缝插件并重启网易云后，macOS 控制中心拖动进度仍会回跳。检查确认 `gaplessMac` 未注入、Media Session 为 none；复查时 BetterNCM 环境仍在。见 [原生对照记录](verification/mac-native-baseline.json)。

因此，回跳不是无缝插件独有，不能把两轮候选中的全部回跳归因于插件或双写。这个对照也不能证明插件完全没有增加回跳的次数或幅度；没有做等条件定量比较。尚未区分网易云客户端、BetterNCM 宿主与 macOS 系统同步各自的影响。

插件接管后系统显示暂停，是另一项仍未解决的兼容问题；原生也会回跳不能豁免它。seek 主动插入 10 ms 空档及旧曲目回调污染则属于可收窄的插件问题，仓库源码保留相应修正。为保持仅增加无缝衔接的范围，已撤回无效的系统进度纠偏，不继续扩展计时器或修改系统面板。

## 本轮保留的源码修正

- 播放中的 SDK Seek 在同一时刻启动新节点、停止旧节点，移除旧实现主动插入的 10 ms 空档。旧节点退出单独释放资源引用，不触发歌曲结束；停止、关闭同时清理待退出节点，累计听音不计入尚未播放的时间。
- 旧节点停止失败时，撤销新节点且保留旧轨道记录，再交给已有桥异常恢复流程处理，避免继续播放两个音乐节点。该异常分支经代码检查，未在实机注入故障。
- 插件拥有播放时过滤所有原生播放状态、进度、结束及 Seek 回调，包含已停放的旧曲目。原生事务等待器仍先收到事件；切歌 Load 切回非接管实例，原生恢复等待器不会被该过滤阻断。接管的 JS 播放事件使用 resume token。

这些 0.1.6 修正保护音频时钟和前端回调，不拦截原生系统信息中心写入，不宣称能消除 macOS 控制中心回跳。0.1.6 未加入媒体载体；0.1.7 后续接入最小载体同步，但仍没有反复系统进度纠偏或新的界面样式。

## 已撤回的系统媒体方案

- 音乐继续使用原有单一 Web Audio 时钟。约 128 KiB 的全零载体仅建立系统会话，不接收音乐或修改其增益、采样率、音源和音质设置。
- 不修改媒体键偏好及原生系统传输命令。`setUseMediaKey(false)` 实际只关闭 SPMediaKey/Mikeys 监听，不能注销 MPRemoteCommandCenter Seek；第一候选使用它的方案已撤销。
- Media Session 对播放、暂停、前后切歌只观察，不再发第二条传输命令。这些动作保留网易云原生处理，避免与其切换/队列操作重复执行。
- 系统拖动立即回报目标并发 Seek，80 ms 内相差不足 20 ms 的重复目标只执行一次；一次只保留一个 SDK 请求。等待请求时不发布旧时钟位置。Seek 后 350 ms 内收到原生进度事件时，重新发布真实时钟位置。此项是有限纠偏，不能阻止原生内部写系统卡片；实测未消除回跳，已撤回。
- API/载体启动失败时恢复原生；禁用、恢复及页面退出清理会话。没有增加 CSS、歌词布局、质量选择或 DSP。

## 取得的证据与失败结论

| 检查 | 结果 | 材料 |
|---|---|---|
| 播放中 SDK Seek，115.8 → 70 秒 | 进度连续推进，始终 playing；上下文代次不变；节点引用回收；听音仅增加真实经过时间 | [Seek 数据](verification/mac-seek-0.1.5.json) |
| 同一路径连续 pause/pause/play | 第二次 pause 不增加控制代次；暂停零节点，恢复同一上下文、当前与预约各一节点 | [分发数据](verification/mac-system-dispatch-0.1.5.json) |
| 两个近似系统动作 150.005 → 150 秒 | 仅一个音频 Seek；目标完成后不残留 pending | 同上 |
| Baptized In Fear → Open Hearts | 预约间隔 0 帧；接认约 222 ms，未重启音频；JS 媒体标题同步 Open Hearts | [跨曲数据](verification/mac-boundary-system-0.1.5.json) |
| 网易云 UI | 原生按钮、样式保持；本轮未加入 CSS | 界面观察与增量差异检查 |
| macOS 控制中心实际手势、按钮与听感 | 两轮候选仍有回跳，未实现消除目标；原生对照也复现，不能据此判定全部由插件新增 | [原生对照](verification/mac-native-baseline.json) |

上述数据来自第一份 0.1.5 候选代码。用户随后在控制中心仍观察到回跳，故该候选未通过；两次近似 Seek 已合并，不能据此认定系统显示问题解决。即时回报目标及短时纠偏也被用户确认仍有回跳，已停止采用。该媒体实验未进入 0.1.6；0.1.7 另行接入精简同步层，不包含旧版纠偏计时器。曾做候选的实机协议操作及 ZIP 完整性检查；0.1.6 增量经 JS 语法、回调顺序、资源引用和异常恢复代码检查。未新增测试、运行全量 lint/tsc 或应用构建。

提交 `9eb19c4` 仅更新了源码、审查报告和四份必要诊断数据，没有同步安装包；当时本机插件仍关闭。后续 0.1.6 已将这些源码修正打包并重新启用，0.1.7 再加入精简系统同步。旧的 0.1.5 候选包和纠偏实现不进入生产包。源码审查通过不等于原生媒体兼容或声卡输出验收通过。

**仍须验证的原生双写边界：** 注销系统命令不会禁用原生 Now Playing 更新。离线检查 `reloadNowPlayingCenter` 仍会读取原生 currentTime/currentStatus 并调用状态更新；原生 `player.setInfo` 也会刷新该路径。控制中心跨曲后是否仍被覆盖、暂停时进度是否冻结、释放后原生媒体键是否恢复，需要实际面板确认。没有用反复暂停/恢复音乐或强行启动原生来修显示，也没有宣称仅能影响加载而其他特性完全等价。

Chromium 依据：[会话控制与音频焦点](https://chromium.googlesource.com/chromium/src/+/refs/tags/120.0.6099.109/content/browser/media/session/media_session_impl.cc)、[系统通知](https://chromium.googlesource.com/chromium/src/+/refs/tags/120.0.6099.109/content/browser/media/system_media_controls_notifier.cc)、[macOS 命令处理](https://chromium.googlesource.com/chromium/src/+/refs/tags/120.0.6099.109/components/system_media_controls/mac/remote_command_center_delegate_cocoa.mm)。这些是调研版本的源码，不能代替网易云定制 CEF 的最终实测。

## 历史诊断事故

早期临时恢复脚本未先核对 Seek 契约，错误字段导致原生参数越界退出；已恢复客户端。它不是安装包产生的调用。后续 Seek 已核对为 `{playId, seekId, value}`；不提交 profile、签名 URL、音频或用户崩溃文件。

## 后续所需的原生能力

`setUseMediaKey` 不能注销系统 Seek；`player.setCurrentPlay` 在此客户端的原生处理器只回调完成，未提供独立状态发布。没有发现已核对且可供插件调用的原生系统状态接口。JS 侧过滤只能保护前端回调，无法拦住原生 `MPNowPlayingInfoCenter` 写入，所以不再叠加纠偏计时器。

若继续采用 Web Audio 出声，原生桥至少需要：在原进程独立发布 Now Playing 播放状态与真实进度；让系统 Seek 路由至实际播放所有者；接管和释放时可靠协调原生 MPRemoteCommandCenter 处理器。这样才有条件消除双写，不应通过启动第二条音乐音频流来伪装修复。当前宿主没有这些已验证的能力；原生跨曲预准备问题另见原生可行性报告。

原生音频后端的手动对照已完成：同样回跳。该显示现象不是插件专属缺陷，不能以此停用用户需要的无缝核心。0.1.6 已恢复无缝功能并包含 seek 修正；系统暂停状态兼容仍待处理，没有把这项对照当作整个无缝方案通过验收。
