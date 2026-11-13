# macOS 无缝播放 0.1.3

仅增加无缝衔接。网易云负责音质选择、授权音源、队列和原生 UI；插件不修改歌词布局，不引入主题、EQ、交叉淡化或静音裁剪。输出经过 Web Audio，不能保证与原生输出完全等价。

实测：macOS 26.6.2 arm64、网易云音乐 3.1.12（3444）、BetterNCM-mac 0.1.7。未知客户端版本保持原生。

## 文件与打包

- `player.js`：Mac 状态/协议、候选接认与原生恢复。
- `startup.js`：启动期原生桥包装与事务回调。
- `../shared/audio-resources.js`：授权源、限额、独立解码与缓存。
- `../shared/playback-clock.js`：播放时钟、预约、取消与累计听音时间。

在仓库根目录执行 `python3 mac/package.py`，生成 `dist/gapless-player-mac-0.1.3.plugin`。这是源码 ZIP 打包，不执行前端/应用构建。

## 安装与使用

1. 使用 [BetterNCM-mac](https://github.com/OyangDer/betterncm-mac) 官方安装渠道；确认网易云为上面的实测版本。
2. 已有插件时先关闭并备份旧 `.plugin`，备份放到 `plugins` 目录之外，避免相同 slug 同时加载多个版本。
3. 将本版 `.plugin` 放入 `~/Library/Application Support/BetterNCM-mac/plugins/`，由 BetterNCM 重新提取/加载，必要时退出网易云后从原应用打开。
4. 标题栏插件菜单保留一项「无缝播放」。本版使用宿主已有开关和保存接口，不新增 CSS；关闭时先恢复原生位置和播放意图，本开关无需页面刷新。
5. 当前与下一首都完成解码、同规格且队列可信后才接管，在同一音频时钟连续开始。资源、权限、音效或队列不兼容时保持/恢复原生，不另选低音质。

本机已安装 0.1.3；0.1.2 备份在 BetterNCM profile 的 `backups/gapless-0.1.2/`，仓库 releases 也保留旧包。仓库不含该用户 profile、账号、音源 URL 或音乐缓存。

## 确认范围

0.1.3 保留已准备的可信下一首，不因暂停、同曲目 Load 或当前仍在准备而提前清理；暂停不新发下载。首次接管入口余量从 2 秒缩为 0.5 秒，每次异步等待后仍须至少剩余 0.12 秒；预约本身保留 0.08 秒提交保护。

针对 Baptized In Fear → Open Hearts，在暂停 Seek 后继续、原生 Seek 到最后 1.2 秒后重新接管两个场景的 400 ms 实际立体声缓冲未发现静音帧；补充的 600 ms 窗口覆盖原生接认之后，也未发现静音。接认未重新启动音频节点。这里测量的是 Web Audio 输出增益节点，未回录声卡输出，不能把它等同于已消除全部听感间隔。详见 [本轮排查](../docs/AUDIBLE_GAP_REVIEW.md)。

0.1.2 复核拖动后立刻暂停、暂停时连续拖动、播放中向后拖动，以及首次接管中途拖动的原生 SDK 路径；进度条逐帧记录未见目标→旧位置→目标。鼠标拖动的全部手势和边界竞态未穷举，详见 [副作用审查](../docs/SIDE_EFFECTS_REVIEW.md)。普通切歌、歌词、开关和恢复的上一版证据保留在 [0.1.1 记录](../docs/REMEDIATION.md)。

暂停后不发送重复进度心跳。已接管时拖动取消旧预约并按新位置重算；初次准备/接管中途拖动时，保留解码资源，等待原生 Seek 完成及 400 ms 稳定窗口后自动重新尝试，不会让整首退出。已实测初次 Seek 后重新接管并实际跨曲。

原生 Hi-Res 选择为 1999、音量为 0.48；示例曲目原生可用档位为 lossless。预约参数一致不能证明声卡输出零间隔。随机/推荐、重复 ID、不同采样率等边界保持原生。

Windows 包尚未实现，不能在 Windows 安装本 Mac 包；详见 [Windows 详细实施方案](../docs/WINDOWS_GAPLESS_IMPLEMENTATION.md)。
