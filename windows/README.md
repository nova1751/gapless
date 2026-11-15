# Windows 无缝播放 0.3.0

支持本机已验证组合：网易云 Windows x64 3.1.43.205627 + BetterNCM 1.3.4。其他版本不自动套用私有协议。

主界面右上角插件图标展开后只有“无缝播放”及开关，歌词详情页不注入入口，不改原生窗口按钮。开关通过 BetterNCM 配置接口保存；失败会显示未保存，保持实际状态。关闭恢复原生播放并释放 Web 资源。

## 当前行为

- 启动读取开关，桥初始化最多暂存2.5秒/32条请求；未知/超时不强制接管。
- 网易云恢复队列后，经原客户端授权/音质流程准备当前曲，保持暂停，不伪造 Load/Play。无有效授权资料就不预载；等待队列恢复最多10秒。
- 当前曲有真实 Load 后，准备可信下一首，包括暂停状态。相同采样率同钟预约，异规格保持预加载但不保证零间隔。
- 内存 → 完整原生缓存 → 同授权网络源；本地普通 FLAC/MP3 按已验证适配读取，受保护 NCM 格式回原生。所有来源核对身份/规格。
- 手动切歌复用时钟和缓冲，保留一首受预算限制的最近歌曲；停用、回退、闲置和内存压力清理。
- 可选 Worker 代码存在，但本机 CSP 拒绝 Blob Worker，实际使用分块处理。没有更改客户端安全策略。
- 没有原生缓存写回，不保证 Web 播放过的新歌重启后已落入网易云缓存。

## 打包安装

```powershell
python windows/package.py --client "C:\Program Files\NetEase\CloudMusic\package\orpheus.ntpk"
```

需要 Python 和 Node.js（增量语法检查），产物 `dist/gapless-player-windows-0.3.0.plugin`。备份旧包并移到插件目录之外，同 slug 只保留一个启用包，然后重启客户端。默认不写诊断日志；`--diagnostics` / `--probe` 只用于明确的本机调查。`--temporary-bridge` 是旧实验，不是推荐模式。

## 验证与限制

[统一方案](../docs/CROSS_PLATFORM_BEST_PRACTICES.md) / [0.3.0记录](../docs/verification/windows-best-practices-0.3.0.json)。本轮验证当前曲静默预载、暂停下一首准备、关闭后立即强杀重启仍关闭。两首歌的30/35ms往返装载记录属于0.2.9，不是所有设备断音保证。

Mac不同平台协议、首次输入授权/恢复、系统媒体、设备切换、混合采样率和多DPI仍需分别验收。当前未证明与原生逐位相同、所有曲目无间隔，或与Mac完整等价。

历史：[0.2.9切歌修复](../docs/WINDOWS_WARM_SWITCH_0.2.9.md)、[0.2.6原生缓存](../docs/WINDOWS_CACHE_TOGGLE_0.2.6.md)、[早期试验](../docs/verification/windows-upstream-0.1.3.json)。
