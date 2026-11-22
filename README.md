# gapless — 网易云无缝播放

网易云负责授权音源、音质选择、队列和持久缓存；插件读取有效区间并解码，由 Web Audio 连续输出。保留原窗口、歌词和频谱，不增加 EQ、交叉淡化、静音裁剪或音质降档。

| 平台 | 源码版本 | 安装／运行记录 | 宿主 |
|---|---|---|---|
| macOS | **0.3.13** | 已安装并加载；原生暂停位置已恢复，真实缓存读取仍有失败；管理入口 1.2.1 | BetterNCM-mac 0.1.7；网易云 3.1.12（3444） |
| Windows | **0.4.21** | 已安装重启，心动队列选曲通过隔离验证 | BetterNCM 1.3.4；网易云 x64 3.1.43.205627 |

[当前状态](docs/CURRENT_STATUS.md)和[版本记录](docs/versions.json)区分源码、已安装、运行和历史哈希证据。两端的版本序列独立，不要求版本数字相同。

## 使用与管理

Mac 右上角插件按钮打开宿主样式快捷菜单：上方「无缝播放」开关，下方「管理插件」。点管理插件进入 BetterNCM 管理页；左侧列出已安装插件，选中后右侧展示详情和原有配置。快捷开关与无缝配置复选框使用同一启停流程，状态与实际播放器和宿主保存值同步。菜单版本 **1.2.1**，安装包 **0.3.13**。插件市场是单独的 PluginMarket 插件：勾选后在同一管理页浏览，关闭后管理入口与无缝控制仍可使用。市场主要面向 Windows，很多插件在 macOS 不能直接使用，尤其是依赖 DLL／原生接口的插件；下载和安装由用户选择。Windows 保留已有 BetterNCM 管理与无缝入口，本轮未修改管理界面。

关闭开关取消预约和工作缓存，恢复网易云原生播放及最新播放意图；重新开启时 Windows 等待下一次有效 Load，Mac 可准备当前曲。Mac 0.3.8 补修页面恢复后首次关闭时同曲 Resume 捷径导致的原生恢复失败。

- [Mac 安装、菜单与本轮验证](mac/README.md)
- [Windows 使用与打包](windows/README.md)
- [当前 Mac 快捷菜单与管理](docs/MAC_PLUGIN_QUICK_MENU_1.2.1.md)
- [跨平台实现原则](docs/CROSS_PLATFORM_BEST_PRACTICES.md)
- [Mac 原生队列、后台缓存和启动恢复修正](docs/MAC_NATIVE_QUEUE_CACHE_0.3.13.md)
- [原生回退后进度停在零点的修正](docs/PROGRESS_RECOVERY_0.3.12.md)
- [曲尾分块解码误降级修正](docs/INDEXED_DECODER_0.3.11.md)
- [曲尾误取消修正与 Windows 建议](docs/QUEUE_BOUNDARY_0.3.10.md)

## 打包

Mac：

```sh
python3 mac/package.py
python3 mac/install-menu.py
```

第二条更新独立 Mac 管理入口并保留市场设置；首次需要透出宿主内置市场时加 `--market`，以后可在管理页勾选启停。不安装其他市场插件；无缝插件包另复制到宿主插件目录。详见 Mac 安装步骤。Windows 必须使用精确客户端归档：

```powershell
python windows/package.py --client "C:\Program Files\NetEase\CloudMusic\package\orpheus.ntpk"
```

这些命令生成 ZIP 插件，不是应用构建。同 slug 的活动目录只保留一个版本，旧包备份到目录之外。默认 Windows 包使用原生数据源；显式 `--web-source` 是旧路径，新歌不保证原生持久缓存。

## 验证边界

同采样率、下一首及时就绪时提前预约；不同采样率重建输出可能有短间隔。缓存完整性以真实有效索引和整首 MD5 为准，不保证跳到曲尾、播完或退出前一定缓存整首。Mac 控制中心进度回跳、Windows 系统时间线能力及极端网络/设备场景仍有限制。

[原文件 PCM 检查](docs/AUDIO_FIDELITY_0.3.4.md)及[Mac 原生/Web 应用输出 A/B](docs/MAC_NATIVE_WEB_OUTPUT_AB_0.3.7.md)没有证明可听降质，也没有证明所有设备逐位一致。本轮修正原生队列、缓存调度和启动恢复，保留前版 FLAC 分块解码及加载回调修正；音乐采样率、音量曲线和预约时钟不变，旧音频证据保留原版本。完整历史见[历史状态](docs/HISTORY_STATUS_2026-11-17.md)。

不提交 profile、账号、签名 URL、凭证、缓存或录音；不新增测试用例或执行全量静态检查、应用构建。
