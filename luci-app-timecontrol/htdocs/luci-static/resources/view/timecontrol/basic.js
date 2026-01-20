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
                // 提取PID
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

// 渲染服务状态显示
function renderServiceStatus(isRunning, pid) {
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

// 配额状态轮询更新函数
function updateQuotaStatus() {
    return fs.exec('/usr/bin/timecontrol-quota', ['status-json']).then(function(res) {
        if (res.code !== 0) return;
        
        try {
            var data = JSON.parse(res.stdout);
            
            // 更新下次重置时间
            var nextResetEl = document.getElementById('next_reset_time');
            if (nextResetEl && data.next_reset) {
                nextResetEl.textContent = data.next_reset;
            }
            
            // 更新各设备剩余时长（用分钟显示）
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
        } catch (e) {
            console.error('Failed to parse quota status:', e);
        }
    }).catch(function(e) {
        console.error('Failed to get quota status:', e);
    });
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
            network.getDevices()
        ]);
    },

    render: function(data) {
        var m, s, o;
        var hostList = [];

        // 注入列宽样式
        // 列顺序: 1-Comment, 2-Enabled, 3-IP/MAC, 4-Start, 5-Stop, 6-Week, 7-Enable Quota, 8-Quota, 9-Remaining, 10-Actions
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
                tableSel + ' tr td:nth-child(2) { width: 50px; text-align: center; }',

                '#cbi-timecontrol-device tr.cbi-section-table-titles th:nth-child(3), ' +
                tableSel + ' tr td:nth-child(3) { width: 22%; }',

                '#cbi-timecontrol-device tr.cbi-section-table-titles th:nth-child(4), ' +
                tableSel + ' tr td:nth-child(4) { width: 70px; }',

                '#cbi-timecontrol-device tr.cbi-section-table-titles th:nth-child(5), ' +
                tableSel + ' tr td:nth-child(5) { width: 70px; }',

                '#cbi-timecontrol-device tr.cbi-section-table-titles th:nth-child(6), ' +
                tableSel + ' tr td:nth-child(6) { width: 200px; }',

                '#cbi-timecontrol-device tr.cbi-section-table-titles th:nth-child(7), ' +
                tableSel + ' tr td:nth-child(7) { width: 70px; text-align: center; }',

                '#cbi-timecontrol-device tr.cbi-section-table-titles th:nth-child(8), ' +
                tableSel + ' tr td:nth-child(8) { width: 70px; text-align: center; }',

                '#cbi-timecontrol-device tr.cbi-section-table-titles th:nth-child(9), ' +
                tableSel + ' tr td:nth-child(9) { width: 80px; }',

                '#cbi-timecontrol-device tr.cbi-section-table-titles th:nth-child(10), ' +
                tableSel + ' tr td:nth-child(10) { width: 100px; }'
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
            
            checkTimeControlProcess()
                .then(function(res) {
                    var status = renderServiceStatus(res.running, res.pid);
                    statusView.innerHTML = status;
                })
                .catch(function(err) {
                    statusView.innerHTML = '<span style="color:orange">⚠ ' + 
                        _('Status check failed') + '</span>';
                    console.error('Status check error:', err);
                });
            
            poll.add(function() {
                return checkTimeControlProcess()
                    .then(function(res) {
                        var status = renderServiceStatus(res.running, res.pid);
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

        // 控制模式（仅黑名单模式时隐藏）
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

        // 配额重置时间
        o = s.option(form.ListValue, 'quota_reset_hour', _('Quota Reset Hour'),
            _('Daily quota resets at this hour (0-23). Default is midnight.'));
        for (var h = 0; h < 24; h++) {
            o.value(String(h), String(h) + ':00');
        }
        o.default = '0';
        o.rmempty = true;

        // 下次重置时间（只读显示）
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
            
            // 检查是否为 range/CIDR/多值，提示配额不可用
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
                    
                    // 添加IP选项
                    o.value(host.ipv4, displayName);
                    
                    // 添加MAC选项
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

        o = s.option(form.ListValue, 'week', _('Week'));
        o.width = '200px';
        o.rmempty = false;

        // cfgvalue: handle '0', empty, undefined → expand to all days
        o.cfgvalue = function(section_id) {
            var v = uci.get('timecontrol', section_id, 'week');
            if (!v || v === '0') return '1,2,3,4,5,6,7';
            return v;
        };

        // formvalue: read from hidden input
        o.formvalue = function(section_id) {
            var node = document.getElementById(this.cbid(section_id));
            return node ? node.value : '';
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

        // Custom renderWidget: buttons + checkboxes
        o.renderWidget = function(section_id, option_index, cfgvalue) {
            var self = this;
            var dayLabels = ['一', '二', '三', '四', '五', '六', '日'];
            var selectedDays = (cfgvalue || '1,2,3,4,5,6,7').split(',').filter(Boolean);

            // Hidden input for actual value storage
            var hidden = E('input', {
                'type': 'hidden',
                'id': this.cbid(section_id),
                'name': this.cbid(section_id),
                'value': selectedDays.join(',')
            });

            // Checkbox container
            var checkboxes = E('div', { 'style': 'display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px;' });

            // Create 7 checkboxes
            for (var i = 1; i <= 7; i++) {
                (function(dayNum) {
                    var cb = E('input', {
                        'type': 'checkbox',
                        'value': String(dayNum),
                        'checked': selectedDays.indexOf(String(dayNum)) >= 0
                    });

                    var label = E('label', { 'style': 'display: inline-flex; align-items: center; margin-right: 2px;' }, [
                        cb,
                        E('span', { 'style': 'margin-left: 2px;' }, dayLabels[dayNum - 1])
                    ]);

                    checkboxes.appendChild(label);
                })(i);
            }

            // Helper function to update hidden value
            function updateHiddenValue() {
                var selected = [];
                Array.prototype.forEach.call(checkboxes.querySelectorAll('input[type="checkbox"]:checked'), function(cb) {
                    selected.push(cb.value);
                });
                hidden.value = selected.join(',');
                hidden.dispatchEvent(new Event('widget-change', { bubbles: true }));
            }

            // Bind checkbox change events
            Array.prototype.forEach.call(checkboxes.querySelectorAll('input[type="checkbox"]'), function(cb) {
                cb.addEventListener('change', updateHiddenValue);
            });

            // Helper function to set checkbox states
            function setDays(days) {
                Array.prototype.forEach.call(checkboxes.querySelectorAll('input[type="checkbox"]'), function(cb) {
                    cb.checked = days.indexOf(parseInt(cb.value)) >= 0;
                });
                updateHiddenValue();
            }

            // Helper function to get currently selected days
            function getSelectedDays() {
                var days = [];
                Array.prototype.forEach.call(checkboxes.querySelectorAll('input[type="checkbox"]:checked'), function(cb) {
                    days.push(parseInt(cb.value));
                });
                return days;
            }

            // Helper to check if arrays are equal
            function arraysEqual(a, b) {
                if (a.length !== b.length) return false;
                for (var i = 0; i < a.length; i++) {
                    if (a[i] !== b[i]) return false;
                }
                return true;
            }

            // Button container
            var buttons = E('div', { 'style': 'display: flex; gap: 4px; margin-bottom: 4px;' });

            // Everyday button
            var btnEveryday = E('button', {
                'type': 'button',
                'class': 'cbi-button cbi-button-action',
                'style': 'padding: 2px 6px; font-size: 12px;'
            }, _('Everyday'));
            btnEveryday.addEventListener('click', function(e) {
                e.preventDefault();
                var current = getSelectedDays().sort(function(a, b) { return a - b; });
                if (arraysEqual(current, [1, 2, 3, 4, 5, 6, 7])) {
                    setDays([]);
                } else {
                    setDays([1, 2, 3, 4, 5, 6, 7]);
                }
            });
            buttons.appendChild(btnEveryday);

            // Workday button
            var btnWorkday = E('button', {
                'type': 'button',
                'class': 'cbi-button cbi-button-action',
                'style': 'padding: 2px 6px; font-size: 12px;'
            }, _('Workday'));
            btnWorkday.addEventListener('click', function(e) {
                e.preventDefault();
                var current = getSelectedDays().sort(function(a, b) { return a - b; });
                if (arraysEqual(current, [1, 2, 3, 4, 5])) {
                    setDays([]);
                } else {
                    setDays([1, 2, 3, 4, 5]);
                }
            });
            buttons.appendChild(btnWorkday);

            // Rest Day button
            var btnRestday = E('button', {
                'type': 'button',
                'class': 'cbi-button cbi-button-action',
                'style': 'padding: 2px 6px; font-size: 12px;'
            }, _('Rest Day'));
            btnRestday.addEventListener('click', function(e) {
                e.preventDefault();
                var current = getSelectedDays().sort(function(a, b) { return a - b; });
                if (arraysEqual(current, [6, 7])) {
                    setDays([]);
                } else {
                    setDays([6, 7]);
                }
            });
            buttons.appendChild(btnRestday);

            return E('div', {}, [hidden, buttons, checkboxes]);
        };

        // 判断是否为单一 IP/MAC（可用配额功能）
        function isQuotaEligible(section_id) {
            var mac = uci.get('timecontrol', section_id, 'mac') || '';
            return mac.indexOf('/') < 0 && mac.indexOf('-') < 0 && mac.indexOf(',') < 0 && mac.indexOf(' ') < 0;
        }

        // 启用时长限制（在 week 之后）
        o = s.option(form.Flag, 'quota_enabled', _('Enable Quota'));
        o.width = '80px';
        o.rmempty = false;
        o.default = '0';
        // 不使用 depends（会导致列错位），改为在 renderWidget 中处理
        o.renderWidget = function(section_id, option_index, cfgvalue) {
            if (!isQuotaEligible(section_id)) {
                return E('em', { 'style': 'color: #999;' }, 'N/A');
            }
            return form.Flag.prototype.renderWidget.apply(this, [section_id, option_index, cfgvalue]);
        };
        // 不合规时强制写入 0，避免配置残留
        o.write = function(section_id, formvalue) {
            if (!isQuotaEligible(section_id)) {
                uci.set('timecontrol', section_id, 'quota_enabled', '0');
                return;
            }
            return form.Flag.prototype.write.apply(this, [section_id, formvalue]);
        };

        // 每日配额（分钟）
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

        // 当天剩余时长（只读，分钟显示）
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

        // 设备保存时自动生成 uid
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

        // 配额状态轮询（60秒）
        poll.add(updateQuotaStatus, 60);
        updateQuotaStatus();

        return m.render();
    }
});
