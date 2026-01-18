#!/bin/sh
# 运行所有测试
# 用法: ./tests/run_all.sh

SCRIPT_DIR=$(dirname "$0")
cd "$SCRIPT_DIR" || exit 1

echo "=============================================="
echo "  luci-app-timecontrol 配额功能测试套件"
echo "=============================================="
echo ""

TOTAL_SUITES=0
PASSED_SUITES=0
FAILED_SUITES=0

run_suite() {
    local script="$1"
    local name="$2"
    
    TOTAL_SUITES=$((TOTAL_SUITES + 1))
    echo ">>> Running: $name"
    echo ""
    
    if ./"$script"; then
        PASSED_SUITES=$((PASSED_SUITES + 1))
    else
        FAILED_SUITES=$((FAILED_SUITES + 1))
    fi
    echo ""
}

# 运行测试套件
run_suite "test_quota.sh" "核心函数库测试"
run_suite "test_cli.sh" "CLI 工具测试"

# 总结
echo "=============================================="
echo "  测试套件总结"
echo "=============================================="
echo "  通过: $PASSED_SUITES / $TOTAL_SUITES"

if [ $FAILED_SUITES -gt 0 ]; then
    echo "  失败: $FAILED_SUITES"
    exit 1
else
    echo "  所有测试套件通过!"
    exit 0
fi
