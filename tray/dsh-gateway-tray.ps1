# DSH 局域网网关 - 托盘宿主（无窗口）
#
# 由 start-tray.vbs 以 -WindowStyle Hidden 启动：不弹控制台，只在通知区域放一个图标。
# 托盘菜单可以打开设置页、复制手机地址、重启网关、看日志、退出。
# 退出时会停掉它启动的网关进程。

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $Here
$IconPath = Join-Path $Here 'gateway.ico'
$TrayLog = Join-Path $Here 'tray.log'
$PidFile = Join-Path $Here 'tray.pid'

# 记下自己的 PID，stop-tray 才能准确定位（命令行匹配会误伤父 shell）。
try { Set-Content -Path $PidFile -Value $PID -Encoding ASCII } catch { }

function Write-Tray([string]$Message) {
  $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $Message
  Add-Content -Path $TrayLog -Value $line -Encoding UTF8
}

function Get-ConfigPath {
  $beside = Join-Path $Root 'config.json'
  if (Test-Path $beside) { return $beside }
  return (Join-Path $Root 'gateway\config.json')
}

function Get-GatewaySettings {
  $path = Get-ConfigPath
  $port = 3080
  $hostAddress = '127.0.0.1'
  if (Test-Path $path) {
    try {
      $config = Get-Content $path -Raw | ConvertFrom-Json
      if ($config.listenPort) { $port = [int]$config.listenPort }
      if ($config.listenHost) { $hostAddress = [string]$config.listenHost }
    } catch { Write-Tray ('读取配置失败: ' + $_.Exception.Message) }
  }
  return @{ Port = $port; HostAddress = $hostAddress; Path = $path }
}

function Resolve-NodeExecutable {
  $bundled = Join-Path $Root 'node\node.exe'
  if (Test-Path $bundled) { return $bundled }
  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $fallback = 'D:\nodejs\node.exe'
  if (Test-Path $fallback) { return $fallback }
  return $null
}

function Test-GatewayPort([int]$Port) {
  try {
    $client = New-Object Net.Sockets.TcpClient
    $client.Connect('127.0.0.1', $Port)
    $client.Close()
    return $true
  } catch { return $false }
}

function Start-Gateway {
  $settings = Get-GatewaySettings
  if (Test-GatewayPort $settings.Port) {
    Write-Tray ('端口 ' + $settings.Port + ' 已在监听，复用现有实例')
    return
  }
  $exe = Join-Path $Root 'dsh-gateway.exe'
  if (Test-Path $exe) {
    $script:GatewayProcess = Start-Process -FilePath $exe -WindowStyle Hidden -PassThru
  } else {
    $node = Resolve-NodeExecutable
    $server = Join-Path $Root 'gateway\server.mjs'
    if ($node -eq $null -or -not (Test-Path $server)) {
      Write-Tray '找不到可执行文件或 server.mjs，无法启动'
      return
    }
    $script:GatewayProcess = Start-Process -FilePath $node -ArgumentList ('"' + $server + '"') -WindowStyle Hidden -PassThru
  }
  Write-Tray ('已启动网关 pid=' + $script:GatewayProcess.Id)
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    if (Test-GatewayPort $settings.Port) { Write-Tray ('端口 ' + $settings.Port + ' 就绪'); break }
  }
}

function Stop-Gateway {
  if ($script:GatewayProcess -ne $null -and -not $script:GatewayProcess.HasExited) {
    try { $script:GatewayProcess.Kill(); Write-Tray ('已停止网关 pid=' + $script:GatewayProcess.Id) } catch { }
  }
  $script:GatewayProcess = $null
  # 兜底：按端口清理（例如复用了外部实例时应由用户自行管理，这里只清理我们起的）
}

function Get-PhoneUrl {
  $settings = Get-GatewaySettings
  $hostAddress = $settings.HostAddress
  if ($hostAddress -eq '0.0.0.0' -or $hostAddress -eq '') { $hostAddress = '127.0.0.1' }
  return ('http://' + $hostAddress + ':' + $settings.Port)
}

