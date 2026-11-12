include $(TOPDIR)/rules.mk

# 版本与构建产物由 scripts/bun-assets.json 统一提供，构建脚本会把该文件复制到 files/。
PKG_NAME:=dsh-our-free-model-bun
PKG_VERSION:=$(shell python3 -c 'import json; print(json.load(open("$(CURDIR)/files/bun-assets.json"))["version"])')
PKG_RELEASE:=1
PKG_LICENSE:=MIT
PKG_MAINTAINER:=ftkey

include $(INCLUDE_DIR)/package.mk

define Package/$(PKG_NAME)
  SECTION:=net
  CATEGORY:=Network
  TITLE:=Bun runtime for Our Free Model (OpenCode free lane)
  URL:=https://bun.sh
endef

define Package/$(PKG_NAME)/description
  Bundled Bun (musl) runtime used by Our Free Model for the OpenCode free
  inference lane. Installs /usr/lib/ourfreemodel/bin/bun.
endef

define Build/Prepare
endef

define Build/Configure
endef

define Build/Compile
endef

define Package/$(PKG_NAME)/install
	$(INSTALL_DIR) $(1)/usr/lib/ourfreemodel/bin
	$(INSTALL_BIN) ./files/bun $(1)/usr/lib/ourfreemodel/bin/bun
endef

$(eval $(call BuildPackage,$(PKG_NAME)))
