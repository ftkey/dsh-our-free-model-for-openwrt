'use strict';
'require view';
'require form';
'require uci';
'require rpc';
'require network';
'require ui';
'require poll';

var callStatus = rpc.declare({ object: 'ourfreemodel', method: 'status', expect: { '': {} }, reject: true });
var callService = rpc.declare({ object: 'ourfreemodel', method: 'service', params: ['action'], expect: { '': {} }, reject: true });
var callPassword = rpc.declare({ object: 'ourfreemodel', method: 'set_password', params: ['password', 'confirmation'], expect: { '': {} }, reject: true });
var callSecret = rpc.declare({ object: 'ourfreemodel', method: 'password', expect: { '': {} }, reject: true });
var callRandom = rpc.declare({ object: 'ourfreemodel', method: 'reset_password', expect: { '': {} }, reject: true });

function copyText(text) {
	if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
	return Promise.resolve().then(function() {
		var area = document.createElement('textarea');
		area.value = text;
		area.setAttribute('readonly', '');
		area.style.position = 'fixed';
		area.style.top = '-1000px';
		document.body.appendChild(area);
		area.select();
		var copied = false;
		try { copied = document.execCommand('copy'); } catch (e) {}
		document.body.removeChild(area);
		if (!copied) throw new Error(_('复制失败，请手动选中密码文本复制'));
	});
}

function addresses(net) {
	return [].concat(net.getIPAddrs ? net.getIPAddrs() : [], net.getIP6Addrs ? net.getIP6Addrs() : []).map(function(ip) { return ip.split('/')[0]; });
}

function endpointUrl(endpoint) {
	if (!endpoint || !endpoint.running || !endpoint.url) return '';
	try {
		var url = new URL(endpoint.url);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
		if (url.hostname === '0.0.0.0' || url.hostname === '[::]') url.hostname = window.location.hostname;
		return url.origin;
	} catch (e) { return ''; }
}

