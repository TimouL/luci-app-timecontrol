#!/bin/sh
# luci-app-timecontrol 配额核心函数库
# 版本: 1.0.0
# 日期: 2026-01-18

# ============================================================================
# 常量定义
# ============================================================================
QUOTA_TMP_FILE="/tmp/timecontrol_quota.json"
QUOTA_PERSIST_FILE="/etc/timecontrol_quota.json"
QUOTA_LOCK_FILE="/var/lock/timecontrol_quota.lock"
QUOTA_DIRTY=0
QUOTA_LAST_HASH=""

# 加载 OpenWrt JSON 库
. /usr/share/libubox/jshn.sh

# ============================================================================
# 文件锁（flock）
# ============================================================================

# 获取排它锁
# 使用 fd 200 作为锁文件描述符
quota_lock() {
    # 确保锁目录存在
    mkdir -p "$(dirname "$QUOTA_LOCK_FILE")" 2>/dev/null
    exec 200>"$QUOTA_LOCK_FILE"
    flock -x 200
}

# 释放锁
quota_unlock() {
    flock -u 200
}

# ============================================================================
# 脏标记管理
# ============================================================================

# 标记状态已变更
quota_mark_dirty() {
    QUOTA_DIRTY=1
}

# 检查是否需要写入
# 返回 0 表示需要写入
quota_should_write() {
    [ "$QUOTA_DIRTY" -eq 1 ] && return 0
    return 1
}

# ============================================================================
# JSON 读写
# ============================================================================

# 从文件加载配额状态到内存（jshn）
# 优先从 /tmp 读取，fallback 到 /etc
quota_load() {
    local content=""
    
    if [ -f "$QUOTA_TMP_FILE" ]; then
        content=$(cat "$QUOTA_TMP_FILE" 2>/dev/null)
    elif [ -f "$QUOTA_PERSIST_FILE" ]; then
        content=$(cat "$QUOTA_PERSIST_FILE" 2>/dev/null)
    fi
    
    # 文件不存在或为空时，初始化空结构
    if [ -z "$content" ]; then
        json_init
        json_add_int "version" 1
        json_add_int "next_reset_epoch" 0
        json_add_object "devices"
        json_close_object
        return 0
    fi
    
    # 加载 JSON 内容
    json_init
    if ! json_load "$content" 2>/dev/null; then
        # 加载失败，初始化空结构
        json_init
        json_add_int "version" 1
        json_add_int "next_reset_epoch" 0
        json_add_object "devices"
        json_close_object
    fi
}

# 将内存状态序列化为 JSON 字符串
quota_serialize() {
    json_dump
}

# 获取设备字段值
# 参数: uid 字段名
quota_get() {
    local uid="$1"
    local field="$2"
    local value=""
    
    json_select "devices" 2>/dev/null || return 1
    if json_select "$uid" 2>/dev/null; then
        json_get_var value "$field"
        json_select ..
    fi
    json_select ..
    
    echo "$value"
}

# 设置设备字段值并标记脏
# 参数: uid 字段名 值
quota_set() {
    local uid="$1"
    local field="$2"
    local val="$3"
    
    # 进入 devices 对象
    json_select "devices" 2>/dev/null
    if [ $? -ne 0 ]; then
        # devices 不存在，需要重建
        local old_content
        old_content=$(json_dump)
        json_init
        json_load "$old_content" 2>/dev/null
        json_add_object "devices"
        json_close_object
        json_select "devices"
    fi
    
    # 检查设备是否存在
    if ! json_select "$uid" 2>/dev/null; then
        # 设备不存在，创建新设备对象
        json_add_object "$uid"
        json_add_string "target" ""
        json_add_int "used_seconds" 0
        json_add_int "last_check" 0
        json_add_int "online" 0
        json_close_object
        json_select "$uid"
    fi
    
    # 设置字段值
    # 根据字段类型添加
    case "$field" in
        used_seconds|last_check|online)
            json_add_int "$field" "$val"
            ;;
        *)
            json_add_string "$field" "$val"
            ;;
    esac
    
    json_select ..
    json_select ..
    
    quota_mark_dirty
}

