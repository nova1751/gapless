# Windows 无缝播放 0.4.10 源码 / 0.4.9 已安装

最新 `main` 的 Windows 0.4.9 已安装 `95e57ff`，运行文件与包一致，分段计时、前后切歌及曲尾 Seek 后跨曲有日常 UI/日志记录。0.4.10 修正独立解码验证后仍以两首规格不相同而丢弃下一首的门槛：位深/声道不同不再拒绝预取，同率可预约，异率保留资源等待输出重建。新修正仅有实际函数隔离检查，尚未安装 Windows，不代表设备音质或全功能验收。[最新两端功能/音质检查](../docs/PLATFORM_AUDIO_REVIEW_0.3.7_0.4.10.md)，[0.4.9 安装记录](../docs/verification/windows-candidate-install.json)。

0.4.9 补修原生取数抢占重试、IDX 候选校验、补齐提交前缓冲复核、真实 Seek 失败按目标位置回原生及清理观察失败的最短宽限。未操作 Windows 实机；实际函数隔离与 Mac 0.3.7 证据分开记录。[缓存/Seek 缺陷及 Windows 复验](../docs/CACHE_SEEK_AUDIT_0.3.7_0.4.9.md)。

0.4.8 修复暂停后 PCM 已淘汰时的恢复准备、回退等待中的控制队列及换曲竞态，并隔离下一首输出故障。共享策略与 Mac 0.3.6 对齐；本轮只有增量语法及实际函数的隔离运行，没有 Windows 安装或音频回录。[主要能力检查及限制](../docs/CORE_PLAYBACK_AUDIT_0.3.6_0.4.8.md)。

共享时钟增加用户音量变化的 5 ms 平滑，固定音量曲线、曲间预约和输出门时刻不变。已有上一首缓冲与原生源两秒准备余量继续复用；安装、性能记录及系统控制的后续操作见 [Windows 0.4.8 修复与验收方案](../docs/WINDOWS_REPAIR_PLAN_0.4.8.md)。Mac 的回录/离线渲染证据不代表 Windows 设备输出验收。

共享 FLAC 顺序/Seek 转换已修正为精确的整数 PCM 比例，并增加音频增强设置保护。Mac 上对实际共享管线的逐样本验证见 [保真记录](../docs/AUDIO_FIDELITY_0.3.4.md)，不冒充 Windows 新候选实机复测。0.4.7 改为无缝优先：原生专属处理在无缝输出期间不执行，不再阻断开关；关闭后原生沿用保存设置。[策略及验证边界](../docs/GAPLESS_PRIORITY_0.3.5.md)。

0.4.6 当时对齐原生取数默认入口、加载偏移复核和 Seek 代次保护，并加随机预约能力门槛；当时已安装证据为 `aae1d55`（0.4.5 原生数据源候选）。最新已安装 0.4.9 见上文，0.4.10 新修正尚未安装。原生取数/缓存、后台补齐和本地播放已有分阶段 Windows 实机证据。见 [此前对齐矩阵与限制](../docs/PLATFORM_ALIGNMENT_0.4.6_0.3.3.md)、[统一状态表](../docs/CURRENT_STATUS.md)。

0.4.5 联动原生清缓存操作，保留当前播放所需缓冲，释放闲置数据；Web 接管期间拒绝重复的原生预加载音源请求。手动选曲的宿主 Stop→Load 间隔仍未消除。[本轮检查与限制](../docs/WINDOWS_CACHE_LIFECYCLE_0.4.5.md)。

支持网易云 Windows x64 3.1.43.205627 + BetterNCM 1.3.4。只保留主界面右上角无缝开关，不修改关闭按钮或歌词页。

受支持的 FLAC 在首段解码就绪后起播，同一 Web Audio 时钟继续输出；下一首可从网易云有效缓存区间、本地文件或原生取数任务准备，无需先播放一遍。异常/不支持规格回原生，不降低音质。默认原生数据源首次资源准备有 8 秒期限；显式旧 Web 路径为 1 秒，输出设备初始化另计。

[实现、完整性策略与验证边界](../docs/WINDOWS_STREAMING_0.4.0.md) / [脱敏记录](../docs/verification/windows-streaming-0.4.0.json)

## 打包安装

```powershell
python windows/package.py --client "C:\Program Files\NetEase\CloudMusic\package\orpheus.ntpk"
```

这是 ZIP 打包，不是应用构建。产物 `dist/gapless-player-windows-0.4.10.plugin`。旧包移到插件目录之外，同 slug 仅保留一个启用版本，重启客户端。FLAC 解码库内置，不增加宿主插件、不使用运行时 CDN、不修改 CSP。

默认包已选原生数据源，`--native-source-trial` 仅作为兼容别名；显式 `--web-source` 生成带该后缀的旧路径包，新歌不保证原生持久缓存。诊断 `status()` 标注版本及 `nativeSourceMode`。需实际 Windows 精确客户端归档才能生成上述包。

完整缓存 MD5 在流结束时验证，不再等待整首才出声；有索引路径单曲 PCM 32 MiB、编码区块共享 64 MiB。其他完整解码路径仍受原有 512 MiB 管理预算约束。MP3 保留原有完整解码/原生回退，不宣称所有 MP3 或弱网首次无缝。

历史：[0.3.1 起播策略](../docs/WINDOWS_FAST_START_0.3.1.md)、[0.3.0 记录](../docs/verification/windows-best-practices-0.3.0.json)、[0.2.9 切歌](../docs/WINDOWS_WARM_SWITCH_0.2.9.md)。
