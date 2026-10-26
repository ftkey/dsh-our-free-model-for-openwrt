# dsh-our-free-model-for-openwrt

将 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) 的独立 Node.js 服务移植到 OpenWrt，提供 OpenAI 兼容 API 和本机 Web 管理页。

仓库地址：[ftkey/dsh-our-free-model-for-openwrt](https://github.com/ftkey/dsh-our-free-model-for-openwrt)。软件包名和 APK 文件名前缀统一为 `dsh-our-free-model-for-openwrt`。这是安装到现有 ROM 的软件包，不会生成或重命名整个路由器固件镜像。

## GitHub Actions 编译 APK

参考 [VIKINGYFY/packages 的 APK 工作流](https://github.com/VIKINGYFY/packages/blob/main/.github/workflows/Build-APK-Packages.yml)，使用 ImmortalWrt snapshot SDK 的 `BuildPackage` 生成正式 APK，并通过 SDK 的 `apk adbdump` 读取元数据、核对包名。下载 SDK 时检查 SHA256；SDK 提供签名公钥时验证 APK 签名。

默认同时构建：

| Actions 平台 | SDK target/subtarget | 用途 |
| --- | --- | --- |
| arm64-ipq60xx | qualcommax/ipq60xx | 太乙 ER1、亚瑟等 IPQ60xx 设备 |
| amd64 | x86/64 | x86_64 软路由 |

ARM64 目标依据 [ER1-WRT-CI 的 ROM 配置](https://github.com/ftkey/ER1-WRT-CI/blob/main/.github/workflows/build-firmware.yml) 选择。ROM 使用 VIKINGYFY/immortalwrt，而此处和参考项目一样使用官方 ImmortalWrt snapshot SDK；两者并非同一构建，安装时仍需核对设备架构、APK 格式和 Node.js 版本。

1. 将**本目录内容**放在新仓库根目录，确保包含隐藏的 `.github/`、根 `Makefile`、`files/` 和 `payload/`。不要将整个 `openwrt-ofm` 嵌套一层上传，也不要上传 `dist/`。
2. 推送到 `main` 后会先检查并同步上游再编译；也可在 **Actions → Build APK → Run workflow** 手动运行（默认勾选 `sync_upstream`）。PR 和版本标签仅构建对应提交，不同步上游。
3. 编译完成后下载 Artifacts 中对应平台的 ZIP。每个平台包含 APK、`SHA256SUMS`、`APK-METADATA.txt`、`SDK.config`、SDK 下载校验列表、移植版本信息及源提交 SHA。
4. 需要发布到 Releases 时，手动运行时勾选 `publish`，或推送 `v*` 标签。普通分支推送只上传 Artifact。无需配置额外 Secret，发布使用仓库内置 `GITHUB_TOKEN`。

APK 使用 SDK 的文件命名规则，例如 `dsh-our-free-model-for-openwrt-2.7.2-r1.apk`，实际版本以 Artifact 为准。载荷是纯 JS，配方使用 `PKGARCH:=all`；仍分别使用两个平台 SDK 处理依赖和验证，产物按平台分开保存。不会打包 Node.js，需要从固件软件源安装。

## 自动同步上游

上游固定为 [Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)，跟随该仓库的默认分支。

- 定时每 24 小时检查一次，北京时间约**每天 08:17**；GitHub 定时任务可能延迟。
- 检测到新的上游提交后，刷新 `payload/`（包括上游已提交的预编译 Web UI）和根 `LICENSE`，提交到本仓库 `main`，随后直接在同一次工作流中编译两种平台。
- 上游版本不变时自动递增 `PKG_RELEASE`；版本升级时重置为 `1`。版本回退或必要文件缺失会报错停止。
- 定时运行时，如果上游没变化且当前仓库提交已有成功运行记录，则跳过编译；没有成功记录时继续构建，因此首次失败后可在后续定时运行中重试。手动运行始终编译。
- ARM64 和 AMD64 构建固定使用同步后确定的同一个仓库提交；`SOURCE-SHA`、`PORT-VERSION.json` 分别记录移植仓库与上游提交。
- 手动取消勾选 `sync_upstream`，可只重新编译现有快照；勾选 `publish` 可同时发布 Releases。定时运行默认只上传 Artifact。

将新版工作流和 `scripts/sync-upstream.sh` 一起推送到 `main` 后生效，无需额外 PAT 或 Secret。工作流使用内置 `GITHUB_TOKEN` 写回同步结果；`main` 的分支规则需允许该机器人提交。

机器人通过 `GITHUB_TOKEN` 推送不会再次触发普通 push 工作流，所以本流程直接把同步后的提交交给后续编译任务，不依赖第二次触发。参见 [GitHub 工作流触发规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)。

## 安装与启动

本移植按上游要求使用 **Node.js 22.19+（22 系列）或 24+**。Node.js 20 未做兼容保证；MIPS32 没有可用的现代 Node.js 支持。先在路由器上检查：

```sh
apk --version
apk update
apk add node
node --version
apk --print-arch
```

将 ZIP 解压后的 APK 上传到路由器，再执行：

```sh
# 文件名按实际下载结果替换
apk add --allow-untrusted ./dsh-our-free-model-for-openwrt-2.7.2-r1.apk
/etc/init.d/ofm enable
/etc/init.d/ofm start
/etc/init.d/ofm status
logread -e ofm
```

这是独立 SDK 构建的第三方 APK，ROM 默认不信任其签名，因此安装时使用 `--allow-untrusted`。依赖无法满足时先核对 ROM 软件源；不要强制跳过 Node.js 依赖。旧 `mkapk.py` 手工生成的 `dist/*.apk` 不属于 SDK 产物，请重新通过 Actions 编译；该入口现已停用。

服务入口已修正为 `/usr/lib/ofm/packages/standalone/cli.mjs`。`/etc/config/openwrt-ofm` 为 SDK 声明的配置文件，升级时由包管理器处理保留。

## 管理页与 API

默认端口 `18900`。管理页仅允许本机访问，在电脑上建立 SSH 隧道：

```sh
ssh -L 18900:127.0.0.1:18900 root@<路由器IP>
```

然后访问 `http://127.0.0.1:18900`，登录链接从路由器服务日志获取。API 基址为 `http://127.0.0.1:18900/v1`；需要其他局域网设备调用时，在管理页开启「LAN 推理中继」，使用该功能配置的独立端口和密钥。默认管理端口不会直接开放给 LAN。

默认数据目录 `/usr/lib/ofm-data`。建议改到持久挂载盘，避免占用路由器内部存储：

```sh
uci set openwrt-ofm.main.data_dir='/mnt/ofm'
uci set openwrt-ofm.main.port='18900'
uci commit openwrt-ofm
/etc/init.d/ofm restart
```

## 本地维护

```text
.github/workflows/Build-APK.yml  定时同步、编译与可选发布
Makefile                       OpenWrt 软件包配方
scripts/build-apk.sh            SDK 编译、元数据检查及产物收集
scripts/sync-upstream.sh        检测上游提交、刷新载荷及更新发布号
build-payload.sh               从上游工作树刷新运行时快照
payload/                       随仓库提交的运行时及预编译 Web UI
files/etc/init.d/ofm            procd 启动脚本
files/etc/config/openwrt-ofm    UCI 配置
LICENSE                        上游 MIT 许可
```

Actions 先检查上游默认分支并将更新保存为仓库快照，再使用确定提交的 `payload/` 编译；两个平台不会各自拉取上游。`payload/PORT-VERSION.json` 记录上游版本和来源提交。当前约 42 MiB，保留上游 `src/engine-parts` 分片；上游 Magpie 二进制目前只有 Windows 版本，本包不提供其 Linux 引擎，不能视为所有平台专用功能均可用。

日常更新由 Action 自动完成。如需在本地手动更新（上游已有预编译 `packages/standalone/web/` 时）：

```sh
bash scripts/sync-upstream.sh /path/to/dsh-our-free-model
# 检查 payload、Makefile、LICENSE 差异后提交；版本号会自动处理。
```

同一个上游版本修改了移植文件时，请递增 `Makefile` 中的 `PKG_RELEASE`，以便设备识别升级。

在 Linux 上使用已解压、支持 APK 的 ImmortalWrt SDK：

```sh
cd /path/to/sdk
./scripts/feeds update -a
./scripts/feeds install -a
cd /path/to/dsh-our-free-model-for-openwrt
bash scripts/build-apk.sh /path/to/sdk ./dist qualcommax ipq60xx
```

也可把根 `Makefile`、`files/`、`payload/` 复制到 ROM 源码的 `package/dsh-our-free-model-for-openwrt/`，在 ROM 配置中启用 `CONFIG_PACKAGE_dsh-our-free-model-for-openwrt=y`。旧 `make-ipk.sh` / `mkar.py` 仅保留为历史 opkg 工具，不参与 APK 工作流。
