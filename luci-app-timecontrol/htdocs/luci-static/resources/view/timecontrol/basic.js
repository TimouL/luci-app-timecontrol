'use strict';
'require view';
'require fs';
'require ui';
'require uci';
'require form';
'require poll';
'require rpc';
'require network';

// Module-level variable to store current blocked rule indices
var currentBlockedRules = [];

function checkTimeControlProcess() {
    return fs.exec('/bin/ps', ['w']).then(function(res) {
        if (res.code !== 0) {
            return { running: false, pid: null };
        }

        var lines = res.stdout.split('\n');
        var running = false;
        var pid = null;

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.indexOf('timecontrolctrl') >= 0) {
                running = true;
                // Extract PID
                var match = line.match(/^\s*(\d+)/);
                if (match) {
                    pid = match[1];
                }
                break;
            }
        }

        return { running: running, pid: pid };
    }).catch(function() {
        return { running: false, pid: null };
    });
}

// Fetch backend blocking status from /var/timecontrol.idlist
// Returns Promise resolving to array of blocked rule indices (e.g., [0, 2])
function fetchBlockedRules() {
    return fs.exec('/bin/cat', ['/var/timecontrol.idlist']).then(function(res) {
        if (res.code !== 0 || !res.stdout) return [];
        // Parse format: "!0!\n!2!\n" -> [0, 2]
        var indices = [];
        var matches = res.stdout.match(/!(\d+)!/g);
        if (matches) {
            for (var i = 0; i < matches.length; i++) {
                var num = parseInt(matches[i].replace(/!/g, ''), 10);
                if (!isNaN(num)) {
                    indices.push(num);
                }
            }
        }
        return indices;
    }).catch(function() {
        return [];
    });
}

// Get blocked device statistics from backend state
// Returns { blocked: currently blocked count, total: unique enabled device count }
// Reads actual blocking state from /var/timecontrol.idlist instead of time calculation
function getBlockedDeviceStats(blockedRules) {
    var sections = uci.sections('timecontrol', 'device');
    var enabledMacs = {};   // All enabled device MACs
    var blockedMacs = {};   // Actually blocked device MACs

    for (var i = 0; i < sections.length; i++) {
        var dev = sections[i];
        if (dev.enable !== '1') continue;

        var mac = (dev.mac || '').toUpperCase();
        if (!mac) continue;

        // Track all enabled devices
        enabledMacs[mac] = true;

        // Check if this rule index is in blocked list
        if (blockedRules && blockedRules.indexOf(i) >= 0) {
            blockedMacs[mac] = true;
        }
    }

    // Count unique devices
    var total = 0;
    var blocked = 0;
    for (var mac in enabledMacs) {
        if (enabledMacs.hasOwnProperty(mac)) {
            total++;
            if (blockedMacs[mac]) {
                blocked++;
            }
        }
    }

    return { blocked: blocked, total: total };
}

// Render service status display
// stats: { blocked: currently blocked count, total: unique device count }
function renderServiceStatus(isRunning, pid, stats) {
    var statusText = isRunning ? _('RUNNING') : _('NOT RUNNING');
    var color = isRunning ? 'green' : 'red';
    var icon = isRunning ? '✓' : '✗';

    var statusHtml = String.format(
        '<em><span style="color:%s">%s <strong>%s %s</strong></span></em>',
        color, icon, _('TimeControl Service'), statusText
    );

    if (isRunning && pid) {
        statusHtml += ' <small>(PID: ' + pid + ')</small>';
    }

    // Display blocking statistics: Blocking: X/Y
    if (stats && typeof stats.blocked === 'number' && typeof stats.total === 'number') {
        var blockColor = stats.blocked > 0 ? '#c00' : '#666';
        statusHtml += ' <small style="margin-left: 1em;">| ' +
            _('Blocking') + ': <strong style="color:' + blockColor + '">' +
            stats.blocked + '/' + stats.total + '</strong></small>';
    }

    return statusHtml;
}

// Build section_id to index map for status indicator lookup
function buildSectionIndexMap() {
    var sections = uci.sections('timecontrol', 'device');
    var map = {};
    for (var i = 0; i < sections.length; i++) {
        map[sections[i]['.name']] = i;
    }
    return map;
}

// Update all status indicators based on blocked rules
function updateStatusIndicators(blockedRules) {
    var sectionMap = buildSectionIndexMap();
    var sections = uci.sections('timecontrol', 'device');
    document.querySelectorAll('.rule-status-indicator').forEach(function(el) {
        var sectionId = el.dataset.sectionId;
        if (!sectionId || !(sectionId in sectionMap)) return;
        var idx = sectionMap[sectionId];
        var dev = sections[idx];
        if (!dev) return;
        var enabled = dev.enable === '1';
        var blocked = blockedRules.indexOf(idx) >= 0;
        el.classList.remove('disabled', 'blocked', 'active');
        if (!enabled) {
            el.classList.add('disabled');
            el.title = _('Disabled');
            el.setAttribute('aria-label', _('Rule disabled'));
        } else if (blocked) {
            el.classList.add('blocked');
            el.title = _('Blocking');
            el.setAttribute('aria-label', _('Device is being blocked'));
        } else {
            el.classList.add('active');
            el.title = _('Active');
            el.setAttribute('aria-label', _('Rule active, device not blocked'));
        }
    });
}

// Week summary helper function (duplicated for card view, original in TableSection)
function getWeekSummaryForCard(value) {
    if (value == null || typeof value !== 'string') {
        value = '';
    }

    var arr = value.split(',').filter(Boolean).map(function(x) {
        var num = parseInt(x, 10);
        return isNaN(num) ? 0 : num;
    }).filter(function(n) {
        return n >= 1 && n <= 7;
    }).sort(function(a, b) { return a - b; });

    var seen = {};
    arr = arr.filter(function(n) {
        if (seen[n]) return false;
        seen[n] = true;
        return true;
    });

    var str = arr.join(',');
    if (str === '1,2,3,4,5,6,7' || str === '') return _('Everyday');
    if (str === '1,2,3,4,5') return _('Workday');
    if (str === '6,7') return _('Weekend');
    return arr.join('/');
}

// Store current edit modal state
var currentEditModal = null;
var currentEditTriggerBtn = null;

// Close edit modal
function closeEditModal() {
    if (!currentEditModal) return;

    var modal = currentEditModal.querySelector('.tc-edit-modal');
    if (modal) {
        modal.classList.remove('tc-modal-open');
    }

    // Unlock body scroll
    document.body.classList.remove('tc-modal-open');

    // Remove after animation
    setTimeout(function() {
        if (currentEditModal && currentEditModal.parentNode) {
            currentEditModal.parentNode.removeChild(currentEditModal);
        }
        currentEditModal = null;

        // Return focus to trigger button
        if (currentEditTriggerBtn) {
            currentEditTriggerBtn.focus();
            currentEditTriggerBtn = null;
        }
    }, 300);
}

// Delete rule with confirmation
function deleteRule(sectionId) {
    if (!confirm(_('Are you sure you want to delete this rule?'))) {
        return;
    }

    uci.remove('timecontrol', sectionId);
    closeEditModal();
    refreshCardView();

    // Trigger dirty state
    var evt = new Event('widget-change', { bubbles: true });
    document.dispatchEvent(evt);
}

