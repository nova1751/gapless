# 当前交付状态（2026-11-16）

目标仍未完成全部验收。Windows 当前机器已安装并保留 `374da7e` 原生数据源候选；不是默认打包产物，也不是正式发布。安装包及 runtime 对照见 [安装记录](verification/windows-candidate-install.json)。Mac 保持原有 0.2.5 候选，未移植本轮 Windows 原生缓存协议。

## 当前实现

最新源码已修正预载后本地文件变化的预约/接认校验，临时函数检查通过，已安装 `374da7e` 并核对 runtime。收藏列表 Baptized In Fear 跳到约 3:41 后自然切至 Open Hearts，预约间隔 0 帧、宿主接认约 203 ms，未观察到回退或校验误取消；起播加载 1026 ms。此轮是缓存在线歌曲的 UI/协议回归，没有新增音频回录；接认延迟不等同于断音长度。详见[文件版本与接认说明](LOCAL_SOURCE_IDENTITY.md)。

后续源码已加入本地文件真实大小/修改时间校验，属性 API 已在宿主验证；该后续候选已安装为 `899325c`，runtime 匹配，在线播放加载 1128 ms；本地/下载列表为空，真实本地播放验收未完成。范围、检查证据与剩余竞态见[本地文件说明](LOCAL_SOURCE_IDENTITY.md)。

源码新增[本地缓存身份修正](LOCAL_SOURCE_IDENTITY.md)：宿主报告文件大小/内容指纹变化时不再复用旧 PCM，语法、临时协议检查及 ZIP 打包通过；已安装并核对 runtime，重启后在线播放加载 1113 ms、44.1 kHz，未观察到回退；这不是实际文件替换验收。

Windows 受支持的在线 FLAC：网易云提供授权音源、音质、队列；原生 Load/Seek/Stop 获取并提交原生缓存，插件读取有效区间、增量解码，由 Web Audio 输出。拖动先取得目标附近的数据，已有效区间复用。当前曲缓冲充足时后台补缺口；切歌后最多保留两首、十分钟的待补齐元数据，不保留旧曲整段 PCM。连续六次无进展暂停后台补齐；取数单次八秒截止。原生写盘时机仍受宿主实现影响，不承诺一播完便必定完整。

索引原生路径单曲 PCM 上限 32 MiB，编码区块共享 64 MiB，音乐节点使用独立不可变片段。未知格式、音效或无法保持的设置回原生，不降音质、不裁剪留白、不混音。UI 仅顶部入口及开关。开关关闭恢复原生；已在原生播放时重新开启，下一次选歌才接管。

## 证据与未完成项

| 要求 | 当前证据 | 判定 |
|---|---|---|
| 切歌后补齐未听过的中间区块 | 原生缺口 6,231,523 字节在切歌后约 6.9 秒补齐，两首整曲 MD5 匹配：[记录](verification/windows-retired-cache-fill.json) | 此场景实机通过；不保证快速连续切歌、退出或弱网全补齐 |
| 原生清缓存与恢复 | 实际 UI 清理成功，30 文件原数据清除、播放时重新按需生成，测试后全部哈希恢复：[记录](verification/windows-ui-cache-clear.json) | 当前播放时通过；旧曲补齐正执行的竞态未在新候选实机复现 |
| 缓存重启复用、关闭交还、重新开启 | runtime 校验、重新选曲、原位置恢复约 191 ms：[记录](verification/windows-candidate-install.json) | 实机通过这些操作；不是全进程网络审计 |
| 自然跨曲及曲尾跳转 | 原生缓存未命中时目标等待 1297 ms；系统回录多窗口时间对齐、无新增近零段：[记录](verification/windows-native-source-cold-pair.json) | 特定两曲的时间连续性有证据；已纠正参考声道误用，左声道相关性约 0.94–0.97；不能承诺 bit-perfect |
| 内存受控、返回已淘汰位置 | 实机 PCM 平台期和回跳；同解码器区块数值对照：[说明](WINDOWS_BOUNDED_PCM_CANDIDATE.md) | 已覆盖选定 FLAC；其他路径仍使用原有预算/回退 |
| 超时、清理与抢占 | 实际 session/queue/byte-source 组合加模拟不返回回调；8009 ms 截止、Stop、队列释放、随后命中缓存；前台抢占时旧 Stop 早于新 Load：[记录](verification/windows-native-pipeline-failure.json) | 协议检查通过；不是实际断网/限速环境 |
| 原生内部是否重复下载、全部统计联动 | 辅助通道没有 Play，暂停 Seek 时原生听音计数未增长；已知预加载通道隔离 | 全进程请求、全部遥测与系统媒体对照仍未完成 |
| 原生淡入淡出设置 | Web 播放时开启原生 playFade，原位置交还耗时 75 ms，原生播放继续；随后恢复原设置并暂停：[记录](verification/windows-native-fade-fallback.json) | UI/协议实测通过；未回录淡化包络，不代表所有音效或设备切换通过 |
| Windows 系统媒体控制 | SMTC 单一网易云会话、曲名及 Playing/Paused 正确；系统会话 API 暂停/继续同步到 Web UI；关闭插件后的原生对照：[记录](verification/windows-smtc-control.json) | 两种后端均未提供时间线/Seek；已恢复原 SMTC 关闭设置。物理媒体键、锁屏、跨曲更新仍未验收 |
| Mac 同等缓存行为 | [平台方案](CROSS_PLATFORM_BEST_PRACTICES.md)、历史 Mac 证据 | 不能把 Windows 的原生协议或运行结果当成 Mac 验收 |
| 本地文件同大小修改 | 实际宿主文件 API、资源缓存和解码器：版本变化后旧 PCM 未命中、新 PCM 重新生成；原文件未改：[记录](verification/windows-local-host-cache.json) | 隔离资源实例通过；流式子类/播放队列、保留修改时间的替换及有界磁盘读取仍未完成 |

## 剩余收尾

继续实际弱网/断网、旧曲补齐与清理相撞、系统媒体/音效/设备及长时间运行回归，完成原生请求审计；按原 [发布矩阵](GAPLESS_NATIVE_PARITY_PLAN.md) 决定正式发布。Mac 的平台适配和实机验收独立进行。本表没有把未完成项改成可选，也不以模拟检查替代实机要求。

## 可复现打包

```powershell
python windows/package.py --native-source-trial --diagnostics
```

这是 ZIP 打包和增量语法检查。默认不带 trial 参数仍生成旧 Web 取数路径。当前安装仍显示 0.4.5，须用构建参数、源码提交和包哈希区别，不能只看版本号。备份位于插件目录之外，恢复时需先正常退出客户端。原音频、账号、缓存和签名地址不入库。
