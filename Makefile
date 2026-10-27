include $(TOPDIR)/rules.mk

PKG_NAME:=dsh-our-free-model-for-openwrt
PKG_VERSION:=$(shell python3 -c 'import json; print(json.load(open("$(CURDIR)/payload/PORT-VERSION.json"))["version"])')
PKG_RELEASE:=1
PKG_LICENSE:=MIT
PKG_LICENSE_FILES:=LICENSE
PKG_MAINTAINER:=ftkey
PKGARCH:=all

include $(INCLUDE_DIR)/package.mk

define Package/$(PKG_NAME)
  SECTION:=net
  CATEGORY:=Network
  TITLE:=Our Free Model standalone gateway for OpenWrt
  URL:=https://github.com/ftkey/dsh-our-free-model-for-openwrt
  DEPENDS:=+node
endef

define Package/$(PKG_NAME)/description
  Our Free Model standalone Node.js service with an OpenAI-compatible API
  and a local web management UI. Requires Node.js 22.19+ or 24+.
endef

define Package/$(PKG_NAME)/conffiles
/etc/config/openwrt-ofm
endef

define Build/Prepare
	$(call Build/Prepare/Default)
	$(INSTALL_DIR) $(PKG_BUILD_DIR)/payload
	$(CP) ./payload/. $(PKG_BUILD_DIR)/payload/
endef

define Build/Configure
endef

define Build/Compile
endef

define Package/$(PKG_NAME)/install
	$(INSTALL_DIR) $(1)/usr/lib/ofm
	$(CP) $(PKG_BUILD_DIR)/payload/. $(1)/usr/lib/ofm/
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/etc/init.d/ofm $(1)/etc/init.d/ofm
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/etc/config/openwrt-ofm $(1)/etc/config/openwrt-ofm
endef

$(eval $(call BuildPackage,$(PKG_NAME)))
