#!/bin/sh
# timecontrol-quota CLI 集成测试
# 用法: ./test_cli.sh
# 测试 CLI 命令行接口功能

SCRIPT_DIR=$(dirname "$0")
PROJECT_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
CLI_SCRIPT="$PROJECT_ROOT/luci-app-timecontrol/root/usr/bin/timecontrol-quota"

# 测试计数
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
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
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "Running: $1"
    $1
}

# ============================================================================
# Mock 环境设置
# ============================================================================

# 测试用临时目录
TEST_TMP_DIR="/tmp/test_cli_$$"
MOCK_BIN_DIR="$TEST_TMP_DIR/bin"
MOCK_SHARE_DIR="$TEST_TMP_DIR/share"
MOCK_LIBUBOX_DIR="$TEST_TMP_DIR/libubox"

# 设置测试环境变量
export QUOTA_TMP_FILE="$TEST_TMP_DIR/quota_tmp.json"
export QUOTA_PERSIST_FILE="$TEST_TMP_DIR/quota_persist.json"
export QUOTA_LOCK_FILE="$TEST_TMP_DIR/quota.lock"

# ============================================================================
# Mock jshn.sh（简化版 JSON 处理）
# ============================================================================

create_mock_jshn() {
    cat > "$MOCK_LIBUBOX_DIR/jshn.sh" << 'MOCK_JSHN'
#!/bin/sh
# Mock jshn.sh for testing

_JSHN_DATA_FILE="${JSHN_DATA_FILE:-/tmp/jshn_data_$$.txt}"
_JSHN_CURRENT_SECTION=""

json_init() {
    echo "version=1" > "$_JSHN_DATA_FILE"
    echo "next_reset_epoch=0" >> "$_JSHN_DATA_FILE"
    _JSHN_CURRENT_SECTION=""
}

json_load() {
    local content="$1"
    echo "version=1" > "$_JSHN_DATA_FILE"
    echo "next_reset_epoch=0" >> "$_JSHN_DATA_FILE"
    _JSHN_CURRENT_SECTION=""
}

json_dump() {
    local next_reset=$(grep "^next_reset_epoch=" "$_JSHN_DATA_FILE" 2>/dev/null | cut -d= -f2)
    next_reset=${next_reset:-0}
    echo "{\"version\":1,\"next_reset_epoch\":$next_reset,\"devices\":{}}"
}

json_select() {
    local key="$1"
    if [ "$key" = ".." ]; then
        case "$_JSHN_CURRENT_SECTION" in
            *.*)
                _JSHN_CURRENT_SECTION="${_JSHN_CURRENT_SECTION%.*}"
                ;;
            *)
                _JSHN_CURRENT_SECTION=""
                ;;
        esac
        return 0
    fi
    
    if [ -z "$_JSHN_CURRENT_SECTION" ]; then
        _JSHN_CURRENT_SECTION="$key"
    else
        _JSHN_CURRENT_SECTION="${_JSHN_CURRENT_SECTION}.$key"
    fi
    return 0
}

json_get_var() {
    local __var="$1"
    local key="$2"
    local full_key val
    
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
    
    grep -v "^${full_key}=" "$_JSHN_DATA_FILE" > "$_JSHN_DATA_FILE.tmp" 2>/dev/null
    mv "$_JSHN_DATA_FILE.tmp" "$_JSHN_DATA_FILE"
    echo "${full_key}=$val" >> "$_JSHN_DATA_FILE"
}

json_add_string() {
    json_add_int "$1" "$2"
}

json_add_boolean() {
    local key="$1"
    local val="$2"
    [ "$val" = "1" ] || [ "$val" = "true" ] && val=1 || val=0
    json_add_int "$key" "$val"
}

json_add_object() {
    local key="$1"
    local full_key
    
    if [ -z "$_JSHN_CURRENT_SECTION" ]; then
        full_key="$key"
    else
        full_key="${_JSHN_CURRENT_SECTION}.$key"
    fi
    
    echo "${full_key}.__exists=1" >> "$_JSHN_DATA_FILE"
}

