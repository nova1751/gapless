# 原生接入实际尝试：未进入播放原型

日期：2026-11-15。用户授权尝试纯原生无缝，接不通则停止。当前网易云 Mac 3.1.12（3444）、BetterNCM-mac 0.1.7、播放插件 0.2.3。

**本次未实现纯原生无缝。已实现并运行一个主进程访问探针，但在原生模块接入前置条件处受阻，未进入独立预加载、流接认或真实原生跨曲验证。不是已运行的 gapless 原型，也不是证明网易云底层无法无缝。**

## 实际运行结果

[probe-native-access-mac.c](../tools/probe-native-access-mac.c)只接受已核对的网易云主进程路径，调用 `task_for_pid` 检查访问结果，立即释放取得的端口。它不附加调试器、不暂停进程、不读写远程内存、不创建远程线程，也不调用音频方法。

用本机 Command Line Tools 编译这个单文件诊断工具，开启 `-Wall -Wextra -Werror`；产物放在 `/tmp`，不进入插件包。随后分别运行普通探针、仅对该临时探针添加 `com.apple.security.cs.debugger` 声明并临时签名后的探针：

| 调用方 | 自身 task 结果 | 网易云主进程 task 结果 | 取得原生控制端口 |
|---|---|---|---|
| 普通本地诊断工具 | `0`，成功 | `5`，`KERN_FAILURE` | 否 |
| 带 debugger 声明的临时诊断工具 | `0`，成功 | `5`，`KERN_FAILURE` | 否 |

本机客户端原签名启用 Hardened Runtime 和 App Sandbox；`disable-library-validation` 为 true，但没有 `get-task-allow` 或 `allow-dyld-environment-variables` 声明。这两个缺失与访问失败及启动注入受限一致；内核错误本身没有给出唯一原因，不将它描述为已定位到某一内部权限检查。

苹果文档说明：调试声明不能保证取得未开放 Get Task Allow 的受保护目标端口；让 Hardened Runtime 应用接受 `DYLD_` 环境变量则需要相应声明。关闭 library validation 与允许环境变量是不同条件，不能只见到前者就认为 dylib 已能注入。[调试工具声明](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.debugger)、[DYLD 环境变量声明](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.allow-dyld-environment-variables)

再次检查已安装宿主：`src/plugins.mjs:234` 忽略 manifest 的 `native_plugin`，`src/server.mjs:337–340` 和 `src/prelude/native-shim.js:46–47` 枚举空原生 API，并拒绝原生插件调用。没有可直接替代进程访问的宿主原生加载路径。原始可执行文件导入了 `dlopen`，这只能说明程序内部使用动态加载，不能作为外部插件可加载或可以执行任意代码的证据。

## 停止位置与未完成范围

在保持当前客户端原签名、当前宿主和系统保护的条件下，本次检查到的接入途径不足以运行原生播放原型。没有继续重签网易云、修改其可执行文件、增添加载命令、调整系统保护或复制客户端启动第二个播放器。原生 `prepareToPlay` 会切换当前流，也没有用提前 Load/Play 代替安全预加载。

[前次底层复查](NATIVE_GAPLESS_RECHECK_2026-11-15.md)发现的输出复用逻辑仍有技术价值；未完成项仍是可用主进程桥、独立下一首 provider/decoder 准备、原管理器接认及输出连续性。若未来客户端/宿主提供可用原生模块入口，可从这些步骤继续；本轮不交付假装可用的原生插件或自动回退模式。

原生私有对象适配还需要版本、线程和生命周期验证，即使解决加载，也不能据此保证音质、歌词、系统控件及跨曲均已达标。Windows 没有本机验证，不能复制 Mac 权限结果或宣称其原生路线失败。

## 对当前安装的影响

现有音乐插件源码和 0.2.3 安装包未修改，运行页面读取版本仍为 0.2.3。没有发送 Load/Play/Pause/Seek/Stop，没有重启或刷新客户端。原生文件 SHA-256 保持 `e9c6b5468749ccad69ffe24e6395d6d29af9e2f7514a2bc9697e265b89b40374`，原签名严格校验通过。诊断端口均立即释放，没有遗留调试器或原生挂钩。

验证仅覆盖新增 C 诊断工具编译及实际前置条件探测，不是音频验证。未新增测试用例、未运行应用构建或全量静态检查。最小结果见 [native-gapless-attempt-2026-11-15.json](verification/native-gapless-attempt-2026-11-15.json)。

## 复查方法

在仓库内执行以下单文件工具编译；这不是应用或插件构建：

```sh
xcrun clang -std=c11 -Wall -Wextra -Werror tools/probe-native-access-mac.c -o /tmp/gapless-native-access-probe
```

取得网易云主进程当前 PID 后，用 `/tmp/gapless-native-access-probe <PID>` 检查。进程路径不符时工具拒绝运行；输出的 `controlPortAvailable` 仅表示该次取得端口，不代表已加载模块或完成无缝。不把 PID、系统签名声明或内存偏移硬编码进播放插件。
