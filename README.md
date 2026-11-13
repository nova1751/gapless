# 网易云无缝播放解决方案

仅增加无缝衔接，沿用网易云的音质选择、授权音源、音量、队列和原生 UI。Mac 插件 0.1.1 已安装并进行实机验证；Windows 提供详细实施方案，尚无 Windows 安装包。

## 直接入口

- [Mac 安装与使用](mac/README.md)
- [Mac 插件包](releases/gapless-player-mac-0.1.1.plugin)
- [修正、验证和已知边界](docs/REMEDIATION.md)
- [Windows 详细实施方案](docs/WINDOWS_GAPLESS_IMPLEMENTATION.md)
- [0.1.0 历史问题审查](docs/MAC_GAPLESS_AUDIT.md)

## 原理与范围

下一首按网易云当前选择预加载，在同一 AudioContext 中从上一首的结束时刻开始。源采样率、解码采样率和播放时钟每次复核，音源用 MD5/可核对指纹接认；特殊音效、不同采样率、权限或资源不足时回退原生，不另选低音质。

不改歌词布局，不新增 DSP、主题或静音裁剪。本插件开关使用宿主已有样式和保存接口，关闭后恢复原生播放，本开关无需刷新页面。

Web Audio 接替了底层解码/输出，不能保证与原生输出比特完全一致。随机/推荐、重复 ID 等无法确认下一首的队列保持原生；不能承诺所有曲目边界均无缝。详细限制见修正记录。

## 源码与打包

```text
shared/     独立解码、限额缓存与播放时钟
mac/        macOS 原生协议、控制、恢复、宿主开关与打包脚本
docs/       Windows 方案、历史审查、修正和验证数据
releases/   可安装的 Mac ZIP 插件包
tools/      可选的本机 CDP 协议诊断脚本
```

在根目录执行 `python3 mac/package.py` 可重新打包至 `dist/`。不需要安装前端依赖，不执行应用构建。源码只对实测 Mac 网易云 3.1.12（3444）启用，未知版本保持原生。

## 来源与许可

借鉴 [NcmGaplessPlayer](https://github.com/AntsandIce/NcmGaplessPlayer) 的采样时钟预约思路，使用 [BetterNCM-mac](https://github.com/OyangDer/betterncm-mac) 宿主与原生桥。保留 MIT 许可与上游署名，见 [第三方说明](THIRD_PARTY_NOTICES.md)。

这是独立本地 Git 仓库。没有关联远程或上传 GitHub，不包含用户账号、profile、令牌、音乐文件或音源 URL。
