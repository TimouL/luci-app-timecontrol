#
# Copyright (C) 2006-2017 OpenWrt.org
# Copyright (C) 2022-2025 sirpdboy <herboy2008@gmail.com>
# Copyright (C) 2026 配额功能扩展
# This is free software, licensed under the GNU General Public License v2.
# See /LICENSE for more information.
#

include $(TOPDIR)/rules.mk

THEME_NAME:=timecontrol
PKG_NAME:=luci-app-$(THEME_NAME)

PKG_LICENSE:=Apache-2.0

LUCI_TITLE:=LuCI support for timecontrol for nftables
LUCI_DESCRIPTION:=LuCI support for Easy timecontrol for nftables(Internet time control) with daily quota feature.
LUCI_DEPENDS:=+bc +nftables +bash +conntrack +flock
LUCI_PKGARCH:=all

PKG_VERSION:=4.0.2
PKG_RELEASE:=20260118
PKG_MAINTAINER:=sirpdboy <herboy2008@gmail.com>

define Build/Compile
endef

define Package/$(PKG_NAME)/postinst
#!/bin/sh
rm -f /tmp/luci-*
# 确保新增脚本可执行
chmod +x /usr/bin/timecontrol-quota 2>/dev/null
chmod +x /usr/libexec/timecontrol-status 2>/dev/null
chmod +x /usr/share/timecontrol/quota.sh 2>/dev/null
endef

define Package/$(PKG_NAME)/conffiles
/etc/config/timecontrol
/etc/timecontrol_quota.json
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature

