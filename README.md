# gapless — 网易云无缝播放

当前源码候选：**Windows 0.3.1 / macOS 0.2.5**。网易云决定授权音源、音质、队列和音量；插件负责受支持曲目的连续 Web Audio 输出，保留原生回退。不增加 EQ、交叉淡化或音质降档。

Windows 0.3.1 优先修复冷歌起播等待：未准备好的曲目立即走原生，已准备的兼容曲目才进入 Web。首次原生边界不保证无缝；见[快速起播策略与实测](docs/WINDOWS_FAST_START_0.3.1.md)。以下 0.3.0 启动准备记录属于历史策略。Windows 修复开关强制重启后丢失：改用 BetterNCM 持久化配置，写入后回读。菜单只在主界面右上角，只有无缝播放和一个开关。

- [跨平台最佳实践与实施方案](docs/CROSS_PLATFORM_BEST_PRACTICES.md)：生命周期、缓存、内存、时延口径、平台差异、后续门槛。
- [Windows 使用与打包](windows/README.md) / [本次验证](docs/verification/windows-best-practices-0.3.0.json)
- [Mac 使用、候选与历史实测](mac/README.md)
- [近期手动前后切歌优化](docs/WINDOWS_WARM_SWITCH_0.2.9.md)

**验证边界：** Windows 0.3.0 已本机安装并验证启动预载、暂停时预取、开关强杀重启后保持关闭。Windows 客户端 CSP 禁止 Blob Worker，因此仍用分块兼容处理；没有修改安全策略。Mac 0.2.5 只完成语法/打包检查，需 Mac 实机验收。Mac 控制中心进度回跳等既有问题未解决。未宣称两端全部特性、耗时或设备输出等价。

缓存优先复用同源解码内存和完整网易云磁盘缓存；没有缓存时读取同一授权网络源。**当前不把 Web 下载内容写回网易云缓存**。Web 解码、float32 PCM、系统重采样不能承诺与原生逐位相同。预约0帧不等于设备输出已测得无间隔。

## 打包

需要 Python、Node.js。只做 ZIP 插件打包，不是应用构建。

```powershell
python windows/package.py --client "C:\Program Files\NetEase\CloudMusic\package\orpheus.ntpk"
python -X utf8 mac/package.py
```

产物在 `dist/`，不提交本机 profile、账号、签名 URL、缓存或音频录音。安装时同 slug 只保留一个启用版本，旧包移到插件目录之外。Windows 包由本机精确客户端版本生成；Mac 新候选应先验收，历史发布包不冒充最新构建。

## 历史依据

- [Mac 0.2.4 首曲入口](docs/STARTUP_WEB_0.2.4.md)
- [Mac 0.2.3 动画时钟](docs/VISUAL_TIMING_0.2.3.md)
- [音质保护](docs/AUDIO_QUALITY_0.2.1.md)
- [原生缓存读取边界](docs/CACHE_PRIORITY.md)
- [系统媒体风险](docs/PLAYBACK_SCOPE_AND_RISKS.md)
- [Windows 适配设计背景](docs/WINDOWS_CONTINUOUS_WEB_AUDIO.md)
- [原生入口调查](docs/NATIVE_GAPLESS_RECHECK_2026-11-15.md)

仓库按 AGENTS.md 采用增量语法、协议和必要实机检查，不新增常驻测试用例或运行全量构建。CryptoJS 4.2.0 core/MD5 及许可固定放在 `vendor/`，无运行时远程依赖。
