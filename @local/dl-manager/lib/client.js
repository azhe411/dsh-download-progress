/**
 * dl-manager — browser half.
 * 常驻下载管理器悬浮面板（右下角）：多任务进度条、历史记录、打开文件位置、拖动缩放。
 * 固化版 @local/dl-manager v2（2026-08-18）：数据源改用 fetch /api/dl-manager/*（host 端 webServer 注册）
 */
window.__ModuleLoader__.load({
	id: "@local/dl-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		let React = require("react");

		const inject = ["slots"];

		function apply(ctx) {
			const slots = ctx.slots;
			slots.inject("shell.overlay", () => slots.register(
				{ name: "shell.overlay", id: "dl-manager", order: 50 },
				() => {
					const [tasks, setTasks] = React.useState(null);
					const [err, setErr] = React.useState('');
					const [expanded, setExpanded] = React.useState(true);
					const [pos, setPos] = React.useState(null);
					const [size, setSize] = React.useState({ w: 340, h: null });
					const [drag, setDrag] = React.useState(null);
					const [resize, setResize] = React.useState(null);
					const nodeRef = React.useRef(null);

					React.useEffect(() => {
						const tick = () => {
							fetch('/api/dl-manager/tasks')
								.then((r) => r.json())
								.then((d) => { setTasks(d.tasks); setErr(''); })
								.catch((e) => setErr(String(e && e.message ? e.message : e)));
						};
						tick();
						const intervalId = setInterval(tick, 1000);
						return () => clearInterval(intervalId);
					}, []);

					const onHeaderMouseDown = (e) => {
						e.preventDefault();
						const node = nodeRef.current;
						if (!node) return;
						const rect = node.getBoundingClientRect();
						setDrag({ startX: e.clientX, startY: e.clientY, origX: rect.left, origY: rect.top });
					};
					const onMouseMove = (e) => {
						if (drag) setPos({ x: drag.origX + e.clientX - drag.startX, y: drag.origY + e.clientY - drag.startY });
						else if (resize) setSize({ w: Math.max(240, resize.origW + e.clientX - resize.startX), h: Math.max(120, resize.origH + e.clientY - resize.startY) });
					};
					const onMouseUp = () => { setDrag(null); setResize(null); };
					const onResizeMouseDown = (e) => {
						e.preventDefault(); e.stopPropagation();
						setResize({ startX: e.clientX, startY: e.clientY, origW: size.w, origH: size.h || 220 });
					};
					const openTask = (taskId) => {
						fetch('/api/dl-manager/open?taskId=' + encodeURIComponent(taskId))
							.then((r) => r.json())
							.then((d) => { if (d && d.error) setErr('打开失败: ' + d.error); })
							.catch((e) => setErr(String(e && e.message ? e.message : e)));
					};

					const collapsedH = 36;
					const panel = {
						position: 'fixed',
						left: pos ? pos.x : undefined, top: pos ? pos.y : undefined,
						right: pos ? undefined : 20, bottom: pos ? undefined : 100,
						width: size.w, height: expanded ? (size.h || undefined) : collapsedH,
						zIndex: 9999, background: '#1c1c1e', border: '1px solid #333',
						borderRadius: 10, boxShadow: '0 4px 20px rgba(0,0,0,.5)',
						fontFamily: 'system-ui', color: '#eee', overflow: 'hidden',
						display: 'flex', flexDirection: 'column',
						cursor: drag ? 'grabbing' : 'default', userSelect: 'none',
					};
					const header = {
						display: 'flex', justifyContent: 'space-between', alignItems: 'center',
						padding: '8px 12px', fontSize: 13, fontWeight: 600,
						background: '#232326', cursor: 'grab', borderBottom: '1px solid #333',
						height: 36, boxSizing: 'border-box',
					};
					const grip = { position: 'absolute', right: 2, bottom: 2, width: 16, height: 16, cursor: 'nwse-resize' };
					const activeCount = tasks ? tasks.filter((t) => t.status === 'downloading' || t.status === 'starting' || t.status === 'probing').length : 0;
					const doneCount = tasks ? tasks.filter((t) => t.status === 'done').length : 0;

					return React.createElement('div', { ref: nodeRef, style: panel, onMouseMove, onMouseUp },
						React.createElement('div', { style: header },
							React.createElement('span', { onMouseDown: onHeaderMouseDown, style: { flex: 1, cursor: 'grab', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
								'⬇ 下载 ' + (activeCount > 0 ? activeCount + ' 个进行中' : '待命'),
							),
							React.createElement('span', { style: { color: '#888', fontSize: 11, marginRight: 8 } }, doneCount > 0 ? doneCount + ' 已完成' : ''),
							React.createElement('span', {
								onClick: () => setExpanded(!expanded),
								style: { cursor: 'pointer', padding: '2px 6px', borderRadius: 4, background: '#333', fontSize: 12 },
							}, expanded ? '▾' : '▸'),
						),
						expanded ? React.createElement('div', { style: { maxHeight: 300, overflowY: 'auto', flex: 1 } },
							(!tasks || tasks.length === 0) ? React.createElement('div', { style: { padding: '16px 12px', fontSize: 12, color: '#888' } }, '暂无下载任务') :
								tasks.map((t) => React.createElement(TaskRow, { key: t.taskId || t.name, task: t, onOpen: openTask })),
						) : null,
						err ? React.createElement('div', { style: { fontSize: 11, color: '#e5484d', padding: '0 12px 8px' } }, 'err: ' + err) : null,
						expanded ? React.createElement('div', { style: grip, onMouseDown: onResizeMouseDown }) : null,
					);
				},
			));
			function TaskRow(props) {
				const t = props.task;
				const active = t.status === 'downloading' || t.status === 'starting' || t.status === 'probing';
				const pct = Math.min(100, Math.max(0, t.percent || 0));
				const speed = t.speedMBps ? t.speedMBps.toFixed(1) : '0';
				const doneMB = t.downloaded ? (t.downloaded / 1048576).toFixed(1) : '0';
				const totalMB = t.total ? (t.total / 1048576).toFixed(1) : '?';
				const eta = t.etaSec != null && t.etaSec > 0 ? Math.round(t.etaSec) + 's' : '';
				const timeStr = t.endedAt ? new Date(t.endedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
				const row = { padding: '8px 12px', borderBottom: '1px solid #2a2a2a' };
				const bar = { height: 5, borderRadius: 3, background: '#2a2a2a', overflow: 'hidden', width: '100%', marginTop: 4 };
				const fill = { height: '100%', width: pct + '%', background: t.status === 'done' ? '#46a758' : t.status === 'error' || t.status === 'cancelled' ? '#e5484d' : '#4c9aff' };
				const btn = { cursor: 'pointer', fontSize: 11, padding: '2px 6px', borderRadius: 4, background: '#333', color: '#ccc', marginLeft: 6 };
				const statusText = t.status === 'done' ? '✅ ' + timeStr : t.status === 'error' ? '❌ 失败' : t.status === 'cancelled' ? '⏹ 已取消' : pct + '%';
				const statusColor = t.status === 'done' ? '#46a758' : t.status === 'error' || t.status === 'cancelled' ? '#e5484d' : '#999';
				return React.createElement('div', { style: row },
					React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 } },
						React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } }, t.name || '未知'),
						React.createElement('span', { style: { color: statusColor, marginLeft: 8, fontSize: 11 } }, statusText),
						(t.status === 'done' || t.status === 'error' || t.status === 'cancelled') ? React.createElement('span', { style: btn, onClick: () => props.onOpen(t.taskId) }, '📁 打开') : null,
					),
					active ? React.createElement('div', { style: bar }, React.createElement('div', { style: fill })) : null,
					active ? React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#888', marginTop: 3 } },
						React.createElement('span', null, doneMB + ' / ' + totalMB + ' MB · ' + speed + ' MB/s'),
						React.createElement('span', null, eta ? '剩余 ' + eta : ''),
					) : null,
				);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
