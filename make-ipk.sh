#!/usr/bin/env bash
# 打包 dsh-our-free-model-for-openwrt 为 OpenWrt .ipk（手工构造，不依赖 OpenWrt SDK）。
# ipk = ar 归档：debian-binary + control.tar.gz + data.tar.gz
# 本包为纯脚本数据包（arch=all），四种目标架构共用同一个文件。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PAYLOAD="$HERE/payload"
OUT="$HERE/dist"
VERSION="$(node -e "console.log(require('$PAYLOAD/PORT-VERSION.json').version)")"
PKG_NAME="dsh-our-free-model-for-openwrt"
PKG_VER="$VERSION"
PKG_REL="1"
ARCH="all"
IPK="$OUT/${PKG_NAME}_${PKG_VER}-${PKG_REL}_${ARCH}.ipk"

command -v ar >/dev/null || { echo "需要 ar (binutils)"; exit 1; }
[ -d "$PAYLOAD/packages" ] || { echo "先跑 ./build-payload.sh"; exit 1; }

rm -rf "$OUT/tmp-ipk" "$IPK"
mkdir -p "$OUT/tmp-ipk/control" "$OUT/tmp-ipk/data"

# ---------- data 载荷 ----------
# 运行时树装到 /usr/lib/ofm/，入口 cli.mjs 保持相对引用（../../src 从
# /usr/lib/ofm/packages/standalone/ 指向 /usr/lib/ofm/src/）✓
rsync -a "$PAYLOAD/" "$OUT/tmp-ipk/data/usr/lib/ofm/"
mkdir -p "$OUT/tmp-ipk/data/etc/init.d" "$OUT/tmp-ipk/data/etc/config"
install -m 755 "$HERE/files/etc/init.d/ofm" "$OUT/tmp-ipk/data/etc/init.d/ofm"
install -m 644 "$HERE/files/etc/config/openwrt-ofm" "$OUT/tmp-ipk/data/etc/config/openwrt-ofm"
# conffiles 必须精确列出
mkdir -p "$OUT/tmp-ipk/data/CONTROL"
cat > "$OUT/tmp-ipk/data/CONTROL/conffiles" <<'EOF'
/etc/config/openwrt-ofm
EOF

# ---------- control ----------
mkdir -p "$OUT/tmp-ipk/control/CONTROL"
cat > "$OUT/tmp-ipk/control/CONTROL/control" <<EOF
Package: $PKG_NAME
Version: $PKG_VER-$PKG_REL
Depends: node
Provides:
Source: package/$PKG_NAME
SourceName: $PKG_NAME
License: MIT
LicenseFiles: LICENSE
Section: net
Requires: node
Architecture: $ARCH
Installed-Size: $(du -sk "$OUT/tmp-ipk/data" | cut -f1)
Maintainer: ftkey
Description: Our Free Model standalone service (dsh-our-free-model port).
 Free-lane LLM gateway with web management UI.
end
EOF
echo "/etc/config/openwrt-ofm" > "$OUT/tmp-ipk/control/CONTROL/conffiles"

# opkg 对 ar 成员顺序敏感：debian-binary 必须第一个。
# macOS 的 ar 会写 __.SYMDEF 索引破坏容器，改用 Python 手工构造经典 ar。
cd "$OUT/tmp-ipk"
echo "2.0" > debian-binary
tar -czf control.tar.gz -C control .
tar -czf data.tar.gz --owner=0 --group=0 -C data .
python3 "$HERE/mkar.py" "$IPK" \
  debian-binary ./debian-binary \
  control.tar.gz ./control.tar.gz \
  data.tar.gz ./data.tar.gz

echo "ipk -> $IPK ($(du -h "$IPK" | cut -f1))"