# 获取全局字段值
# 参数: 字段名（如 next_reset_epoch）
quota_get_global() {
    local field="$1"
    local value=""
    json_get_var value "$field"
    echo "$value"
}

# 设置全局字段值
# 参数: 字段名 值
quota_set_global() {
    local field="$1"
    local val="$2"
    
    case "$field" in
        version|next_reset_epoch)
            json_add_int "$field" "$val"
            ;;
        *)
            json_add_string "$field" "$val"
            ;;
    esac
    
    quota_mark_dirty
}

# ============================================================================
# 原子写入
# ============================================================================

# 原子写入内容到目标文件
# 使用同目录 mktemp + mv 确保原子性
# 参数: 内容 目标文件路径
quota_write() {
    local content="$1"
    local target="$2"
    local tmp
    local dir
    
    dir="$(dirname "$target")"
    mkdir -p "$dir" 2>/dev/null
    
    tmp="$(mktemp "$dir/.quota.XXXXXX")" || return 1
    echo "$content" > "$tmp" || {
        rm -f "$tmp"
        return 1
    }
    mv "$tmp" "$target" || {
        rm -f "$tmp"
        return 1
    }
    return 0
}

# 仅在状态变更时写入（带脏标记和哈希比对）
# 参数: 目标文件路径
quota_write_if_changed() {
    local target="$1"
    local content
    local new_hash
    
    # 未变更则跳过
    quota_should_write || return 0
    
    content=$(quota_serialize)
    
    # 内容哈希比对（双重保险）
    new_hash=$(echo "$content" | md5sum | cut -d' ' -f1)
    [ "$new_hash" = "$QUOTA_LAST_HASH" ] && return 0
    
    # 执行写入
    quota_write "$content" "$target" || return 1
    QUOTA_LAST_HASH="$new_hash"
    QUOTA_DIRTY=0
    return 0
}

# 持久化写入到 /etc（低频调用）
quota_persist() {
    quota_write_if_changed "$QUOTA_PERSIST_FILE"
}

# 刷新写入到 /tmp（每轮调用）
quota_flush() {
    quota_write_if_changed "$QUOTA_TMP_FILE"
}

# ============================================================================
# 配额计算
# ============================================================================

# 检查设备配额是否耗尽
# 参数: uid
# 返回: 0=已耗尽 1=未耗尽
quota_is_exhausted() {
    local uid="$1"
    local quota_minutes="$2"
    local used_seconds
    local quota_seconds
    
    used_seconds=$(quota_get "$uid" "used_seconds")
    used_seconds=${used_seconds:-0}
    quota_seconds=$((quota_minutes * 60))
    
    [ "$used_seconds" -ge "$quota_seconds" ] && return 0
    return 1
}

# 更新设备使用量（含 offline→online 处理）
# 参数: uid 当前 epoch
quota_update_usage() {
    local uid="$1"
    local now="$2"
    local was_online
    local last_check
    local delta
    local used
    
    was_online=$(quota_get "$uid" "online")
    last_check=$(quota_get "$uid" "last_check")
    was_online=${was_online:-0}
    last_check=${last_check:-0}
    
    # 刚从 offline 转 online，重置计时起点
    if [ "$was_online" != "1" ]; then
        quota_set "$uid" "last_check" "$now"
        quota_set "$uid" "online" 1
        return 0
    fi
    
    # 持续 online，累加时间（上限 120 秒防跳变）
    delta=$((now - last_check))
    [ $delta -gt 120 ] && delta=120
    [ $delta -lt 0 ] && delta=0
    
    if [ $delta -gt 0 ]; then
        used=$(quota_get "$uid" "used_seconds")
        used=${used:-0}
        quota_set "$uid" "used_seconds" "$((used + delta))"
        quota_set "$uid" "last_check" "$now"
    fi
}

