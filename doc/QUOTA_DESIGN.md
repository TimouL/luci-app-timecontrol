# luci-app-timecontrol 每日时长配额功能设计文档

> 版本: 1.0.1  
> 日期: 2026-01-18  
> 基于: sirpdboy/luci-app-timecontrol v3.2.1  
> 审查: Oracle 交叉审查通过

## 1. 需求概述

在现有时间段控制基础上，新增**每日总时长限制**功能：
- 设备每天可上网 X 分钟，用完即断
- 与时间段控制可同时启用
- 跨天自动重置配额

## 2. 核心决策表

| block_period | quota_enabled | quota_exhausted | is_online | should_block | should_count | 说明 |
|---:|---:|---:|---:|---:|---:|:---|
| 0 | 0 | - | 0 | 0 | 0 | 非禁网时段；未启用配额；离线，不计时 |
| 0 | 0 | - | 1 | 0 | 0 | 非禁网时段；未启用配额；在线但不计时（无配额） |
| 0 | 1 | 0 | 0 | 0 | 0 | 非禁网时段；配额未耗尽；离线，不计时 |
| 0 | 1 | 0 | 1 | 0 | 1 | 非禁网时段；配额未耗尽；在线，允许并计时 |
| 0 | 1 | 1 | - | 1 | 0 | 非禁网时段；配额已耗尽；阻断，不计时 |
| 1 | - | - | - | 1 | 0 | 禁网时段优先阻断；不计时 |

**关键规则**：
- `blocked_by_quota = quota_enabled && quota_exhausted`
- `should_block = block_period || blocked_by_quota`
- `should_count = quota_enabled && (!should_block) && is_online`  *(v1.0.1 修正：仅启用配额的设备才计时)*
- 阻断时**不消耗配额**

## 3. 配置扩展

### 3.1 UCI 配置 (`/etc/config/timecontrol`)

```uci
config timecontrol
    option enabled '1'
    option list_type 'blacklist'
    option chain 'input'
    option quota_reset_hour '0'     # 配额重置时间（0-23点）

config device
    option uid 'dev_abc123'         # 唯一标识（自动生成）
    option enable '1'
    option mac '192.168.10.100'
    option timestart '21:00'
    option timeend '07:00'
    option week '0'
    option quota_enabled '0'        # 是否启用时长限制
    option quota_minutes '120'      # 每日可用分钟数
```

### 3.2 配额状态文件

**运行态**：`/tmp/timecontrol_quota.json`（每分钟更新）

**持久化**：`/etc/timecontrol_quota.json`（低频写入）

```json
{
  "version": 1,
  "next_reset_epoch": 1737244800,
  "devices": {
    "dev_abc123": {
      "target": "192.168.10.100",
      "used_seconds": 2700,
      "last_check": 1737187200,
      "online": 1
    }
  }
}
```

**落盘时机**：
- 每 10 分钟同步到 `/etc`
- 配额耗尽时
- 服务停止时
- 日期重置时

## 4. 主循环伪代码

```pseudo
init:
  load UCI config
  ensure each device section has uid (stable key)
  load quota_state from file (atomic read)
  next_reset = calculate_next_reset(reset_hour)

loop every 60 seconds:
  now = epoch()

  # 检查配额重置
  if now >= next_reset:
    for each device uid:
      quota_state[uid].used_seconds = 0
      quota_state[uid].last_check = now
      quota_state[uid].online = 0
    atomic_write(quota_state)
    next_reset = calculate_next_reset(reset_hour)

  # 遍历设备
  for each device in config:
    uid = device.uid
    target = device.target

    block_period = is_in_block_period(device.schedule, now)
    is_online = is_device_online(target)

    quota_enabled = device.quota_enabled
    quota_seconds = device.quota_minutes * 60
    used = quota_state[uid].used_seconds

    quota_exhausted = (used >= quota_seconds)
    blocked_by_quota = quota_enabled && quota_exhausted
    should_block = block_period || blocked_by_quota
    should_count = (!should_block) && is_online

    # 执行阻断/放行（单点决策）
    if should_block:
      apply_block(uid, target)
    else:
      remove_block(uid, target)

    # 计时逻辑
    if should_count:
      update_quota_usage(uid, now)
    else:
      mark_device_offline(uid)

  atomic_write(quota_state)
  sleep(60)
```

## 5. 在线判定

使用 `ip neigh show` 获取邻居状态：

