# Windows 0.4.8 修复与验收方案

2026-11-16。对应 Mac 0.3.6。本轮不操作 Windows 机器，也不把 Mac 的播放结果写成 Windows 已验收。目标是完善既有实现：网易云负责授权、音源、原生持久缓存与队列，Web Audio 用同一时钟连续输出，插件只保留有界工作缓冲。[两端检查及 Mac 实测](CORE_PLAYBACK_AUDIT_0.3.6_0.4.8.md)。

## 可直接使用的源码修正

| 文件/入口 | 0.4.8 状态 | Windows 复验重点 |
|---|---|---|
| windows/player.js / recover | 第一处 await 前创建 recoverySeeks、queuedTransport；等待后复核 current/restoring；旧回退不清理新曲任务 | 原生准备/恢复音量等待中连续 Seek、暂停、换曲，只执行最新意图 |
| windows/player.js / seekWhenReady | 暂停位置 PCM 被淘汰时先补读再播放；恢复不伪造 Seek；真实失败按最新 Play 意图回原生 | 长暂停/内存淘汰后恢复；等待中暂停或再次 Seek 不出旧位置声音 |
| windows/streaming.js + player onState | stream-failed 带 failedTrack；下一首故障只取消候选 | 候选失败不能停当前曲，当前曲失败仍能恢复原生 |
| shared/playback-clock.js / setVolume | 用户音量变化 5 ms 参数自动化；同值不重置；保留预约输出门 | 当前 CEF 的 cancelAndHoldAtTime 支持、快速拉音量、静态音量及输出门时刻 |

无需再复制 Mac 的上一首缓冲和两秒门槛：Windows player.js 已有 recentEntry、abandon(keepWarm)、内存压力释放重试，以及 seekBufferSeconds(native-source)=2。继续保留 128 MiB 单个暖资源上限、原有总预算、索引 PCM 每首 32 MiB 和编码共享 64 MiB。实际进程峰值还包括 Chromium/解码器，不能只看资源预算。

## 还需在 Windows 落地的有限改进

1. **分段计时。** 在 loadOwned 记录源解析/缓存命中、目标 PCM、上下文、原生输出门的耗时；跟首次 clock.start 记录 outputWallTime(start)−loadStart。通过 player.js 的健康诊断白名单仅导出必要字段；首次出声后清理计时值，加载中主动暂停不算入性能样本。另记宿主 Stop、Load 收到时间，以单独暴露手动选曲 Stop→Load 等待。不把它算为自然曲间空隙。
2. **清缓存失败仍保留最短等待。** 当前 windows/native-cache.js / settleStoppedWrites 正常路径已有 500 ms 总等待、250 ms 稳定窗口和两秒截止，观察原生 .idx/.info。player.js / cacheClearRequested 对异常直接继续转发：捕获开始时间，失败后补足 500 ms，再按现有流程转交原生清理；继续阻止辅助取数直到真实 onclearcache 或既有超时。无需照搬 Mac 的文件命名，不新增 .info 写入、永久缓存或 flush 伪确认。
3. **真实 Seek 故障归类。** seekWhenReady 目前 resume 故障可回原生，普通 Seek 失败主要回复失败。若 Windows 实测发现目标位置失败后声音滞留，增加 request.failureKind，区分主动取消/替代/换曲和超时/源错误。仅当前请求的真实故障进入 recover，明确携带 target，初始化 recoverySeeks 时保留目标；后续用户 Seek/暂停优先。取消不回退、不发旧 PlayState，SDK 接受的每个 Seek 只完成一次。先确认宿主原生目标 Seek 能完成再启用此分支。
4. **系统控制保持平台适配。** 继续沿用已验证的网易云/BetterNCM Windows 媒体键与状态桥。Mac 静音 MediaSession 载体不能直接复制到 Windows：已有宿主 SMTC 曾不提供 timeline/Seek。先实测 play/pause、前后切歌及实际 Seek 能力；没有宿主接口则明确禁用/说明能力，不伪造可拖时间线，不引入第二个竞争状态发布者。

不为降低手动等待更换音源、降低采样率、取消有效区间校验或延长无限重试。保留同率连续预约、异率在旧曲结束后重建输出。不要在前台首次播放时强制等整首缓存，也不以播放辅助音乐来取数。

## 安装与日常验收顺序

只支持当前已适配的网易云 Windows x64 3.1.43.205627 / BetterNCM 1.3.4。先确认客户端精确版本、保存当前曲目/位置/播放意图，旧插件放在启用目录之外。使用仓库 ZIP 打包入口，不执行应用构建：

```powershell
python windows/package.py --client "C:\Program Files\NetEase\CloudMusic\package\orpheus.ntpk"
```

默认产物 `dist/gapless-player-windows-0.4.8.plugin`；保持默认原生数据源，不使用旧 `--web-source` 替代。仅启用一个 slug，重启后核对 manifest、运行文件 hash 和 status 版本/nativeSourceMode。

| 日常场景 | 通过条件与证据 |
|---|---|
| 起播和手动前后选曲 | 分别记录内存命中、原生磁盘命中、无缓存三种情况；报告资源准备和输出预计时间，宿主 Stop→Load 单列。暖缓存与原生对照后再决定是否需要进一步优化 |
| 暂停恢复/加载中暂停 | 等待结束仍保持暂停，不偷偷 Play；恢复只在有效目标 PCM 已备妥时出声 |
| 连续 Seek、等待中换曲 | 最新位置/歌曲获胜，旧 Promise 不取消新控制器、不 Load 旧曲；每个接受的 SDK 请求都完成 |
| Baptized In Fear→Open Hearts 自然跨曲 | 提前准备、预约 0 帧；应用输出回录边界前后各一秒，无新增静音/PTS 缺口；原歌词/频谱随实际输出时钟更新。界面接认耗时单列 |
| 候选失败与当前失败 | 候选失败保留当前声音；当前真实失败回到同一授权源/目标位置、最新暂停状态，无第二路音乐 |
| 音量与音质 | 5 ms 平滑不改变静态增益；原生源/PCM/context 同采样率和声道，16/24-bit 源取数不降档；关闭后恢复原生保存设置。原生/Web 做等响度输出对照，不把共同解码证据当设备逐位一致 |
| 原生缓存/关闭 | 缺口取数串行且无辅助 Play，前台 Seek 优先；索引有效区间命中、正常退出重启复用；清理/关闭后旧任务取消，原生控制、音量、曲目/位置和右上角开关样式正常 |

每类只做有限日常样本，不新增仓库测试、不执行全量 lint/tsc；改动 JS 用 Node 18 做局部语法检查。无需为上述验收删除全部用户缓存，可使用已知未缓存源并单独记录索引有效区间。

出现第二路声音、暂停意图丢失、旧 Seek 覆盖新位置、PCM/源采样率不符或控件失效时不推广候选：关闭无缝恢复原生，移走新包、恢复旧包，再复核用户曲目/位置/音量/播放意图。未通过的系统功能明示限制。真正的主线程长阻塞、设备切换及弱网仍可能欠载；若日常记录证明调度问题，再单独评估音频 Worker/AudioWorklet，先验证当前 CEF 和宿主通道，不修改 CSP 或安全策略。
