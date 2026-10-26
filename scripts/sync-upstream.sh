#!/usr/bin/env bash
# 只同步调用者已检出的上游提交；提交与推送由 workflow 负责。
set -euo pipefail
[[ $# == 1 ]] || { echo "用法: $0 <上游工作树>" >&2; exit 2; }
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_ROOT="$(cd "$1" && pwd)"
UPSTREAM_SHA="$(git -C "$UPSTREAM_ROOT" rev-parse HEAD)"
CURRENT_SHA="$(python3 - "$REPO_ROOT/payload/PORT-VERSION.json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1])).get('sourceSha', ''))
PY
)"
if [[ "$CURRENT_SHA" == "$UPSTREAM_SHA" ]]; then
  echo "上游未更新: $UPSTREAM_SHA"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo 'changed=false' >> "$GITHUB_OUTPUT"; fi
  exit 0
fi

# 在覆盖 payload 前验证版本和配方；拒绝意外版本回退。
NEXT_RELEASE="$(python3 - "$REPO_ROOT" "$UPSTREAM_ROOT" <<'PY'
import json, pathlib, re, sys
root, upstream = map(pathlib.Path, sys.argv[1:])
old = json.loads((root / 'payload/PORT-VERSION.json').read_text())['version']
new = json.loads((upstream / 'package.json').read_text())['version']
if not all(re.fullmatch(r'\d+\.\d+\.\d+', v) for v in [old, new]):
    raise SystemExit('版本必须为数字 major.minor.patch，需人工适配上游版本规则。')
if tuple(map(int, new.split('.'))) < tuple(map(int, old.split('.'))):
    raise SystemExit(f'拒绝上游版本回退: {old} -> {new}')
releases = re.findall(r'^PKG_RELEASE:=(\d+)$', (root / 'Makefile').read_text(), re.M)
if len(releases) != 1:
    raise SystemExit('Makefile 必须包含唯一的数字 PKG_RELEASE。')
print(int(releases[0]) + 1 if old == new else 1)
PY
)"
bash "$REPO_ROOT/build-payload.sh" "$UPSTREAM_ROOT"
python3 - "$REPO_ROOT/Makefile" "$NEXT_RELEASE" <<'PY'
import pathlib, re, sys
path = pathlib.Path(sys.argv[1])
path.write_text(re.sub(r'^PKG_RELEASE:=\d+$', f'PKG_RELEASE:={sys.argv[2]}', path.read_text(), flags=re.M))
PY
cp "$UPSTREAM_ROOT/LICENSE" "$REPO_ROOT/LICENSE"
# 构建前至少确认上游 CLI 仍能在受支持的 Node.js 中加载。
node "$REPO_ROOT/payload/packages/standalone/cli.mjs" --help >/dev/null
echo "已同步上游: $UPSTREAM_SHA; PKG_RELEASE=$NEXT_RELEASE"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo 'changed=true' >> "$GITHUB_OUTPUT"; fi
