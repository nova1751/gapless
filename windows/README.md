# Windows 无缝播放 0.4.16

当前 manifest 版本 **0.4.17**，支持网易云 x64 **3.1.43.205627** ＋ BetterNCM **1.3.4**。无关队列变化保留有效预约和接认，实际下一首变化取消旧预约。包含 0.4.15 的[共享 FLAC 索引边界修正](../docs/INDEXED_DECODER_0.3.11.md)。0.4.17 修正切换播放顺序可能中断当前曲 Web Audio 的问题。下一首尚未确定时取消旧预约，等网易云队列就绪再准备，不中断当前曲。0.4.17 已通过网易云重启加载，宿主运行文件与安装包一致；播放顺序切换已通过隔离检查，待实机播放验证。

隔离检查覆盖队列重建、改动后续曲目、实际下一首变化、重复队列项，以及缓存读取失败时原始 Load 的回退。实机验收范围和包哈希见[当前状态](../docs/CURRENT_STATUS.md)和[统一版本记录](../docs/versions.json)。

## 插件入口

右上角统一 BetterNCM 菜单，显示无缝开关、状态和「管理插件」；打开管理页后该项变为「返回网易云」。复用宿主管理页并默认打开无缝配置，不添加第二套市场。样式限定在自己的弹层及已打开的宿主管理页，不注入歌词页。Ctrl+Alt+G 使用同一入口。

0.4.11／0.4.12 修改入口与管理界面，音频链路沿用 0.4.10。本机上游移除未使用的 LibEAPIRequest 后报告市场在线列表可加载，保留 NativeWindowControls；这不是其他电脑的依赖卸载指令，也不能保证市场网络状态。Mac 只对齐已安装管理和样式，没有启用 Windows 通用市场。[两端菜单范围](../docs/PLUGIN_MENU_ALIGNMENT_0.3.8_0.4.12.md)。

## 打包安装

```powershell
python windows/package.py --client "C:\Program Files\NetEase\CloudMusic\package\orpheus.ntpk"
```

产物为 `dist/gapless-player-windows-0.4.17.plugin`。必须使用精确客户端归档，不能安装 Mac 包。同 slug 活动目录只保留一个版本；旧包备份到目录之外，重启后核对 manifest、main、startup 及运行诊断版本。这里只做 ZIP 打包，不是应用构建；FLAC 解码库内置，无运行时 CDN 或 CSP 改动。

默认原生数据源，`--native-source-trial` 为兼容别名；显式 `--web-source` 生成旧路径包，新歌不保证原生持久缓存。无需 LibEAPIRequest 作为本无缝插件依赖；其他插件依赖应按各自说明处理。

## 播放与边界

网易云提供授权音源、档位、队列和原生缓存；插件只读有效区间，缺口由原生 Load／Seek／Stop 串行准备，Web Audio 连续输出。明文本地 FLAC、索引 Seek、当前及切走歌曲的有界后台补齐保留既有实现。编码区块共享 64 MiB，索引路径单曲 PCM 32 MiB；未索引路径受 512 MiB 管理预算约束。

同率可提前预约；位深／声道差异不再阻断预取，异率保留资源并在下一次 Load 重建输出，可能有短间隔。手动选曲没有人为等待定时，但客户端 Stop → Load、授权、缓存和输出准备仍会耗时。无缝优先，关闭后原生沿用保存的音效偏好；重新开启在下一次有效 Load 接管，保留当前原生播放。

不保证播放／跳到曲尾后整首必定提交，也不以第二套永久缓存替代。SMTC 既有实测没有时间线／Seek，物理媒体键及极端网络／设备场景仍有验收边界。Windows 没有新增原生/Web 输出 A/B；Mac 结果不能替代 Windows 设备结果。

历史：[0.4.10 两端音质/混合规格](../docs/PLATFORM_AUDIO_REVIEW_0.3.7_0.4.10.md)、[缓存/Seek](../docs/CACHE_SEEK_AUDIT_0.3.7_0.4.9.md)、[原生数据源试验](../docs/WINDOWS_NATIVE_SOURCE_TRIAL.md)、[完整历史状态](../docs/HISTORY_STATUS_2026-11-17.md)。
