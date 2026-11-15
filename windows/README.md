# Windows 无缝播放 0.4.3

0.4.3 对有索引的 FLAC 优先读取跳转位置附近的缓存或授权网络区块，并提前准备下一首。手动选曲的宿主 Stop→Load 间隔仍未消除。[本轮检查与限制](../docs/WINDOWS_INDEXED_SEEK_0.4.3.md)。

支持网易云 Windows x64 3.1.43.205627 + BetterNCM 1.3.4。只保留主界面右上角无缝开关，不修改关闭按钮或歌词页。

受支持的 FLAC 在首段解码就绪后起播，同一 Web Audio 时钟继续输出；下一首可从网易云完整缓存、本地文件或同授权网络源准备，无需先播放一遍。异常/不支持规格回原生，不降低音质。首次资源准备有 1 秒期限；输出设备初始化另计。

[实现、完整性策略与验证边界](../docs/WINDOWS_STREAMING_0.4.0.md) / [脱敏记录](../docs/verification/windows-streaming-0.4.0.json)

## 打包安装

```powershell
python windows/package.py --client "C:\Program Files\NetEase\CloudMusic\package\orpheus.ntpk"
```

这是 ZIP 打包，不是应用构建。产物 `dist/gapless-player-windows-0.4.3.plugin`。旧包移到插件目录之外，同 slug 仅保留一个启用版本，重启客户端。FLAC 解码库内置，不增加宿主插件、不使用运行时 CDN、不修改 CSP。

完整缓存 MD5 在流结束时验证，不再等待整首才出声；已解码 PCM 仍受 512 MiB 管理预算约束，不是固定小内存环形缓冲。MP3 保留原有完整解码/原生回退，不宣称所有 MP3 或弱网首次无缝。

历史：[0.3.1 起播策略](../docs/WINDOWS_FAST_START_0.3.1.md)、[0.3.0 记录](../docs/verification/windows-best-practices-0.3.0.json)、[0.2.9 切歌](../docs/WINDOWS_WARM_SWITCH_0.2.9.md)。