# 标记设备离线
# 参数: uid
quota_mark_offline() {
    local uid="$1"
    local was_online
    
    was_online=$(quota_get "$uid" "online")
    if [ "$was_online" = "1" ]; then
        quota_set "$uid" "online" 0
    fi
}

# 重置所有设备配额
quota_reset_all() {
    local now
    local uids
    local uid
    
    now=$(date +%s)
    
    # 获取所有设备 uid
    json_select "devices" 2>/dev/null || return 0
    json_get_keys uids
    
    for uid in $uids; do
        json_select "$uid" 2>/dev/null || continue
        json_add_int "used_seconds" 0
        json_add_int "last_check" "$now"
        json_add_int "online" 0
        json_select ..
    done
    
    json_select ..
    quota_mark_dirty
}

# 计算下次配额重置的 epoch 时间
# 参数: 重置小时（0-23）
# 输出: 下次重置的 epoch
quota_calculate_next_reset() {
    local reset_hour="$1"
    local now
    local today_start
    local reset_today
    local tomorrow_reset
    
    now=$(date +%s)
    
    # 获取今天 0 点的 epoch
    today_start=$(date -d "$(date +%Y-%m-%d)" +%s 2>/dev/null)
    
    # 如果 busybox date 不支持 -d，使用替代方案
    if [ -z "$today_start" ]; then
        local hour min sec
        hour=$(date +%H)
        min=$(date +%M)
        sec=$(date +%S)
        today_start=$((now - hour*3600 - min*60 - sec))
    fi
    
    # 今天的重置时刻
    reset_today=$((today_start + reset_hour * 3600))
    
    # 如果今天重置时刻已过，返回明天的重置时刻
    if [ "$now" -ge "$reset_today" ]; then
        tomorrow_reset=$((reset_today + 86400))
        echo "$tomorrow_reset"
    else
        echo "$reset_today"
    fi
}

# ============================================================================
# 在线判定
# ============================================================================

# 判断目标是否在线
# 参数: target（IP 或 MAC）
# 返回: 0=在线 1=离线
quota_is_online() {
    local target="$1"
    local state
    local ip
    
    # 优先判断 MAC 格式（6 组 hex，用:分隔）
    # MAC 格式: XX:XX:XX:XX:XX:XX
    if echo "$target" | grep -qE '^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$'; then
        # MAC 地址：从 /proc/net/arp 反查 IP
        ip=$(grep -i "$target" /proc/net/arp 2>/dev/null | awk '{print $1}' | head -1)
        if [ -n "$ip" ]; then
            quota_is_online "$ip" && return 0
        fi
        return 1
    fi
    
    # IPv4 格式: x.x.x.x
    if echo "$target" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
        state=$(ip neigh show "$target" 2>/dev/null | awk '{print $NF}')
        case "$state" in
            REACHABLE|STALE|DELAY|PROBE)
                return 0
                ;;
        esac
        return 1
    fi
    
    # IPv6 格式（暂不支持，返回离线）
    # v1.0 仅支持 IPv4 + MAC
    return 1
}

# ============================================================================
# 格式校验
# ============================================================================

# 检查目标是否为单 IP/MAC（非 range/CIDR）
# 参数: target
# 返回: 0=单目标（支持配额） 1=range/CIDR（不支持配额）
quota_is_single_target() {
    local target="$1"
    
    # 检查是否包含 CIDR 标记（/）
    if echo "$target" | grep -q '/'; then
        return 1
    fi
    
    # 检查是否为 IP range（-）
    if echo "$target" | grep -q '-'; then
        return 1
    fi
    
    # 检查是否为多值（逗号或空格分隔）
    if echo "$target" | grep -qE '[, ]'; then
        return 1
    fi
    
    # 单 IPv4
    if echo "$target" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
        return 0
    fi
    
    # 单 MAC
    if echo "$target" | grep -qE '^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$'; then
        return 0
    fi
    
    # 其他格式（如主机名），不支持配额
    return 1
}

