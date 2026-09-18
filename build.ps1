# ShortFilm 手动构建脚本（Windows 本机）
# 用法：.\build.ps1 [-Target msi|nsis|all] [-SkipSidecar]
# 说明：本机只能构建 Windows 包；macOS/Linux 包必须在对应系统上跑 build.sh。
param(
    [string]$Target = "all",
    [switch]$SkipSidecar
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# 1. 校验 ffmpeg sidecar
if (-not $SkipSidecar) {
    $sidecar = "src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe"
    if (-not (Test-Path $sidecar)) { Write-Error "缺少 $sidecar，请先放置 ffmpeg sidecar"; }
    $size = (Get-Item $sidecar).Length
    if ($size -lt 1MB) { Write-Error "$sidecar 是占位文件（$size 字节），请替换为真实 ffmpeg 二进制" }
    Write-Host "ffmpeg sidecar 就绪: $sidecar ($([math]::Round($size/1MB,1)) MB)" -ForegroundColor Green
}

# 2. 构建
Write-Host "开始构建 Windows 包（target=$Target）……" -ForegroundColor Cyan
cargo tauri build --bundles $Target
if ($LASTEXITCODE -ne 0) { Write-Error "构建失败" }

# 3. 产物清单
Write-Host "`n构建完成，产物：" -ForegroundColor Green
Get-ChildItem -Recurse "src-tauri/target/release/bundle" -Include *.msi,*.exe | ForEach-Object {
    Write-Host ("  {0}  ({1:N1} MB)" -f $_.FullName, ($_.Length/1MB)) -ForegroundColor White
}
Write-Host "`n把安装包直接发给别人即可（自包含 ffmpeg，对方无需安装任何东西）。" -ForegroundColor Cyan
