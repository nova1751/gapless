# macOS 无缝播放 0.3.8

当前源码、安装包和运行版本均为 **0.3.8**。实测宿主 **BetterNCM-mac 0.1.7**、网易云音乐 **3.1.12（3444）**；独立菜单扩展版本 **1.0.0**。宿主版本、菜单版本与无缝插件版本分别显示／记录，不能混用。[版本与哈希](../docs/versions.json)，[本轮验证](../docs/verification/mac-menu-0.3.8.json)。

## 本次更新

- 右上角原插件按钮默认打开「无缝播放」开关、状态和「管理已安装插件」。保留原生按钮、宿主开关及认证 API，样式限定在自己的弹层内。
- 管理页列出本机已安装插件及宿主内置项，展示版本和宿主兼容说明；通用市场保持默认隐藏。不能直接安装依赖 Windows DLL／桥接口的插件。
- 版本标签来自宿主安装清单，悬停显示安装与运行版本；不一致时提示重启更新。无缝运行版本由打包时的 manifest 自动注入。
- 修复页面恢复后首次关闭、同曲尚无原生 Load 时的恢复失败：使用已验证的原生 SDK 重建同曲实例，保留授权音源，再 Seek 并恢复最新暂停或播放意图，避免完整选曲的迟到状态更新。开关保存串行执行，管理视图切换期间不能重复提交。

未修改音源选择、解码、音量曲线、采样率策略、音乐排程、歌词或频谱算法。未知客户端版本保持原生。

## 安装与回退

```sh
python3 mac/package.py
python3 mac/install-menu.py
```

1. 生成 `dist/gapless-player-mac-0.3.8.plugin`，交付副本见 [0.3.8 包](../releases/gapless-player-mac-0.3.8.plugin)。复制到 `~/Library/Application Support/BetterNCM-mac/plugins/`；同 slug 只留一个活动版本，旧包移到目录之外。
2. 菜单安装脚本只写 `/Applications/BetterNCM.app/Contents/Resources/app/src/prelude/gapless-plugin-menu.js`，不改宿主原文件，不启用通用市场、不修改 CSP。宿主 API／自动发现接口不匹配时退出，保留原菜单。非默认安装位置可加 `--app /path/to/BetterNCM.app`。
3. 由宿主重载插件并刷新页面，或正常退出后重新打开。核对菜单安装版本、`gaplessMac.version` 和 [当前状态](../docs/CURRENT_STATUS.md)。初次真实输入之前 Web Audio 可以等待授权，不主动发声。

移除菜单扩展：`python3 mac/install-menu.py --remove`，下次重载恢复宿主原菜单；无缝播放包与其独立。播放器回退可关闭无缝开关，或正常退出后换回插件目录之外备份的 0.3.7 包。本机已保留旧包。宿主升级可能移除独立 prelude；升级后需重新检查接口并安装。

## 播放与缓存

同源、同档位内存 → 原生有效磁盘区间／原生解析器返回的明文本地 FLAC → 原生串行 Load → Seek → Stop 准备缺口、提交缓存。辅助实例不 Play，通知不覆盖主曲目、歌词、进度或系统状态。插件只读有效数据并解码，不写 UC／IDX，不建立第二套永久音乐缓存。

编码区块共享 64 MiB，索引路径每首 PCM 32 MiB，其他路径受 512 MiB 管理预算约束。当前曲、用户 Seek 优先；当前 PCM 余量足够后才后台补齐，任务有期限并可取消，不保证退出前整首落盘。同采样率预约连续输出，异率重建上下文可能有短间隔。

无缝开关优先，Web 输出期间不执行冲突的原生音效，保存值供关闭后原生使用。关闭恢复原生并释放工作缓存，重新开启可准备当前曲。系统控制中心进度回跳仍有原生对照问题，不能宣称完全解决。

## 证据

本轮完成菜单、管理页、开关保存、首次原生恢复及包／运行版本核对；相关协议与 UI 范围见 [菜单对齐记录](../docs/PLUGIN_MENU_ALIGNMENT_0.3.8_0.4.12.md)。没有新增设备回录或全客户端兼容验收。

历史音频／缓存证据保留原版本：[0.3.7 应用输出 A/B](../docs/MAC_NATIVE_WEB_OUTPUT_AB_0.3.7.md)、[0.3.7 缓存/Seek](../docs/CACHE_SEEK_AUDIT_0.3.7_0.4.9.md)、[0.3.6 真实跨曲回录](../docs/CORE_PLAYBACK_AUDIT_0.3.6_0.4.8.md)、[0.3.4 PCM 保真](../docs/AUDIO_FIDELITY_0.3.4.md)、[0.3.3 本地及后台缓存](../docs/PLATFORM_ALIGNMENT_0.4.6_0.3.3.md)、[0.2.3 频谱修复](../docs/VISUAL_TIMING_0.2.3.md)。不能把历史证据改写为 0.3.8 全量验收；不承诺所有输出 bit-perfect。
