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
const bunPkg = 'dsh-our-free-model-bun'
const inspector = path.join(repo, 'scripts/inspect-ipk.py')
const mainFiles = [
  'etc/init.d/ourfreemodel', 'etc/config/ourfreemodel',
  'etc/ourfreemodel-access.json', 'etc/ourfreemodel-migrated',
  'usr/lib/ourfreemodel-access/cli.mjs',
  'usr/lib/ourfreemodel/packages/standalone/service.mjs',
  'usr/lib/ourfreemodel/bun-assets.json',
  'usr/libexec/rpcd/ourfreemodel',
  'usr/share/luci/menu.d/luci-app-ourfreemodel.json',
  'usr/share/rpcd/acl.d/luci-app-ourfreemodel.json',
  'www/luci-static/resources/view/ourfreemodel.js',
]
const bunFiles = ['usr/lib/ourfreemodel/bin/bun']

async function ipkFixture(file, { name = pkg, omit = '', files = mainFiles } = {}) {
  // Same nested tar layout produced by SDK scripts/ipkg-build.
  await run('python3', ['-c', `import io,tarfile,sys,json
def tar(files):
 out=io.BytesIO()
 with tarfile.open(fileobj=out,mode='w:gz') as archive:
  for name,data in files.items():
   data=data.encode() if isinstance(data,str) else data
   entry=tarfile.TarInfo('./'+name);entry.size=len(data);entry.mode=0o644
   archive.addfile(entry,io.BytesIO(data))
 return out.getvalue()
paths=json.loads(sys.argv[4])
control='Package: '+sys.argv[2]+'\\nVersion: 2.8.3-r4\\nArchitecture: all\\n'
open(sys.argv[1],'wb').write(tar({'debian-binary':'2.0\\n','control.tar.gz':tar({'control':control}),'data.tar.gz':tar({p:('BUN' if p.endswith('/bun') else 'fixture') for p in paths if p!=sys.argv[3]})}))
`, file, name, omit, JSON.stringify(files)])
}

async function sdkFixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ourfreemodel-format-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const sdk = path.join(dir, 'sdk'), bin = path.join(dir, 'bin')
  for (const relative of ['include', 'scripts', 'staging_dir/host/bin', 'bin']) await fs.mkdir(path.join(sdk, relative), { recursive: true })
  await fs.mkdir(bin)
  const bunBinary = path.join(dir, 'host-bun')
  await fs.writeFile(bunBinary, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
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
  */compile*)
    cp "$OURFREEMODEL_TEST_ARTIFACT" "$OURFREEMODEL_TEST_SDK/bin/"
    cp "$OURFREEMODEL_TEST_BUN_ARTIFACT" "$OURFREEMODEL_TEST_SDK/bin/"
    ;;
esac
`, { mode: 0o755 })
  await fs.writeFile(path.join(sdk, 'staging_dir/host/bin/apk'), `#!/bin/sh
if [ "$1" = adbdump ]; then
  case "$2" in
    *${bunPkg}-*) printf '  name: ${bunPkg}\\n' ;;
    *) printf '  name: ${pkg}\\n' ;;
  esac
fi
`, { mode: 0o755 })
  return {
    dir, sdk,
    env: {
      ...process.env,
      PATH: bin + path.delimiter + process.env.PATH,
      OURFREEMODEL_TEST_SDK: sdk,
      OURFREEMODEL_BUN_BINARY: bunBinary,
    },
  }
}

test('IPK 校验器接受主程序与 Bun 包，拒绝错误包名与缺失文件', async t => {
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

  const bunFile = path.join(dir, bunPkg + '_fixture.ipk')
  await ipkFixture(bunFile, { name: bunPkg, files: bunFiles })
  assert.match((await run('python3', [inspector, bunFile, bunPkg])).stdout, new RegExp('Package: ' + bunPkg))
  await ipkFixture(bunFile, { name: bunPkg, files: bunFiles, omit: 'usr/lib/ourfreemodel/bin/bun' })
  await assert.rejects(run('python3', [inspector, bunFile, bunPkg]), /缺少安装文件/)
})

test('构建脚本分别选择 APK/IPK 配置，同时产出主程序与 Bun 包', async t => {
  for (const format of ['apk', 'ipk']) {
    const { dir, sdk, env } = await sdkFixture(t)
    const artifact = path.join(dir, format === 'apk' ? pkg + '-2.8.3-r4.apk' : pkg + '_2.8.3-r4_all.ipk')
    const bunArtifact = path.join(dir, format === 'apk' ? bunPkg + '-1.4.4-r1.apk' : bunPkg + '_1.4.4-r1_aarch64_cortex-a53.ipk')
    if (format === 'ipk') {
      await ipkFixture(artifact)
      await ipkFixture(bunArtifact, { name: bunPkg, files: bunFiles })
    } else {
      await fs.writeFile(artifact, 'APK fixture validated by SDK tool facade')
      await fs.writeFile(bunArtifact, 'Bun APK fixture validated by SDK tool facade')
    }
    const output = path.join(dir, 'output')
    await run('bash', [path.join(repo, 'scripts/build-package.sh'), sdk, output, 'x86', '64', format], {
      env: { ...env, OURFREEMODEL_TEST_ARTIFACT: artifact, OURFREEMODEL_TEST_BUN_ARTIFACT: bunArtifact },
      maxBuffer: 65536,
    })
    const config = await fs.readFile(path.join(sdk, '.config'), 'utf8')
    assert.ok(config.includes(format === 'apk' ? 'CONFIG_USE_APK=y' : '# CONFIG_USE_APK is not set'))
    assert.ok(config.includes('CONFIG_PACKAGE_' + bunPkg + '=m'))
    assert.equal((await fs.readFile(path.join(output, 'PACKAGE-FORMAT'), 'utf8')).trim(), format)
    await fs.access(path.join(output, path.basename(artifact)))
    await fs.access(path.join(output, path.basename(bunArtifact)))
    await fs.access(path.join(output, format.toUpperCase() + '-METADATA.txt'))
    await fs.access(path.join(output, 'BUN-METADATA.txt'))
    const sums = await fs.readFile(path.join(output, 'SHA256SUMS'), 'utf8')
    assert.match(sums, new RegExp(path.basename(artifact).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(sums, new RegExp(path.basename(bunArtifact).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('SDK 未关闭 APK 模式时，IPK 构建提前失败', async t => {
  const { dir, sdk, env } = await sdkFixture(t)
  await assert.rejects(run('bash', [path.join(repo, 'scripts/build-package.sh'), sdk, path.join(dir, 'out'), 'x86', '64', 'ipk'], {
    env: { ...env, OURFREEMODEL_FORCE_APK: '1' },
  }), /SDK 未关闭 APK 模式/)
  await assert.rejects(run('bash', [path.join(repo, 'scripts/build-package.sh'), sdk, path.join(dir, 'out'), 'x86', '64', 'zip']), /打包格式必须为/)
})
