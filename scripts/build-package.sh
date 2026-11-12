#!/usr/bin/env bash
# 使用真实 ImmortalWrt SDK 生成并校验 APK 或 IPK（主程序 + Bun 运行时）。
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
BUN_PKG=dsh-our-free-model-bun

[[ -x "$SDK_ROOT/scripts/feeds" && -f "$SDK_ROOT/include/package.mk" ]] || {
  echo "不是有效的 ImmortalWrt SDK: $SDK_ROOT" >&2; exit 1;
}
[[ -f "$REPO_ROOT/payload/packages/standalone/cli.mjs" &&
   -f "$REPO_ROOT/payload/packages/standalone/web/index.html" &&
   -f "$REPO_ROOT/payload/LICENSE" ]] || {
  echo 'payload 不完整，请先运行 build-payload.sh' >&2; exit 1;
}
[[ -f "$REPO_ROOT/scripts/bun-assets.json" && -f "$REPO_ROOT/openwrt/$BUN_PKG/Makefile" ]] || {
  echo '缺少 Bun 运行时包定义（scripts/bun-assets.json 或 openwrt 目录）' >&2; exit 1;
}

# Bun 官方 musl 归档；目标架构与 OpenWrt target/subtarget 一一对应。
case "$TARGET/$SUBTARGET" in
  qualcommax/ipq60xx) BUN_ARCH=aarch64 ;;
  x86/64) BUN_ARCH=x64 ;;
  *) echo "尚未为 $TARGET/$SUBTARGET 配置 Bun 运行时，请更新 scripts/bun-assets.json 和本脚本的架构映射。" >&2; exit 1 ;;
esac
read -r BUN_VERSION BUN_FILE BUN_SHA BUN_MEMBER < <(python3 - "$REPO_ROOT/scripts/bun-assets.json" "$BUN_ARCH" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
asset = data['assets'][sys.argv[2]]
print(data['version'], asset['file'], asset['sha256'], asset['binary'])
PY
)
[[ -n "$BUN_VERSION" && -n "$BUN_FILE" && -n "$BUN_SHA" && -n "$BUN_MEMBER" ]] || {
  echo 'Bun 资产清单不完整。' >&2; exit 1;
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

PACKAGE_DIR="$SDK_ROOT/package/$PKG_NAME"
BUN_PACKAGE_DIR="$SDK_ROOT/package/$BUN_PKG"
mkdir -p "$PACKAGE_DIR" "$BUN_PACKAGE_DIR/files"
rsync -a --delete "$REPO_ROOT/payload/" "$PACKAGE_DIR/payload/"
rsync -a --delete "$REPO_ROOT/files/" "$PACKAGE_DIR/files/"
cp "$REPO_ROOT/Makefile" "$PACKAGE_DIR/Makefile"
mkdir -p "$PACKAGE_DIR/scripts"
cp "$REPO_ROOT/scripts/bun-assets.json" "$PACKAGE_DIR/scripts/bun-assets.json"
chmod 755 "$PACKAGE_DIR/files/etc/init.d/ourfreemodel"
cp "$REPO_ROOT/openwrt/$BUN_PKG/Makefile" "$BUN_PACKAGE_DIR/Makefile"
cp "$REPO_ROOT/scripts/bun-assets.json" "$BUN_PACKAGE_DIR/files/bun-assets.json"

# 测试环境可直接提供二进制以跳过下载；正式构建只使用官方归档并校验 SHA256。
if [[ -n "${OURFREEMODEL_BUN_BINARY:-}" ]]; then
  install -m 0755 "$OURFREEMODEL_BUN_BINARY" "$BUN_PACKAGE_DIR/files/bun"
else
  BUN_CACHE="${OURFREEMODEL_BUN_CACHE:-$HOME/.cache/ourfreemodel-bun}"
  mkdir -p "$BUN_CACHE"
  BUN_ARCHIVE="$BUN_CACHE/$BUN_FILE"
  if [[ ! -f "$BUN_ARCHIVE" ]] || [[ "$(sha256_of "$BUN_ARCHIVE")" != "$BUN_SHA" ]]; then
    rm -f "$BUN_ARCHIVE.part"
    curl -fL --retry 3 --connect-timeout 15 \
      "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/$BUN_FILE" \
      -o "$BUN_ARCHIVE.part"
    [[ "$(sha256_of "$BUN_ARCHIVE.part")" == "$BUN_SHA" ]] || {
      rm -f "$BUN_ARCHIVE.part"
      echo "Bun 归档 SHA256 校验失败: $BUN_FILE" >&2; exit 1;
    }
    mv "$BUN_ARCHIVE.part" "$BUN_ARCHIVE"
  fi
  EXTRACT_DIR="$(mktemp -d)"
  trap 'rm -rf "$EXTRACT_DIR"' EXIT
  unzip -q -o "$BUN_ARCHIVE" "$BUN_MEMBER" -d "$EXTRACT_DIR"
  install -m 0755 "$EXTRACT_DIR/$BUN_MEMBER" "$BUN_PACKAGE_DIR/files/bun"
fi

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
CONFIG_PACKAGE_${BUN_PKG}=m
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
for pkg in "$BUN_PKG" "$PKG_NAME"; do
  if ! grep -Eq "^CONFIG_PACKAGE_${pkg}=[my]$" "$SDK_ROOT/.config"; then
    echo "SDK 没有启用目标包 $pkg，请检查架构与依赖支持。" >&2; exit 1
  fi
done
make -C "$SDK_ROOT" "package/$BUN_PKG/clean" "package/$PKG_NAME/clean"
make -C "$SDK_ROOT" -j"$(nproc)" "package/$BUN_PKG/compile" "package/$PKG_NAME/compile" ||
  make -C "$SDK_ROOT" -j1 "package/$BUN_PKG/compile" "package/$PKG_NAME/compile" V=s

main_file=''
bun_file=''
if [[ "$PACKAGE_FORMAT" == apk ]]; then
  APK_TOOL="$SDK_ROOT/staging_dir/host/bin/apk"
  [[ -x "$APK_TOOL" ]] || { echo 'SDK 未生成 apk 工具。' >&2; exit 1; }
  while IFS= read -r -d '' file; do
    metadata="$("$APK_TOOL" adbdump "$file")"
    actual_name="$(awk '/^  name: / { sub(/^  name: /, ""); print; exit }' <<< "$metadata")"
    case "$actual_name" in
      "$PKG_NAME")
        [[ -z "$main_file" ]] || { echo '找到多个主程序 APK。' >&2; exit 1; }
        main_file="$file"
        ;;
      "$BUN_PKG")
        [[ -z "$bun_file" ]] || { echo '找到多个 Bun 运行时 APK。' >&2; exit 1; }
        bun_file="$file"
        ;;
    esac
  done < <(find "$SDK_ROOT/bin" -type f -name '*.apk' -print0)
  [[ -n "$main_file" && -n "$bun_file" ]] || {
    echo "预期各一个 $PACKAGE_FORMAT，实际主程序 ${main_file:-无} / Bun ${bun_file:-无}。" >&2; exit 1
  }
  if [[ -f "$SDK_ROOT/public-key.pem" ]]; then
    "$APK_TOOL" verify --keys-dir "$SDK_ROOT" "$main_file"
    "$APK_TOOL" verify --keys-dir "$SDK_ROOT" "$bun_file"
  fi
  "$APK_TOOL" adbdump "$main_file" > "$OUTPUT_DIR/APK-METADATA.txt"
  "$APK_TOOL" adbdump "$bun_file" > "$OUTPUT_DIR/BUN-METADATA.txt"
  cp "$main_file" "$bun_file" "$OUTPUT_DIR/"
