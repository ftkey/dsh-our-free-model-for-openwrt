#!/usr/bin/env bash
# 使用真实 ImmortalWrt SDK 生成并校验 APK v3。
set -euo pipefail

[[ $# == 4 ]] || { echo "用法: $0 <SDK目录> <输出目录> <target> <subtarget>" >&2; exit 2; }
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
PACKAGE_DIR="$SDK_ROOT/package/$PKG_NAME"
mkdir -p "$PACKAGE_DIR"
rsync -a --delete "$REPO_ROOT/payload/" "$PACKAGE_DIR/payload/"
rsync -a --delete "$REPO_ROOT/files/" "$PACKAGE_DIR/files/"
cp "$REPO_ROOT/Makefile" "$PACKAGE_DIR/Makefile"
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
make -C "$SDK_ROOT" defconfig
if ! grep -Eq "^CONFIG_PACKAGE_${PKG_NAME}=[my]$" "$SDK_ROOT/.config"; then
  echo 'SDK 没有启用目标包，请检查 node 依赖与架构支持。' >&2; exit 1
fi
make -C "$SDK_ROOT" "package/$PKG_NAME/clean"
make -C "$SDK_ROOT" -j"$(nproc)" "package/$PKG_NAME/compile" || 
  make -C "$SDK_ROOT" -j1 "package/$PKG_NAME/compile" V=s

APK_TOOL="$SDK_ROOT/staging_dir/host/bin/apk"
[[ -x "$APK_TOOL" ]] || { echo 'SDK 未生成 apk 工具；请使用支持 APK 的 snapshot SDK。' >&2; exit 1; }
count=0
while IFS= read -r -d '' file; do
  metadata="$("$APK_TOOL" adbdump "$file")"
  actual_name="$(awk '/^  name: / { sub(/^  name: /, ""); print; exit }' <<< "$metadata")"
  [[ "$actual_name" == "$PKG_NAME" ]] || continue
  count=$((count + 1))
  selected_file="$file"
done < <(find "$SDK_ROOT/bin" -type f -name "$PKG_NAME-*.apk" -print0)
[[ "$count" == 1 ]] || { echo "预期一个 APK，实际找到 $count 个。" >&2; exit 1; }
if [[ -f "$SDK_ROOT/public-key.pem" ]]; then
  "$APK_TOOL" verify --keys-dir "$SDK_ROOT" "$selected_file"
fi
cp "$selected_file" "$OUTPUT_DIR/"
"$APK_TOOL" adbdump "$selected_file" > "$OUTPUT_DIR/APK-METADATA.txt"
cp "$SDK_ROOT/.config" "$OUTPUT_DIR/SDK.config"
cp "$REPO_ROOT/payload/PORT-VERSION.json" "$OUTPUT_DIR/PORT-VERSION.json"
(cd "$OUTPUT_DIR" && sha256sum -- ./*.apk > SHA256SUMS)
echo "APK -> $OUTPUT_DIR/$(basename "$selected_file")"