return view.extend({
	load: function() {
		var self = this;
		return Promise.all([
			uci.load('ourfreemodel'),
			network.getNetworks(),
			callStatus(),
			callSecret().catch(function() { return {}; })
		]).then(function(data) {
			self.secret = (data[3] && data[3].password) || '';
			return [data[0], data[1], data[2]];
		});
	},

	// LuCI 的 ui.createHandlerFn 把绑定参数放在前面、事件对象放在最后：fn(arg1, ..., ev)，
	// 且 LuCI 已代管点击期间的按钮禁用与 spinning 状态，这里不需要再处理按钮。
	serviceAction: function(action, ev) {
		return callService(action).then(function(result) {
			if (!result.ok) throw new Error(result.error || _('操作失败'));
			ui.addNotification(null, E('p', _('操作已提交，请等待服务状态更新。')), 'info');
		}).catch(function(error) {
			ui.addNotification(null, E('p', {}, error.message), 'error');
		});
	},

	resetPassword: function() {
		var password = E('input', { type: 'password', autocomplete: 'new-password', maxlength: 128, placeholder: _('至少 12 个字符') });
		var confirmation = E('input', { type: 'password', autocomplete: 'new-password', maxlength: 128, placeholder: _('再次输入新密码') });
		var submit = E('button', { 'class': 'btn cbi-button cbi-button-positive', click: function() {
			if (password.value.length < 12 || password.value.length > 128 || password.value !== confirmation.value) {
				ui.addNotification(null, E('p', _('密码应为 12–128 个字符，且两次输入必须一致。')), 'error');
				return;
			}
			submit.disabled = true;
			return callPassword(password.value, confirmation.value).then(function(result) {
				if (!result.ok) throw new Error(result.error || _('密码保存失败'));
				password.value = confirmation.value = '';
				ui.hideModal();
				ui.addNotification(null, E('p', result.message), 'info');
			}).catch(function(error) {
				ui.addNotification(null, E('p', error.message), 'error');
			}).finally(function() { submit.disabled = false; });
		} }, _('保存 WebUI 密码'));
		ui.showModal(_('设置 / 重置 WebUI 管理密码'), [
			E('p', _('此密码仅用于自带 WebUI。模型 API 仍使用原有 API Key，无需此密码。重置会注销所有 WebUI 会话，不会更换 API Key 或中断模型 API。')),
			E('p', {}, [E('label', {}, [_('新密码'), E('br'), password])]),
			E('p', {}, [E('label', {}, [_('确认密码'), E('br'), confirmation])]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', click: function() { password.value = confirmation.value = ''; ui.hideModal(); } }, _('取消')),
				' ', submit
			])
		]);
	},

	refreshStatus: function() {
		var self = this;
		if (!this.statusNode) return Promise.resolve();
		return callStatus().then(function(next) {
			self.drawStatus(self.statusNode, next);
			if (self.actionsNode) self.drawActions(self.actionsNode, next);
		});
	},

	// 启动与停止互斥、开机自启与取消自启互斥：只显示当前可执行的那一组。
	drawActions: function(node, status) {
		var self = this;
		var actions = status.running
			? [['stop', _('停止')], ['restart', _('重启')]]
			: [['start', _('启动'), 'cbi-button-positive']];
		actions.push(status.autostart ? ['disable', _('取消开机自启')] : ['enable', _('开机自启')]);
		var buttons = actions.map(function(item) {
			return E('button', { 'class': 'btn cbi-button' + (item[2] ? ' ' + item[2] : ''), click: ui.createHandlerFn(self, 'serviceAction', item[0]) }, item[1]);
		});
		buttons.push(E('button', { 'class': 'btn cbi-button cbi-button-action', click: ui.createHandlerFn(this, 'resetRandomPassword') }, _('重置密码')));
		buttons.push(E('button', { 'class': 'btn cbi-button', click: ui.createHandlerFn(this, 'resetPassword') }, _('设置密码')));
		L.dom.content(node, buttons);
	},

	copyPassword: function() {
		if (!this.secret) return Promise.reject(new Error(_('没有可复制的密码，请先重置为随机密码')));
		return copyText(this.secret).then(function() {
			ui.addNotification(null, E('p', {}, _('WebUI 密码已复制到剪贴板。')), 'info');
		}).catch(function(error) {
			ui.addNotification(null, E('p', {}, error.message), 'error');
		});
	},

	resetRandomPassword: function(ev) {
		var submit = E('button', { 'class': 'btn cbi-button cbi-button-negative' }, _('生成并应用'));
		var self = this;
		submit.addEventListener('click', function() {
			submit.disabled = true;
			return callRandom().then(function(result) {
				if (!result.ok) throw new Error(result.error || _('生成失败'));
				self.secret = result.password || '';
				ui.hideModal();
				void self.refreshStatus();
				ui.addNotification(null, E('p', {}, [_('已生成新的随机 WebUI 密码：'), E('code', {}, self.secret)]), 'info');
			}).catch(function(error) {
				ui.addNotification(null, E('p', {}, error.message), 'error');
			}).finally(function() { submit.disabled = false; });
		});
		ui.showModal(_('重置为随机密码'), [
			E('p', {}, _('将立即生成一个 16 位随机密码，可在状态表中查看并复制。重置会注销所有 WebUI 会话，不会更换 API Key 或中断模型 API。')),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', click: function() { ui.hideModal(); } }, _('取消')),
				' ', submit
			])
		]);
	},

	drawStatus: function(node, status) {
		var api = endpointUrl(status.api), web = endpointUrl(status.web), self = this;
		var passwordCell;
		self.lastStatus = status;
		if (!status.passwordSet) passwordCell = _('尚未设置，首次启动会自动生成随机密码');
		else if (this.secret) passwordCell = E('span', {}, [
			E('code', {}, self.showSecret ? self.secret : self.secret.replace(/./g, '•')), ' ',
			E('button', { 'class': 'btn cbi-button cbi-button-small', click: function() {
				self.showSecret = !self.showSecret;
				self.drawStatus(node, self.lastStatus);
			} }, self.showSecret ? _('隐藏') : _('显示')), ' ',
			E('button', { 'class': 'btn cbi-button cbi-button-small', click: function() { self.copyPassword(); } }, _('复制'))
		]);
		else passwordCell = _('已设置（未保存明文；点下方“重置为随机密码”可生成可复制的密码）');
		var row = function(label, value) { return E('tr', {}, [E('td', { style: 'width:35%' }, label), E('td', {}, value || '—')]); };
		var errors = [status.error, status.api && status.api.error, status.web && status.web.error].filter(Boolean);
		var rows = [
			row(_('服务状态'), status.running ? _('运行中') : _('已停止')),
			row(_('开机自启'), status.autostart ? _('已启用') : _('未启用')),
			row(_('版本 / Node.js'), (status.version || '—') + ' / ' + (status.nodeVersion || '—')),
			row(_('WebUI 管理密码'), passwordCell),
			row(_('WebUI 地址'), web ? E('a', { href: web, target: '_blank', rel: 'noopener noreferrer' }, _('打开自带 WebUI') + ' · ' + web) : _('未启动')),
			row(_('模型 API Base URL'), api ? E('code', {}, api + '/v1') : _('未启动')),
			row(_('API 鉴权'), _('Bearer API Key（与 WebUI 密码独立）')),
			row(_('数据目录'), status.dataDir)
		];
		if (errors.length) rows.push(row(_('运行提示'), E('span', { style: 'color:#b45309' }, errors.join('；'))));
		L.dom.content(node, E('table', { 'class': 'table', style: 'table-layout:fixed;width:100%;word-break:break-word' }, rows));
	},

	render: function(data) {
		// 操作按钮交给 rpcd ACL 在调用时鉴权：只读账号会收到 ubus 权限错误提示，不在这里预先禁用。
		var self = this, networks = data[1], status = data[2];
		// 页面标题与说明放在页面顶部，表单本身不再渲染标题，避免标题与说明分离。
		var m = new form.Map('ourfreemodel');
		var s = m.section(form.NamedSection, 'main', 'ourfreemodel', _('基本设置'));
		s.addremove = false;
		s.tab('general', _('服务'));
		s.tab('api', _('模型 API'));
		s.tab('web', _('WebUI'));
		var o = s.taboption('general', form.Flag, 'enabled', _('启用服务'));
		o.default = '1'; o.rmempty = false;
		o = s.taboption('general', form.Value, 'data_dir', _('数据目录'), _('建议使用持久挂载盘。更换目录不会自动迁移已有账号、密钥和用量记录。'));
		o.default = '/etc/ourfreemodel'; o.rmempty = false; o.datatype = 'directory';

		['api', 'web'].forEach(function(kind) {
			var label = kind === 'api' ? 'API' : 'WebUI';
			var other = kind === 'api' ? 'web' : 'api';
			var port = s.taboption(kind, form.Value, kind + '_port', label + _(' 端口'));
			port.default = kind === 'api' ? '18900' : '18901'; port.rmempty = false; port.datatype = 'port';
			port.validate = function(section, value) {
				if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) return _('端口必须为 1–65535');
				var counterpart = m.lookupOption(other + '_port', section)[0];
				var otherValue = counterpart.formvalue(section) || counterpart.cfgvalue(section) || counterpart.default;
				return Number(value) !== Number(otherValue) || _('API 和 WebUI 需要不同端口');
			};
			var iface = s.taboption(kind, form.ListValue, kind + '_interface', label + _(' 绑定接口'),
				_('按所选逻辑接口的本地 IP 监听。接口下线时停止该入口，不会回退到所有接口。'));
			iface.default = 'lan'; iface.rmempty = false;
			networks.forEach(function(net) { iface.value(net.getName(), net.getName() + ' · ' + (addresses(net).join(', ') || _('暂无地址'))); });
			iface.value('*', _('所有本地接口（0.0.0.0，需自行配置防火墙）'));
			var address = s.taboption(kind, form.Value, kind + '_address', label + _(' 指定本地 IP'),
				_('可选；留空自动选取该接口首个 IPv4 地址，没有 IPv4 时使用 IPv6。指定地址必须属于所选接口。'));
			address.datatype = 'ipaddr'; address.placeholder = _('自动选择接口地址'); address.rmempty = true;
			networks.forEach(function(net) { addresses(net).forEach(function(ip) { address.value(ip, ip + ' (' + net.getName() + ')'); }); });
			address.validate = function(section, value) {
				if (!value) return true;
				var selected = iface.formvalue(section) || iface.cfgvalue(section) || iface.default;
				var candidates = networks.filter(function(net) { return selected === '*' || net.getName() === selected; });
				return candidates.some(function(net) { return addresses(net).indexOf(value) !== -1; }) || _('此 IP 不属于所选接口的当前本地地址');
			};
		});
		o = s.taboption('web', form.Value, 'web_public_origin', _('WebUI HTTPS 外部来源（可选）'),
			_('使用 HTTPS 反向代理时填写 https://域名，不含路径。直连路由器时留空。'));
		o.placeholder = 'https://ourfreemodel.example.com';
		o.validate = function(section, value) {
			if (!value) return true;
			try { var url = new URL(value); return url.protocol === 'https:' && url.origin === value || _('请填写不含路径的 HTTPS 来源'); }
			catch (e) { return _('请填写有效 HTTPS 来源'); }
		};
		var statusNode = E('div');
		this.statusNode = statusNode;
		this.drawStatus(statusNode, status);
		// 不用 cbi-page-actions：它是底部吸底样式（负外边距 + sticky），窄屏会溢出并压住下方文字。
		var actionsNode = E('div', { 'class': 'ourfreemodel-actions', style: 'display:flex;flex-wrap:wrap;gap:.5em;align-items:center;padding:.25em 1em 1em' });
		this.actionsNode = actionsNode;
		this.drawActions(actionsNode, status);
		poll.add(function() { return self.refreshStatus(); }, 5);
		return m.render().then(function(map) {
			return E('div', {}, [
				E('div', { 'class': 'cbi-map' }, [
					E('h2', { 'name': 'content' }, 'OurFreeModel'),
					E('div', { 'class': 'cbi-map-descr' },
						_('自带 WebUI 使用独立管理密码；模型 API 使用 API Key。两个端口和监听接口分别配置，修改后点击保存并应用。'))
				]),
				E('div', { 'class': 'cbi-section' }, [statusNode]),
				E('div', { 'class': 'cbi-section' }, [E('h2', {}, _('操作')), actionsNode]),
				map
			]);
		});
	}
});
