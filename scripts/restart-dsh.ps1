# 一键重启本机 DSH（profile web）。
# 用法：右键「使用 PowerShell 运行」，或在终端执行：
#   powershell -ExecutionPolicy Bypass -File .\scripts\restart-dsh.ps1 [-Checkout <路径>] [-Port <端口>]
# 注意：重启会断开 Web GUI 与当前 agent 会话（会话可从 JSONL 恢复）。

param(
    [string]$Checkout = 'C:\1\DeepSeek Harness',
    [int]$Port = 3080
)

$ErrorActionPreference = 'Stop'

$port = $Port
$checkout = $Checkout
$logOut = Join-Path $env:USERPROFILE '.dsh\dsh-run.log'
$logErr = Join-Path $env:USERPROFILE '.dsh\dsh-run.log.err'

# 1. 停掉占用端口的旧进程
$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    $pid = ($conn | Select-Object -First 1).OwningProcess
    Write-Host "stopping old DSH process $pid ..."
    Stop-Process -Id $pid -Force
    Start-Sleep -Seconds 3
} else {
    Write-Host 'no process listening on 3080'
}

# 2. 从 checkout 重启（输出重定向到 ~/.dsh，便于排查）
Write-Host "starting DSH from $checkout ..."
Start-Process -FilePath 'node' `
    -ArgumentList '--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web' `
    -WorkingDirectory $checkout `
    -RedirectStandardOutput $logOut `
    -RedirectStandardError $logErr `
    -WindowStyle Hidden

Write-Host 'started. 等待就绪...'
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($conn) { Write-Host "DSH is up (pid $($conn.OwningProcess)). GUI: http://127.0.0.1:$port"; exit 0 }
    if ((Test-Path $logErr) -and (Get-Item $logErr).Length -gt 0) {
        Write-Host '--- startup stderr (tail) ---'
        Get-Content $logErr -Tail 20
        exit 1
    }
}
Write-Host 'startup timeout; check ~/.dsh/dsh-run.log(.err)'
exit 1