json_close_object() {
    :
}
MOCK_JSHN
}

# ============================================================================
# Mock uci（返回空或测试数据）
# ============================================================================

create_mock_uci() {
    cat > "$MOCK_BIN_DIR/uci" << 'MOCK_UCI'
#!/bin/sh
# Mock uci for testing - 返回空结果
exit 1
MOCK_UCI
    chmod +x "$MOCK_BIN_DIR/uci"
}

# ============================================================================
# 创建修改版 CLI 脚本（使用 mock 路径）
# ============================================================================

create_test_cli() {
    # 复制原始脚本并修改路径
    sed -e "s|/usr/share/timecontrol/quota.sh|$MOCK_SHARE_DIR/quota.sh|g" \
        "$CLI_SCRIPT" > "$MOCK_BIN_DIR/timecontrol-quota"
    chmod +x "$MOCK_BIN_DIR/timecontrol-quota"
    
    # 复制 quota.sh 并修改 jshn.sh 路径 + 替换锁函数（高编号 fd 在 dash 中不支持）
    mkdir -p "$MOCK_SHARE_DIR"
    sed -e "s|/usr/share/libubox/jshn.sh|$MOCK_LIBUBOX_DIR/jshn.sh|g" \
        -e 's/exec 200>"$QUOTA_LOCK_FILE"/touch "$QUOTA_LOCK_FILE"/' \
        -e 's/flock -x 200/:/' \
        -e 's/flock -u 200/:/' \
        "$PROJECT_ROOT/luci-app-timecontrol/root/usr/share/timecontrol/quota.sh" \
        > "$MOCK_SHARE_DIR/quota.sh"
}

# ============================================================================
# 环境设置与清理
# ============================================================================

setup() {
    mkdir -p "$TEST_TMP_DIR" "$MOCK_BIN_DIR" "$MOCK_SHARE_DIR" "$MOCK_LIBUBOX_DIR"
    
    # 创建 mock 文件
    create_mock_jshn
    create_mock_uci
    create_test_cli
    
    # 设置 jshn 数据文件
    export JSHN_DATA_FILE="$TEST_TMP_DIR/jshn_data.txt"
    touch "$JSHN_DATA_FILE"
    
    # 设置 PATH，mock 优先
    export PATH="$MOCK_BIN_DIR:$PATH"
    
    # 清理测试文件
    rm -f "$QUOTA_TMP_FILE" "$QUOTA_PERSIST_FILE" "$QUOTA_LOCK_FILE"
}

teardown() {
    rm -rf "$TEST_TMP_DIR"
}

# CLI 执行辅助函数
run_cli() {
    "$MOCK_BIN_DIR/timecontrol-quota" "$@" 2>&1
}

# ============================================================================
# 测试用例
# ============================================================================

test_help() {
    local output=$(run_cli help)
    
    echo "$output" | grep -q "Usage:" || { fail "Help should show Usage"; return; }
    echo "$output" | grep -q "status" || { fail "Help should list status command"; return; }
    echo "$output" | grep -q "reset" || { fail "Help should list reset command"; return; }
    echo "$output" | grep -q "add" || { fail "Help should list add command"; return; }
    echo "$output" | grep -q "info" || { fail "Help should list info command"; return; }
    
    pass "Help command works"
}

test_help_empty() {
    # 无参数时应显示帮助
    local output=$(run_cli)
    
    echo "$output" | grep -q "Usage:" || { fail "No args should show usage"; return; }
    
    pass "Empty command shows help"
}

test_info() {
    local output=$(run_cli info)
    
    # 应该显示 reset 信息
    echo "$output" | grep -qi "reset" || { fail "Info should show reset time"; return; }
    # 应该显示设备统计
    echo "$output" | grep -qi "devices" || { fail "Info should show device count"; return; }
    
    pass "Info command works"
}

