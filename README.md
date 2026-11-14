# gapless — 网易云无缝播放解决方案

**0.1.10 已接入临时桥接及网易云缓存优先读取：普通播放归原生；距曲尾约 10 秒才进入 Web Audio，跨曲后约 10 秒经对齐交还原生。**10 秒只决定窗口，实际切换依据音频计时和设备输出时间戳校准。下一首不会持续由 Web 播放整首。见 [实现与边界](docs/TEMPORARY_WEB_BRIDGE.md)。

准备顺序为已解码内存缓存 → 网易云完整磁盘缓存 → 当前授权音源。只复用同歌曲、同实际音质、同 MD5 的完整缓存，不降低音质；缓存文件只读，校验和解码发生在接管前。源码与当前页面已接入，锁屏/系统文件访问等待期间尚未完成最终磁盘命中及跨曲复验，见 [缓存读取范围与验证状态](docs/CACHE_PRIORITY.md)。

仅增加无缝衔接，沿用网易云的音源授权、音质选择、音量、队列和原生窗口样式。原生恢复前先静默准备并核对播放计时；不再先停止 Web 再装载原生。Windows 仍只有详细方案，没有安装包。

控制中心图标闪动、原生进度回跳尚未宣布全部修复；设备输出也未做声卡回录。音乐交还原生后，静音系统同步层仍保留，以避免释放会话导致系统控件失效。不能把本版理解为已达到所有设备的采样级零间隔。

本轮源码/待复验发布包为 **0.1.11**，补接管失败和取消后的预热上下文释放；当前安装和运行页面仍为 0.1.10，尚未激活或实机验收新版本。

## 直接入口

- [0.1.11 复查修正与确认范围](docs/IMPLEMENTATION_CHECK_0.1.11.md)
- [Windows 一致实施方案 v8](docs/WINDOWS_GAPLESS_IMPLEMENTATION.md)
- [0.1.9 临时 Web Audio 桥接并交还原生](docs/TEMPORARY_WEB_BRIDGE.md)
- [0.1.10 网易云缓存优先读取](docs/CACHE_PRIORITY.md)
- [Mac 安装与使用](mac/README.md)
- [Mac 当前安装包 0.1.10](releases/gapless-player-mac-0.1.10.plugin)
- [Mac 0.1.11 待复验包](releases/gapless-player-mac-0.1.11.plugin)
- [0.1.8 系统控制路由与会话生命周期修正](docs/SYSTEM_SYNC_0.1.8.md)
- [0.1.7 历史系统同步记录](docs/SYSTEM_SYNC_0.1.7.md)
- [0.1.6 无缝功能恢复与实际跨曲记录](docs/RESTORE_GAPLESS_0.1.6.md)
- [原生无缝可行性实查与 Windows 参考实现](docs/NATIVE_GAPLESS_FEASIBILITY.md)
- [无缝播放技术路线调研与改进优先级](docs/GAPLESS_IMPLEMENTATION_RESEARCH.md)
- [macOS 系统媒体状态、原生对照与源码修正](docs/SYSTEM_MEDIA_CONTROLS_REVIEW.md)
- [临近衔接卡顿与输出冷启动排查](docs/HANDOFF_HITCH_REVIEW.md)
- [Baptized In Fear → Open Hearts 间隔排查与实际缓冲验证](docs/AUDIBLE_GAP_REVIEW.md)
- [进度回跳、副作用与精简审查](docs/SIDE_EFFECTS_REVIEW.md)
- [0.1.1 修正、验证和已知边界](docs/REMEDIATION.md)
- [0.1.0 历史问题审查](docs/MAC_GAPLESS_AUDIT.md)

## 原理与范围

原生继续播放，后台准备当前曲目和可信下一首；两首已解码且规格兼容、进入曲尾窗口且计时对齐后才接管，在同一 AudioContext 中让下一首从上一首的结束时刻开始。源采样率、解码采样率和播放时钟每次复核，音源用 MD5/可核对指纹接认；特殊音效、不同采样率、权限或资源不足时保持/恢复原生，不另选低音质。

不改歌词布局，不新增 DSP、主题或静音裁剪。本插件开关使用宿主已有样式和保存接口，关闭后恢复原生播放，本开关无需刷新页面。

Web Audio 接替了底层解码/输出，不能保证与原生输出比特完全一致。随机/推荐、重复 ID 等无法确认下一首的队列保持原生。初次准备/接管期间拖动进度时，等待原生 Seek 完成及 400 ms 稳定窗口后自动重新尝试接管，不会让整首曲目退出无缝。详细限制见副作用审查。

本轮只读检查确认：Mac 3.1.12 的原生引擎含跨曲处理逻辑，但 SDK 的下一首预加载方法为空实现，尚无可验证的插件调用路径。没有据此替换播放代码或启用隐藏配置。Windows 参考插件同样通过 Web Audio 接管出声；其固定码率兜底与额外调音/UI 不符合本项目范围。Windows 优先验证原生预准备能力，不能把 Mac 的接口结果直接套用过去。

## 源码与打包

```text
shared/     独立解码、限额缓存与播放时钟
mac/        macOS 原生协议、控制、恢复、宿主开关与打包脚本
docs/       Windows 方案、历史审查、修正和验证数据
releases/   可安装的 Mac ZIP 插件包
tools/      可选的本机 CDP 协议诊断脚本
```

在根目录执行 `python3 mac/package.py` 可重新打包至 `dist/`。当前 manifest 为 0.1.11，组合源码与发布包已核对；本机安装/运行仍为 0.1.10，新包待激活复验。旧版本保留在 `releases/`，安装时只保留一个同 slug 的插件包。不需要安装前端依赖，不执行应用构建。源码只对实测 Mac 网易云 3.1.12（3444）启用，未知版本保持原生。

## 来源与许可

借鉴 [NcmGaplessPlayer](https://github.com/AntsandIce/NcmGaplessPlayer) 的采样时钟预约思路，使用 [BetterNCM-mac](https://github.com/OyangDer/betterncm-mac) 宿主与原生桥。保留 MIT 许可与上游署名，见 [第三方说明](THIRD_PARTY_NOTICES.md)。

项目仓库：[nova1751/gapless](https://github.com/nova1751/gapless)。不包含用户账号、profile、令牌、音乐文件或音源 URL。
