include $(TOPDIR)/rules.mk

PKG_NAME:=dsh-our-free-model-for-openwrt
PKG_VERSION:=$(shell python3 -c 'import json; print(json.load(open("$(CURDIR)/payload/PORT-VERSION.json"))["version"])')
PKG_RELEASE:=3
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
  DEPENDS:=+node +luci-base +rpcd +rpcd-mod-luci
endef

define Package/$(PKG_NAME)/description
  Our Free Model standalone Node.js service with an OpenAI-compatible API
  and a local web management UI. Requires Node.js 22.19+ or 24+.
endef

define Package/$(PKG_NAME)/conffiles
/etc/config/openwrt-ofm
/etc/ofm-access.json
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
	$(INSTALL_CONF) ./files/etc/ofm-access.json $(1)/etc/ofm-access.json
	$(INSTALL_DIR) $(1)/usr/lib/ofm-access
	$(CP) ./files/usr/lib/ofm-access/. $(1)/usr/lib/ofm-access/
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view
	$(INSTALL_DATA) ./files/www/luci-static/resources/view/ourfreemodel.js $(1)/www/luci-static/resources/view/
	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./files/usr/share/luci/menu.d/luci-app-ourfreemodel.json $(1)/usr/share/luci/menu.d/
	$(INSTALL_DATA) ./files/usr/share/rpcd/acl.d/luci-app-ourfreemodel.json $(1)/usr/share/rpcd/acl.d/
	$(INSTALL_DIR) $(1)/usr/libexec/rpcd $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./files/usr/libexec/rpcd/ourfreemodel $(1)/usr/libexec/rpcd/
	$(INSTALL_BIN) ./files/etc/uci-defaults/90-ourfreemodel $(1)/etc/uci-defaults/
endef

define Package/$(PKG_NAME)/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
[ ! -f /etc/uci-defaults/90-ourfreemodel ] || /bin/sh /etc/uci-defaults/90-ourfreemodel || exit 1
rm -f /tmp/luci-indexcache /tmp/luci-indexcache.*
/etc/init.d/rpcd restart >/dev/null 2>&1 || true
exit 0
endef

$(eval $(call BuildPackage,$(PKG_NAME)))
