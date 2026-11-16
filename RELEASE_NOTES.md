# DSH 局域网网关 v0.1.1

给 DeepSeek Harness 桌面版加一个带密码的局域网入口：手机、平板、另一台电脑的浏览器，直接接着用桌面版里**同一个** Host——相同会话、进行中的任务、文件与审批弹窗，不复制数据。

## 本次新增：无窗口托盘版

`dsh-gateway-tray.zip` 解压出 `tray\` 目录，放到 `dsh-gateway.exe` 旁边，双击 `tray\start-tray.vbs`：

- **不弹控制台窗口**，只在通知区域出现一个图标；
- 右键菜单：打开网关设置页 / 打开手机页面 / 复制手机地址 / 重启网关 / 打开日志目录 / 退出；
- 双击图标直接打开设置页；
- 首次启动会气泡提示临时密码；
- `tray\install-autostart.cmd`：让托盘随登录静默启动；
- `tray\stop-tray.cmd`：连托盘带网关一起停掉。

## 下载

| 文件 | 说明 |
|---|---|
| **`dsh-gateway.exe`**（81.4 MB） | 单文件网关，内置 Node 运行时，双击即用 |
| **`dsh-gateway-tray.zip`**（几 KB） | 托盘宿主，解压到 exe 旁即为无窗口模式 |

两个都下，解压后目录长这样：

```
D:\dsh-gateway\
  dsh-gateway.exe
  tray\
    dsh-gateway-tray.ps1
    start-tray.vbs
    stop-tray.cmd
    install-autostart.cmd
    gateway.ico
```

## 三步开始

1. 双击 `dsh-gateway.exe`（或 `tray\start-tray.vbs` 走无窗口模式）。
2. 首次启动自动选本机网卡地址、生成随机密码，打印/气泡提示：
   ```
   gateway: temporary password is xxxxxxxxxxxx
   gateway: listening on http://192.168.1.23:3080
   ```
   防火墙弹窗选「允许访问」。
3. 手机连同一 WiFi，浏览器打开该地址，输入密码。

改密码：设置页「密码」，或 `dsh-gateway.exe --set-password 新密码`。

## 里面有什么

- **同一份数据**：反向代理到桌面版正在跑的 Host（`127.0.0.1` 随机端口，自动发现），手机与桌面看到的是同一会话、同一进度。
- **密码保护**：scrypt 哈希 + HMAC 签名 cookie，连续失败锁定；「锁定网关」在服务端吊销会话。
- **设备管理**：看到哪台设备登录过、加备注、单独登出；同地址同 UA 只保留一条，脚本流量不计入。
- **底部统计可点**：`N 轮 · tok/s`、`M tok · 缓存命中`、上下文占比，点一下出「会话统计 / Token 用量」面板。
- **零依赖**：只用 Node 内置模块；注入用的 CSS/JS 已内嵌进 exe。

## 数据放在哪

全部在 exe 同目录，拷走文件夹即迁移：

| 文件 | 内容 |
|---|---|
| `config.json` | 监听地址、端口、登录保持、注入开关、TLS |
| `auth.json` | 密码哈希与签名密钥（**勿外传**） |
| `sessions.json` | 已登录设备记录（含会话签名，**勿外传**） |
| `logs\` | 每日运行日志 |

## 限制

- 仅 Windows；需要桌面版 DeepSeek Harness 正在运行（网关只转发，不代替它）。
- 默认 HTTP 明文，同网段可嗅探；需要加密请在设置页填 TLS 证书与私钥。
- 拿到密码 = 完整 owner 权限（可执行命令、改文件），只在可信局域网使用，不要做公网端口映射。
- exe 未签名，首次运行可能出现 SmartScreen 提示：点「更多信息 → 仍要运行」。
- 托盘需要 PowerShell（Windows 自带），不需要额外安装。

## 从源码运行

```bat
git clone https://github.com/carbon-wolf/dsh-lan-gateway.git
cd dsh-lan-gateway
setup.cmd
```

构建单文件 exe：`npm install && npm run build:exe`。
