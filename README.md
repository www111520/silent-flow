# QQ 群技术信息采集器

当前仓库已在目标电脑完成 2A 的主要落地验证。代码覆盖可靠接收、任务处理、登录启动、备份维护，以及带鉴权的本机运行/审核工作台；真实 NapCat、QQ 账号、本地模型、回环网络连接和登录启动任务均已联调。

## 已实现

- OneBot V11 反向 WebSocket 回环监听和 Bearer Token 鉴权
- 群白名单、发送者哈希、文本规范化和非文本 `skipped` 落库
- 信息类型、技术领域、地点、来源、产品、版本和事件时间结构化提取
- SQLite WAL、`synchronous=FULL`、消息与任务原子提交及组合去重
- 持久化租约、崩溃后重新领取、指数退避、死信和重新入队
- 模型结果结构校验、待审核创建、人工修正和乐观锁审计
- 模型鉴权失败暂停整个分析队列，修复后继续原任务
- OpenAI 兼容模型适配器、后台分析循环和安全停机
- Windows 当前用户登录启动、磁盘紧急空间和定期备份轮换
- OneBot 仅监听回环地址；运行与审核工作台可用独立管理令牌在可信局域网访问
- 健康状态和队列统计查看、暂停队列恢复、提前重试、人工审核与死信重新入队
- 在电脑或手机工作台查看、添加和移除多个采集群，修改立即生效并写回配置
- 在工作台按时间浏览已完成分类的信息和待审核标记
- 带公式注入防护的 UTF-8 CSV 导出
- WebSocket、SQLite 和模拟模型端到端自动化测试

## 本地运行

要求 Node.js 24 和 pnpm。

```powershell
Copy-Item .env.example .env
pnpm install
pnpm check
pnpm start
```

启动前必须修改 `.env` 中的两个随机令牌、发送者哈希盐和群白名单。`ONEBOT_TOKEN` 与 `ADMIN_TOKEN` 必须使用不同的随机值，且均不少于 32 个字符。NapCat 的反向 WebSocket 地址配置为 `ws://127.0.0.1:3001`，请求头使用 `Authorization: Bearer <ONEBOT_TOKEN>`。

也可以用本机配置脚本生成互不相同的随机令牌，并明确指定群白名单：

```powershell
.\scripts\configure-local.ps1 -GroupWhitelist "123456789" -ModelAlias "qwen3-4b-instruct"
```

脚本默认拒绝覆盖已有 `.env`；只有明确传入 `-Force` 才会重新生成全部密钥。

启动后可在电脑打开 `http://127.0.0.1:3002`，或让同一可信局域网内的手机打开 `http://<电脑局域网IP>:3002`，输入 `ADMIN_TOKEN` 进入完整工作台。工作台可监听 `0.0.0.0`，但 OneBot 接口仍只监听回环地址；不要做公网端口映射，也不要在公共 Wi-Fi 使用手机工作台。

工作台的“模型设置”允许每台电脑填写自己的 OpenAI 兼容接口、模型名和 API Key。密钥不会通过读取接口返回，也不会在不同安装之间共享；把产品交给别人时，应让对方在自己的安装中填写自己的密钥，不要复制你的 `.env`。

构建完成后可安装到 D 盘并创建桌面快捷方式：

```powershell
.\scripts\install-product.ps1 -InstallDirectory "D:\QQTechInfoCollector"
```

默认示例使用本机 OpenAI 兼容模型地址，不产生第三方模型 API 费用。系统不会在本地模型不可用时自动切换到云端。

完成配置和构建后，可以注册当前 Windows 用户登录启动任务：

```powershell
pnpm startup:install
```

如果使用便携式本地模型和 NapCat，可以在 PowerShell 中把它们一并注册为登录启动任务：

```powershell
.\scripts\install-startup.ps1 `
  -NodeExecutable "D:\QQCollectorTools\node\node.exe" `
  -ModelExecutable "D:\QQCollectorTools\llama.cpp\llama-server.exe" `
  -ModelPath "D:\QQCollectorData\Models\qwen3-4b-instruct.gguf" `
  -ModelAlias "qwen3-4b-instruct" `
  -NapCatExecutable "D:\QQCollectorTools\NapCat\NapCat.52230.Shell\NapCatWinBootMain.exe" `
  -NapCatQuickLogin "123456789"
```

Node、模型和 NapCat 参数都是可选的；提供时脚本会先验证文件存在，再创建独立、可重启且仅限当前交互用户的任务。正式登录启动应给出稳定的 `NodeExecutable`，不要依赖临时开发环境的 PATH。`ModelAlias` 必须与 `.env` 中的 `LLM_MODEL` 一致；`NapCatQuickLogin` 用于避免每次登录 Windows 后重新扫码。

移除启动任务使用 `pnpm startup:remove`。任务在该用户登录后运行，切换到电池供电时保持运行，错过登录触发后会尽快补启动；不会伪装成无需桌面会话的系统服务。

## 当前边界

- 只处理实时群消息，不补采断线期间的历史消息。
- 纯非文本消息保存为 `skipped`，不调用模型。
- 已提供 Windows 当前用户登录启动脚本和响应式手机工作台，尚无正式安装器和公网远程访问。
- 运行与审核工作台可用于电脑及可信局域网内的手机操作，但首次配置仍需手工编辑 `.env`。
- 当前目标电脑已完成 NapCat 登录、OneBot 心跳、真实本地模型推理和三项登录启动任务验证。由于连接后尚未出现新的白名单群消息，还需用首条自然产生的新消息观察一次真实接收、落库和分析闭环；自动化端到端测试已覆盖同一流程。

## 安卓 App

`android-app` 提供原生 Android 安装包外壳：启动时会通过 UDP 3003 在同一局域网自动发现电脑工作台，电脑 IP 变化后无需重新配置；手动地址仍作为备用。右上角可以随时更换地址，管理令牌仍由工作台登录页输入，不会固化进 APK。

本地构建（需要 JDK 17、Android API 37 与 Build Tools 36.0.0）：

```powershell
.\android-app\build-apk.ps1 -SdkRoot <Android SDK 路径> -JdkRoot <JDK 17 路径>
```

输出文件位于 `android-app/app/build/outputs/apk/debug/grasswood-workbench-debug.apk`。

## 许可证

本项目使用 MIT License，详见 `LICENSE`。
