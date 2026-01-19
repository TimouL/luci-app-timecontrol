#!/bin/sh
# luci-app-timecontrol 配额核心函数库
# 版本: 1.1.0
# 日期: 2026-01-18
# 修复: Oracle 审查 P0 问题

# ============================================================================
# 常量定义
# ============================================================================
QUOTA_TMP_FILE="/tmp/timecontrol_quota.json"
QUOTA_PERSIST_FILE="/etc/timecontrol_quota.json"
QUOTA_LOCK_FILE="/var/lock/timecontrol_quota.lock"
# 分离 /tmp 和 /etc 的脏标记和哈希，避免互相干扰
QUOTA_DIRTY_TMP=0
QUOTA_DIRTY_PERSIST=0
QUOTA_LAST_HASH_TMP=""
QUOTA_LAST_HASH_PERSIST=""

# 加载 OpenWrt JSON 库
. /usr/share/libubox/jshn.sh

# ============================================================================
# 数字清洗工具函数
# ============================================================================

# 将输入规范化为整数，非数字返回默认值
# 参数: 输入值 [默认值=0]
# 输出: 纯整数
_to_int() {
    local val="$1"
    local default="${2:-0}"
    
    # 去除前后空格
    val=$(echo "$val" | tr -d ' \t\n\r')
    
    # 空值返回默认
    [ -z "$val" ] && { echo "$default"; return; }
    
    # 去除前导零（避免八进制问题）
    # 保留负号，去除数字部分的前导零
    case "$val" in
        -*)
            local sign="-"
            local num="${val#-}"
            # 去除前导零
            while [ "${num#0}" != "$num" ] && [ "${#num}" -gt 1 ]; do
                num="${num#0}"
            done
            # 检查是否为纯数字
            case "$num" in
                ''|*[!0-9]*) echo "$default"; return ;;
            esac
            echo "${sign}${num}"
            ;;
        *)
            # 去除前导零
            while [ "${val#0}" != "$val" ] && [ "${#val}" -gt 1 ]; do
                val="${val#0}"
            done
            # 检查是否为纯数字
            case "$val" in
                ''|*[!0-9]*) echo "$default"; return ;;
            esac
            echo "$val"
            ;;
    esac
}

# ============================================================================
# 文件锁（flock）
# ============================================================================

# 获取排它锁
quota_lock() {
    # 检查 flock 是否可用
    if ! command -v flock >/dev/null 2>&1; then
        # flock 不可用，使用简单文件锁
        local lockdir="$(dirname "$QUOTA_LOCK_FILE")"
        mkdir -p "$lockdir" 2>/dev/null
        while ! mkdir "$QUOTA_LOCK_FILE.dir" 2>/dev/null; do
            sleep 1
        done
        return 0
    fi
    
    mkdir -p "$(dirname "$QUOTA_LOCK_FILE")" 2>/dev/null
    exec 200>"$QUOTA_LOCK_FILE"
    flock -x 200
}

# 释放锁
quota_unlock() {
    if ! command -v flock >/dev/null 2>&1; then
        rmdir "$QUOTA_LOCK_FILE.dir" 2>/dev/null
        return 0
    fi
    
    flock -u 200
    exec 200>&-
}

# ============================================================================
# 脏标记管理
# ============================================================================

quota_mark_dirty() {
    QUOTA_DIRTY_TMP=1
    QUOTA_DIRTY_PERSIST=1
}

quota_should_write_tmp() {
    [ "${QUOTA_DIRTY_TMP:-0}" = "1" ] && return 0
    return 1
}

quota_should_write_persist() {
    [ "${QUOTA_DIRTY_PERSIST:-0}" = "1" ] && return 0
    return 1
}

# ============================================================================
# JSON 读写
# ============================================================================

# 初始化空的配额结构
_quota_init_empty() {
    json_init
    json_add_int "version" 1
    json_add_int "next_reset_epoch" 0
    json_add_object "devices"
    json_close_object
    quota_mark_dirty
    QUOTA_LAST_HASH_TMP=""
    QUOTA_LAST_HASH_PERSIST=""
}

