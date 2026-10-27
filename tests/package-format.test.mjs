import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const repo = fileURLToPath(new URL('../', import.meta.url))
const pkg = 'dsh-our-free-model-for-openwrt'
const inspector = path.join(repo, 'scripts/inspect-ipk.py')

async function ipkFixture(file, { name = pkg, omit = '' } = {}) {
  // Same nested tar layout produced by SDK scripts/ipkg-build.
  await run('python3', ['-c', `import io,tarfile,sys
def tar(files):
 out=io.BytesIO()
 with tarfile.open(fileobj=out,mode='w:gz') as archive:
  for name,data in files.items():
   data=data.encode() if isinstance(data,str) else data
   entry=tarfile.TarInfo('./'+name);entry.size=len(data);entry.mode=0o644
   archive.addfile(entry,io.BytesIO(data))
 return out.getvalue()
paths=['etc/init.d/ourfreemodel','etc/config/ourfreemodel','etc/ourfreemodel-access.json','etc/ourfreemodel-migrated','usr/lib/ourfreemodel-access/cli.mjs','usr/lib/ourfreemodel/packages/standalone/service.mjs','usr/libexec/rpcd/ourfreemodel','usr/share/luci/menu.d/luci-app-ourfreemodel.json','usr/share/rpcd/acl.d/luci-app-ourfreemodel.json','www/luci-static/resources/view/ourfreemodel.js']
control='Package: '+sys.argv[2]+'\\nVersion: 2.7.2-r4\\nArchitecture: all\\nDepends: node127, luci-base, rpcd, rpcd-mod-luci\\n'
open(sys.argv[1],'wb').write(tar({'debian-binary':'2.0\\n','control.tar.gz':tar({'control':control}),'data.tar.gz':tar({p:'fixture' for p in paths if p!=sys.argv[3]})}))
`, file, name, omit])
}

async function sdkFixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ourfreemodel-format-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const sdk = path.join(dir, 'sdk'), bin = path.join(dir, 'bin')
  for (const relative of ['include', 'scripts', 'staging_dir/host/bin', 'bin']) await fs.mkdir(path.join(sdk, relative), { recursive: true })
  await fs.mkdir(bin)
  await fs.writeFile(path.join(sdk, 'include/package.mk'), '')
  await fs.writeFile(path.join(sdk, 'scripts/ipkg-build'), 'SDK tool fixture')
  await fs.writeFile(path.join(sdk, 'scripts/feeds'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await fs.writeFile(path.join(bin, 'nproc'), '#!/bin/sh\necho 2\n', { mode: 0o755 })
  await fs.writeFile(path.join(bin, 'rsync'), '#!/bin/sh\nsource=""; destination=""\nfor argument do source="$destination"; destination="$argument"; done\nmkdir -p "$destination"\ncp -a "$source/." "$destination/"\n', { mode: 0o755 })
  await fs.writeFile(path.join(bin, 'make'), `#!/bin/sh
case "$*" in
  *defconfig*)
    [ "$OURFREEMODEL_FORCE_APK" != 1 ] || echo CONFIG_USE_APK=y >> "$OURFREEMODEL_TEST_SDK/.config"
    ;;
  */compile*) cp "$OURFREEMODEL_TEST_ARTIFACT" "$OURFREEMODEL_TEST_SDK/bin/" ;;
esac
`, { mode: 0o755 })
  await fs.writeFile(path.join(sdk, 'staging_dir/host/bin/apk'), `#!/bin/sh
if [ "$1" = adbdump ]; then printf '  name: ${pkg}\\n'; fi
`, { mode: 0o755 })
  return { dir, sdk, env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, OURFREEMODEL_TEST_SDK: sdk } }
}

test('IPK 校验器接受 SDK 格式，拒绝错误包名、缺失 LuCI 文件和伪装的 APK', async t => {
  const { dir } = await sdkFixture(t)
  const file = path.join(dir, pkg + '_fixture.ipk')
  await ipkFixture(file)
  assert.match((await run('python3', [inspector, file, pkg])).stdout, /Architecture: all/)
  await ipkFixture(file, { name: 'wrong-package' })
  await assert.rejects(run('python3', [inspector, file, pkg]), /包名与目标不一致/)
  await ipkFixture(file, { omit: 'www/luci-static/resources/view/ourfreemodel.js' })
  await assert.rejects(run('python3', [inspector, file, pkg]), /缺少安装文件/)
  await fs.writeFile(file, 'not-an-ipk')
  await assert.rejects(run('python3', [inspector, file, pkg]))
})

test('构建脚本分别选择 APK/IPK 配置、校验对应元数据并生成正确后缀产物', async t => {
  for (const format of ['apk', 'ipk']) {
    const { dir, sdk, env } = await sdkFixture(t)
    const artifact = path.join(dir, format === 'apk' ? pkg + '-2.7.2-r4.apk' : pkg + '_2.7.2-r4_all.ipk')
    if (format === 'ipk') await ipkFixture(artifact)
    else await fs.writeFile(artifact, 'APK fixture validated by SDK tool facade')
    const output = path.join(dir, 'output')
    await run('bash', [path.join(repo, 'scripts/build-package.sh'), sdk, output, 'x86', '64', format], {
      env: { ...env, OURFREEMODEL_TEST_ARTIFACT: artifact }, maxBuffer: 65536,
    })
    const config = await fs.readFile(path.join(sdk, '.config'), 'utf8')
    assert.ok(config.includes(format === 'apk' ? 'CONFIG_USE_APK=y' : '# CONFIG_USE_APK is not set'))
    assert.equal((await fs.readFile(path.join(output, 'PACKAGE-FORMAT'), 'utf8')).trim(), format)
    await fs.access(path.join(output, path.basename(artifact)))
    await fs.access(path.join(output, format.toUpperCase() + '-METADATA.txt'))
    assert.match(await fs.readFile(path.join(output, 'SHA256SUMS'), 'utf8'), new RegExp('\\.' + format))
  }
})

test('SDK 未关闭 APK 模式时，IPK 构建提前失败', async t => {
  const { dir, sdk, env } = await sdkFixture(t)
  await assert.rejects(run('bash', [path.join(repo, 'scripts/build-package.sh'), sdk, path.join(dir, 'out'), 'x86', '64', 'ipk'], {
    env: { ...env, OURFREEMODEL_FORCE_APK: '1' },
  }), /SDK 未关闭 APK 模式/)
  await assert.rejects(run('bash', [path.join(repo, 'scripts/build-package.sh'), sdk, path.join(dir, 'out'), 'x86', '64', 'zip']), /打包格式必须为/)
})
