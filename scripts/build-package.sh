#!/usr/bin/env bash
# 使用真实 ImmortalWrt SDK 生成并校验 APK 或 IPK（主程序）。
set -euo pipefail

[[ $# == 5 ]] || { echo "用法: $0 <SDK目录> <输出目录> <target> <subtarget> <apk|ipk>" >&2; exit 2; }
PACKAGE_FORMAT="$5"
[[ "$PACKAGE_FORMAT" == apk || "$PACKAGE_FORMAT" == ipk ]] || { echo '打包格式必须为 apk 或 ipk' >&2; exit 2; }
SDK_ROOT="$(cd "$1" && pwd)"
mkdir -p "$2"
OUTPUT_DIR="$(cd "$2" && pwd)"
TARGET="$3"
SUBTARGET="$4"
[[ "$TARGET" =~ ^[a-z0-9_]+$ && "$SUBTARGET" =~ ^[a-z0-9_]+$ ]] || exit 2
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_NAME=dsh-our-free-model-for-openwrt

[[ -x "$SDK_ROOT/scripts/feeds" && -f "$SDK_ROOT/include/package.mk" ]] || {
  echo "不是有效的 ImmortalWrt SDK: $SDK_ROOT" >&2; exit 1;
}
[[ -f "$REPO_ROOT/payload/packages/standalone/cli.mjs" &&
   -f "$REPO_ROOT/payload/packages/standalone/web/index.html" &&
   -f "$REPO_ROOT/payload/LICENSE" ]] || {
  echo 'payload 不完整，请先运行 build-payload.sh' >&2; exit 1;
}
[[ -f "$REPO_ROOT/scripts/bun-assets.json" ]] || {
  echo '缺少 Bun 资产清单 scripts/bun-assets.json（LuCI 按需下载使用）' >&2; exit 1;
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

PACKAGE_DIR="$SDK_ROOT/package/$PKG_NAME"
mkdir -p "$PACKAGE_DIR"
rsync -a --delete "$REPO_ROOT/payload/" "$PACKAGE_DIR/payload/"
rsync -a --delete "$REPO_ROOT/files/" "$PACKAGE_DIR/files/"
cp "$REPO_ROOT/Makefile" "$PACKAGE_DIR/Makefile"
mkdir -p "$PACKAGE_DIR/scripts"
cp "$REPO_ROOT/scripts/bun-assets.json" "$PACKAGE_DIR/scripts/bun-assets.json"
chmod 755 "$PACKAGE_DIR/files/etc/init.d/ourfreemodel"

cat > "$SDK_ROOT/.config" <<CONFIG
CONFIG_TARGET_${TARGET}=y
CONFIG_TARGET_${TARGET}_${SUBTARGET}=y
CONFIG_TARGET_MULTI_PROFILE=y
CONFIG_DEVEL=y
CONFIG_BUILD_LOG=y
CONFIG_ALL_NONSHARED=n
CONFIG_ALL_KMODS=n
CONFIG_ALL=n
CONFIG_PACKAGE_${PKG_NAME}=m
CONFIG
if [[ "$PACKAGE_FORMAT" == apk ]]; then
  echo 'CONFIG_USE_APK=y' >> "$SDK_ROOT/.config"
else
  echo '# CONFIG_USE_APK is not set' >> "$SDK_ROOT/.config"
fi
make -C "$SDK_ROOT" defconfig
if [[ "$PACKAGE_FORMAT" == apk ]]; then
  grep -qx 'CONFIG_USE_APK=y' "$SDK_ROOT/.config" || { echo 'SDK 未启用 APK 打包。' >&2; exit 1; }
else
  if grep -qx 'CONFIG_USE_APK=y' "$SDK_ROOT/.config"; then
    echo 'SDK 未关闭 APK 模式，无法生成 IPK。' >&2; exit 1
  fi
  [[ -f "$SDK_ROOT/scripts/ipkg-build" ]] || { echo 'SDK 缺少 IPK 打包工具。' >&2; exit 1; }
fi
if ! grep -Eq "^CONFIG_PACKAGE_${PKG_NAME}=[my]$" "$SDK_ROOT/.config"; then
  echo "SDK 没有启用目标包 $PKG_NAME，请检查架构与依赖支持。" >&2; exit 1
fi
make -C "$SDK_ROOT" "package/$PKG_NAME/clean"
make -C "$SDK_ROOT" -j"$(nproc)" "package/$PKG_NAME/compile" ||
  make -C "$SDK_ROOT" -j1 "package/$PKG_NAME/compile" V=s

main_file=''
if [[ "$PACKAGE_FORMAT" == apk ]]; then
  APK_TOOL="$SDK_ROOT/staging_dir/host/bin/apk"
  [[ -x "$APK_TOOL" ]] || { echo 'SDK 未生成 apk 工具。' >&2; exit 1; }
  while IFS= read -r -d '' file; do
    metadata="$("$APK_TOOL" adbdump "$file")"
    actual_name="$(awk '/^  name: / { sub(/^  name: /, ""); print; exit }' <<< "$metadata")"
    if [[ "$actual_name" == "$PKG_NAME" ]]; then
      [[ -z "$main_file" ]] || { echo '找到多个主程序 APK。' >&2; exit 1; }
      main_file="$file"
    fi
  done < <(find "$SDK_ROOT/bin" -type f -name '*.apk' -print0)
  [[ -n "$main_file" ]] || { echo "预期一个 $PACKAGE_FORMAT，实际未找到主程序。" >&2; exit 1; }
  if [[ -f "$SDK_ROOT/public-key.pem" ]]; then
    "$APK_TOOL" verify --keys-dir "$SDK_ROOT" "$main_file"
  fi
  "$APK_TOOL" adbdump "$main_file" > "$OUTPUT_DIR/APK-METADATA.txt"
  cp "$main_file" "$OUTPUT_DIR/"
else
  while IFS= read -r -d '' file; do
    base="$(basename "$file")"
    if [[ "$base" == "${PKG_NAME}_"* ]]; then
      [[ -z "$main_file" ]] || { echo '找到多个主程序 IPK。' >&2; exit 1; }
      python3 "$REPO_ROOT/scripts/inspect-ipk.py" "$file" "$PKG_NAME" >/dev/null
      main_file="$file"
    fi
  done < <(find "$SDK_ROOT/bin" -type f -name '*.ipk' -print0)
  [[ -n "$main_file" ]] || { echo "预期一个 $PACKAGE_FORMAT，实际未找到主程序。" >&2; exit 1; }
  python3 "$REPO_ROOT/scripts/inspect-ipk.py" "$main_file" "$PKG_NAME" > "$OUTPUT_DIR/IPK-METADATA.txt"
  cp "$main_file" "$OUTPUT_DIR/"
fi
cp "$SDK_ROOT/.config" "$OUTPUT_DIR/SDK.config"
cp "$REPO_ROOT/payload/PORT-VERSION.json" "$OUTPUT_DIR/PORT-VERSION.json"
printf '%s\n' "$PACKAGE_FORMAT" > "$OUTPUT_DIR/PACKAGE-FORMAT"
( cd "$OUTPUT_DIR" && for file in ./*."$PACKAGE_FORMAT"; do
    printf '%s  %s\n' "$(sha256_of "$file")" "$file"
  done > SHA256SUMS )
echo "$PACKAGE_FORMAT -> $OUTPUT_DIR/$(basename "$main_file")"