# 从文件加载配额状态到内存
# 优先从 /tmp 读取，/tmp 损坏时 fallback 到 /etc
quota_load() {
    local content=""
    local loaded=0
    
    # 尝试 /tmp
    if [ -f "$QUOTA_TMP_FILE" ]; then
        content=$(cat "$QUOTA_TMP_FILE" 2>/dev/null)
        if [ -n "$content" ]; then
            json_init
            if json_load "$content" 2>/dev/null; then
                loaded=1
            fi
        fi
    fi
    
    # /tmp 失败，尝试 /etc
    if [ "$loaded" != "1" ] && [ -f "$QUOTA_PERSIST_FILE" ]; then
        content=$(cat "$QUOTA_PERSIST_FILE" 2>/dev/null)
        if [ -n "$content" ]; then
            json_init
            if json_load "$content" 2>/dev/null; then
                loaded=1
                # 从持久化恢复成功，标记脏以便写回 /tmp
                quota_mark_dirty
            fi
        fi
    fi
    
    # 都失败，初始化空结构
    if [ "$loaded" != "1" ]; then
        _quota_init_empty
        return 0
    fi
    
    # 加载成功后，更新两边的哈希基准（避免误判变更）
    local current_hash
    if command -v md5sum >/dev/null 2>&1; then
        current_hash=$(json_dump 2>/dev/null | md5sum | cut -d' ' -f1)
        QUOTA_LAST_HASH_TMP="$current_hash"
        QUOTA_LAST_HASH_PERSIST="$current_hash"
    fi
}

quota_serialize() {
    json_dump 2>/dev/null
}

# 获取设备字段值
# 参数: uid 字段名
# 返回: 字段值（失败时返回空字符串）
quota_get() {
    local uid="$1"
    local field="$2"
    local value=""
    
    {
        json_select "devices" || { echo ""; return 1; }
        if json_select "$uid"; then
            json_get_var value "$field"
            json_select ..
        fi
        json_select ..
    } 2>/dev/null
    
    echo "$value"
}

# 设置设备字段值并标记脏
# 参数: uid 字段名 值
quota_set() {
    local uid="$1"
    local field="$2"
    local val="$3"
    
    {
        # 进入 devices 对象
        if ! json_select "devices"; then
            # devices 不存在，在 root 创建
            json_add_object "devices"
            json_close_object
            json_select "devices" || return 1
        fi
        
        # 检查设备是否存在
        if ! json_select "$uid"; then
            # 设备不存在，创建新设备对象
            json_add_object "$uid"
            json_add_string "target" ""
            json_add_int "used_seconds" 0
            json_add_int "last_check" 0
            json_add_int "online" 0
            json_close_object
            json_select "$uid" || { json_select ..; return 1; }
        fi
        
        # 设置字段值（数字类型做清洗）
        case "$field" in
            used_seconds|last_check|online)
                val=$(_to_int "$val" 0)
                json_add_int "$field" "$val"
                ;;
            *)
                json_add_string "$field" "$val"
                ;;
        esac
        
        json_select ..
        json_select ..
    } 2>/dev/null
    
    quota_mark_dirty
}

# 获取全局字段值
quota_get_global() {
    local field="$1"
    local value=""
    json_get_var value "$field" 2>/dev/null
    echo "$value"
}

# 设置全局字段值
quota_set_global() {
    local field="$1"
    local val="$2"
    
    {
        case "$field" in
            version|next_reset_epoch)
                val=$(_to_int "$val" 0)
                json_add_int "$field" "$val"
                ;;
            *)
                json_add_string "$field" "$val"
                ;;
        esac
    } 2>/dev/null
    
    quota_mark_dirty
}

# ============================================================================
# 原子写入
# ============================================================================

quota_write() {
    local content="$1"
    local target="$2"
    local tmp
    local dir
    
    dir="$(dirname "$target")"
    mkdir -p "$dir" 2>/dev/null
    
    tmp="$(mktemp "$dir/.quota.XXXXXX")" || return 1
    printf '%s\n' "$content" > "$tmp" || {
        rm -f "$tmp"
        return 1
    }
    chmod 0644 "$tmp" 2>/dev/null
    mv "$tmp" "$target" || {
        rm -f "$tmp"
        return 1
    }
    return 0
}

# 写入 /etc 持久化文件（独立脏标记和哈希）
quota_persist() {
    local content
    local new_hash
    
    quota_should_write_persist || return 0
    
    content=$(quota_serialize)
    
    if command -v md5sum >/dev/null 2>&1; then
        new_hash=$(printf '%s' "$content" | md5sum | cut -d' ' -f1)
        if [ "$new_hash" = "$QUOTA_LAST_HASH_PERSIST" ]; then
            QUOTA_DIRTY_PERSIST=0
            return 0
        fi
    fi
    
    quota_write "$content" "$QUOTA_PERSIST_FILE" || return 1
    QUOTA_LAST_HASH_PERSIST="$new_hash"
    QUOTA_DIRTY_PERSIST=0
    return 0
}

# 写入 /tmp 临时文件（独立脏标记和哈希）
quota_flush() {
    local content
    local new_hash
    
    quota_should_write_tmp || return 0
    
    content=$(quota_serialize)
    
    if command -v md5sum >/dev/null 2>&1; then
        new_hash=$(printf '%s' "$content" | md5sum | cut -d' ' -f1)
        if [ "$new_hash" = "$QUOTA_LAST_HASH_TMP" ]; then
            QUOTA_DIRTY_TMP=0
            return 0
        fi
    fi
    
    quota_write "$content" "$QUOTA_TMP_FILE" || return 1
    QUOTA_LAST_HASH_TMP="$new_hash"
    QUOTA_DIRTY_TMP=0
    return 0
}

