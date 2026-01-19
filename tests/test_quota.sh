#!/bin/sh
# luci-app-timecontrol 配额功能测试脚本
# 用法: ./test_quota.sh
# 纯 shell 实现，不依赖 jq

SCRIPT_DIR=$(dirname "$0")
PROJECT_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

# 测试计数
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() {
    TESTS_PASSED=$((TESTS_PASSED + 1))
    printf "${GREEN}[PASS]${NC} %s\n" "$1"
}

fail() {
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf "${RED}[FAIL]${NC} %s\n" "$1"
}

run_test() {
    local test_name="$1"
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "Running: $test_name"
    $test_name
}

# ============================================================================
# 简化版 JSON 存储（使用 key=value 格式的临时文件）
# 模拟 jshn.sh 接口
# ============================================================================

_JSHN_DATA_FILE=""
_JSHN_CURRENT_SECTION=""

json_init() {
    echo "version=1" > "$_JSHN_DATA_FILE"
    echo "next_reset_epoch=0" >> "$_JSHN_DATA_FILE"
    _JSHN_CURRENT_SECTION=""
}

json_load() {
    # 简化：从 JSON 字符串解析（仅处理测试需要的结构）
    local content="$1"
    echo "version=1" > "$_JSHN_DATA_FILE"
    echo "next_reset_epoch=0" >> "$_JSHN_DATA_FILE"
    _JSHN_CURRENT_SECTION=""
}

json_dump() {
    # 输出简化的 JSON（足够测试用）
    local result='{"version":1,"next_reset_epoch":0,"devices":{'
    local first=1
    local line
    
    while IFS='=' read -r key val; do
        case "$key" in
            devices.*.*)
                local uid=$(echo "$key" | cut -d. -f2)
                local field=$(echo "$key" | cut -d. -f3)
                # 简化输出
                ;;
        esac
    done < "$_JSHN_DATA_FILE"
    
    result="$result}}"
    cat "$_JSHN_DATA_FILE"
}

json_select() {
    local key="$1"
    if [ "$key" = ".." ]; then
        case "$_JSHN_CURRENT_SECTION" in
            *.*)
                # 去掉最后一段
                _JSHN_CURRENT_SECTION="${_JSHN_CURRENT_SECTION%.*}"
                ;;
            *)
                _JSHN_CURRENT_SECTION=""
                ;;
        esac
        return 0
    fi
    
    # 构建新路径
    local new_section
    if [ -z "$_JSHN_CURRENT_SECTION" ]; then
        new_section="$key"
    else
        new_section="${_JSHN_CURRENT_SECTION}.$key"
    fi
    
    # 检查是否存在此路径的任何键
    if grep -q "^${new_section}" "$_JSHN_DATA_FILE" 2>/dev/null; then
        _JSHN_CURRENT_SECTION="$new_section"
        return 0
    fi
    
    # 特殊处理：devices 总是存在
    if [ "$new_section" = "devices" ]; then
        _JSHN_CURRENT_SECTION="$new_section"
        return 0
    fi
    
    # 不存在则返回失败，但不改变当前 section
    return 1
}

