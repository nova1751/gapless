# macOS 无缝播放 0.1.11

本版已安装并启用。正常播放由网易云原生后端负责；Web Audio 仅临时覆盖曲尾与下一首开头，完成对齐后交还原生。见 [实现、取消和已知边界](../docs/TEMPORARY_WEB_BRIDGE.md)。

本版已实测完整、同音质的网易云缓存优先读取，Baptized In Fear 与 Open Hearts 均命中磁盘缓存、完整 MD5 与解码校验通过，Web 预加载音频下载为零；随后完成同钟跨曲及交还原生。读取失败回到原授权音源，不修改缓存。见 [缓存检查和验证状态](../docs/CACHE_PRIORITY.md)。

0.1.11 已安装并激活，补接管失败/取消后的预热资源释放，已实测主动 Seek 取消预热及一次临时注入的输出时戳失败后上下文关闭。见 [本轮检查](../docs/IMPLEMENTATION_CHECK_0.1.11.md)。

## 使用范围

- 距当前曲尾约 10 秒，当前及可信下一首已准备且规格匹配时才进入桥接；接管前先预热并校准，准备好缓存不会提前接管整首。
- 下一首实际输出约 10 秒后校准并交还原生；拖进度或暂停可提前结束桥接。交还后 Web 音乐节点和播放上下文退出。
- 网易云负责授权音源、用户音质、音量、队列、播放速度、歌词及原生窗口。没有新增 CSS、主题、EQ、交叉淡化或静音裁剪。不兼容时保持原生，不另选低音质。
- Web 解码/输出与原生不能承诺比特等同。25 ms 估算计时门槛不是采样级设备输出证明；异常恢复可能有间隔。

实测客户端：macOS 26.6.2 arm64、网易云音乐 3.1.12（3444）、BetterNCM-mac 0.1.7。未知客户端版本保持原生。

## 安装和开关

发布包为 [gapless-player-mac-0.1.11.plugin](../releases/gapless-player-mac-0.1.11.plugin)。复制到 `~/Library/Application Support/BetterNCM-mac/plugins/`，相同 slug 只保留一个版本；旧包备份放到插件目录之外。由 BetterNCM 重新加载并刷新页面后生效，本机安装包/解压文件已核对，宿主已重新注册并刷新页面，实读运行版本为 0.1.11，普通播放、缓存桥接和原生恢复已确认。

标题栏插件菜单只有「无缝播放」开关，复用宿主样式与保存接口。关闭会恢复原生音乐播放，停止插件下载和 Web 音乐输出；开关操作无需刷新页面。

已建立的静音系统媒体载体仍保留到页面退出，用于保持系统控件可用；它不承载音乐。原生 NowPlaying 仍可能自行发布内部状态，控制中心图标闪动和原生进度回跳尚未宣布全修复，见 [0.1.8 历史系统检查](../docs/SYSTEM_SYNC_0.1.8.md)。

## 源码与验证

`player.js` 管理原生协议、临时桥接、恢复与宿主开关；`native-cache.js` 只读查询和校验网易云缓存；`media-session.js` 同步系统控制；`startup.js` 包装原生桥。共享目录管理独立解码、限额缓存和音频时钟。原生静默准备暂时关闭该后端输出，保留并恢复用户音量；用户音量选择、界面数值和 Web 输出音量保持一致，失败与退出路径亦恢复。

根目录执行 `python3 mac/package.py` 生成当前源码的 `dist/gapless-player-mac-0.1.11.plugin`；这是 ZIP 打包，不是应用构建。没有新增测试或全量 lint/tsc。本机包及运行记录见 [0.1.11 实机记录](../docs/verification/mac-runtime-0.1.11.json) 和 [0.1.11 包校验](../docs/verification/PACKAGE_0.1.11_SHA256.json)。此前桥接协议场景见 [0.1.9 历史验证](../docs/verification/mac-temporary-bridge-0.1.9.json)；0.1.10 首次缓存接入时的受阻历史见 [旧缓存记录](../docs/verification/mac-cache-priority-0.1.10.json)。

历史实现与排查保留在 [0.1.1 恢复记录](../docs/REMEDIATION.md)、[卡顿排查](../docs/HANDOFF_HITCH_REVIEW.md) 和 [间隔排查](../docs/AUDIBLE_GAP_REVIEW.md)。这些结果不代表本版已经完成声卡回录。Windows 尚未实现，不能安装 Mac 包。