# ============================================================================
# 配额计算
# ============================================================================

# 检查设备配额是否耗尽
quota_is_exhausted() {
    local uid="$1"
    local quota_minutes="$2"
    local used_seconds
    local quota_seconds
    
    quota_minutes=$(_to_int "$quota_minutes" 0)
    used_seconds=$(_to_int "$(quota_get "$uid" "used_seconds")" 0)
    quota_seconds=$((quota_minutes * 60))
    
    [ "$used_seconds" -ge "$quota_seconds" ] && return 0
    return 1
}

# 更新设备使用量
quota_update_usage() {
    local uid="$1"
    local now="$2"
    local was_online
    local last_check
    local delta
    local used
    
    now=$(_to_int "$now" 0)
    was_online=$(_to_int "$(quota_get "$uid" "online")" 0)
    last_check=$(_to_int "$(quota_get "$uid" "last_check")" 0)
    
    # 刚从 offline 转 online，重置计时起点
    if [ "$was_online" != "1" ]; then
        quota_set "$uid" "last_check" "$now"
        quota_set "$uid" "online" 1
        return 0
    fi
    
    # 持续 online，累加时间（上限 120 秒防跳变）
    delta=$((now - last_check))
    [ "$delta" -gt 120 ] && delta=120
    [ "$delta" -lt 0 ] && delta=0
    
    if [ "$delta" -gt 0 ]; then
        used=$(_to_int "$(quota_get "$uid" "used_seconds")" 0)
        quota_set "$uid" "used_seconds" "$((used + delta))"
        quota_set "$uid" "last_check" "$now"
    fi
}

# 标记设备离线
quota_mark_offline() {
    local uid="$1"
    local was_online
    
    was_online=$(_to_int "$(quota_get "$uid" "online")" 0)
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
    now=$(_to_int "$now" 0)
    
    {
        json_select "devices" || return 0
        json_get_keys uids
        
        for uid in $uids; do
            json_select "$uid" || continue
            json_add_int "used_seconds" 0
            json_add_int "last_check" "$now"
            json_add_int "online" 0
            json_select ..
        done
        
        json_select ..
    } 2>/dev/null
    
    quota_mark_dirty
}