json_get_var() {
    local __var="$1"
    local key="$2"
    local full_key
    local val
    
    if [ -z "$_JSHN_CURRENT_SECTION" ]; then
        full_key="$key"
    else
        full_key="${_JSHN_CURRENT_SECTION}.$key"
    fi
    
    val=$(grep "^${full_key}=" "$_JSHN_DATA_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
    eval "$__var=\"\$val\""
}

json_get_keys() {
    local __var="$1"
    local keys=""
    local prefix="${_JSHN_CURRENT_SECTION}."
    
    # 获取当前 section 下的所有直接子键
    keys=$(grep "^${prefix}" "$_JSHN_DATA_FILE" 2>/dev/null | \
           sed "s|^${prefix}||" | \
           cut -d. -f1 | \
           sort -u | \
           tr '\n' ' ')
    
    eval "$__var=\"\$keys\""
}

json_add_int() {
    local key="$1"
    local val="$2"
    local full_key
    
    if [ -z "$_JSHN_CURRENT_SECTION" ]; then
        full_key="$key"
    else
        full_key="${_JSHN_CURRENT_SECTION}.$key"
    fi
    
    # 删除旧值
    grep -v "^${full_key}=" "$_JSHN_DATA_FILE" > "$_JSHN_DATA_FILE.tmp" 2>/dev/null
    mv "$_JSHN_DATA_FILE.tmp" "$_JSHN_DATA_FILE"
    
    # 添加新值
    echo "${full_key}=$val" >> "$_JSHN_DATA_FILE"
}

json_add_string() {
    json_add_int "$1" "$2"
}

json_add_object() {
    local key="$1"
    local full_key
    
    if [ -z "$_JSHN_CURRENT_SECTION" ]; then
        full_key="$key"
    else
        full_key="${_JSHN_CURRENT_SECTION}.$key"
    fi
    
    # 添加一个占位符，表示这个对象存在
    echo "${full_key}.__exists=1" >> "$_JSHN_DATA_FILE"
}

json_close_object() {
    :
}

# ============================================================================
# 测试环境设置
# ============================================================================

setup() {
    _JSHN_DATA_FILE="/tmp/test_quota_data_$$.txt"
    export QUOTA_TMP_FILE="/tmp/test_quota_tmp_$$.json"
    export QUOTA_PERSIST_FILE="/tmp/test_quota_persist_$$.json"
    export QUOTA_LOCK_FILE="/tmp/test_quota_$$.lock"
    
    # 清理旧文件
    rm -f "$_JSHN_DATA_FILE" "$QUOTA_TMP_FILE" "$QUOTA_PERSIST_FILE" "$QUOTA_LOCK_FILE"
    
    # 初始化数据文件
    touch "$_JSHN_DATA_FILE"
}

teardown() {
    rm -f "$_JSHN_DATA_FILE" "${_JSHN_DATA_FILE}.tmp"
    rm -f "$QUOTA_TMP_FILE" "$QUOTA_PERSIST_FILE" "$QUOTA_LOCK_FILE"
}

# 加载 quota.sh（跳过 jshn.sh 引入）
load_quota_lib() {
    eval "$(sed '/\. \/usr\/share\/libubox\/jshn.sh/d' "$PROJECT_ROOT/luci-app-timecontrol/root/usr/share/timecontrol/quota.sh")"
}

# ============================================================================
# 测试用例
# ============================================================================

test_dirty_flag() {
    QUOTA_DIRTY_TMP=0
    QUOTA_DIRTY_PERSIST=0
    
    quota_should_write_tmp && { fail "Should be clean initially"; return; }
    
    quota_mark_dirty
    quota_should_write_tmp || { fail "Should be dirty after mark (tmp)"; return; }
    quota_should_write_persist || { fail "Should be dirty after mark (persist)"; return; }
    
    pass "Dirty flag works"
}

test_json_rw() {
    quota_load
    quota_set "test_dev" "used_seconds" 120
    quota_set "test_dev" "online" 1
    
    local val=$(quota_get "test_dev" "used_seconds")
    [ "$val" = "120" ] || { fail "Expected 120, got '$val'"; return; }
    
    pass "JSON read/write works"
}

test_quota_exhausted() {
    quota_load
    
    quota_set "dev1" "used_seconds" 60
    quota_is_exhausted "dev1" 1 || { fail "60s used / 1min quota should be exhausted"; return; }
    
    quota_set "dev2" "used_seconds" 59
    quota_is_exhausted "dev2" 1 && { fail "59s < 60s should not be exhausted"; return; }
    
    pass "Quota exhausted check works"
}

test_usage_update() {
    quota_load
    local now=$(date +%s)
    
    quota_set "dev_test" "used_seconds" 0
    quota_set "dev_test" "last_check" $((now - 60))
    quota_set "dev_test" "online" 1
    
    quota_update_usage "dev_test" "$now"
    
    local used=$(quota_get "dev_test" "used_seconds")
    [ "$used" = "60" ] || { fail "Expected 60s, got '$used'"; return; }
    
    # Delta clamp 测试
    quota_set "dev_test2" "used_seconds" 0
    quota_set "dev_test2" "last_check" $((now - 300))
    quota_set "dev_test2" "online" 1
    
    quota_update_usage "dev_test2" "$now"
    used=$(quota_get "dev_test2" "used_seconds")
    [ "$used" = "120" ] || { fail "Delta clamp failed: expected 120, got '$used'"; return; }
    
    pass "Usage update with delta clamp works"
}

test_offline_online() {
    quota_load
    local now=$(date +%s)
    
    quota_set "dev_oo" "used_seconds" 100
    quota_set "dev_oo" "last_check" $((now - 3600))
    quota_set "dev_oo" "online" 0
    
    quota_update_usage "dev_oo" "$now"
    local used=$(quota_get "dev_oo" "used_seconds")
    [ "$used" = "100" ] || { fail "First online should not add time, got '$used'"; return; }
    
    local online=$(quota_get "dev_oo" "online")
    [ "$online" = "1" ] || { fail "Should be online now"; return; }
    
    pass "Offline to online transition works"
}

test_reset_all() {
    quota_load
    
    quota_set "dev_a" "used_seconds" 1000
    quota_set "dev_b" "used_seconds" 2000
    
    quota_reset_all
    
    local a=$(quota_get "dev_a" "used_seconds")
    local b=$(quota_get "dev_b" "used_seconds")
    
    [ "$a" = "0" ] || { fail "dev_a should be reset, got '$a'"; return; }
    [ "$b" = "0" ] || { fail "dev_b should be reset, got '$b'"; return; }
    
    pass "Reset all quotas works"
}

test_single_target() {
    quota_is_single_target "192.168.1.100" || { fail "Single IP should be supported"; return; }
    quota_is_single_target "00:11:22:33:44:55" || { fail "Single MAC should be supported"; return; }
    quota_is_single_target "192.168.1.0/24" && { fail "CIDR should not be supported"; return; }
    quota_is_single_target "192.168.1.1-192.168.1.100" && { fail "Range should not be supported"; return; }
    quota_is_single_target "192.168.1.1,192.168.1.2" && { fail "Multi-value should not be supported"; return; }
    
    pass "Single target validation works"
}

test_gc() {
    quota_load
    
    quota_set "dev_keep1" "used_seconds" 100
    quota_set "dev_keep2" "used_seconds" 200
    quota_set "dev_orphan" "used_seconds" 300
    
    # GC 需要 jsonfilter，跳过完整测试
    # 仅验证设备数据正确写入
    local k1=$(quota_get "dev_keep1" "used_seconds")
    local k2=$(quota_get "dev_keep2" "used_seconds")
    [ "$k1" = "100" ] || { fail "dev_keep1 should exist, got '$k1'"; return; }
    [ "$k2" = "200" ] || { fail "dev_keep2 should exist, got '$k2'"; return; }
    
    pass "GC test (partial - jsonfilter not available)"
}

test_next_reset() {
    local now=$(date +%s)
    
    local next=$(quota_calculate_next_reset 0)
    [ "$next" -gt "$now" ] || { fail "Next reset should be in the future"; return; }
    
    local diff=$((next - now))
    [ "$diff" -le 86400 ] || { fail "Next reset should be within 24h"; return; }
    
    pass "Next reset calculation works"
}

test_truth_table() {
    local should_block=0
    local should_count=0
    local quota_enabled=0
    local is_online=1
    
    if [ "$quota_enabled" = "1" ] && [ "$should_block" = "0" ] && [ "$is_online" = "1" ]; then
        should_count=1
    fi
    [ "$should_count" = "0" ] || { fail "Case 1: quota_enabled=0 should not count"; return; }
    
    should_block=0
    quota_enabled=1
    is_online=1
    should_count=0
    if [ "$quota_enabled" = "1" ] && [ "$should_block" = "0" ] && [ "$is_online" = "1" ]; then
        should_count=1
    fi
    [ "$should_count" = "1" ] || { fail "Case 2: should count when enabled and online"; return; }
    
    local block_period=1
    local blocked_by_quota=0
    should_block=$((block_period || blocked_by_quota))
    should_count=0
    if [ "$quota_enabled" = "1" ] && [ "$should_block" = "0" ] && [ "$is_online" = "1" ]; then
        should_count=1
    fi
    [ "$should_block" = "1" ] || { fail "Case 3: block_period=1 should block"; return; }
    [ "$should_count" = "0" ] || { fail "Case 3: should not count when blocked"; return; }
    
    pass "Truth table verification works"
}

# ============================================================================
# 主函数
# ============================================================================

main() {
    echo "========================================"
    echo "  luci-app-timecontrol Quota Tests"
    echo "========================================"
    echo ""
    
    setup
    load_quota_lib
    
    run_test test_dirty_flag
    run_test test_json_rw
    run_test test_quota_exhausted
    run_test test_usage_update
    run_test test_offline_online
    run_test test_reset_all
    run_test test_single_target
    run_test test_gc
    run_test test_next_reset
    run_test test_truth_table
    
    teardown
    
    echo ""
    echo "========================================"
    echo "  Results: $TESTS_PASSED/$TESTS_RUN passed"
    if [ $TESTS_FAILED -gt 0 ]; then
        printf "  ${RED}%d tests failed${NC}\n" "$TESTS_FAILED"
        exit 1
    else
        printf "  ${GREEN}All tests passed!${NC}\n"
        exit 0
    fi
}

main
