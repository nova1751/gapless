# 原生无缝可行性实查与 Windows 对照

日期：2026-11-14。目标：优先保留网易云原生解码、输出、音质选择与 UI，只增加跨曲无缝。本轮检查 Mac 网易云 3.1.12（3444）、BetterNCM-mac 0.1.7 和当前插件 0.1.4；Windows 对照固定到参考项目的具体提交。

**结论：当前 Mac 的已检查接口不足以安全实现纯原生无缝。底层确有跨曲处理逻辑，但没有找到可验证的插件调用路径。本轮保留现有 0.1.4，不新增内部对象挂钩、隐藏配置或替代播放器。Windows 参考插件也使用 Web Audio 接管；Windows 官方引擎的可用接口仍需该平台单独验证。**

这不是证明所有客户端都没有原生无缝能力，也不是宣布现有 Web Audio 已消除全部卡顿。只读证据见 [native-gapless-capability.json](verification/native-gapless-capability.json)。

## 1. Mac SDK：同名方法不代表原生能力

通过现有 CDP 诊断工具读取正在加载的 SDK 方法体；没有调用播放、暂停、Seek、预加载或设置写入方法。当前页面有 2328 个 Webpack factory，已加载 SDK 位于模块 `4`；模块号仅是本次版本的定位结果，不是跨版本契约。

| 方法 | 实际方法体行为 | 对本需求的含义 |
|---|---|---|
| `AudioPlayer.preLoad` | 空异步实现，没有原生命令 | 调用成功也不会准备下一首 |
| `subscribePreloadInfo` | 返回无动作的退订函数，不注册事件 | 无法靠该 SDK 接收原生下一首资料请求 |
| `setPreloadInfoResult` | 返回 false，没有原生命令 | 前端整理出的下一首资料未交给音频后端 |
| `setRangeConfig` | 空异步实现 | 无法靠该方法控制有效采样范围 |
| `getPlaybackInfo` | 直接返回空对象，没有原生命令 | 不能据此查询设备格式或后端状态 |
| `play` | 注册 Load 回调 → `audioplayer.load` → 成功后 `audioplayer.play` | 是当前曲目的装载/播放流程，没有观察到下一首预约入口 |

共享前端的模块 `100` 已包含根据 `curPlayId`、`preloadIndex`、原生队列及当前音质准备下一首资料的流程；模块 `129` 订阅预加载通知。但上述 Mac SDK 入口为空实现，所以这段前端代码不能单独构成原生无缝。播放遥测里的 `gapless: "false"` 也不能当成配置开关。

SDK 的 `Storage` 提供缓存查询、缓存容量配置和缓存更新通知；`Library`、`Bridge` 的已检查接口没有发现下一首音频准备/调度方法。命中原生文件缓存有机会减少 I/O 等待，但并不保证下一条解码管线已准备好，也不保证跨曲持续输出。不能把额外下载或提前 `load` 当前播放器称为原生无缝。

## 2. 原生二进制：跨曲逻辑存在，入口尚未连通

只读检查 `/Applications/NeteaseMusic.app/Contents/MacOS/NeteaseMusic` 的 Objective-C 元数据和 arm64 离线反汇编；没有附加运行中进程、修改可执行文件或读取原生实例内存。文件 SHA-256 为 `e9c6b5468749ccad69ffe24e6395d6d29af9e2f7514a2bc9697e265b89b40374`。

| 位置 | 静态证据 | 结论边界 |
|---|---|---|
| `NTESAudioStreamer.gaplessEnable` / `setGaplessEnable:` | getter `0x1003785dc` 和 setter `0x1003785e4` 读写偏移 `0x59` 的布尔字段 | 真实内部属性，不是仅有名字的常量 |
| `NTESAudioRunLoop.handleEvent:streamer:userInfo:` | `0x100375b3c`、`0x100375b48` 检查两个 streamer 的 gapless 属性，再检查新 streamer 状态，进入跨流切换分支 | 存在涉及当前/下一条流的逻辑，不能仅解释为单文件编码填充 |
| `NTESAudioRunLoop.handleStreamer:` | `0x100376524` 检查 gapless 后进入不同的完成/输出等待路径 | 输出排空与切换行为受该属性影响；未证明端到端队列准备可用 |
| `initWithAudioProvider:` | 检查到的初始化方法未写 gapless 布尔字段 | 不能据此确认运行中实例状态或排除其他初始化路径 |
| `NTESAudioABTestDefinition.inAudioGaplessFixAbTest` | 当前二进制方法直接返回 false | 是名为 gapless fix 的实验分支；不能当成整个 gapless 的启用开关 |

在检查的常见 selector/stub 引用与直接调用中没有找到 gapless setter 调用；动态 selector、KVC、直接字段写入等途径仍未排除。已发现的 Mac `audioplayer` 桥命令有 load/play/pause/seek 等控制，没有发现可验证的下一首预准备、预约或 gapless 设置命令。

本机配置中心未包含精确键 `preload#audioServiceHelperConfig`；两个只读 `app.getLocalConfig` 探针返回空字符串，存储命名空间/键的映射未确认。这些结果不能证明不存在隐藏配置，也不能把带 audio service 的配置名解释成 gapless 开关。没有写配置或改动用户的原生 `playFade`。

仅把内部 gapless 字段改成 true，仍没有解决下一首 streamer 的创建、同音质授权资料、提前解码就绪、原生队列关联和撤销时序。要继续尝试，需要增加对私有音频对象/线程的挂钩及版本维护；现阶段不能证明比当前方案副作用更小，因此本轮没有实施。