test_status_empty() {
    local output=$(run_cli status)
    
    # 应该显示表头
    echo "$output" | grep -q "UID" || { fail "Status should show UID header"; return; }
    echo "$output" | grep -q "Target" || { fail "Status should show Target header"; return; }
    echo "$output" | grep -q "Used" || { fail "Status should show Used header"; return; }
    echo "$output" | grep -q "Quota" || { fail "Status should show Quota header"; return; }
    echo "$output" | grep -q "Status" || { fail "Status should show Status header"; return; }
    
    pass "Status command (empty) works"
}

test_status_json() {
    local output=$(run_cli status-json)
    
    # 应该是有效 JSON 格式
    echo "$output" | grep -q "{" || { fail "Should output JSON object"; return; }
    echo "$output" | grep -q "next_reset" || { fail "Should have next_reset field"; return; }
    echo "$output" | grep -q "devices" || { fail "Should have devices field"; return; }
    
    pass "Status-json command works"
}

test_unknown_command() {
    local output=$(run_cli unknown_cmd)
    
    # 应该报告未知命令
    echo "$output" | grep -qi "unknown" || { fail "Should report unknown command"; return; }
    # 并显示帮助
    echo "$output" | grep -q "Usage:" || { fail "Should show usage after unknown command"; return; }
    
    pass "Unknown command handling works"
}

test_reset_no_args() {
    local output=$(run_cli reset)
    
    # 无参数时应显示用法
    echo "$output" | grep -q "Usage:" || { fail "Reset without args should show usage"; return; }
    echo "$output" | grep -q "reset" || { fail "Should show reset usage"; return; }
    
    pass "Reset without args shows usage"
}

test_reset_invalid_uid() {
    local output=$(run_cli reset nonexistent_device)
    
    # 应该报告设备不存在
    echo "$output" | grep -qi "not found" || { fail "Should report device not found"; return; }
    
    pass "Reset invalid uid reports error"
}

test_add_no_args() {
    local output=$(run_cli add)
    
    # 无参数时应显示用法
    echo "$output" | grep -q "Usage:" || { fail "Add without args should show usage"; return; }
    
    pass "Add without args shows usage"
}

test_add_missing_minutes() {
    local output=$(run_cli add some_uid)
    
    # 缺少 minutes 参数
    echo "$output" | grep -q "Usage:" || { fail "Add without minutes should show usage"; return; }
    
    pass "Add without minutes shows usage"
}

test_add_invalid_minutes() {
    local output=$(run_cli add some_uid abc)
    
    # 非数字应该报错
    echo "$output" | grep -qi "must be.*integer\|must be.*number\|invalid" || { 
        fail "Add with invalid minutes should report error"; return
    }
    
    pass "Add with invalid minutes reports error"
}

test_add_invalid_uid() {
    local output=$(run_cli add nonexistent_device 30)
    
    # 应该报告设备不存在
    echo "$output" | grep -qi "not found" || { fail "Should report device not found"; return; }
    
    pass "Add invalid uid reports error"
}

test_status_invalid_uid() {
    local output=$(run_cli status nonexistent_device)
    
    # 应该报告设备不存在
    echo "$output" | grep -qi "not found" || { fail "Should report device not found"; return; }
    
    pass "Status invalid uid reports error"
}

# ============================================================================
# 主函数
# ============================================================================

main() {
    echo "========================================"
    echo "  timecontrol-quota CLI Tests"
    echo "========================================"
    echo ""
    
    setup
    
    run_test test_help
    run_test test_help_empty
    run_test test_info
    run_test test_status_empty
    run_test test_status_json
    run_test test_unknown_command
    run_test test_reset_no_args
    run_test test_reset_invalid_uid
    run_test test_add_no_args
    run_test test_add_missing_minutes
    run_test test_add_invalid_minutes
    run_test test_add_invalid_uid
    run_test test_status_invalid_uid
    
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
