# gapless — 网易云无缝播放

**当前安装与验收状态见 [统一状态表](docs/CURRENT_STATUS.md)。** Windows 已安装并保留原生缓存数据源候选；尚未正式发布。下文各版本记录需按平台和构建模式区分。

实验进展：[Windows 原生取数及后台整首缓存试验](docs/WINDOWS_NATIVE_SOURCE_TRIAL.md)。已跑通原生缓存供给 Web 解码、抢占取消与后台补齐；0.4.6 默认打包采用原生数据源，仍为待实机复测的候选。

路线决策调研：[无缝播放与原生行为对齐方案](docs/GAPLESS_NATIVE_PARITY_PLAN.md)。比较纯原生、原生取数＋Web 输出及当前 Web 取数路线，覆盖缓存、任意位置起播、网络请求和逐项验收；原生数据源方案已在 Windows 候选实施并安装，完整发布矩阵尚未通过。

0.4.5 联动原生清缓存入口，释放闲置 PCM，并隔离 Web 接管期间的原生预加载请求。[本轮检查与限制](docs/WINDOWS_CACHE_LIFECYCLE_0.4.5.md)。

最新调查：Mac 0.3.1 已接入原生 Load/Seek/Stop 取数及有效区间读取，日常场景实机验收见 [Mac 记录](docs/MAC_NATIVE_CACHE_0.3.1.md)。早期可行性调查见[原生缓存数据源可行性](docs/NATIVE_CACHE_PROVIDER_FEASIBILITY.md)。

原生缓存复核：新版受支持 FLAC 使用原生取数与提交，落盘完整性仍须读索引证明；缓存百分比不保证完整，旧 Web 取数路径不能保证原生落盘。见[缓存所有权调查](docs/NATIVE_CACHE_OWNERSHIP_AUDIT.md)。

当前源码候选：**Windows 0.4.6 / macOS 0.3.3**。Mac 已补本地有索引 FLAC 和切歌后原生缓存补齐，并安装验证；Windows 新候选尚未实机复测。默认 Windows 打包已选原生数据源，旧 Web 路径须显式 `--web-source`。[功能矩阵、实测与限制](docs/PLATFORM_ALIGNMENT_0.4.6_0.3.3.md)。网易云决定授权音源、音质、队列和音量；插件负责受支持曲目的连续 Web Audio 输出，保留原生回退。不增加 EQ、交叉淡化或音质降档。

Windows 0.4.0 对受支持的 FLAC 从第一首开始增量解码，缓冲约 0.75 秒即可准备输出；下一首可直接从原授权网络源准备，不再要求先播放两首。修复同曲重播、暂停 ID 和失败重试。[实现与验证](docs/WINDOWS_STREAMING_0.4.0.md)。只有一个插件及右上角开关，未修改窗口/歌词样式。

- [跨平台最佳实践与实施方案](docs/CROSS_PLATFORM_BEST_PRACTICES.md)：生命周期、缓存、内存、时延口径、平台差异、后续门槛。
- [Windows 使用与打包](windows/README.md) / [本次验证](docs/verification/windows-streaming-0.4.0.json)
- [Mac 使用、候选与历史实测](mac/README.md)
- [近期手动前后切歌优化](docs/WINDOWS_WARM_SWITCH_0.2.9.md)

**历史验证边界：** Windows 0.4.0 当时已安装，验证空 Web 缓冲及绕过磁盘缓存后的首次准备、重播/暂停、失败重试和一次曲间系统回录。支持格式及下一首及时就绪时才可能首次无缝；弱网/异常回退不保证无间隔。Mac 0.3.1 已实测原生取数、重启复用及实际跨曲回录；具体限制见 Mac 当前说明。

流式缓存读取先核对授权元数据，整首 MD5 在读取结束时检查，失败恢复原生；不能称为出声前已完成整首校验。单曲 PCM 与 Chromium 完整解码比对一致，不承诺所有音源与原生/DAC bit-perfect。受支持的原生数据源由网易云写盘，插件不写回 Web 下载；索引路径采用有上限的 PCM 分块缓存。

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
