#!/usr/bin/env bash
# 使用 SDK 配方生成完整 IPK，与 APK 共用安装内容及依赖声明。
set -euo pipefail
[[ $# == 4 ]] || { echo "用法: $0 <SDK目录> <输出目录> <target> <subtarget>" >&2; exit 2; }
exec bash "$(dirname "${BASH_SOURCE[0]}")/scripts/build-package.sh" "$@" ipk
