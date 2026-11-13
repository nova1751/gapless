# macOS 无缝播放 0.1.1

仅增加无缝衔接。网易云负责音质选择、授权音源、队列和原生 UI；插件不修改歌词布局，不引入主题、EQ、交叉淡化或静音裁剪。输出经过 Web Audio，不能保证与原生输出完全等价。

实测：macOS 26.6.2 arm64、网易云音乐 3.1.12（3444）、BetterNCM-mac 0.1.7。未知客户端版本保持原生。

## 文件与打包

- `player.js`：Mac 状态/协议、候选接认与原生恢复。
- `startup.js`：启动期原生桥包装与事务回调。
- `../shared/audio-resources.js`：授权源、限额、独立解码与缓存。
- `../shared/playback-clock.js`：播放时钟、预约、取消与累计听音时间。

在仓库根目录执行 `python3 mac/package.py`，生成 `dist/gapless-player-mac-0.1.1.plugin`。这是源码 ZIP 打包，不执行前端/应用构建。

## 安装与使用

1. 使用 [BetterNCM-mac](https://github.com/OyangDer/betterncm-mac) 官方安装渠道；确认网易云为上面的实测版本。
2. 已有插件时先关闭并备份旧 `.plugin`，备份放到 `plugins` 目录之外，避免相同 slug 同时加载多个版本。
3. 将本版 `.plugin` 放入 `~/Library/Application Support/BetterNCM-mac/plugins/`，由 BetterNCM 重新提取/加载，必要时退出网易云后从原应用打开。
4. 标题栏插件菜单保留一项「无缝播放」。本版使用宿主已有开关和保存接口，不新增 CSS；关闭时先恢复原生位置和播放意图，本开关无需页面刷新。
5. 兼容的同采样率曲目预加载完成后，在同一音频时钟连续开始。资源、权限、音效或队列不兼容时回退原生，不另选低音质。

本机已安装 0.1.1，旧包备份在 BetterNCM profile 的 `backups/gapless-0.1.0/`。仓库不含该用户 profile、账号、音源 URL 或音乐缓存。

## 确认范围

普通切歌、暂停/继续、Seek、原生歌词显示、候选未接认恢复、刷新恢复和开关已按真实客户端复核。详见 [修正与验证记录](../docs/REMEDIATION.md)。

原生 Hi-Res 选择为 1999、音量为 0.48；示例曲目原生可用档位为 lossless。预约参数一致不能证明声卡输出零间隔。随机/推荐、重复 ID、不同采样率等边界保持原生。

Windows 包尚未实现，不能在 Windows 安装本 Mac 包；详见 [Windows 详细实施方案](../docs/WINDOWS_GAPLESS_IMPLEMENTATION.md)。
