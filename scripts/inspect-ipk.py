#!/usr/bin/env python3
"""只读校验 SDK IPK 的控制信息和安装内容，不解压到文件系统。"""
import io
import pathlib
import subprocess
import sys
import tarfile

REQUIRED = {
    'etc/init.d/ourfreemodel', 'etc/config/ourfreemodel',
    'etc/ourfreemodel-access.json', 'etc/ourfreemodel-migrated',
    'usr/lib/ourfreemodel-access/cli.mjs',
    'usr/lib/ourfreemodel/packages/standalone/service.mjs',
    'usr/libexec/rpcd/ourfreemodel',
    'usr/share/luci/menu.d/luci-app-ourfreemodel.json',
    'usr/share/rpcd/acl.d/luci-app-ourfreemodel.json',
    'www/luci-static/resources/view/ourfreemodel.js',
}


def inspect(file, expected):
    with open(file, 'rb') as stream:
        ar = stream.read(8) == b'!<arch>\n'
    if ar:
        def member(name):
            return subprocess.check_output(['ar', 'p', str(file), name])
        parts = {name: member(name) for name in ['debian-binary', 'control.tar.gz', 'data.tar.gz']}
    else:
        with tarfile.open(file, 'r:*') as archive:
            parts = {}
            for entry in archive:
                name = entry.name.removeprefix('./')
                if name in ['debian-binary', 'control.tar.gz', 'data.tar.gz']:
                    if name in parts or not entry.isfile():
                        raise ValueError('IPK 归档成员重复或不是普通文件')
                    parts[name] = archive.extractfile(entry).read()
    if parts.get('debian-binary', b'').strip() != b'2.0':
        raise ValueError('不是有效 IPK：缺少 debian-binary 2.0')
    with tarfile.open(fileobj=io.BytesIO(parts['control.tar.gz']), mode='r:gz') as archive:
        controls = [entry for entry in archive if entry.name.removeprefix('./') == 'control' and entry.isfile()]
        if len(controls) != 1 or controls[0].size > 65536:
            raise ValueError('IPK 控制文件无效')
        control = archive.extractfile(controls[0]).read().decode('utf-8')
    fields = dict(line.split(':', 1) for line in control.splitlines() if line and not line[0].isspace() and ':' in line)
    if fields.get('Package', '').strip() != expected:
        raise ValueError('IPK 包名与目标不一致')
    if not fields.get('Version', '').strip() or not fields.get('Architecture', '').strip():
        raise ValueError('IPK 缺少版本或架构')
    with tarfile.open(fileobj=io.BytesIO(parts['data.tar.gz']), mode='r:gz') as archive:
        installed = {entry.name.removeprefix('./') for entry in archive if entry.isfile()}
    missing = REQUIRED - installed
    if missing:
        raise ValueError('IPK 缺少安装文件：' + ', '.join(sorted(missing)))
    return control


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3:
            raise ValueError('用法: inspect-ipk.py <IPK文件> <预期包名>')
        print(inspect(pathlib.Path(sys.argv[1]), sys.argv[2]), end='')
    except (ValueError, KeyError, OSError, tarfile.TarError, subprocess.CalledProcessError) as error:
        sys.exit(f'IPK 校验失败：{error}')
