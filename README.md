# gapless — 网易云无缝播放解决方案

当前开发候选为 **0.2.3**：无缝模式持续由Web Audio播放；同采样率保持同一输出时钟，混合采样率边界重新打开输出以保留音源规格，可能有间隔。0.2.3修正频谱变长包残留和动画时钟不同步，保留原有30 fps、渲染器及样式，不改音乐输出；用户实测当前效果已恢复正常。见[动画节奏修复](docs/VISUAL_TIMING_0.2.3.md)及[音质保护](docs/AUDIO_QUALITY_0.2.1.md)。

实际已观察连续跨曲、普通暂停/Seek、原有窗口及歌词；应用输出回录覆盖一次跨曲及下一首超过十秒。**macOS 控制中心进度回跳仍未解决，不能宣布所有原生特性等价或全部检查通过。** 最新候选已安装；已核对恢复后缓存预算、下一首预约和暂停意图。实际系统拖动记录确认原生旧状态会覆盖 Web 发布约半秒，见[系统状态证据](docs/verification/mac-system-seek-0.2.0.json)。随机模式及其他设备仍未完成验收。

网易云决定授权音源、音质、音量、队列和界面。后台源选择复用原有客户端流程，优先同源内存/完整磁盘缓存；不增加 CSS、歌词布局、EQ、混音或静音裁剪。Web 解码、float32 PCM 和系统重采样不能承诺与原生比特相同。不兼容设置和错误仍保留原生恢复路径。

开发候选包：[gapless-player-mac-0.2.3.plugin](releases/gapless-player-mac-0.2.3.plugin)。完整包已安装、重载并实读运行0.2.3；固定显示包及原WASM分析长度均为1600字节，动画使用声音输出时钟。普通Seek、暂停/继续、Baptized In Fear→Open Hearts实际跨曲和原生PCM交还已核对。见[本轮验证](docs/verification/mac-visual-timing-0.2.3.json)。系统Seek仍未通过，不能当作全部特性已验收稳定版。

## 入口

- [0.2.3 实现、验收与已知限制](docs/CONTINUOUS_WEB_AUDIO.md)
- [0.2.3 频谱输入与动画时钟修正](docs/VISUAL_TIMING_0.2.3.md)
- [0.2.2 原有频谱动态修复](docs/VISUAL_PCM_0.2.2.md)
- [0.2.1 采样率与音质保护](docs/AUDIO_QUALITY_0.2.1.md)
- [0.2.0 实际跨曲回录记录](docs/verification/mac-continuous-web-0.2.0.json)
- [Mac 安装及历史说明](mac/README.md)
- [Windows 持续 Web 实施方案 v14](docs/WINDOWS_CONTINUOUS_WEB_AUDIO.md)：含宿主建议、系统控制、固定显示包和原动画时钟接入要求；尚无Windows适配器、安装包或实机验收
- [播放范围与原生特性风险](docs/PLAYBACK_SCOPE_AND_RISKS.md)
- [网易云缓存读取边界](docs/CACHE_PRIORITY.md)
- [原生无缝能力实查](docs/NATIVE_GAPLESS_FEASIBILITY.md)

## 开发验证

按仓库约束采用增量 JS 语法检查、协议审查和相关实机场景；不新增测试，不执行全量 lint、TypeScript 检查或应用构建。`python3 mac/package.py` 只生成 ZIP 插件包。

系统进度只读诊断：`swift tools/read-system-media-mac.swift` 读取一次；附加 0 至 120 的秒数可短时采样。工具仅记录时间、进度、播放率和时长，不读取音频、曲名或账号，不进入插件播放流程。它使用可选的系统私有接口，其他 macOS 版本可能不可用。

## 历史资料

0.1.12 的临时桥接路线、安装包和回录仅为历史基线，不适用于当前持续 Web 源码：

- [0.1.12 输出交接修正](docs/OUTPUT_HANDOFF_0.1.12.md)
- [历史十秒桥接流程](docs/TEMPORARY_WEB_BRIDGE.md)
- [历史 Windows 方案 v10](docs/WINDOWS_GAPLESS_IMPLEMENTATION.md)
- [0.1.8 系统同步检查](docs/SYSTEM_SYNC_0.1.8.md)
- [系统媒体控制与原生对照](docs/SYSTEM_MEDIA_CONTROLS_REVIEW.md)
- [历史间隔排查](docs/AUDIBLE_GAP_REVIEW.md)
- [历史副作用审查](docs/SIDE_EFFECTS_REVIEW.md)
- [0.1.1 修正记录](docs/REMEDIATION.md)
