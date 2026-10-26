#!/usr/bin/env python3
"""旧手工 APK 打包入口已停用；使用 ImmortalWrt SDK 生成正式 APK。"""
import sys

sys.exit("手工 tar 不能替代 OpenWrt APK。请运行 GitHub Actions 的 Build APK，"
         "或执行 bash scripts/build-apk.sh <SDK目录> <输出目录> <target> <subtarget>。")