else
  while IFS= read -r -d '' file; do
    base="$(basename "$file")"
    case "$base" in
      "${PKG_NAME}_"*)
        [[ -z "$main_file" ]] || { echo '找到多个主程序 IPK。' >&2; exit 1; }
        python3 "$REPO_ROOT/scripts/inspect-ipk.py" "$file" "$PKG_NAME" >/dev/null
        main_file="$file"
        ;;
      "${BUN_PKG}_"*)
        [[ -z "$bun_file" ]] || { echo '找到多个 Bun 运行时 IPK。' >&2; exit 1; }
        python3 "$REPO_ROOT/scripts/inspect-ipk.py" "$file" "$BUN_PKG" >/dev/null
        bun_file="$file"
        ;;
    esac
  done < <(find "$SDK_ROOT/bin" -type f -name '*.ipk' -print0)
  [[ -n "$main_file" && -n "$bun_file" ]] || {
    echo "预期各一个 $PACKAGE_FORMAT，实际主程序 ${main_file:-无} / Bun ${bun_file:-无}。" >&2; exit 1
  }
  python3 "$REPO_ROOT/scripts/inspect-ipk.py" "$main_file" "$PKG_NAME" > "$OUTPUT_DIR/IPK-METADATA.txt"
  python3 "$REPO_ROOT/scripts/inspect-ipk.py" "$bun_file" "$BUN_PKG" > "$OUTPUT_DIR/BUN-METADATA.txt"
  cp "$main_file" "$bun_file" "$OUTPUT_DIR/"
fi
cp "$SDK_ROOT/.config" "$OUTPUT_DIR/SDK.config"
cp "$REPO_ROOT/payload/PORT-VERSION.json" "$OUTPUT_DIR/PORT-VERSION.json"
printf '%s\n' "$PACKAGE_FORMAT" > "$OUTPUT_DIR/PACKAGE-FORMAT"
( cd "$OUTPUT_DIR" && for file in ./*."$PACKAGE_FORMAT"; do
    printf '%s  %s\n' "$(sha256_of "$file")" "$file"
  done > SHA256SUMS )
echo "$PACKAGE_FORMAT -> $OUTPUT_DIR/$(basename "$main_file") + $(basename "$bun_file")"