## 3. Windows 参考插件实际怎么做

2026-11-14 通过 GitHub API 再次确认 `AntsandIce/NcmGaplessPlayer` 的 `ncm-3x` 分支 HEAD 为 `87e444c4599aac97f4a0de74421cea7853bbf1bc`，清单版本 1.20.0；以下按该固定源码核对，不把作者注释中的实测数值当成本仓库 Windows 验收结果。

| 环节 | 参考源码的实际行为 | 本项目取舍 |
|---|---|---|
| 原生接入 | 捕获 `channel.call`，记录 JS 事件注册器，代发 Load/进度/播放状态 | 是私有协议适配，并非官方原生无缝接口 |
| 当前曲目接管 | 推算原生位置、启动自建音源，然后调用原生 pause | 存在两后端交接，不能称为只做预加载 |
| 已解码下一首 | 用同一 AudioContext 的 `AudioBufferSourceNode.start` 提前预约下一首 | 可参考采样时钟；保持纯衔接，不复制混音/入点处理 |
| 下一首未准备好 | 双 `<audio>` 元素预开/流式后备 | 是另一个播放后端；不能保证与缓冲预约同等准确 |
| 原生网络 | `network.fetch` 返回音源/文件字节，再进入自建播放链 | 原生网络请求不等于原生解码和输出 |
| 音源兜底 | 3.x 请求失败时尝试固定 320k，再尝试 128k outer URL | 不符合保持网易云当前音质的要求，本项目不复制 |
| 额外功能 | 响度处理、拍点/拉伸/交叉、分析与磁盘缓存、独立设置面板 | 本项目不移植这些功能 |

固定源码入口：[接管当前曲目](https://github.com/AntsandIce/NcmGaplessPlayer/blob/87e444c4599aac97f4a0de74421cea7853bbf1bc/src/main.js#L2066-L2146)、[缓冲预约](https://github.com/AntsandIce/NcmGaplessPlayer/blob/87e444c4599aac97f4a0de74421cea7853bbf1bc/src/main.js#L3670-L3733)、[码率后备路径](https://github.com/AntsandIce/NcmGaplessPlayer/blob/87e444c4599aac97f4a0de74421cea7853bbf1bc/src/main.js#L2418-L2461)、[原生暂停与命令处理](https://github.com/AntsandIce/NcmGaplessPlayer/blob/87e444c4599aac97f4a0de74421cea7853bbf1bc/src/main.js#L9432-L9598)、[事件注册](https://github.com/AntsandIce/NcmGaplessPlayer/blob/87e444c4599aac97f4a0de74421cea7853bbf1bc/src/startup_script.js)。

## 4. Windows 原生路线还缺哪些证据

Windows 的 SDK 方法体、桥实现和音频后端与 Mac 不能相互推断。在实际客户端先确认：下一首预准备请求与完成事件、权威下一首/实例标识、用户音质授权、持续输出，以及 Seek/暂停/手动切歌后的撤销。通过这些条件时，只需要薄适配和已有宿主开关；无需复制 Web Audio 接管核心。

查到的 BetterNCM-v3 候选宿主声明支持网易云 3.1.41.205529，但没有在本机 Windows 验证。其 `native-commands.json` 来自限定命名空间的字符串扫描，扫描器白名单没有 `audioplayer`，所以目录里缺少预加载命令不能作为否定证据。其发行包包含主题/歌词插件，使用时也必须按本项目范围精简。[固定宿主源码](https://github.com/Leafmy/BetterNCM-v3/tree/438dddf6d6b6b6e75db2715828f47cb9a7a71446)、[原生桥文档](https://github.com/Leafmy/BetterNCM-v3/blob/438dddf6d6b6b6e75db2715828f47cb9a7a71446/docs/03-native-bridge.md)、[扫描范围](https://github.com/Leafmy/BetterNCM-v3/blob/438dddf6d6b6b6e75db2715828f47cb9a7a71446/tools/analyze_bundle.py#L32-L41)

另检查了 open-orpheus 的音频桥实现：它是独立宿主/播放器，已读音频模块没有提供可复用到官方客户端的 gapless/preload 协议证据；不能把换成这个宿主当成保留网易云原生输出。[项目说明](https://github.com/YUCLing/open-orpheus/tree/deee97667e522ee3bfdca24abbe044ba4aaf8f35)、[音频桥实现](https://github.com/YUCLing/open-orpheus/blob/deee97667e522ee3bfdca24abbe044ba4aaf8f35/src/preload/calls/audioplayer.ts)

Windows 实施方案已更新为原生检查优先：能力通过则薄适配；无法获得原生协议时再评估已有 Web Audio 方案。没有 Windows 实机意味着本轮不能宣布其原生能力可用/不可用，也不能交付假装已验收的安装包。详见 [方案 v7](WINDOWS_GAPLESS_IMPLEMENTATION.md)。

## 5. 本轮交付与运行影响

交付技术路线报告、原生可行性证据和 Windows 方案 v7，修正原先把 Mac `getPlaybackInfo` 描述为由暂停后端回答的表述。播放源码、0.1.4 安装包、音质/音效/音量配置和页面样式没有变更；检查前后仍启用插件、拥有同一暂停播放状态，解码持有量不变，新增预留和任务均为零。

未新增测试用例，未执行全仓 lint/TypeScript 检查或应用构建。完成只读 SDK/二进制核对、固定上游源码对照、文档链接和增量提交检查。没有新声卡回录或新播放场景验收，现有首次后端交接与听感卡顿限制继续保留。