```bash
is_device_online() {
    local target="$1"
    case "$target" in
        # IPv4/IPv6: 直接查邻居状态
        *.*.*|*:*)
            local state=$(ip neigh show "$target" 2>/dev/null | awk '{print $NF}')
            case "$state" in
                REACHABLE|STALE|DELAY|PROBE) return 0 ;;
            esac
            ;;
        # MAC: 从 ARP 反查 IP
        *:*:*)
            local ip=$(grep -i "$target" /proc/net/arp | awk '{print $1}' | head -1)
            [ -n "$ip" ] && is_device_online "$ip" && return 0
            ;;
    esac
    return 1
}
```

## 6. 计时逻辑

```bash
update_quota_usage() {
    local uid="$1"
    local now="$2"
    
    local was_online=$(quota_get "$uid" "online")
    local last_check=$(quota_get "$uid" "last_check")
    
    # 刚从 offline 转 online，重置计时起点
    if [ "$was_online" != "1" ]; then
        quota_set "$uid" "last_check" "$now"
        quota_set "$uid" "online" "1"
        return
    fi
    
    # 持续 online，累加（上限 120 秒防跳变）
    local delta=$((now - last_check))
    [ $delta -gt 120 ] && delta=120
    [ $delta -lt 0 ] && delta=0
    
    local used=$(quota_get "$uid" "used_seconds")
    quota_set "$uid" "used_seconds" "$((used + delta))"
    quota_set "$uid" "last_check" "$now"
}
```

## 7. 原子写入与并发

```bash
# 文件锁
quota_lock() {
    exec 200>/var/lock/timecontrol_quota.lock
    flock -x 200
}

quota_unlock() {
    flock -u 200
}

# 原子写入（同目录 mktemp + mv）
quota_write() {
    local content="$1"
    local target="$2"
    local tmp
    tmp="$(mktemp "$(dirname "$target")/.quota.XXXXXX")"
    echo "$content" > "$tmp"
    mv "$tmp" "$target"
}
```

### 7.1 写入优化：仅状态变更时写入

为减少 flash 写放大，采用**脏标记 + 变更检测**策略：

```bash
QUOTA_DIRTY=0           # 脏标记
QUOTA_LAST_HASH=""      # 上次内容哈希

# 标记状态已变更
quota_mark_dirty() {
    QUOTA_DIRTY=1
}

# 检查是否需要写入
quota_should_write() {
    [ "$QUOTA_DIRTY" -eq 1 ] && return 0
    return 1
}

# 条件写入（仅当状态变更时）
quota_write_if_changed() {
    local target="$1"
    
    # 未变更则跳过
    quota_should_write || return 0
    
    local content
    content=$(quota_serialize)
    
    # 内容哈希比对（双重保险）
    local new_hash
    new_hash=$(echo "$content" | md5sum | cut -d' ' -f1)
    [ "$new_hash" = "$QUOTA_LAST_HASH" ] && return 0
    
    # 执行写入
    quota_write "$content" "$target"
    QUOTA_LAST_HASH="$new_hash"
    QUOTA_DIRTY=0
}
```

**触发 `quota_mark_dirty()` 的时机**：
- `used_seconds` 累加时
- 设备 `online` 状态变化时
- 配额重置时
- 设备首次添加时

**写入策略**：

| 目标文件 | 写入条件 |
|---------|---------|
| `/tmp/timecontrol_quota.json` | `QUOTA_DIRTY=1` 时每轮写入 |
| `/etc/timecontrol_quota.json` | `QUOTA_DIRTY=1` **且** (每 10 分钟 / 配额耗尽 / 服务停止 / 日期重置) |

**预期效果**：
- 设备全部离线时：无任何写入
- 设备在线但配额未变（如仅检测状态）：无写入
- 正常使用：`/tmp` 每分钟最多 1 次，`/etc` 每 10 分钟最多 1 次

## 8. 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `/etc/config/timecontrol` | 修改 | 新增 quota_reset_hour |
| `/usr/share/timecontrol/quota.sh` | **新增** | 配额核心函数库 |
| `/usr/bin/timecontrolctrl` | 修改 | 集成配额逻辑，修复 idlist bug |
| `/usr/bin/timecontrol-quota` | **新增** | CLI 工具（status/reset/add） |
| `/usr/libexec/timecontrol-status` | **新增** | RPC 批量状态接口 |
| `htdocs/.../timecontrol/basic.js` | 修改 | 配额 UI 元素 |
| `po/zh_Hans/timecontrol.po` | 修改 | 新增翻译 |

## 9. LuCI 界面扩展

### 全局配置
- **配额重置时间** (ListValue): 0-23 点

### 设备规则表格新增列
- **启用时长限制** (Flag)
- **每日配额** (Value, 分钟)
- **剩余时长** (DummyValue, 只读，通过 RPC 获取)

