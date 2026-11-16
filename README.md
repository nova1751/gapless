# gapless — 网易云无缝播放

网易云负责授权音源、音质选择、队列和持久缓存；插件读取有效区间并解码，由 Web Audio 连续输出。保留原窗口、歌词和频谱，不增加 EQ、交叉淡化、静音裁剪或音质降档。

| 平台 | 源码版本 | 安装／运行记录 | 宿主 |
|---|---|---|---|
| macOS | **0.3.8** | 本轮安装，包与运行文件一致 | BetterNCM-mac 0.1.7；网易云 3.1.12（3444） |
| Windows | **0.4.12** | main `a9cd8b8` 报告已安装及运行核对；本轮未操作 Windows | BetterNCM 1.3.4；网易云 x64 3.1.43.205627 |

[当前状态](docs/CURRENT_STATUS.md)和[版本记录](docs/versions.json)区分源码、已安装、运行和历史哈希证据。两端的版本序列独立，不要求版本数字相同。

## 使用与管理

右上角插件入口默认显示无缝开关、状态和管理入口。Windows 复用 BetterNCM 管理页，默认打开无缝设置；Mac 复用宿主按钮和开关，只管理本机已安装插件，保留通用市场默认隐藏。多数市场插件依赖 Windows 原生接口，菜单对齐不代表兼容性对齐。

关闭开关取消预约和工作缓存，恢复网易云原生播放及最新播放意图；重新开启时 Windows 等待下一次有效 Load，Mac 可准备当前曲。Mac 0.3.8 补修页面恢复后首次关闭时同曲 Resume 捷径导致的原生恢复失败。

- [Mac 安装、菜单与本轮验证](mac/README.md)
- [Windows 使用与打包](windows/README.md)
- [两端菜单对齐范围](docs/PLUGIN_MENU_ALIGNMENT_0.3.8_0.4.12.md)
- [跨平台实现原则](docs/CROSS_PLATFORM_BEST_PRACTICES.md)

## 打包

Mac：

```sh
python3 mac/package.py
python3 mac/install-menu.py
```

第二条只安装独立的 Mac 宿主菜单扩展；无缝插件包另复制到宿主插件目录。详见 Mac 安装步骤。Windows 必须使用精确客户端归档：

```powershell
python windows/package.py --client "C:\Program Files\NetEase\CloudMusic\package\orpheus.ntpk"
```

这些命令生成 ZIP 插件，不是应用构建。同 slug 的活动目录只保留一个版本，旧包备份到目录之外。默认 Windows 包使用原生数据源；显式 `--web-source` 是旧路径，新歌不保证原生持久缓存。

## 验证边界

同采样率、下一首及时就绪时提前预约；不同采样率重建输出可能有短间隔。缓存完整性以真实有效索引和整首 MD5 为准，不保证跳到曲尾、播完或退出前一定缓存整首。Mac 控制中心进度回跳、Windows 系统时间线能力及极端网络/设备场景仍有限制。

[原文件 PCM 检查](docs/AUDIO_FIDELITY_0.3.4.md)及[Mac 原生/Web 应用输出 A/B](docs/MAC_NATIVE_WEB_OUTPUT_AB_0.3.7.md)没有证明可听降质，也没有证明所有设备逐位一致。新菜单未修改解码、采样率、音量曲线或跨曲排程；旧音频证据保留原版本。完整历史见[历史状态](docs/HISTORY_STATUS_2026-11-17.md)。

不提交 profile、账号、签名 URL、凭证、缓存或录音；不新增测试用例或执行全量静态检查、应用构建。