function Get-SettingsUrl {
  $settings = Get-GatewaySettings
  return ('http://127.0.0.1:' + $settings.Port + '/_gw/settings')
}

function Show-FirstRunPassword {
  $logDir = if (Test-Path (Join-Path $Root 'logs')) { Join-Path $Root 'logs' } else { Join-Path $Root 'gateway\logs' }
  if (-not (Test-Path $logDir)) { return }
  $latest = Get-ChildItem $logDir -Filter 'gateway-*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
  if ($latest -eq $null) { return }
  $match = Select-String -Path $latest.FullName -Pattern 'temporary password is (\S+)' -Encoding UTF8 | Select-Object -Last 1
  if ($match -eq $null) { return }
  $password = $match.Matches[0].Groups[1].Value
  $script:Notify.ShowBalloonTip(15000, 'DSH 局域网网关', '首次启动密码：' + $password + '  请记下，登录后可在设置页修改。', [System.Windows.Forms.ToolTipIcon]::Info)
}

# ── 托盘与菜单 ────────────────────────────────────────────────────────────────

$script:GatewayProcess = $null

$script:Notify = New-Object System.Windows.Forms.NotifyIcon
if (Test-Path $IconPath) {
  $script:Notify.Icon = New-Object System.Drawing.Icon($IconPath)
} else {
  $script:Notify.Icon = [System.Drawing.SystemIcons]::Shield
}
$script:Notify.Text = 'DSH 局域网网关'
$script:Notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$itemSettings = $menu.Items.Add('打开网关设置页')
$itemPhone = $menu.Items.Add('打开手机页面')
$itemCopy = $menu.Items.Add('复制手机地址')
$menu.Items.Add('-') | Out-Null
$itemRestart = $menu.Items.Add('重启网关')
$itemLogs = $menu.Items.Add('打开日志目录')
$menu.Items.Add('-') | Out-Null
$itemExit = $menu.Items.Add('退出')

$itemSettings.add_Click({ Start-Process (Get-SettingsUrl) })
$itemPhone.add_Click({ Start-Process (Get-PhoneUrl) })
$itemCopy.add_Click({
  Set-Clipboard -Value (Get-PhoneUrl)
  $script:Notify.ShowBalloonTip(4000, 'DSH 局域网网关', '已复制：' + (Get-PhoneUrl), [System.Windows.Forms.ToolTipIcon]::Info)
})
$itemRestart.add_Click({
  Write-Tray '菜单：重启网关'
  Stop-Gateway
  Start-Sleep -Milliseconds 600
  Start-Gateway
  $script:Notify.ShowBalloonTip(4000, 'DSH 局域网网关', '网关已重启', [System.Windows.Forms.ToolTipIcon]::Info)
})
$itemLogs.add_Click({
  $logDir = if (Test-Path (Join-Path $Root 'logs')) { Join-Path $Root 'logs' } else { Join-Path $Root 'gateway\logs' }
  if (Test-Path $logDir) { Start-Process explorer.exe $logDir } else { Start-Process explorer.exe $Root }
})
$itemExit.add_Click({
  Write-Tray '菜单：退出'
  Stop-Gateway
  try { Remove-Item $PidFile -Force -ErrorAction SilentlyContinue } catch { }
  $script:Notify.Visible = $false
  $script:Notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

$script:Notify.ContextMenuStrip = $menu
$script:Notify.add_MouseDoubleClick({ Start-Process (Get-SettingsUrl) })

# 需要一个隐藏窗体承载消息循环；托盘才能响应点击。
$form = New-Object System.Windows.Forms.Form
$form.Text = 'DSH 局域网网关'
$form.ShowInTaskbar = $false
$form.WindowState = 'Minimized'
$form.FormBorderStyle = 'None'
$form.Opacity = 0
$form.Size = New-Object System.Drawing.Size(1, 1)
$form.add_Shown({
  $form.Hide()
  Start-Gateway
  Show-FirstRunPassword
  $settings = Get-GatewaySettings
  $script:Notify.Text = 'DSH 局域网网关 · ' + $settings.HostAddress + ':' + $settings.Port
})

[System.Windows.Forms.Application]::Run($form)
