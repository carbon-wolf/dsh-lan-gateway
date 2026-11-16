# DSH 局域网网关 v0.1.0

给 DeepSeek Harness 桌面版加一个带密码的局域网入口：手机、平板、另一台电脑的浏览器，直接接着用桌面版里**同一个** Host——相同会话、进行中的任务、文件与审批弹窗，不复制数据。

## 下载

**`dsh-gateway.exe`（约 81 MB，Windows 10/11 x64）** —— 内置 Node 运行时，**不需要安装 Node、不需要配置环境**。

## 三步开始

1. 把 exe 放进一个空文件夹（例如 `D:\dsh-gateway`），双击运行。
2. 首次启动会自动选本机网卡地址、生成随机密码，并在窗口里打印两行关键信息：
   ```
   gateway: temporary password is xxxxxxxxxxxx
   gateway: listening on http://192.168.1.23:3080
   ```
   第一次连不上时，Windows 防火墙会弹窗，选「允许访问」。
3. 手机连同一个 WiFi，浏览器打开上面那个地址，输入密码。

想要固定密码？登录后在设置页「密码」里改；或者用 `dsh-gateway.exe --set-password 新密码`。

## 里面有什么

- **同一份数据**：反向代理到桌面版正在跑的 Host（`127.0.0.1` 随机端口，自动发现），手机与桌面看到的是同一会话、同一进度。
- **密码保护**：scrypt 哈希 + HMAC 签名 cookie，连续失败会锁定；「锁定网关」在服务端吊销会话。
- **设备管理**：看到哪台设备登录过、加备注、单独登出；同地址同 UA 只保留一条，脚本流量不计入。
- **底部统计可点**：`N 轮 · tok/s`、`M tok · 缓存命中`、上下文占比，点一下出「会话统计 / Token 用量」面板（横幅面板被锚点算到屏幕外的问题已兜底）。
- **零依赖**：只用到 Node 内置模块；exe 里已内嵌注入用的 CSS/JS。

## 数据放在哪

全部在 exe 同目录，拷走文件夹即迁移：

| 文件 | 内容 |
|---|---|
| `config.json` | 监听地址、端口、登录保持、注入开关、TLS |
| `auth.json` | 密码哈希与签名密钥（**勿外传**） |
| `sessions.json` | 已登录设备记录（含会话签名，**勿外传**） |
| `logs\` | 每日运行日志 |

## 停止与自启

- 关闭窗口即停止；再次双击即恢复。
- 需要开机自启：给 exe 建快捷方式放进
  `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`。

## 限制

- 仅 Windows；需要桌面版 DeepSeek Harness 正在运行（网关只是转发，不代替它）。
- 默认 HTTP 明文，同网段可嗅探；需要加密请在设置页填 TLS 证书与私钥。
- 拿到密码 = 完整 owner 权限（可执行命令、改文件），只在可信局域网使用，不要做公网端口映射。
- 首次运行 exe 可能出现 SmartScreen 提示（未签名）：点「更多信息 → 仍要运行」。

## 从源码运行

```bat
git clone https://github.com/carbon-wolf/dsh-lan-gateway.git
cd dsh-lan-gateway
setup.cmd
```

详见仓库 README。自己构建 exe：`npm install && npm run build:exe`。
