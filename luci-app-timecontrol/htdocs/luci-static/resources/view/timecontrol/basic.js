'use strict';
'require view';
'require fs';
'require ui';
'require uci';
'require form';
'require poll';
'require rpc';
'require network';

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

// Check if current time is within blocking period (for status display only)
// Note: Uses >= for start time (inclusive), backend uses > (exclusive).
// This may cause 1-minute display discrepancy at exact boundaries, which is acceptable.
// Format: timestart/timeend "HH:MM", week "1,2,3" or "0" (all days)
function isInBlockPeriod(timestart, timeend, week) {
    var now = new Date();
    var currentDay = now.getDay();
    // Convert: JS Sunday=0 → System Sunday=7
    if (currentDay === 0) currentDay = 7;

    // Parse week configuration
    var weekDays = [];
    if (!week || week === '0') {
        weekDays = [1, 2, 3, 4, 5, 6, 7];
    } else {
        weekDays = week.split(',').map(function(d) {
            return parseInt(d, 10);
        }).filter(function(d) {
            return d >= 1 && d <= 7;
        });
    }

    // Check if today is in controlled days
    if (weekDays.indexOf(currentDay) < 0) {
        return false;
    }

    // Parse time
    var startParts = (timestart || '00:00').split(':');
    var endParts = (timeend || '00:00').split(':');
    var startMinutes = parseInt(startParts[0], 10) * 60 + parseInt(startParts[1] || 0, 10);
    var endMinutes = parseInt(endParts[0], 10) * 60 + parseInt(endParts[1] || 0, 10);
    var currentMinutes = now.getHours() * 60 + now.getMinutes();

    // Same start/end time means no blocking
    if (startMinutes === endMinutes) {
        return false;
    }

    // Cross-midnight case (e.g., 21:00 - 07:00)
    if (startMinutes > endMinutes) {
        return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }

    // Normal case (e.g., 08:00 - 18:00)
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

// Get blocked device statistics (requires quota data)
// Returns { blocked: currently blocked count, total: unique device count }
// Counts by unique MAC address, not by rule count.
// Note: When quotaData is null (backend not running), blocked only includes
// time-period blocking; quota blocking is ignored. This is acceptable degradation.
function getBlockedDeviceStats(quotaData) {
    var sections = uci.sections('timecontrol', 'device');
    var deviceMap = {};  // MAC -> { blocked: boolean }

    for (var i = 0; i < sections.length; i++) {
        var dev = sections[i];
        if (dev.enable !== '1') continue;

        var mac = (dev.mac || '').toUpperCase();
        if (!mac) continue;

        // Initialize device entry if not exists
        if (!deviceMap[mac]) {
            deviceMap[mac] = { blocked: false };
        }

        // If already blocked by another rule, skip calculation
        if (deviceMap[mac].blocked) continue;

        // Calculate block_period
        var blockPeriod = isInBlockPeriod(dev.timestart, dev.timeend, dev.week);

        // Calculate blocked_by_quota
        var blockedByQuota = false;
        if (dev.quota_enabled === '1' && quotaData && quotaData.devices) {
            var uid = dev.uid;
            var deviceQuota = quotaData.devices[uid];
            if (deviceQuota) {
                // Use backend-computed exhausted flag directly
                blockedByQuota = deviceQuota.exhausted === true;
            }
        }

        // should_block = block_period || blocked_by_quota
        if (blockPeriod || blockedByQuota) {
            deviceMap[mac].blocked = true;
        }
    }

    // Count unique devices
    var total = 0;
    var blocked = 0;
    for (var mac in deviceMap) {
        if (deviceMap.hasOwnProperty(mac)) {
            total++;
            if (deviceMap[mac].blocked) {
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
                '}'
            ].join('\n');
            document.head.appendChild(style);
        }

        m = new form.Map('timecontrol', _('Internet Time Control'),
            _('Users can limit their internet usage time through MAC and IP, with available IP ranges such as 192.168.110.00 to 192.168.10.200') + '<br/>' +
            _('Suggested feedback:') + ' <a href="https://github.com/sirpdboy/luci-app-timecontrol.git" target="_blank">GitHub @timecontrol</a>');

        s = m.section(form.TypedSection);
        s.anonymous = true;
        s.render = function() {
            var statusView = E('p', { id: 'service_status' },
                '<span class="spinning"> </span> ' + _('Checking service status...'));

            // Fetch process status and quota data simultaneously
            Promise.all([checkTimeControlProcess(), fetchQuotaStatus()])
                .then(function(results) {
                    var processInfo = results[0];
                    var quotaData = results[1];
                    var stats = getBlockedDeviceStats(quotaData);
                    var status = renderServiceStatus(processInfo.running, processInfo.pid, stats);
                    statusView.innerHTML = status;
                })
                .catch(function(err) {
                    statusView.innerHTML = '<span style="color:orange">⚠ ' +
                        _('Status check failed') + '</span>';
                    console.error('Status check error:', err);
                });

            poll.add(function() {
                return Promise.all([checkTimeControlProcess(), fetchQuotaStatus()])
                    .then(function(results) {
                        var processInfo = results[0];
                        var quotaData = results[1];
                        var stats = getBlockedDeviceStats(quotaData);
                        var status = renderServiceStatus(processInfo.running, processInfo.pid, stats);
                        statusView.innerHTML = status;
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
                    var cb = E('input', {
                        'type': 'checkbox',
                        'value': String(dayNum),
                        'checked': selectedDays.indexOf(String(dayNum)) >= 0
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
            if (initialQuotaData) {
                window.requestAnimationFrame(function() {
                    applyQuotaStatus(initialQuotaData);
                });
            }
            return mapEl;
        });
    }
});
