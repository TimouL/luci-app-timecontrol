# luci-app-timecontrol opkg 源

## 首次使用：添加公钥

```bash
wget -O /tmp/timecontrol.pub https://timoul.github.io/luci-app-timecontrol/key-build.pub
opkg-key add /tmp/timecontrol.pub
```

## 添加源

```bash
echo "src/gz timecontrol https://timoul.github.io/luci-app-timecontrol" >> /etc/opkg/customfeeds.conf
```

## 安装

```bash
opkg update
opkg install luci-app-timecontrol luci-i18n-timecontrol-zh-cn
```