// Save edit modal data
function saveEditModal(sectionId, isNew) {
    var modal = currentEditModal;
    if (!modal) return false;

    // Clear previous errors
    var errorFields = modal.querySelectorAll('.tc-edit-field.tc-field-error');
    for (var i = 0; i < errorFields.length; i++) {
        errorFields[i].classList.remove('tc-field-error');
        var errMsg = errorFields[i].querySelector('.tc-field-error-msg');
        if (errMsg) errMsg.remove();
    }

    // Get form values
    var commentInput = modal.querySelector('input[name="tc-edit-comment"]');
    var macInput = modal.querySelector('input[name="tc-edit-mac"]');
    var timestartInput = modal.querySelector('input[name="tc-edit-timestart"]');
    var timeendInput = modal.querySelector('input[name="tc-edit-timeend"]');
    var enableInput = modal.querySelector('input[name="tc-edit-enable"]');
    var quotaEnabledInput = modal.querySelector('input[name="tc-edit-quota-enabled"]');
    var quotaMinutesInput = modal.querySelector('input[name="tc-edit-quota-minutes"]');

    var comment = commentInput ? commentInput.value.trim() : '';
    var mac = macInput ? macInput.value.trim() : '';
    var timestart = timestartInput ? timestartInput.value : '00:00';
    var timeend = timeendInput ? timeendInput.value : '23:59';
    var enable = enableInput ? (enableInput.checked ? '1' : '0') : '1';
    var quotaEnabled = quotaEnabledInput ? (quotaEnabledInput.checked ? '1' : '0') : '0';
    var quotaMinutes = quotaMinutesInput ? quotaMinutesInput.value : '120';

    // Get week values
    var weekCheckboxes = modal.querySelectorAll('.tc-edit-week-group input[type="checkbox"]:checked');
    var weekDays = [];
    for (var j = 0; j < weekCheckboxes.length; j++) {
        weekDays.push(parseInt(weekCheckboxes[j].value, 10));
    }
    weekDays.sort(function(a, b) { return a - b; });

    // Validation
    var hasError = false;

    function showError(input, msg) {
        var field = input.closest('.tc-edit-field');
        if (field) {
            field.classList.add('tc-field-error');
            var errEl = E('div', { 'class': 'tc-field-error-msg' }, msg);
            field.appendChild(errEl);
        }
        hasError = true;
    }

    // MAC/IP validation patterns
    var macPattern = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/;
    var ipPattern = /^(\d{1,3}\.){3}\d{1,3}$/;
    var ipRangePattern = /^(\d{1,3}\.){3}\d{1,3}\s*-\s*(\d{1,3}\.){3}\d{1,3}$/;

    // MAC/IP required and format validation
    if (!mac) {
        showError(macInput, _('IP/MAC Address is required'));
    } else if (!macPattern.test(mac) && !ipPattern.test(mac) && !ipRangePattern.test(mac)) {
        showError(macInput, _('Invalid format. Use MAC (00:11:22:33:44:55) or IP (192.168.1.100)'));
    }

    // Week at least one day
    if (weekDays.length === 0) {
        var weekGroup = modal.querySelector('.tc-edit-week-group');
        if (weekGroup) {
            var weekField = weekGroup.closest('.tc-edit-field');
            if (weekField) {
                weekField.classList.add('tc-field-error');
                var errEl = E('div', { 'class': 'tc-field-error-msg' }, _('Please select at least one day'));
                weekField.appendChild(errEl);
            }
        }
        hasError = true;
    }

    // Quota validation
    if (quotaEnabled === '1') {
        var mins = parseInt(quotaMinutes, 10);
        if (isNaN(mins) || mins < 1 || mins > 1440) {
            showError(quotaMinutesInput, _('Quota must be between 1-1440 minutes'));
        }
    }

    if (hasError) {
        return false;
    }

    // Write to UCI
    var weekValue = weekDays.join(',');
    if (weekValue === '1,2,3,4,5,6,7') {
        weekValue = '0';
    }

    // For new rules, create UCI section now
    if (isNew) {
        sectionId = uci.add('timecontrol', 'device');
    }

    // Try to sync to table inputs first, fallback to uci.set
    function syncField(fieldName, value) {
        var tableInput = document.querySelector('input[id^="cbid.timecontrol.' + sectionId + '.' + fieldName + '"]');
        if (tableInput) {
            if (tableInput.type === 'checkbox') {
                tableInput.checked = (value === '1');
            } else {
                tableInput.value = value;
            }
            tableInput.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
            uci.set('timecontrol', sectionId, fieldName, value);
        }
    }

    syncField('comment', comment);
    syncField('mac', mac);
    syncField('timestart', timestart);
    syncField('timeend', timeend);
    syncField('enable', enable);
    syncField('week', weekValue);
    syncField('quota_enabled', quotaEnabled);
    syncField('quota_minutes', quotaMinutes);

    // Ensure uid exists for quota
    var existingUid = uci.get('timecontrol', sectionId, 'uid');
    if (!existingUid) {
        var uid = 'dev_' + Math.random().toString(36).substring(2, 10);
        uci.set('timecontrol', sectionId, 'uid', uid);
    }

    // Trigger dirty state
    var evt = new Event('widget-change', { bubbles: true });
    document.dispatchEvent(evt);

    closeEditModal();
    refreshCardView();

    return true;
}