# 计算下次配额重置的 epoch 时间
quota_calculate_next_reset() {
    local reset_hour="$1"
    local now
    local today_start
    local reset_today
    local tomorrow_reset
    
    reset_hour=$(_to_int "$reset_hour" 0)
    # 限制范围 0-23
    [ "$reset_hour" -lt 0 ] && reset_hour=0
    [ "$reset_hour" -gt 23 ] && reset_hour=0
    
    now=$(date +%s)
    now=$(_to_int "$now" 0)
    
    # 获取今天 0 点的 epoch
    today_start=$(date -d "$(date +%Y-%m-%d)" +%s 2>/dev/null)
    
    # 如果 busybox date 不支持 -d，使用替代方案
    if [ -z "$today_start" ] || [ "$today_start" = "" ]; then
        local hour min sec
        hour=$(date +%H)
        min=$(date +%M)
        sec=$(date +%S)
        # 使用 10# 避免八进制问题
        hour=$((10#$hour + 0))
        min=$((10#$min + 0))
        sec=$((10#$sec + 0))
        today_start=$((now - hour*3600 - min*60 - sec))
    fi
    
    today_start=$(_to_int "$today_start" "$now")
    
    reset_today=$((today_start + reset_hour * 3600))
    
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

quota_is_online() {
    local target="$1"
    local state
    local ip
    
    # 检查必要命令
    command -v ip >/dev/null 2>&1 || return 1
    
    # MAC 格式: XX:XX:XX:XX:XX:XX
    if echo "$target" | grep -qE '^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$'; then
        # MAC 地址：从 /proc/net/arp 反查 IP（使用 -F 固定字符串匹配）
        ip=$(grep -iF "$target" /proc/net/arp 2>/dev/null | awk '{print $1}' | head -1)
        if [ -n "$ip" ]; then
            quota_is_online "$ip" && return 0
        fi
        return 1
    fi
    
    # IPv4 格式
    if echo "$target" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
        state=$(ip neigh show "$target" 2>/dev/null | awk '{print $NF}')
        case "$state" in
            REACHABLE|STALE|DELAY|PROBE)
                return 0
                ;;
        esac
        return 1
    fi
    
    return 1
}

# ============================================================================
# 格式校验
# ============================================================================

quota_is_single_target() {
    local target="$1"
    
    # CIDR
    echo "$target" | grep -q '/' && return 1
    # IP range
    echo "$target" | grep -q '-' && return 1
    # 多值
    echo "$target" | grep -qE '[, ]' && return 1
    
    # 单 IPv4
    echo "$target" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' && return 0
    # 单 MAC
    echo "$target" | grep -qE '^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$' && return 0
    
    return 1
}

# ============================================================================
# GC 清理（使用 jshn 重建，不依赖 jsonfilter）
# ============================================================================

quota_gc() {
    local valid_uids="$1"
    local existing_uids
    local uid
    local found
    local valid
    local has_orphan=0
    
    # 临时存储有效设备数据
    local dev_data=""
    
    {
        json_select "devices" || return 0
        json_get_keys existing_uids
        
        # 检查是否有孤儿项并收集有效设备数据
        for uid in $existing_uids; do
            found=0
            for valid in $valid_uids; do
                if [ "$uid" = "$valid" ]; then
                    found=1
                    break
                fi
            done
            
            if [ "$found" = "0" ]; then
                has_orphan=1
            else
                # 收集有效设备数据
                if json_select "$uid"; then
                    local target used_seconds last_check online
                    json_get_var target "target"
                    json_get_var used_seconds "used_seconds"
                    json_get_var last_check "last_check"
                    json_get_var online "online"
                    dev_data="$dev_data $uid|$target|$used_seconds|$last_check|$online"
                    json_select ..
                fi
            fi
        done
        
        json_select ..
    } 2>/dev/null
    
    # 如果有孤儿项，重建 devices 对象
    if [ "$has_orphan" = "1" ]; then
        local version next_reset
        version=$(_to_int "$(quota_get_global "version")" 1)
        next_reset=$(_to_int "$(quota_get_global "next_reset_epoch")" 0)
        
        # 重新初始化
        json_init
        json_add_int "version" "$version"
        json_add_int "next_reset_epoch" "$next_reset"
        json_add_object "devices"
        
        # 恢复有效设备
        for entry in $dev_data; do
            [ -z "$entry" ] && continue
            local uid target used_seconds last_check online
            uid=$(echo "$entry" | cut -d'|' -f1)
            target=$(echo "$entry" | cut -d'|' -f2)
            used_seconds=$(_to_int "$(echo "$entry" | cut -d'|' -f3)" 0)
            last_check=$(_to_int "$(echo "$entry" | cut -d'|' -f4)" 0)
            online=$(_to_int "$(echo "$entry" | cut -d'|' -f5)" 0)
            
            json_add_object "$uid"
            json_add_string "target" "$target"
            json_add_int "used_seconds" "$used_seconds"
            json_add_int "last_check" "$last_check"
            json_add_int "online" "$online"
            json_close_object
        done
        
        json_close_object
        quota_mark_dirty
    fi
}

# 初始化设备配额记录
quota_init_device() {
    local uid="$1"
    local target="$2"
    local now
    
    now=$(date +%s)
    now=$(_to_int "$now" 0)
    
    quota_set "$uid" "target" "$target"
    quota_set "$uid" "used_seconds" 0
    quota_set "$uid" "last_check" "$now"
    quota_set "$uid" "online" 0
}

# 确保设备配额记录存在（不重置已有用量）
# 参数: uid target now
# 设备不存在时创建，存在时仅更新 target
quota_ensure_device() {
    local uid="$1"
    local target="$2"
    local now="$3"
    local existing_target
    local existing_used
    
    now=$(_to_int "$now" 0)
    
    # 检查设备是否已存在
    existing_used=$(quota_get "$uid" "used_seconds")
    
    if [ -z "$existing_used" ]; then
        # 设备不存在，初始化
        quota_set "$uid" "target" "$target"
        quota_set "$uid" "used_seconds" 0
        quota_set "$uid" "last_check" "$now"
        quota_set "$uid" "online" 0
    else
        # 设备存在，仅更新 target（MAC 可能变化）
        existing_target=$(quota_get "$uid" "target")
        if [ "$existing_target" != "$target" ]; then
            quota_set "$uid" "target" "$target"
        fi
    fi
}

# 获取设备剩余秒数
quota_get_remaining() {
    local uid="$1"
    local quota_minutes="$2"
    local used_seconds
    local quota_seconds
    local remaining
    
    quota_minutes=$(_to_int "$quota_minutes" 0)
    used_seconds=$(_to_int "$(quota_get "$uid" "used_seconds")" 0)
    quota_seconds=$((quota_minutes * 60))
    remaining=$((quota_seconds - used_seconds))
    
    echo "$remaining"
}

# 格式化秒数为易读字符串
quota_format_time() {
    local seconds="$1"
    local hours
    local mins
    local secs
    
    seconds=$(_to_int "$seconds" 0)
    
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
