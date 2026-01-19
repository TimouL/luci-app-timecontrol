# AGENTS.md - AI Agent Guidelines for luci-app-timecontrol

This document provides essential context for AI coding agents working on this OpenWrt LuCI application.

## Project Overview

**luci-app-timecontrol** is an OpenWrt LuCI application for internet time control using nftables.
It allows administrators to limit device internet access by time periods and daily quotas.

### Tech Stack
- **Backend**: POSIX shell scripts (sh/ash compatible, NOT bash-specific)
- **Frontend**: LuCI JS framework (ES5-compatible JavaScript)
- **Config**: UCI (Unified Configuration Interface)
- **Firewall**: nftables
- **Build**: OpenWrt SDK / LuCI build system

### Directory Structure
```
luci-app-timecontrol/
├── htdocs/luci-static/resources/view/timecontrol/  # LuCI JS views
├── root/
│   ├── etc/config/timecontrol         # UCI config template
│   ├── etc/init.d/timecontrol         # procd init script
│   ├── usr/bin/                       # CLI tools
│   ├── usr/libexec/                   # Helper scripts
│   └── usr/share/
│       ├── luci/menu.d/               # LuCI menu registration
│       ├── rpcd/acl.d/                # RPC ACL permissions
│       └── timecontrol/quota.sh       # Core quota library
tests/                                  # Shell-based test suites
```

---

## Build / Test / Lint Commands

### Running Tests

```bash
# Run all test suites
./tests/run_all.sh

# Run a single test file
./tests/test_quota.sh    # Core quota function tests
./tests/test_cli.sh      # CLI interface tests
```

### Building for OpenWrt

```bash
make package/luci-app-timecontrol/compile V=s
# Dependencies: +bc +nftables +bash +conntrack +flock
```

### CI Pipeline

GitHub Actions runs on push/PR:
1. **Test stage**: `./tests/run_all.sh`
2. **Build stage**: Only on version tags (v*)

---

## Code Style Guidelines

### Shell Scripts (POSIX sh)

**Target Shell**: BusyBox ash / dash (NOT bash)

```bash
# CORRECT - POSIX compatible
local var="value"
[ "$var" = "value" ] && echo "match"
command -v tool >/dev/null 2>&1 || return 1

# INCORRECT - Bash-specific (DO NOT USE)
[[ $var == "value" ]]   # Use [ ] not [[ ]]
${var,,}                # No lowercase expansion
declare -A              # No associative arrays
```

**Naming Conventions**:
- Functions: `snake_case` with module prefix (e.g., `quota_load`, `quota_set`)
- Local variables: `snake_case`, always declare with `local`
- Constants: `UPPER_SNAKE_CASE` (e.g., `QUOTA_TMP_FILE`)
- Private functions: Prefix with `_` (e.g., `_to_int`, `_quota_init_empty`)

**Error Handling**:
- Always quote variables: `echo "$variable"`
- Check command existence: `command -v tool >/dev/null 2>&1 || return 1`
- Sanitize numeric inputs: `val=$(_to_int "$input" 0)`

**Integer Safety**: Always use `_to_int()` for arithmetic to avoid octal issues, empty values, non-numeric input.

### JavaScript (LuCI Frontend)

**Target**: ES5 compatible (no arrow functions, no const/let in some contexts)

**Imports**:
```javascript
'use strict';
'require view';
'require fs';
'require ui';
'require uci';
'require form';
```

**Naming**: `camelCase` for functions/variables, `PascalCase` for classes

**Patterns**:
```javascript
// Promise-based async
fs.exec('/path/cmd', ['args']).then(function(res) { ... });

// Safe defaults
L.resolveDefault(network.getHostHints(), [])

// DOM creation
E('div', { 'class': 'cbi-section' }, [E('span', {}, 'text')])
```

---

## Testing Guidelines

### Test Structure
```bash
setup() { ... }
teardown() { ... }

test_feature_name() {
    [ "$result" = "expected" ] || { fail "message"; return; }
    pass "Test description"
}

run_test test_feature_name
```

### Adding New Tests
1. Add test function following `test_*` naming
2. Register in `main()` with `run_test test_function_name`
3. Use `pass "description"` / `fail "description"` for results

---

## Key Components

### quota.sh - Core Quota Library
- `quota_load()` / `quota_flush()` / `quota_persist()` - State I/O
- `quota_get(uid, field)` / `quota_set(uid, field, value)` - Device data
- `quota_is_exhausted(uid, quota_minutes)` - Check quota status
- `quota_lock()` / `quota_unlock()` - File locking with flock

### timecontrol-quota CLI
- `status [uid|all]` - Display quota status
- `status-json [uid]` - JSON output for LuCI RPC
- `reset [uid|all]` - Reset quotas
- `add <uid> <minutes>` - Add bonus time
- `info` - Global status info

---

## Common Pitfalls

1. **Shell compatibility**: Test with `dash` or BusyBox `ash`, not `bash`
2. **Integer parsing**: Always use `_to_int()` - never raw arithmetic on user input
3. **JSON context**: `jshn.sh` is single-context; save data before reinitializing
4. **File locking**: Always pair `quota_lock()` with `quota_unlock()`
5. **UCI arrays**: Use index-based access `@device[0]`, not named sections
6. **LuCI ES5**: Avoid ES6+ syntax (arrow functions, template literals, const/let)

---

## Quick Reference

| Task | Command |
|------|---------|
| Run all tests | `./tests/run_all.sh` |
| Run quota tests | `./tests/test_quota.sh` |
| Run CLI tests | `./tests/test_cli.sh` |
| Check quota status | `timecontrol-quota status` |
| View logs | `cat /var/log/timecontrol.log` |