// Open edit modal
// sectionId: null for new, string for edit
function openEditModal(sectionId) {
    // Prevent multiple modals from opening
    if (currentEditModal) {
        return;
    }

    var isNew = !sectionId;
    var triggerBtn = document.activeElement;

    // For new rules, use default values (don't create UCI section yet)
    var comment = '';
    var mac = '';
    var timestart = '00:00';
    var timeend = '23:59';
    var enable = '1';
    var weekValue = '1,2,3,4,5,6,7';
    var quotaEnabled = '0';
    var quotaMinutes = '120';

    // For existing rules, get current values
    if (!isNew) {
        comment = uci.get('timecontrol', sectionId, 'comment') || '';
        mac = uci.get('timecontrol', sectionId, 'mac') || '';
        timestart = uci.get('timecontrol', sectionId, 'timestart') || '00:00';
        timeend = uci.get('timecontrol', sectionId, 'timeend') || '23:59';
        enable = uci.get('timecontrol', sectionId, 'enable') || '1';
        weekValue = uci.get('timecontrol', sectionId, 'week') || '0';
        quotaEnabled = uci.get('timecontrol', sectionId, 'quota_enabled') || '0';
        quotaMinutes = uci.get('timecontrol', sectionId, 'quota_minutes') || '120';
        // Expand week value
        if (weekValue === '0') weekValue = '1,2,3,4,5,6,7';
    }

    var selectedDays = weekValue.split(',').filter(Boolean).map(function(x) {
        return parseInt(x, 10);
    });

    // Build modal DOM
    var overlay = E('div', { 'class': 'tc-edit-overlay' });
    var modal = E('div', {
        'class': 'tc-edit-modal',
        'role': 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'tc-edit-title'
    });

    // Header
    var header = E('div', { 'class': 'tc-edit-header' }, [
        E('h3', { 'id': 'tc-edit-title' }, isNew ? _('Add Rule') : _('Edit Rule')),
        E('button', {
            'type': 'button',
            'class': 'tc-edit-close',
            'aria-label': _('Close')
        }, '\u00d7')
    ]);

    // Body
    var body = E('div', { 'class': 'tc-edit-body' });

    // Enable field
    // Note: LuCI E() requires null (not false) to omit checked attribute
    var enableField = E('div', { 'class': 'tc-edit-field' }, [
        E('div', { 'class': 'tc-edit-toggle' }, [
            E('input', {
                'type': 'checkbox',
                'name': 'tc-edit-enable',
                'checked': enable === '1' ? '' : null
            }),
            E('label', {}, _('Enable Rule'))
        ])
    ]);
    body.appendChild(enableField);

    // Comment field
    var commentField = E('div', { 'class': 'tc-edit-field' }, [
        E('label', {}, _('Device Name')),
        E('input', {
            'type': 'text',
            'name': 'tc-edit-comment',
            'value': comment,
            'placeholder': _('Description')
        })
    ]);
    body.appendChild(commentField);

    // MAC field
    var macField = E('div', { 'class': 'tc-edit-field' }, [
        E('label', {}, _('IP/MAC Address')),
        E('input', {
            'type': 'text',
            'name': 'tc-edit-mac',
            'value': mac,
            'placeholder': '192.168.1.100 or 00:11:22:33:44:55'
        })
    ]);
    body.appendChild(macField);

    // Time fields
    var timeField = E('div', { 'class': 'tc-edit-field' }, [
        E('label', {}, _('Block Time Period')),
        E('div', { 'style': 'display: flex; gap: 8px; align-items: center;' }, [
            E('input', {
                'type': 'time',
                'name': 'tc-edit-timestart',
                'value': timestart,
                'style': 'flex: 1;'
            }),
            E('span', {}, '-'),
            E('input', {
                'type': 'time',
                'name': 'tc-edit-timeend',
                'value': timeend,
                'style': 'flex: 1;'
            })
        ])
    ]);
    body.appendChild(timeField);

    // Week field
    var dayLabels = [_('Mon'), _('Tue'), _('Wed'), _('Thu'), _('Fri'), _('Sat'), _('Sun')];
    var weekGroup = E('div', { 'class': 'tc-edit-week-group' });
    for (var d = 1; d <= 7; d++) {
        (function(dayNum) {
            var isChecked = selectedDays.indexOf(dayNum) >= 0;
            var cb = E('input', {
                'type': 'checkbox',
                'value': String(dayNum),
                'checked': isChecked ? '' : null
            });
            var label = E('label', { 'class': isChecked ? 'checked' : '' }, [cb, dayLabels[dayNum - 1]]);
            cb.addEventListener('change', function() {
                this.closest('.tc-edit-field').classList.remove('tc-field-error');
                var errMsg = this.closest('.tc-edit-field').querySelector('.tc-field-error-msg');
                if (errMsg) errMsg.remove();
                // Toggle checked class for CSS compatibility
                if (this.checked) {
                    this.parentElement.classList.add('checked');
                } else {
                    this.parentElement.classList.remove('checked');
                }
            });
            weekGroup.appendChild(label);
        })(d);
    }

    var weekShortcuts = E('div', { 'class': 'tc-edit-week-shortcuts' }, [
        E('button', { 'type': 'button', 'data-days': '1,2,3,4,5,6,7' }, _('Everyday')),
        E('button', { 'type': 'button', 'data-days': '1,2,3,4,5' }, _('Workday')),
        E('button', { 'type': 'button', 'data-days': '6,7' }, _('Weekend'))
    ]);

    var weekField = E('div', { 'class': 'tc-edit-field' }, [
        E('label', {}, _('Week Days')),
        weekShortcuts,
        weekGroup
    ]);
    body.appendChild(weekField);

    // Quota field - checkbox and input on same row
    // Note: LuCI E() requires null (not false) to omit checked attribute
    var quotaCheckbox = E('input', {
        'type': 'checkbox',
        'name': 'tc-edit-quota-enabled',
        'checked': quotaEnabled === '1' ? '' : null
    });
    var quotaMinutesInput = E('input', {
        'type': 'number',
        'name': 'tc-edit-quota-minutes',
        'value': quotaMinutes,
        'min': '1',
        'max': '1440',
        'placeholder': '120',
        'style': 'width: 80px; min-height: 36px; margin-left: 12px;' + (quotaEnabled === '1' ? '' : ' display: none;')
    });
    var quotaUnit = E('span', {
        'style': 'margin-left: 4px; color: #666;' + (quotaEnabled === '1' ? '' : ' display: none;'),
        'class': 'tc-quota-unit'
    }, _('min'));
    var quotaField = E('div', { 'class': 'tc-edit-field' }, [
        E('div', { 'class': 'tc-edit-toggle' }, [
            quotaCheckbox,
            E('label', {}, _('Enable Daily Quota')),
            quotaMinutesInput,
            quotaUnit
        ])
    ]);
    body.appendChild(quotaField);

    // Delete button (only for edit mode)
    if (!isNew) {
        var deleteBtn = E('button', {
            'type': 'button',
            'class': 'tc-edit-delete'
        }, _('Delete Rule'));
        body.appendChild(deleteBtn);

        deleteBtn.addEventListener('click', function() {
            deleteRule(sectionId);
        });
    }

    // Footer
    var footer = E('div', { 'class': 'tc-edit-footer' }, [
        E('button', { 'type': 'button', 'class': 'tc-btn-cancel' }, _('Cancel')),
        E('button', { 'type': 'button', 'class': 'tc-btn-save' }, _('Save'))
    ]);

    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(footer);

    var container = E('div', {}, [overlay, modal]);
    document.body.appendChild(container);
    currentEditModal = container;
    currentEditTriggerBtn = triggerBtn;

    // Lock body scroll
    document.body.classList.add('tc-modal-open');

    // Trigger slide-in animation
    requestAnimationFrame(function() {
        modal.classList.add('tc-modal-open');
    });

    // Focus first input
    var firstInput = body.querySelector('input[type="text"], input[type="checkbox"]');
    if (firstInput) {
        setTimeout(function() { firstInput.focus(); }, 100);
    }

    // Event handlers
    header.querySelector('.tc-edit-close').addEventListener('click', function() {
        closeEditModal();
    });

    overlay.addEventListener('click', function() {
        closeEditModal();
    });

    footer.querySelector('.tc-btn-cancel').addEventListener('click', function() {
        closeEditModal();
    });

    footer.querySelector('.tc-btn-save').addEventListener('click', function() {
        saveEditModal(sectionId, isNew);
    });

    // Escape key
    modal.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            closeEditModal();
        }
    });

    // Week shortcuts
    weekShortcuts.querySelectorAll('button').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.preventDefault();
            var days = this.dataset.days.split(',').map(function(x) { return parseInt(x, 10); });
            weekGroup.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
                var shouldCheck = days.indexOf(parseInt(cb.value, 10)) >= 0;
                cb.checked = shouldCheck;
                // Update checked class for CSS compatibility
                if (shouldCheck) {
                    cb.parentElement.classList.add('checked');
                } else {
                    cb.parentElement.classList.remove('checked');
                }
            });
        });
    });

    // Quota toggle
    quotaCheckbox.addEventListener('change', function() {
        var show = this.checked;
        quotaMinutesInput.style.display = show ? '' : 'none';
        quotaUnit.style.display = show ? '' : 'none';
    });

    // Clear error on input change
    body.querySelectorAll('input').forEach(function(input) {
        input.addEventListener('input', function() {
            var field = this.closest('.tc-edit-field');
            if (field) {
                field.classList.remove('tc-field-error');
                var errMsg = field.querySelector('.tc-field-error-msg');
                if (errMsg) errMsg.remove();
            }
        });
    });
}

// Render card view for mobile devices
// Returns DOM element (tc-card-view container)
function renderCardView() {
    var sections = uci.sections('timecontrol', 'device');
    var cardContainer = E('div', { 'class': 'tc-card-view' });

    for (var idx = 0; idx < sections.length; idx++) {
        var dev = sections[idx];
        var sectionId = dev['.name'];
        var enabled = dev.enable === '1';
        var comment = dev.comment || '';
        var mac = dev.mac || '';
        var displayName = comment || mac || _('Unnamed');
        var timeStart = dev.timestart || '00:00';
        var timeEnd = dev.timeend || '23:59';
        var weekValue = dev.week;
        if (weekValue === '0') weekValue = '1,2,3,4,5,6,7';
        var weekSummary = getWeekSummaryForCard(weekValue);

        // Determine initial status indicator class
        var indicatorClass = 'rule-status-indicator';
        if (!enabled) {
            indicatorClass += ' disabled';
        } else if (currentBlockedRules.indexOf(idx) >= 0) {
            indicatorClass += ' blocked';
        } else {
            indicatorClass += ' active';
        }

        // Create checkbox for enable/disable
        var cardCheckbox = E('input', { 'type': 'checkbox' });
        cardCheckbox.checked = enabled;

        // Create status indicator
        var indicator = E('span', {
            'class': indicatorClass,
            'data-section-id': sectionId,
            'title': enabled ? (currentBlockedRules.indexOf(idx) >= 0 ? _('Blocking') : _('Active')) : _('Disabled')
        });

        // Create edit button
        var editBtn = E('button', {
            'type': 'button',
            'class': 'tc-edit-btn',
            'aria-label': _('Edit')
        }, '\u270f');

        // Row 1: checkbox + indicator + name + MAC (small) + edit button
        var row1Children = [
            cardCheckbox,
            indicator,
            E('span', { 'class': 'tc-card-name' }, displayName)
        ];

        // Show MAC as small text if different from displayName
        if (mac && mac !== displayName) {
            row1Children.push(E('span', { 'class': 'tc-card-mac', 'style': 'margin-left: 4px;' }, mac));
        }

        row1Children.push(editBtn);

        var cardHeader = E('div', { 'class': 'tc-card-header' }, row1Children);

        // Row 2: time range + week summary + remaining time (if quota enabled)
        var row2Content = timeStart + ' - ' + timeEnd + ' | ' + weekSummary;
        var row2Children = [E('span', {}, row2Content)];

        if (dev.quota_enabled === '1') {
            var uid = dev.uid || '';
            row2Children.push(E('span', { 'style': 'margin-left: 8px;' }, [
                _('Remaining') + ': ',
                E('span', { 'class': 'quota-remaining', 'data-uid': uid }, '--'),
                'min'
            ]));
        }

        var cardInfo = E('div', { 'class': 'tc-card-info' }, row2Children);

        // Card container - disabled cards show all info but grayed out
        var cardClass = 'tc-card';
        if (!enabled) {
            cardClass += ' disabled';
        }
        var card = E('div', { 'class': cardClass, 'data-section-id': sectionId }, [
            cardHeader,
            cardInfo
        ]);

        // Checkbox change handler - sync with table input and UCI
        (function(sid, cardEl, checkbox) {
            checkbox.addEventListener('change', function() {
                var tableInput = document.querySelector(
                    'input[id^="cbid.timecontrol.' + sid + '.enable"]'
                );
                if (tableInput) {
                    tableInput.checked = this.checked;
                    tableInput.dispatchEvent(new Event('change', { bubbles: true }));
                } else {
                    uci.set('timecontrol', sid, 'enable', this.checked ? '1' : '0');
                    document.dispatchEvent(new Event('widget-change', { bubbles: true }));
                }
                // Update card disabled state
                if (this.checked) {
                    cardEl.classList.remove('disabled');
                } else {
                    cardEl.classList.add('disabled');
                }
            });
        })(sectionId, card, cardCheckbox);

        // Edit button handler
        (function(sid, btn) {
            btn.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                openEditModal(sid);
            });
        })(sectionId, editBtn);

        cardContainer.appendChild(card);
    }

    return cardContainer;
}

