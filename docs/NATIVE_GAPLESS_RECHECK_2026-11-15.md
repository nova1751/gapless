# 纯原生无缝路线复查

日期：2026-11-15。检查对象：本机网易云 Mac 3.1.12（3444）arm64、已安装 BetterNCM-mac 0.1.7；播放插件仍为 0.2.3。此次只读取 SDK 方法、宿主源码和离线原生反汇编，没有附加进程、调用私有播放方法、安装原生模块或调整播放配置。

**结论：网易云原生引擎具备有条件复用输出的跨曲逻辑，纯原生方案值得做验证原型。但当前 Mac SDK 和插件宿主没有把这条能力开放出来，不能仅修改现有 JS 插件或打开隐藏布尔字段就交付原生无缝。原生独立预加载、跨曲提交及管理器接认尚未验证。**

这次新增的关键证据是：`prepareToPlay` 会切换当前流，而真正保留输出的分支同时检查流状态、输出格式及内部策略。此前的[可行性报告](NATIVE_GAPLESS_FEASIBILITY.md)保留为 0.1.4 时的历史记录；本次结构化证据见 [native-gapless-recheck-2026-11-15.json](verification/native-gapless-recheck-2026-11-15.json)。

## 实查到的调用关系

原生可执行文件 SHA-256：`e9c6b5468749ccad69ffe24e6395d6d29af9e2f7514a2bc9697e265b89b40374`。以下地址为该文件 arm64 切片的静态地址，不能用作其他版本或运行中未经 ASLR 解析的地址。

| 位置 | 本次证据 | 能确定什么 |
|---|---|---|
| `YYYPlayManager.setPlayLoadModel:`，`0x1001522d4` | 移除旧 streamer 的观察、释放管理器持有的旧 streamer，更新播放模型；按源创建新 streamer、配置 effector/tempoer，并调用 `prepareToPlay`（`0x100153190`） | 这是装载当前曲目的流程，不能直接当后台下一首准备方法 |
| `NTESAudioStreamer.prepareToPlay`，`0x100377b30` | 线程已就绪时查询共享 runLoop 的 streamer；不是自身则调用 `setStreamer:`（`0x100377ba0`） | 提前对下一首调用此方法会进入当前流切换，不能视为独立预加载 |
| `NTESAudioRunLoop.setStreamer:`，`0x100376da0` | 变更共享当前 streamer、设置 switching 并发事件；另有 crossfade 分支 | 切流是原生受控操作；不能靠两个原生实例各自 Play 实现无缝。本方案不启用 crossfade |
| `NTESAudioRunLoop.makeStreamerFinish:`，`0x100375f50` | 清理 provider 并将传入 streamer 的状态设为 `4` | 可解释下面切换分支检查的完成状态；它不是“下一首已准备”状态 |
| `handleEvent:streamer:userInfo:`，`0x100375b38–0x100375c34` | 检查共享当前流和事件携带流的 `gaplessEnable`，以及事件携带流状态 `4`；还检查 `avoidMutexWaitingWhenSwitching`。满足其中一条路径时跳过输出 `stop:`，设置 `_shouldGapless`（偏移 `0xda`） | 确有避免停止输出的原生分支；不是无条件保证跨曲连续，也不能仅凭两个变量名断定当前/下一首事件身份 |
| `resetPlayerWithStreamer:pcmFormat:bufferSize:`，`0x100374694` | 复用分支检查 render API、输出已初始化和 `_shouldGapless`；再比较 `ASBD:equalToASBD:`（`0x1003748b8`）、声道布局（`0x1003748e8`）及 bufferSize（`0x100374904`）。通过后跳过 `resetPlayerWithOutputFormat:bufferSize:channelLayout:`，沿用输出并调用原有 `resetVolume` | 保留的是同一原生输出，条件比仅同采样率更严格；不匹配会进入正常输出重建 |

`_shouldGapless` 是运行循环根据事件路径写入的状态，不能把它强制保持为 true；这样可能把不兼容格式误判为可复用。`gaplessEnable` getter/setter 的存在，也不代表上层已经实现独立下一首预加载。

原生 `NTESAudioDecoder` 有元数据、解码、缓冲和就绪相关方法；这仅提供下一步调查方向。本轮没有证明它能在原 provider/decoder 线程调度中独立预热下一首，更没有证明预热后的缓冲能被管理器接认。基础 `NTESAudioProvider` 的 `loadData` / `prepareToProvide` 方法进入共同辅助函数；需要进一步查实际使用的 provider 子类，不能将基础类方法当可用预加载 API。

## 为什么现有插件还不能直接使用

重新读取正在运行页面的 `AudioPlayer` 方法体：`preLoad` 和 `setRangeConfig` 仍为空异步实现，`subscribePreloadInfo` 返回空退订函数，`setPreloadInfoResult` 返回 false，`getPlaybackInfo` 返回空对象。此次没有调用这些方法，仅读取函数体。原有 SDK 的 Load/Play 工作流不能保持当前曲目播放并独立准备第二首。