### 限制
- 配额功能仅支持单 IP/单 MAC
- 对 range/CIDR 禁用配额选项（UI 灰化）

## 10. 现有代码修复

### 10.1 设备索引解析 Bug

```bash
# 修复前（只能取单位数）
idlist=$(... | grep -o '[0-9]')

# 修复后
idlist=$(uci show $NAME | grep "enable='1'" | grep "device" | \
         grep -oE '\[([0-9]+)\]' | grep -oE '[0-9]+')
```

### 10.2 配置热更新

每轮循环重新读取 UCI 设备列表，而非仅启动时读取一次。

## 11. 实施步骤

1. **Phase 1**: 创建 `quota.sh` 核心库，实现锁、读写、计算函数
2. **Phase 2**: 修改 `timecontrolctrl`，集成配额检查逻辑
3. **Phase 3**: 创建 `timecontrol-quota` CLI 工具
4. **Phase 4**: 扩展 LuCI 界面
5. **Phase 5**: 测试与验收

---

*Reviewed by Oracle*

---

## 附录 A：Oracle 审查意见与补充约束

### A.1 技术边界条件

1. **MAC/IPv6 在线判定分支冲突**
   - 问题：`case` 中 `*:*` 会同时匹配 IPv6 和 MAC
   - 约束：实现时必须优先判断 MAC（6 组 hex 格式），或明确限制"v1.0 仅支持 IPv4 + MAC，IPv6 后续版本支持"

2. **range/CIDR 后端强制校验**
   - 约束：后端必须拒绝/忽略 CIDR 的 `quota_enabled`/`quota_minutes`，不能仅靠 UI 灰化
   - 实现：`quota.sh` 中检测目标格式，若为 range/CIDR 则跳过计时

3. **设备删除后的状态清理（GC 策略）**
   - 约束：每次写 `/etc` 时，prune 不存在的 uid
   - 实现：对比 UCI 设备列表与 JSON devices，移除孤儿项

4. **reset_hour 与时间跳变**
   - 约束：启动时若文件中 `next_reset_epoch` 与计算值偏差 >24h，以重新计算为准
   - 避免 NTP 校时/重启后卡在错误 reset 点

5. **start == end 语义**
   - 现有习惯：`start == end` 代表全天命中（24 小时禁网）
   - 约束：UI 文案需明示，避免用户误解为"0 分钟/无效"

6. **服务停止时 flush**
   - 约束：init.d stop / trap EXIT 必须显式调用 `quota_write_if_changed`
   - 避免 kill/重启丢失最后一段使用量

7. **锁的全局一致性**
   - 约束：所有读写入口（主循环、RPC、CLI）必须走同一把 flock 锁

### A.2 UI/UX 约束

1. **表格列优化**
   - 问题：新增 3 列后共 9 列，移动端必然溢出
   - 方案：
     - 表格仅显示：`启用时长限制`(Flag) + `剩余时长`(DummyValue)
     - `每日配额(分钟)` 设为 `modalonly`（编辑弹窗内修改）
   - 列顺序：Enabled → Comment → IP/MAC → Week+Time → 启用时长限制 → 剩余时长

2. **时间段与配额关系说明**
   - 约束：在全局配置区或表格标题下加一句说明
   - 文案建议："禁网时段优先阻断；阻断时不消耗配额；仅在允许上网且在线时扣减配额"

3. **剩余时长显示**
   - 刷新频率：30-60 秒，与主循环一致
   - 格式：`1h 20m` 或中文 `1小时20分`
   - 特殊状态：
     - `< 5 min`：显示"即将耗尽"
     - `= 0`：显示"已耗尽（已阻断）"并标红

4. **配额耗尽反馈**
   - 增加状态标签 DummyValue（如"Quota exhausted"）
   - 保存时校验：启用配额但分钟数为 0 时报错

5. **Accessibility**
   - 灰化不能仅靠颜色，必须同时设 disabled + 说明文案（"CIDR/范围地址不支持配额"）
   - 状态显示：文字优先、颜色辅助（避免色盲问题）

6. **全局配置增强**
   - 在"配额重置时间"旁显示"下次重置时间"（只读 DummyValue）
   - 用户更容易验证配置生效

7. **批量重置按钮**
   - 提供"重置全部配额"按钮
   - 二次确认 + 范围选择（全部 vs 仅启用配额的设备）
   - 提示："仅影响配额计数，不改变时间段规则"

8. **IP/MAC 输入即时校验**
   - 检测到 CIDR/range 时立即提示"配额将不可用"
