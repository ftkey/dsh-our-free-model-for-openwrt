#!/usr/bin/env bash
# 保留已有 APK 构建命令。
set -euo pipefail
[[ $# == 4 ]] || { echo "用法: $0 <SDK目录> <输出目录> <target> <subtarget>" >&2; exit 2; }
exec bash "$(dirname "${BASH_SOURCE[0]}")/build-package.sh" "$@" apk
