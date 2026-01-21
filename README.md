# luci-app-timecontrol

[![GitHub release](https://img.shields.io/github/v/release/TimouL/luci-app-timecontrol)](https://github.com/TimouL/luci-app-timecontrol/releases)
[![GitHub license](https://img.shields.io/github/license/TimouL/luci-app-timecontrol)](https://github.com/TimouL/luci-app-timecontrol/blob/main/LICENSE)

OpenWrt 上网时间控制插件 - 基于 NFT (nftables) 的设备上网时间管理工具。

> 本项目 fork 自 [sirpdboy/luci-app-timecontrol](https://github.com/sirpdboy/luci-app-timecontrol)，在原版基础上增加了每日配额管控等新功能。

## 功能特性

### 原版功能
- 基于 NFT (nftables) 的上网时间控制
- 按时间段阻断设备上网
- 按星期设置控制规则
- 实时日志显示
- 强力管控 + 即时断开

### Fork 新增功能 (v4.x)

#### 每日上网配额
- 为每个设备设置每日上网时长限制（分钟）
- 实时显示剩余时长
- 配额用尽自动阻断
- 每日零点自动重置

#### 移动端优化 (v4.0.3+)
- 紧凑两行卡片布局
- 弹窗编辑全部字段
- 快捷星期选择（每天/工作日/周末）
- 一键删除规则

#### 其他改进
- 阻断状态实时显示
- 配额状态后端同步
- 多项 Bug 修复

## 安装方法

### 方法一：通过 opkg 源安装（推荐）

```bash
# 1. 添加公钥（仅首次需要）
wget -O /tmp/timecontrol.pub https://timoul.github.io/luci-app-timecontrol/key-build.pub
opkg-key add /tmp/timecontrol.pub

# 2. 添加软件源
echo "src/gz timecontrol https://timoul.github.io/luci-app-timecontrol" >> /etc/opkg/customfeeds.conf

# 3. 更新并安装
opkg update
opkg install luci-app-timecontrol luci-i18n-timecontrol-zh-cn
```

### 方法二：手动下载安装

从 [Releases](https://github.com/TimouL/luci-app-timecontrol/releases) 页面下载最新 ipk 文件，然后：

```bash
opkg install luci-app-timecontrol_*.ipk
opkg install luci-i18n-timecontrol-zh-cn_*.ipk
```

### 方法三：编译安装

```bash
# 添加 feeds
echo "src-git timecontrol https://github.com/TimouL/luci-app-timecontrol" >> feeds.conf.default

# 更新并安装
./scripts/feeds update timecontrol
./scripts/feeds install luci-app-timecontrol

# 编译
make menuconfig  # LuCI -> Applications -> luci-app-timecontrol
make package/luci-app-timecontrol/compile V=s
```

## 更新方法

如果已通过 opkg 源安装：

```bash
opkg update
opkg upgrade luci-app-timecontrol luci-i18n-timecontrol-zh-cn
```

## 界面截图

### 桌面端
![桌面端界面](./doc/timecontrol1.png)

### 移动端（v4.0.3+）
![移动端卡片视图](./doc/timecontrol2.png)

## 系统要求

- OpenWrt 24.10+ (使用 nftables)
- 依赖：`bc`, `nftables`, `bash`, `conntrack`, `flock`

## 版本历史

| 版本 | 更新内容 |
|------|----------|
| v4.0.3 | 移动端卡片布局优化 + 弹窗编辑 |
| v4.0.2 | 修复多项前端显示和配置保存问题 |
| v4.0.1 | 阻断统计改为读取后端实际状态 |
| v4.0.0 | 新增每日配额功能 |

## 致谢

- 原作者：[sirpdboy](https://github.com/sirpdboy)
- 原项目：[sirpdboy/luci-app-timecontrol](https://github.com/sirpdboy/luci-app-timecontrol)

## 许可证

Apache-2.0 License
