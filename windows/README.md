# Windows 无缝播放 0.4.6 源码候选

本轮对齐原生取数默认入口、加载偏移复核和 Seek 代次保护，并加随机预约能力门槛。新候选未在本轮打包或 Windows 实机安装；当前已安装证据仍为 `aae1d55`（0.4.5 原生数据源候选）。原生取数/缓存、后台补齐和本地播放已有 Windows 实机证据，“未复测”仅指最新候选改动。见 [最新对齐矩阵与限制](../docs/PLATFORM_ALIGNMENT_0.4.6_0.3.3.md)、[统一状态表](../docs/CURRENT_STATUS.md)。

0.4.5 联动原生清缓存操作，保留当前播放所需缓冲，释放闲置数据；Web 接管期间拒绝重复的原生预加载音源请求。手动选曲的宿主 Stop→Load 间隔仍未消除。[本轮检查与限制](../docs/WINDOWS_CACHE_LIFECYCLE_0.4.5.md)。

支持网易云 Windows x64 3.1.43.205627 + BetterNCM 1.3.4。只保留主界面右上角无缝开关，不修改关闭按钮或歌词页。

受支持的 FLAC 在首段解码就绪后起播，同一 Web Audio 时钟继续输出；下一首可从网易云有效缓存区间、本地文件或原生取数任务准备，无需先播放一遍。异常/不支持规格回原生，不降低音质。默认原生数据源首次资源准备有 8 秒期限；显式旧 Web 路径为 1 秒，输出设备初始化另计。

[实现、完整性策略与验证边界](../docs/WINDOWS_STREAMING_0.4.0.md) / [脱敏记录](../docs/verification/windows-streaming-0.4.0.json)

## 打包安装

```powershell
python windows/package.py --client "C:\Program Files\NetEase\CloudMusic\package\orpheus.ntpk"
```

这是 ZIP 打包，不是应用构建。产物 `dist/gapless-player-windows-0.4.6.plugin`。旧包移到插件目录之外，同 slug 仅保留一个启用版本，重启客户端。FLAC 解码库内置，不增加宿主插件、不使用运行时 CDN、不修改 CSP。

默认包已选原生数据源，`--native-source-trial` 仅作为兼容别名；显式 `--web-source` 生成带该后缀的旧路径包，新歌不保证原生持久缓存。诊断 `status()` 标注版本及 `nativeSourceMode`。需实际 Windows 精确客户端归档才能生成上述包。

完整缓存 MD5 在流结束时验证，不再等待整首才出声；有索引路径单曲 PCM 32 MiB、编码区块共享 64 MiB。其他完整解码路径仍受原有 512 MiB 管理预算约束。MP3 保留原有完整解码/原生回退，不宣称所有 MP3 或弱网首次无缝。

历史：[0.3.1 起播策略](../docs/WINDOWS_FAST_START_0.3.1.md)、[0.3.0 记录](../docs/verification/windows-best-practices-0.3.0.json)、[0.2.9 切歌](../docs/WINDOWS_WARM_SWITCH_0.2.9.md)。
