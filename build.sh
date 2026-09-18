#!/usr/bin/env bash
# ShortFilm 手动构建脚本（macOS / Linux 机器）
# 用法：bash build.sh [all|app|dmg|appimage|deb]
# 说明：Windows 包必须在 Windows 上跑 build.ps1；Tauri 无法跨系统交叉构建安装包。
set -euo pipefail

TARGET="${1:-all}"
cd "$(dirname "$0")"

# 1. 平台与 sidecar 校验
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  sidecar="src-tauri/binaries/ffmpeg-aarch64-apple-darwin" ;;
  Darwin-x86_64) sidecar="src-tauri/binaries/ffmpeg-x86_64-apple-darwin" ;;
  Linux-x86_64)  sidecar="src-tauri/binaries/ffmpeg-x86_64-unknown-linux-gnu" ;;
  MINGW*|MSYS*|CYGWIN*) echo "错误：Windows 上请使用 build.ps1（Tauri 安装包不能在 Git Bash 里构建）" >&2; exit 1 ;;
  *) echo "错误：不支持的构建平台 $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

[ -f "$sidecar" ] || { echo "错误：缺少 $sidecar" >&2; exit 1; }
size=$(stat -c%s "$sidecar" 2>/dev/null || stat -f%z "$sidecar")
[ "$size" -lt 1000000 ] && { echo "错误：$sidecar 是占位文件（${size} 字节）" >&2; exit 1; }
chmod +x "$sidecar"
echo "ffmpeg sidecar 就绪: $sidecar ($((size / 1024 / 1024)) MB)"

# 2. 构建
echo "开始构建（bundle=$TARGET）……"
cargo tauri build --bundles "$TARGET"

# 3. 产物清单
echo
echo "构建完成，产物："
find src-tauri/target/release/bundle -type f \( -name "*.dmg" -o -name "*.app" -o -name "*.AppImage" -o -name "*.deb" \) -exec ls -lh {} \;
echo
echo "把安装包直接发给别人即可（自包含 ffmpeg，对方无需安装任何东西）。"
