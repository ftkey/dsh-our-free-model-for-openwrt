#!/usr/bin/env bash
# 从已检出的上游工作树刷新 payload；Actions 先同步，再使用固定提交编译。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC_REPO="$(cd "${1:-$HERE/../dsh-our-free-model}" && pwd)"
OUT="$HERE/payload"
[[ "$SRC_REPO" != "$HERE" && "$SRC_REPO" != "$OUT" && "$SRC_REPO" != "$OUT/"* ]] || {
  echo '上游目录不能指向本移植仓库或 payload。' >&2; exit 1;
}
for file in package.json LICENSE icon.svg packages/standalone/cli.mjs packages/standalone/web/index.html; do
  [[ -f "$SRC_REPO/$file" ]] || { echo "缺少上游文件: $file" >&2; exit 1; }
done
# 先在临时目录完整组装，避免失败时破坏现有快照。
STAGING="$(mktemp -d "$HERE/.payload-XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT
mkdir -p "$STAGING/packages" "$STAGING/vendor/channel-pack" "$STAGING/vendor/magpie"
rsync -a "$SRC_REPO/src" "$STAGING/"
rsync -a --exclude node_modules --exclude frontend "$SRC_REPO/packages/standalone" "$STAGING/packages/"
for file in pack.js qoder-auth-wasm.wasm package.json NOTICE.md LICENSE; do
  cp "$SRC_REPO/vendor/channel-pack/$file" "$STAGING/vendor/channel-pack/"
done
# 只保留引擎元数据与许可；上游当前二进制仅支持 Windows，不随路由器包安装。
for file in engine.json LICENSE NOTICE.md; do
  cp "$SRC_REPO/vendor/magpie/$file" "$STAGING/vendor/magpie/"
done
rsync -a "$SRC_REPO/locale" "$STAGING/"
cp "$SRC_REPO/package.json" "$SRC_REPO/LICENSE" "$SRC_REPO/icon.svg" "$STAGING/"
# 上游时常忘记升 packages/standalone 的版本，导致 WebUI 显示旧版本号；同步时强制对齐。
node --input-type=commonjs - "$STAGING" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const root = process.argv[2]
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const file = path.join(root, 'packages/standalone/package.json')
const manifest = fs.readFileSync(file, 'utf8')
const next = manifest.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`)
if (next === manifest) throw new Error('无法写入 standalone 版本号')
fs.writeFileSync(file, next)
NODE
SOURCE_SHA="$(git -C "$SRC_REPO" rev-parse HEAD)"
SOURCE_SHA="$SOURCE_SHA" node --input-type=commonjs - "$SRC_REPO" > "$STAGING/PORT-VERSION.json" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const version = JSON.parse(fs.readFileSync(path.join(process.argv[2], 'package.json'))).version
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`不支持的包版本: ${version}`)
console.log(JSON.stringify({version, channel: 'openwrt', source: 'https://github.com/Ebony-Vinyl/dsh-our-free-model', sourceSha: process.env.SOURCE_SHA, builtAt: new Date().toISOString()}, null, 2))
NODE
mkdir -p "$OUT"
rsync -a --delete "$STAGING/" "$OUT/"
echo "payload -> $OUT ($(du -sh "$OUT" | cut -f1))"