# ============================================================================
# GC 清理
# ============================================================================

# 清理不存在的 uid（孤儿项）
# 参数: 有效 uid 列表（空格分隔）
# 通过重建 devices 对象实现删除
quota_gc() {
    local valid_uids="$1"
    local existing_uids
    local uid
    local found
    local valid
    local has_orphan=0
    
    # 获取 JSON 中所有设备 uid
    json_select "devices" 2>/dev/null || return 0
    json_get_keys existing_uids
    
    # 先检查是否有孤儿项
    for uid in $existing_uids; do
        found=0
        for valid in $valid_uids; do
            if [ "$uid" = "$valid" ]; then
                found=1
                break
            fi
        done
        
        if [ "$found" -eq 0 ]; then
            has_orphan=1
            break
        fi
    done
    
    json_select ..
    
    # 如果有孤儿项，需要重建 devices 对象
    if [ "$has_orphan" -eq 1 ]; then
        local old_json=$(quota_serialize)
        local new_devices=""
        
        # 遍历有效 uid，提取其数据
        for valid in $valid_uids; do
            [ -z "$valid" ] && continue
            
            # 使用 jsonfilter 提取设备数据
            local device_data=$(echo "$old_json" | jsonfilter -e "$.devices['$valid']" 2>/dev/null)
            if [ -n "$device_data" ]; then
                if [ -z "$new_devices" ]; then
                    new_devices="\"$valid\":$device_data"
                else
                    new_devices="$new_devices,\"$valid\":$device_data"
                fi
            fi
        done
        
        # 重建 JSON
        local version=$(echo "$old_json" | jsonfilter -e '$.version' 2>/dev/null)
        local next_reset=$(echo "$old_json" | jsonfilter -e '$.next_reset_epoch' 2>/dev/null)
        version=${version:-1}
        next_reset=${next_reset:-0}
        
        local new_json="{\"version\":$version,\"next_reset_epoch\":$next_reset,\"devices\":{$new_devices}}"
        
        # 重新加载
        json_init
        if json_load "$new_json" 2>/dev/null; then
            quota_mark_dirty
        else
            # 加载失败，保持原状
            json_init
            json_load "$old_json" 2>/dev/null
        fi
    fi
}

# 初始化设备配额记录
# 参数: uid target
quota_init_device() {
    local uid="$1"
    local target="$2"
    local now
    
    now=$(date +%s)
    
    quota_set "$uid" "target" "$target"
    quota_set "$uid" "used_seconds" 0
    quota_set "$uid" "last_check" "$now"
    quota_set "$uid" "online" 0
}

# 获取设备剩余秒数
# 参数: uid quota_minutes
# 输出: 剩余秒数（负数表示已超额）
quota_get_remaining() {
    local uid="$1"
    local quota_minutes="$2"
    local used_seconds
    local quota_seconds
    local remaining
    
    used_seconds=$(quota_get "$uid" "used_seconds")
    used_seconds=${used_seconds:-0}
    quota_seconds=$((quota_minutes * 60))
    remaining=$((quota_seconds - used_seconds))
    
    echo "$remaining"
}

# 格式化秒数为易读字符串
# 参数: 秒数
# 输出: "Xh Ym" 或 "Xm Ys"
quota_format_time() {
    local seconds="$1"
    local hours
    local mins
    local secs
    
    if [ "$seconds" -le 0 ]; then
        echo "0m"
        return
    fi
    
    hours=$((seconds / 3600))
    mins=$(((seconds % 3600) / 60))
    secs=$((seconds % 60))
    
    if [ "$hours" -gt 0 ]; then
        echo "${hours}h ${mins}m"
    elif [ "$mins" -gt 0 ]; then
        echo "${mins}m ${secs}s"
    else
        echo "${secs}s"
    fi
}