// Refresh card view (called after add/delete/save)
function refreshCardView() {
    var deviceSection = document.getElementById('cbi-timecontrol-device');
    if (!deviceSection) return;

    // Remove old card view
    var oldCards = deviceSection.querySelector('.tc-card-view');
    if (oldCards) oldCards.remove();

    // Re-render
    var addBtn = deviceSection.querySelector('.cbi-section-create');
    var cardView = renderCardView();
    if (addBtn) {
        deviceSection.insertBefore(cardView, addBtn);
    } else {
        deviceSection.appendChild(cardView);
    }

    // Update status indicators and quota display
    updateStatusIndicators(currentBlockedRules);
    updateQuotaStatus();
}

function getHostList() {
    return L.resolveDefault(network.getHostHints(), [])
        .then(function(hosts) {
            var hostList = [];
            if (hosts && hosts.length > 0) {
                hosts.forEach(function(host) {
                    if (host.ipv4 && host.mac) {
                        hostList.push({
                            ipv4: host.ipv4,
                            mac: host.mac,
                            name: host.name || '',
                            ipv6: host.ipv6 || ''
                        });
                    }
                });
            }
            return hostList;
        })
        .catch(function() {
            return [];
        });
}

// Fetch quota status JSON
function fetchQuotaStatus() {
    return fs.exec('/usr/bin/timecontrol-quota', ['status-json']).then(function(res) {
        if (res.code === 0) {
            try {
                return JSON.parse(res.stdout);
            } catch(e) {
                return null;
            }
        }
        return null;
    }).catch(function() {
        return null;
    });
}

// Apply quota status to DOM
function applyQuotaStatus(data) {
    if (!data) return;

    // Update next reset time
    var nextResetEl = document.getElementById('next_reset_time');
    if (nextResetEl && data.next_reset) {
        nextResetEl.textContent = data.next_reset;
    }

    // Update remaining time for each device (displayed in minutes)
    var devices = data.devices || {};
    Array.prototype.forEach.call(document.querySelectorAll('.quota-remaining'), function(el) {
        var uid = el.dataset.uid;
        if (uid && devices[uid]) {
            var d = devices[uid];
            var text = String(d.remaining_minutes);
            var color = 'inherit';

            if (d.exhausted) {
                text = '0';
                color = 'red';
            } else if (d.remaining_minutes <= 5) {
                color = 'orange';
            }

            el.textContent = text;
            el.style.color = color;
        }
    });
}

// Quota status polling update function
function updateQuotaStatus() {
    return fetchQuotaStatus().then(applyQuotaStatus);
}

var cbiRichListValue = form.ListValue.extend({
    renderWidget: function(section_id, option_index, cfgvalue) {
        var choices = this.transformChoices();
        var widget = new ui.Dropdown((cfgvalue != null) ? cfgvalue : this.default, choices, {
            id: this.cbid(section_id),
            sort: this.keylist,
            optional: true,
            select_placeholder: this.select_placeholder || this.placeholder,
            custom_placeholder: this.custom_placeholder || this.placeholder,
            validate: L.bind(this.validate, this, section_id),
            disabled: (this.readonly != null) ? this.readonly : this.map.readonly
        });

        return widget.render();
    },

    value: function(value, title, description) {
        if (description) {
            form.ListValue.prototype.value.call(this, value, E([], [
                E('span', { 'class': 'hide-open' }, [title]),
                E('div', { 'class': 'hide-close', 'style': 'min-width:25vw' }, [
                    E('strong', [title]),
                    E('br'),
                    E('span', { 'style': 'white-space:normal' }, description)
                ])
            ]));
        } else {
            form.ListValue.prototype.value.call(this, value, title);
        }
    }
});