本机宿主 `src/plugins.mjs:234` 忽略 manifest 的 `native_plugin`；`src/server.mjs:337–340` 的原生插件 API 枚举返回空列表、调用直接报错。上游 HEAD `b3e3ab89c4e368c41b984453bd79a599f270f2c8` 也保持相同限制：[插件加载器](https://github.com/OyangDer/betterncm-mac/blob/b3e3ab89c4e368c41b984453bd79a599f270f2c8/src/plugins.mjs#L216)、[原生插件桥](https://github.com/OyangDer/betterncm-mac/blob/b3e3ab89c4e368c41b984453bd79a599f270f2c8/src/server.mjs#L315-L318)。普通 CDP / 外部 Node 代码不能直接操作网易云主进程里的 Objective-C 音频实例。

因此阻力是**缺少可调用的原生入口和生命周期适配**，不是原生音频技术无法无缝。继续实现需要在拥有原生音频对象的进程中增加受限桥接模块；仅在外部启动另一个 AVAudioPlayer/AVAudioEngine，仍会换输出与播放状态所有者，不符合保留网易云原生后端的目标。

原生接入也不自动意味着风险更小：私有方法签名、线程或对象生命周期处理错误可能影响整个客户端；更新后必须重新验证。它的优势是有机会保留原音频链和状态来源，代价是更深的原生适配与维护。优先寻找可用原生协议；需要私有挂钩时限制范围、绑定已验证版本并保留完整撤销，不把固定内存地址写入通用插件。

## 最小原生实现路线

以下为设计契约，不是已经存在的接口或实现。先证明能复用原生后端，再决定是否替换 0.2.3。

1. **只读原生能力探针。** 增加可撤销的主进程桥，核对类/方法签名、对象身份、线程归属、输出规格和活动流；不在音频回调中执行 JS、网络、磁盘访问或同步跨进程等待。未知版本与能力不齐时停用适配，不猜测字段偏移。
2. **独立准备下一首。** 通过网易云原有源选择与 provider 工厂复用授权、音质、下载/缓存、加密和解码逻辑。原生层持有候选 provider/decoder 与有界缓冲；不得调用会切换当前流的 `prepareToPlay`，不得提前更新当前曲名或系统状态。确认预热不会覆盖原有全局解码/输出状态；若做不到，继续补上原生调度入口，不能伪称完成。
3. **同一输出提交边界。** 候选已经可持续产出音频、队列和源身份仍有效，且原生输出规格兼容时，在原生音频调度流程完成上一首有效 PCM 尾部 → 下一首首部。验证能真正进入跳过 Stop/输出重建的路径；不得依赖 JS End 回调后才 Load，也不得靠音量重叠或静音裁剪制造听感。
4. **接回原管理器。** 保持 `YYYPlayManager`、播放模型和已预热实例一致，避免普通 Load 流程再次创建/替换已准备实例。区分音频提交边界与已到达设备输出的曲目边界；按原有事件语义更新曲名、歌词、PCM 视觉输入、时间与听音统计，防止 UI 过早跳曲或队列推进两次。系统控制始终作用于同一原生播放器，不增加 Web 或静音系统会话。
5. **取消与回退。** 暂停、Seek、手动前后切歌、队列/音质变化、设备切换、休眠及关闭开关都复核实例和代次；释放过期候选。下一首未就绪、格式不兼容或原生能力不满足时，让客户端正常切歌，允许间隔，不改变用户音质、音效或播放意图。不能以避免间隔为由强制统一输出格式。

若这条路线验证成功，音乐解码、音效、输出及播放状态都沿用原后端，可移除 Web 音乐时钟、频谱 PCM 代发和第二个系统发布者，减少目前因替换后端而产生的兼容适配。**这是预期收益，尚非本机验证结果。** 原生客户端自身的控制中心 Seek 回跳已有独立对照复现，换成纯原生并不自动修复它；原生固有重采样/输出处理也仍然存在，不能额外承诺 bit-perfect。

## 原型怎样算通过

首个原型只覆盖原有顺序队列、相同输出规格、同质量授权的两首歌。用 Baptized In Fear → Open Hearts 等连续作品验证：下一首准备期间当前输出不变；跨曲未 Stop/重建；原生真实输出没有新增零样本段、重复/丢失片段；曲名、歌词、频谱及系统控件只推进一次，并可正常 Seek、暂停/继续、前后切歌。

先取得应用输出及原生流/格式事件的联合证据，再比较完全原生基线。静态分支、定时器预约、缓存命中或“没听到间隔”都不能单独证明有效采样连续；作品本身的留白应保留。随后覆盖取消、失败、格式变化与设备事件，确认卸载/关闭恢复。

本轮完成的是离线入口追踪和 SDK/宿主能力复查；没有原生桥原型、真实原生跨曲回录或新播放验收。未新增测试、未执行应用构建及全量静态检查；现有播放器源码和安装包不变。

## Windows 对应路线

Windows 可复用上述职责、候选生命周期与验收条件，不能复制 Mac 私有类/地址/线程。先查实际客户端的 preload 请求/就绪事件及输出持续能力，通过后做薄适配。

若需要 DLL 桥，必须确认宿主能加载到拥有音频对象的进程，以及当前客户端 ABI/线程契约。[官方原生插件 Rust 绑定](https://github.com/BetterNCM/betterncm-native-plugin-rs/tree/764b38155a31518560e9dc346c75d4527f9dde37)证明生态存在 DLL 注册机制，不证明它支持用户当前 3.x 或已经开放无缝播放。此前候选 [Leafmy/BetterNCM-v3](https://github.com/Leafmy/BetterNCM-v3/blob/438dddf6d6b6b6e75db2715828f47cb9a7a71446/README.md)仍声明 `native_plugin` 未实现，不能把该 CDP 宿主当现成原生桥。

原生能力通过时使用原生方案；[持续 Web 方案 v14](WINDOWS_CONTINUOUS_WEB_AUDIO.md)作为另一条已整理的适配设计继续保留。Windows 尚无本仓适配器、安装包或实机验收。