return view.extend({
    load: function() {
        return Promise.all([
            uci.load('timecontrol'),
            network.getDevices(),
            fetchQuotaStatus()  // Preload quota status
        ]);
    },

    render: function(data) {
        var m, s, o;
        var hostList = [];
        var initialQuotaData = data[2];  // Preloaded quota data

        // Inject column width styles
        // Column order: 1-Comment, 2-Enabled, 3-IP/MAC, 4-Start, 5-Stop, 6-Week, 7-Enable Quota, 8-Quota, 9-Remaining, 10-Actions
        var styleId = 'timecontrol-table-style';
        if (!document.getElementById(styleId)) {
            var style = document.createElement('style');
            style.id = styleId;
            var tableSel = '#cbi-timecontrol-device table.cbi-section-table';
            style.textContent = [
                '#cbi-timecontrol-device .table { overflow-x: auto; }',
                tableSel + ' { table-layout: fixed; width: 100%; }',

                tableSel + ' th { white-space: normal !important; word-wrap: break-word !important; overflow: visible !important; }',
                tableSel + ' td { overflow: hidden; text-overflow: ellipsis; }',

                tableSel + ' input, ' + tableSel + ' select { min-width: 0; box-sizing: border-box; }',
                tableSel + ' input[type="text"], ' + tableSel + ' select { width: 100%; }',

                tableSel + ' td:nth-child(4) input, ' + tableSel + ' td:nth-child(5) input { text-align: center; font-variant-numeric: tabular-nums; }',

                '#cbi-timecontrol-device tr.cbi-section-table-titles th:nth-child(1), ' +
                tableSel + ' tr td:nth-child(1) { width: 18%; }',

                '#cbi-timecontrol-device tr.cbi-section-table-titles th:nth-child(2), ' +
                tableSel + ' tr td:nth-child(2) { width: 20px; text-align: center; }',

                '#cbi-timecontrol-device tr.cbi-section-table-titles th:nth-child(3), ' +
                tableSel + ' tr td:nth-child(3) { width: 22%; }',

                '#cbi-timecontrol-device tr.cbi-section-table-titles th:nth-child(4), ' +
                tableSel + ' tr td:nth-child(4) { width: 70px; }',

                '#cbi-timecontrol-device tr.cbi-section-table-titles th:nth-child(5), ' +
                tableSel + ' tr td:nth-child(5) { width: 70px; }',

                '#cbi-timecontrol-device tr.cbi-section-table-titles th:nth-child(6), ' +
                tableSel + ' tr td:nth-child(6) { width: 150px; }',

                '#cbi-timecontrol-device tr.cbi-section-table-titles th:nth-child(7), ' +
                tableSel + ' tr td:nth-child(7) { width: 70px; text-align: center; }',

                '#cbi-timecontrol-device tr.cbi-section-table-titles th:nth-child(8), ' +
                tableSel + ' tr td:nth-child(8) { width: 70px; text-align: center; }',

                '#cbi-timecontrol-device tr.cbi-section-table-titles th:nth-child(9), ' +
                tableSel + ' tr td:nth-child(9) { width: 80px; }',

                '#cbi-timecontrol-device tr.cbi-section-table-titles th:nth-child(10), ' +
                tableSel + ' tr td:nth-child(10) { width: 100px; }',

                // Week Popover styles
                '.week-summary-btn { display: inline-block; min-width: 44px; min-height: 32px; padding: 4px 8px; cursor: pointer; border: 1px solid #ccc; border-radius: 4px; background: #f8f8f8; text-align: center; white-space: nowrap; }',
                '.week-summary-btn:hover { background: #e8e8e8; }',
                '.week-popover-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.3); z-index: 9998; }',
                '.week-popover { position: absolute; z-index: 9999; background: #fff; border: 1px solid #ccc; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); padding: 12px; min-width: 200px; }',
                '.week-popover-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-weight: bold; }',
                '.week-popover-close { cursor: pointer; padding: 4px 8px; font-size: 18px; line-height: 1; border: none; background: none; }',
                '.week-popover-buttons { display: flex; gap: 4px; margin-bottom: 8px; }',
                '.week-popover-buttons button { padding: 4px 8px; font-size: 12px; }',
                '.week-popover-checkboxes { display: flex; flex-wrap: wrap; gap: 8px; }',
                '.week-popover-checkboxes label { display: inline-flex; align-items: center; min-width: 44px; min-height: 32px; cursor: pointer; }',

                // Mobile responsive - hide Comment column on narrow screens
                '@media (max-width: 768px) { ' +
                    '#cbi-timecontrol-device tr.cbi-section-table-titles th:nth-child(1), ' +
                    tableSel + ' tr td:nth-child(1) { display: none; } ' +
                    '.week-popover { position: fixed !important; top: 50% !important; left: 50% !important; transform: translate(-50%, -50%) !important; max-width: 90vw; } ' +
                '}',

                // Rule status indicator styles
                '.rule-status-indicator { display: inline-block; width: 10px; height: 10px; min-width: 10px; min-height: 10px; border-radius: 50%; margin-left: 8px; vertical-align: middle; cursor: help; flex-shrink: 0; }',
                '.rule-status-indicator.disabled { background: #888; border: 2px solid #555; box-sizing: border-box; }',
                '.rule-status-indicator.blocked { background: #e53935; }',
                '.rule-status-indicator.active { background: #4caf50; }',

                // Card view styles for mobile
                '.tc-card-view { display: none; padding: 0 12px; }',
                '.tc-card-view .tc-card { border: 1px solid #ddd; border-radius: 6px; padding: 12px; margin-bottom: 8px; background: #fff; }',
                '.tc-card-view .tc-card.disabled { opacity: 0.5; }',
                '.tc-card-header { display: flex; align-items: center; }',
                '.tc-card-header > * { margin-right: 8px; }',
                '.tc-card-header > *:last-child { margin-right: 0; }',
                '.tc-card-name { font-weight: bold; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
                '.tc-card-mac { color: #666; font-size: 12px; margin-top: 4px; }',
                '.tc-card-info { color: #666; font-size: 12px; margin-top: 4px; }',
                '.tc-card-quota { color: #666; font-size: 12px; margin-top: 4px; }',

                // Mobile responsive - show card view, hide table
                '@media (max-width: 768px) { ' +
                    '.tc-table-view { display: none !important; } ' +
                    '.tc-card-view { display: block; } ' +
                    '#cbi-timecontrol-device .cbi-section-create { width: 100%; text-align: center; } ' +
                '}',

                // Edit modal styles
                '.tc-edit-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 10000; }',
                '.tc-edit-modal { position: fixed; left: 50%; bottom: 0; transform: translateX(-50%) translateY(100%); width: 100%; max-width: 400px; max-height: 90vh; background: #fff; border-radius: 12px 12px 0 0; box-shadow: 0 4px 20px rgba(0,0,0,0.15); z-index: 10001; display: flex; flex-direction: column; transition: transform 0.3s ease-out; }',
                '.tc-edit-modal.tc-modal-open { transform: translateX(-50%) translateY(0); }',
                '.tc-edit-header { display: flex; justify-content: space-between; align-items: center; padding: 16px; border-bottom: 1px solid #eee; flex-shrink: 0; }',
                '.tc-edit-header h3 { margin: 0; font-size: 18px; }',
                '.tc-edit-close { width: 32px; height: 32px; border: none; background: none; font-size: 24px; cursor: pointer; display: flex; align-items: center; justify-content: center; border-radius: 50%; }',
                '.tc-edit-close:hover { background: #f0f0f0; }',
                '.tc-edit-body { flex: 1; overflow-y: auto; padding: 16px; max-height: calc(90vh - 140px); }',
                '.tc-edit-field { margin-bottom: 16px; }',
                '.tc-edit-field label { display: block; font-weight: 500; margin-bottom: 6px; font-size: 14px; }',
                '.tc-edit-field input[type="text"], .tc-edit-field input[type="time"], .tc-edit-field input[type="number"] { width: 100%; min-height: 44px; padding: 8px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 16px; box-sizing: border-box; }',
                '.tc-edit-field input:focus { outline: none; border-color: #0077cc; box-shadow: 0 0 0 2px rgba(0,119,204,0.2); }',
                '.tc-edit-field.tc-field-error input { border-color: #e53935; }',
                '.tc-edit-field .tc-field-error-msg { color: #e53935; font-size: 12px; margin-top: 4px; }',
                '.tc-edit-week-group { display: flex; flex-wrap: wrap; gap: 8px; }',
                '.tc-edit-week-group label { display: inline-flex; align-items: center; min-width: 70px; min-height: 36px; padding: 4px 8px; border: 1px solid #ddd; border-radius: 4px; cursor: pointer; }',
                '.tc-edit-week-group label.checked { background: #e3f2fd; border-color: #0077cc; }',
                '.tc-edit-week-group input { margin-right: 6px; }',
                '.tc-edit-week-shortcuts { display: flex; gap: 8px; margin-bottom: 8px; }',
                '.tc-edit-week-shortcuts button { padding: 6px 12px; font-size: 12px; border: 1px solid #ddd; border-radius: 4px; background: #f8f8f8; cursor: pointer; }',
                '.tc-edit-week-shortcuts button:hover { background: #e8e8e8; }',
                '.tc-edit-footer { display: flex; gap: 12px; padding: 16px; border-top: 1px solid #eee; flex-shrink: 0; }',
                '.tc-edit-footer button { flex: 1; min-height: 44px; border-radius: 6px; font-size: 16px; cursor: pointer; }',
                '.tc-edit-footer .tc-btn-cancel { background: #fff; border: 1px solid #ddd; color: #333; }',
                '.tc-edit-footer .tc-btn-cancel:hover { background: #f8f8f8; }',
                '.tc-edit-footer .tc-btn-save { background: #0077cc; border: none; color: #fff; }',
                '.tc-edit-footer .tc-btn-save:hover { background: #0066b3; }',
                '.tc-edit-delete { width: 100%; padding: 12px; margin-top: 16px; border: 1px solid #e53935; border-radius: 6px; background: #fff; color: #e53935; font-size: 14px; cursor: pointer; text-align: center; }',
                '.tc-edit-delete:hover { background: #ffebee; }',
                '.tc-edit-btn { width: 32px; height: 32px; min-width: 32px; border: none; background: #f0f0f0; border-radius: 50%; cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-left: auto; }',
                '.tc-edit-btn:hover { background: #e0e0e0; }',
                '.tc-edit-toggle { display: flex; align-items: center; gap: 8px; }',
                '.tc-edit-toggle input[type="checkbox"] { width: 20px; height: 20px; }',
                'body.tc-modal-open { overflow: hidden; }'
            ].join('\n');
            document.head.appendChild(style);
        }

        // Inject animation keyframes separately for better browser compatibility
        var animStyleId = 'timecontrol-animation-style';
        if (!document.getElementById(animStyleId)) {
            var animStyle = document.createElement('style');
            animStyle.id = animStyleId;
            animStyle.setAttribute('type', 'text/css');
            animStyle.appendChild(document.createTextNode(
                '@keyframes pulse-glow {' +
                '  0%, 100% { box-shadow: 0 0 2px 1px rgba(229, 57, 53, 0.4); }' +
                '  50% { box-shadow: 0 0 5px 2px rgba(229, 57, 53, 0.8); }' +
                '}' +
                '.rule-status-indicator.blocked {' +
                '  animation: pulse-glow 1s ease-in-out infinite;' +
                '}'
            ));
            document.head.appendChild(animStyle);
        }

        m = new form.Map('timecontrol', _('Internet Time Control'),
            _('Users can limit their internet usage time through MAC and IP, with available IP ranges such as 192.168.110.00 to 192.168.10.200') + '<br/>' +
            _('Suggested feedback:') + ' <a href="https://github.com/sirpdboy/luci-app-timecontrol.git" target="_blank">GitHub @timecontrol</a>');

        s = m.section(form.TypedSection);
        s.anonymous = true;
        s.render = function() {
            var statusView = E('p', { id: 'service_status' },
                '<span class="spinning"> </span> ' + _('Checking service status...'));

            // Fetch process status and blocked rules simultaneously
            Promise.all([checkTimeControlProcess(), fetchBlockedRules()])
                .then(function(results) {
                    var processInfo = results[0];
                    var blockedRules = results[1];
                    currentBlockedRules = blockedRules;
                    var stats = getBlockedDeviceStats(blockedRules);
                    var status = renderServiceStatus(processInfo.running, processInfo.pid, stats);
                    statusView.innerHTML = status;
                    updateStatusIndicators(blockedRules);
                })
                .catch(function(err) {
                    statusView.innerHTML = '<span style="color:orange">⚠ ' +
                        _('Status check failed') + '</span>';
                    console.error('Status check error:', err);
                });

            poll.add(function() {
                return Promise.all([checkTimeControlProcess(), fetchBlockedRules()])
                    .then(function(results) {
                        var processInfo = results[0];
                        var blockedRules = results[1];
                        currentBlockedRules = blockedRules;
                        var stats = getBlockedDeviceStats(blockedRules);
                        var status = renderServiceStatus(processInfo.running, processInfo.pid, stats);
                        statusView.innerHTML = status;
                        updateStatusIndicators(blockedRules);
                    })
                    .catch(function(err) {
                        statusView.innerHTML = '<span style="color:orange">⚠ ' +
                            _('Status check failed') + '</span>';
                        console.error('Status check error:', err);
                    });
            }, 5); 

            poll.start();
            return E('div', { class: 'cbi-section', id: 'status_bar' }, [
                statusView,
                E('div', { 'style': 'text-align: right; font-style: italic;' }, [
                    E('span', {}, [
                        _('© github '),
                        E('a', {
                            'href': 'https://github.com/sirpdboy',
                            'target': '_blank',
                            'style': 'text-decoration: none;'
                        }, 'by sirpdboy')
                    ])
                ])
            ]);
        };

        s = m.section(form.TypedSection, 'timecontrol', _('Global Settings'));
        s.anonymous = true;
        s.addremove = false;

        // Control mode (hidden when blacklist-only mode)
        // o = s.option(cbiRichListValue, 'list_type', _('Control Mode'),
        //     _('blacklist: Block the networking of the target address, whitelist: Only allow networking for the target address and block all other addresses.'));
        // o.rmempty = false;
        // o.value('blacklist', _('Blacklist'));
        // o.value('whitelist', _('Whitelist'));
        // o.default = 'blacklist';

        o = s.option(form.ListValue, 'chain', _('Control Intensity'),
            _('Pay attention to strong control: machines under control will not be able to connect to the software router backend!'));
        o.value('forward', _('Ordinary forward control'));
        o.value('input', _('Strong input control'));
        o.default = 'forward';
        o.rmempty = false;

        // Quota reset hour
        o = s.option(form.ListValue, 'quota_reset_hour', _('Quota Reset Hour'),
            _('Daily quota resets at this hour (0-23). Default is midnight.'));
        for (var h = 0; h < 24; h++) {
            o.value(String(h), String(h) + ':00');
        }
        o.default = '0';
        o.rmempty = true;

        // Next reset time (read-only display)
        o = s.option(form.DummyValue, '_next_reset', _('Next Reset Time'));
        o.rawhtml = true;
        o.cfgvalue = function(section_id) {
            return '<span id="next_reset_time">Loading...</span>';
        };

        var s = m.section(form.TableSection, 'device',  _('Device Rules'));
        s.addremove = true;
        s.anonymous = true;
        s.sortable = false;
        s.description = _('Block time periods take priority; quota is only consumed when online and not blocked.');

        o = s.option(form.Value, 'comment', _('Comment'));
        o.optional = true;
        o.placeholder = _('Description');
        o.renderWidget = function(section_id, option_index, cfgvalue) {
            var widget = form.Value.prototype.renderWidget.call(this, section_id, option_index, cfgvalue);
            var indicator = E('span', {
                'class': 'rule-status-indicator disabled',
                'data-section-id': section_id,
                'title': _('Disabled'),
                'role': 'status',
                'aria-live': 'polite',
                'aria-label': _('Rule disabled')
            });
            return E('div', { 'style': 'display: inline-flex; align-items: center;' }, [widget, indicator]);
        };

        o = s.option(form.Flag, 'enable', _('Enabled'));
        o.rmempty = false;
        o.default = '1';
	
        o = s.option(form.Value, 'mac', _('IP/MAC Address'));
        o.rmempty = false;
        o.placeholder = '192.168.10.100 or 00:11:22:33:44:55';
        o.validate = function(section_id, value) {
            if (!value) return _('IP/MAC Address is required');

            // Check if range/CIDR/multi-value, notify quota not available
            if (value.indexOf('/') >= 0 || value.indexOf('-') >= 0 || value.indexOf(',') >= 0 || value.indexOf(' ') >= 0) {
                ui.addNotification(null, E('p', _('Note: Quota is not available for CIDR/range/multi-value addresses.')), 'info');
            }
            return true;
        };
        
        getHostList().then(function(hosts) {
            hostList = hosts;
            o.value('', _('-- Please select or enter manually --'));
            
            if (hosts.length > 0) {
                hosts.forEach(function(host) {
                    var displayName = '';
                    if (host.name) {
                        displayName = host.name + ' - ';
                    }
                    displayName += host.ipv4 + ' (' + host.mac + ')';

                    // Add IP option
                    o.value(host.ipv4, displayName);

                    // Add MAC option
                    var macDisplay = host.mac;
                    if (host.name) {
                        macDisplay += ' - ' + host.name;
                    }
                    if (host.ipv4) {
                        macDisplay += ' (' + host.ipv4 + ')';
                    }
                    o.value(host.mac, macDisplay);
                });
            }
        });

        o = s.option(form.Value, 'timestart', _('Start Control Time'));
        o.placeholder = '00:00';
        o.default = '00:00';
        o.rmempty = false;

        o = s.option(form.Value, 'timeend', _('Stop Control Time'));
        o.placeholder = '00:00';
        o.default = '00:00';
        o.rmempty = false;

        // Week summary helper function
        function getWeekSummary(value) {
            // Input validation: handle null/undefined/non-string
            if (value == null || typeof value !== 'string') {
                value = '';
            }

            var arr = value.split(',').filter(Boolean).map(function(x) {
                var num = parseInt(x, 10);  // Explicit radix 10 to avoid octal
                return isNaN(num) ? 0 : num;
            }).filter(function(n) {
                return n >= 1 && n <= 7;  // Only valid days 1-7
            }).sort(function(a, b) { return a - b; });

            // Deduplicate
            var seen = {};
            arr = arr.filter(function(n) {
                if (seen[n]) return false;
                seen[n] = true;
                return true;
            });

            var str = arr.join(',');

            // Preset pattern matching - use translated labels
            if (str === '1,2,3,4,5,6,7' || str === '') return _('Everyday');
            if (str === '1,2,3,4,5') return _('Workday');
            if (str === '6,7') return _('Weekend');

            // Multiple days or single day - use pure numbers for compact display
            return arr.join('/');
        }

        o = s.option(form.ListValue, 'week', _('Week'));
        o.rmempty = false;
        o.default = '1,2,3,4,5,6,7';  // Default value for new devices

        // cfgvalue: return actual UCI value to let LuCI detect changes
        // Note: '0' needs to be expanded to '1,2,3,4,5,6,7' for renderWidget
        o.cfgvalue = function(section_id) {
            var v = uci.get('timecontrol', section_id, 'week');
            if (v === '0') return '1,2,3,4,5,6,7';
            return v;  // Return empty for missing values to let LuCI use default
        };

        // formvalue: read from hidden input, sync from checkboxes if popover is open
        o.formvalue = function(section_id) {
            var node = document.getElementById(this.cbid(section_id));
            if (!node) return '';

            // Sync from checkboxes if popover is open
            var parent = node.parentNode;
            var popover = parent ? parent.querySelector('.week-popover') : null;
            if (popover && popover.offsetParent !== null) {
                var checkboxes = popover.querySelectorAll('.week-popover-checkboxes input[type="checkbox"]:checked');
                var days = [];
                for (var i = 0; i < checkboxes.length; i++) {
                    days.push(parseInt(checkboxes[i].value, 10));
                }
                days.sort(function(a, b) { return a - b; });
                node.value = days.join(',');
            }

            return node.value;
        };

        // write: sort and normalize to '0' if all days selected
        o.write = function(section_id, value) {
            var arr = (value || '').split(',').filter(Boolean).sort(function(a, b) {
                return parseInt(a) - parseInt(b);
            });
            if (arr.join(',') === '1,2,3,4,5,6,7') {
                value = '0';
            } else {
                value = arr.join(',');
            }
            uci.set('timecontrol', section_id, 'week', value);
        };

        // validate: at least one day must be selected
        o.validate = function(section_id, value) {
            if (!value || value.split(',').filter(Boolean).length === 0) {
                return _('Please select at least one day');
            }
            return true;
        };

        // Custom renderWidget: Summary button + Popover
        o.renderWidget = function(section_id, option_index, cfgvalue) {
            // Guard against invalid section_id
            if (!section_id) {
                return document.createDocumentFragment();
            }

            var self = this;
            var selectedDays = (cfgvalue || '1,2,3,4,5,6,7').split(',').filter(Boolean);

            // Hidden input for actual value storage
            var hidden = E('input', {
                'type': 'hidden',
                'id': this.cbid(section_id),
                'name': this.cbid(section_id),
                'value': selectedDays.join(',')
            });

            // Summary button
            var summaryBtn = E('span', {
                'class': 'week-summary-btn',
                'role': 'button',
                'tabindex': '0',
                'aria-haspopup': 'dialog',
                'aria-expanded': 'false'
            }, getWeekSummary(selectedDays.join(',')));

            // Popover container (initially hidden)
            var popoverContainer = E('div', { 'style': 'display: none;' });

            // Create overlay
            var overlay = E('div', { 'class': 'week-popover-overlay' });

            // Create popover
            var popover = E('div', {
                'class': 'week-popover',
                'role': 'dialog',
                'aria-modal': 'true',
                'aria-labelledby': 'week-popover-title-' + section_id
            });

            // Popover header
            var header = E('div', { 'class': 'week-popover-header' }, [
                E('span', { 'id': 'week-popover-title-' + section_id }, _('Week')),
                E('button', {
                    'type': 'button',
                    'class': 'week-popover-close',
                    'aria-label': _('Close')
                }, '\u00d7')
            ]);

            // Quick select buttons
            var buttonsDiv = E('div', { 'class': 'week-popover-buttons' });

            var btnEveryday = E('button', {
                'type': 'button',
                'class': 'cbi-button cbi-button-action'
            }, _('Everyday'));

            var btnWorkday = E('button', {
                'type': 'button',
                'class': 'cbi-button cbi-button-action'
            }, _('Workday'));

            var btnRestday = E('button', {
                'type': 'button',
                'class': 'cbi-button cbi-button-action'
            }, _('Rest Day'));

            buttonsDiv.appendChild(btnEveryday);
            buttonsDiv.appendChild(btnWorkday);
            buttonsDiv.appendChild(btnRestday);

            // Checkboxes
            var checkboxesDiv = E('div', { 'class': 'week-popover-checkboxes' });
            var dayLabels = [_('Monday'), _('Tuesday'), _('Wednesday'),
                             _('Thursday'), _('Friday'), _('Saturday'), _('Sunday')];

            for (var i = 1; i <= 7; i++) {
                (function(dayNum) {
                    var isSelected = selectedDays.indexOf(String(dayNum)) >= 0;
                    var cb = E('input', {
                        'type': 'checkbox',
                        'value': String(dayNum),
                        'checked': isSelected ? '' : null
                    });

                    var label = E('label', {}, [
                        cb,
                        E('span', { 'style': 'margin-left: 4px;' }, dayLabels[dayNum - 1])
                    ]);

                    checkboxesDiv.appendChild(label);
                })(i);
            }

            // Assemble popover
            popover.appendChild(header);
            popover.appendChild(buttonsDiv);
            popover.appendChild(checkboxesDiv);

            popoverContainer.appendChild(overlay);
            popoverContainer.appendChild(popover);

            // Helper: get selected days from checkboxes
            function getSelectedDays() {
                var days = [];
                Array.prototype.forEach.call(checkboxesDiv.querySelectorAll('input[type="checkbox"]:checked'), function(cb) {
                    days.push(parseInt(cb.value, 10));
                });
                return days.sort(function(a, b) { return a - b; });
            }

            // Helper: set checkbox states
            function setDays(days) {
                Array.prototype.forEach.call(checkboxesDiv.querySelectorAll('input[type="checkbox"]'), function(cb) {
                    cb.checked = days.indexOf(parseInt(cb.value, 10)) >= 0;
                });
            }

            // Helper: check if arrays are equal
            function arraysEqual(a, b) {
                if (a.length !== b.length) return false;
                for (var i = 0; i < a.length; i++) {
                    if (a[i] !== b[i]) return false;
                }
                return true;
            }

            // Helper: close popover
            function closePopover() {
                popoverContainer.style.display = 'none';
                summaryBtn.setAttribute('aria-expanded', 'false');

                // Remove scroll listener
                document.removeEventListener('scroll', scrollHandler, { passive: true, capture: true });

                // Update hidden value and summary
                var days = getSelectedDays();
                hidden.value = days.join(',');
                summaryBtn.textContent = getWeekSummary(days.join(','));

                // Dispatch widget-change event
                hidden.dispatchEvent(new Event('widget-change', { bubbles: true }));

                // Return focus to summary button
                summaryBtn.focus();
            }

            // Scroll handler (defined here for add/remove)
            var scrollHandler = function() {
                if (popoverContainer.style.display !== 'none') {
                    closePopover();
                }
            };

            // Helper: open popover
            function openPopover() {
                // Sync checkboxes to current hidden value before showing
                var currentDays = hidden.value.split(',').filter(Boolean).map(function(x) {
                    return parseInt(x, 10);
                });
                setDays(currentDays);

                popoverContainer.style.display = '';
                summaryBtn.setAttribute('aria-expanded', 'true');

                // Add scroll listener (will be removed on close)
                document.addEventListener('scroll', scrollHandler, { passive: true, capture: true });

                // Use requestAnimationFrame to ensure layout is complete before positioning
                window.requestAnimationFrame(function() {
                    // Position popover (desktop: below button, mobile: centered via CSS)
                    var rect = summaryBtn.getBoundingClientRect();
                    var viewportWidth = window.innerWidth;
                    var viewportHeight = window.innerHeight;

                    // Reset any previous positioning
                    popover.style.top = '';
                    popover.style.left = '';
                    popover.style.right = '';
                    popover.style.bottom = '';
                    popover.style.transform = '';

                    // Only apply positioning on desktop (>768px), mobile uses CSS fixed centering
                    if (viewportWidth > 768) {
                        // Get actual popover dimensions after rendering
                        var popoverRect = popover.getBoundingClientRect();
                        var popoverHeight = popoverRect.height || 200;
                        var popoverWidth = popoverRect.width || 260;

                        // Default: below and left-aligned
                        var top = rect.bottom + 4;
                        var left = rect.left;

                        // If overflows right, align to right edge
                        if (left + popoverWidth > viewportWidth) {
                            left = viewportWidth - popoverWidth - 10;
                        }

                        // If overflows bottom, show above
                        if (top + popoverHeight > viewportHeight) {
                            top = rect.top - popoverHeight - 4;
                        }

                        popover.style.position = 'fixed';
                        popover.style.top = top + 'px';
                        popover.style.left = Math.max(10, left) + 'px';
                    }

                    // Focus first checkbox
                    var firstCheckbox = checkboxesDiv.querySelector('input[type="checkbox"]');
                    if (firstCheckbox) {
                        firstCheckbox.focus();
                    }
                });
            }

            // Event: open popover on click
            summaryBtn.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                openPopover();
            });

            // Event: keyboard support for summary button
            summaryBtn.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openPopover();
                }
            });

            // Event: close on overlay click
            overlay.addEventListener('click', function(e) {
                e.preventDefault();
                closePopover();
            });

            // Event: close button
            header.querySelector('.week-popover-close').addEventListener('click', function(e) {
                e.preventDefault();
                closePopover();
            });

            // Event: Escape key closes popover
            popover.addEventListener('keydown', function(e) {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    closePopover();
                }
            });

            // Event: quick select buttons
            btnEveryday.addEventListener('click', function(e) {
                e.preventDefault();
                var current = getSelectedDays();
                if (arraysEqual(current, [1, 2, 3, 4, 5, 6, 7])) {
                    setDays([]);
                } else {
                    setDays([1, 2, 3, 4, 5, 6, 7]);
                }
            });

            btnWorkday.addEventListener('click', function(e) {
                e.preventDefault();
                var current = getSelectedDays();
                if (arraysEqual(current, [1, 2, 3, 4, 5])) {
                    setDays([]);
                } else {
                    setDays([1, 2, 3, 4, 5]);
                }
            });

            btnRestday.addEventListener('click', function(e) {
                e.preventDefault();
                var current = getSelectedDays();
                if (arraysEqual(current, [6, 7])) {
                    setDays([]);
                } else {
                    setDays([6, 7]);
                }
            });

            return E('div', { 'style': 'position: relative;' }, [hidden, summaryBtn, popoverContainer]);
        };

        // Check if single IP/MAC (quota feature available)
        function isQuotaEligible(section_id) {
            var mac = uci.get('timecontrol', section_id, 'mac') || '';
            return mac.indexOf('/') < 0 && mac.indexOf('-') < 0 && mac.indexOf(',') < 0 && mac.indexOf(' ') < 0;
        }

        // Enable quota limit (after week column)
        o = s.option(form.Flag, 'quota_enabled', _('Enable Quota'));
        o.width = '80px';
        o.rmempty = false;
        o.default = '0';
        // Don't use depends (causes column misalignment), handle in renderWidget instead
        o.renderWidget = function(section_id, option_index, cfgvalue) {
            if (!isQuotaEligible(section_id)) {
                return E('em', { 'style': 'color: #999;' }, 'N/A');
            }
            return form.Flag.prototype.renderWidget.apply(this, [section_id, option_index, cfgvalue]);
        };
        // Force write 0 when ineligible to avoid config residue
        o.write = function(section_id, formvalue) {
            if (!isQuotaEligible(section_id)) {
                uci.set('timecontrol', section_id, 'quota_enabled', '0');
                return;
            }
            return form.Flag.prototype.write.apply(this, [section_id, formvalue]);
        };

        // Daily quota (minutes)
        o = s.option(form.Value, 'quota_minutes', _('Quota (min)'));
        o.width = '80px';
        o.datatype = 'uinteger';
        o.placeholder = '120';
        o.default = '120';
        o.renderWidget = function(section_id, option_index, cfgvalue) {
            if (!isQuotaEligible(section_id)) {
                return E('em', { 'style': 'color:#999' }, _('N/A'));
            }

            var widget = form.Value.prototype.renderWidget.call(this, section_id, option_index, cfgvalue);
            var naEl = E('em', { 'style': 'color:#999' }, _('N/A'));
            var widgetWrapper = E('span', {}, [widget]);
            var container = E('div', {}, [widgetWrapper, naEl]);

            var self = this;
            
            function updateVisibility() {
                var quotaEnabledOpt = self.map.lookupOption('quota_enabled', section_id);
                var v = null;
                if (quotaEnabledOpt && quotaEnabledOpt[0]) {
                    v = quotaEnabledOpt[0].formvalue(section_id);
                }
                var enabled = (v === '1' || v === true);
                widgetWrapper.style.display = enabled ? '' : 'none';
                naEl.style.display = enabled ? 'none' : '';
            }

            document.addEventListener('widget-change', updateVisibility);
            window.requestAnimationFrame(updateVisibility);

            return container;
        };
        o.validate = function(section_id, value) {
            var quotaEnabled = uci.get('timecontrol', section_id, 'quota_enabled');
            if (quotaEnabled === '1') {
                if (!value || parseInt(value) <= 0) {
                    return _('Quota minutes must be greater than 0');
                }
            }
            return true;
        };

        // Remaining time today (read-only, displayed in minutes)
        o = s.option(form.DummyValue, '_remaining', _('Remaining Today (min)'));
        o.width = '100px';
        o.rawhtml = true;
        o.cfgvalue = function(section_id) {
            if (!isQuotaEligible(section_id)) {
                return '<em style="color: #999;">N/A</em>';
            }
            var uid = uci.get('timecontrol', section_id, 'uid');
            return '<span class="quota-remaining" data-uid="' + (uid || '') + '">--</span>';
        };

        // Auto-generate uid when saving device
        m.save = function() {
            var sections = uci.sections('timecontrol', 'device');
            sections.forEach(function(s) {
                if (!s.uid) {
                    var uid = 'dev_' + Math.random().toString(36).substring(2, 10);
                    uci.set('timecontrol', s['.name'], 'uid', uid);
                }
            });
            return form.Map.prototype.save.apply(this, arguments);
        };

        // Quota status polling (60 seconds)
        poll.add(updateQuotaStatus, 60);

        // Apply preloaded quota data immediately after render
        // Note: m.render().then() resolves when map is built, but DOM may not be
        // inserted into document yet. Use requestAnimationFrame to defer until
        // next paint cycle when DOM is queryable. Without this, applyQuotaStatus
        // may fail to find elements, causing 60s delay until poll refresh.
        return m.render().then(function(mapEl) {
            window.requestAnimationFrame(function() {
                if (initialQuotaData) {
                    applyQuotaStatus(initialQuotaData);
                }
                updateStatusIndicators(currentBlockedRules);

                // Inject card view for mobile
                var deviceSection = document.getElementById('cbi-timecontrol-device');
                if (deviceSection) {
                    // Add tc-table-view class to table for CSS toggle
                    var table = deviceSection.querySelector('table.cbi-section-table');
                    if (table && !table.classList.contains('tc-table-view')) {
                        table.classList.add('tc-table-view');
                    }

                    // Insert card view before add button
                    var addBtn = deviceSection.querySelector('.cbi-section-create');
                    var cardView = renderCardView();
                    if (addBtn) {
                        deviceSection.insertBefore(cardView, addBtn);
                    } else {
                        deviceSection.appendChild(cardView);
                    }

                    // Apply quota status to card view
                    if (initialQuotaData) {
                        applyQuotaStatus(initialQuotaData);
                    }

                    // Listen for add button click - intercept on mobile
                    // Use capture phase (true) to run BEFORE LuCI's inline click handler
                    var createBtn = deviceSection.querySelector('.cbi-section-create button');
                    if (createBtn) {
                        createBtn.addEventListener('click', function(e) {
                            // On mobile, intercept and open modal instead
                            if (window.innerWidth < 768) {
                                e.preventDefault();
                                e.stopPropagation();
                                e.stopImmediatePropagation();
                                openEditModal(null);
                                return false;
                            }
                            // Desktop: refresh card view after default behavior
                            setTimeout(refreshCardView, 200);
                        }, true);
                    }

                    // Listen for delete button clicks (event delegation)
                    deviceSection.addEventListener('click', function(e) {
                        if (e.target.closest('.cbi-section-remove')) {
                            setTimeout(refreshCardView, 200);
                        }
                    });
                }

                // Listen for UCI save completion to refresh card view (only once)
                if (!window._tcUciAppliedListenerAdded) {
                    document.addEventListener('uci-applied', refreshCardView);
                    window._tcUciAppliedListenerAdded = true;
                }
            });
            return mapEl;
        });
    }
});
