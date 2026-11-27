window.__ModuleLoader__.load({
	id: "dsh-oneclick-restart",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var React = require("react");
		var react_jsx_runtime = require("react/jsx-runtime");
		var jsx = react_jsx_runtime.jsx;
		var jsxs = react_jsx_runtime.jsxs;

		var PLUGIN = "dsh-oneclick-restart";
		var ROUTE_STATUS = "/oneclick-restart/status";
		var ROUTE_TOKEN = "/oneclick-restart/token";
		var ROUTE_RESTART = "/oneclick-restart/restart";

		var TOKEN_HEADER = "x-oneclick-restart-token";
		// 客户端构建标记：改完这里就必须变，用户看头部就知道浏览器加载的是不是新代码。
		var UI_REV = "ui-2026-11-19a";

		var colorLabel = "var(--dsw-alias-label-primary)";
		var colorMuted = "var(--dsw-alias-label-tertiary)";
		var colorBorder = "var(--dsw-alias-border-l2, rgba(128,128,128,0.25))";
		var colorDanger = "var(--dsw-alias-state-error-primary, #e5484d)";
		var colorOk = "var(--dsw-alias-state-success-primary, #30a46c)";
		var colorSurface = "var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-base, transparent))";

		function cardStyle() {
			return {
				border: "1px solid " + colorBorder,
				borderRadius: "10px",
				padding: "14px 16px",
				display: "flex",
				flexDirection: "column",
				gap: "10px",
				background: colorSurface
			};
		}
		function headingStyle() {
			return { fontSize: "13px", lineHeight: "20px", fontWeight: 600, color: colorLabel };
		}
		function textStyle(color) {
			return { fontSize: "12px", lineHeight: "18px", color: color || colorMuted };
		}
		function buttonStyle(kind) {
			var danger = kind === "danger";
			return {
				padding: "5px 12px",
				fontSize: "12px",
				lineHeight: "16px",
				borderRadius: "6px",
				cursor: "pointer",
				border: "1px solid " + (danger ? colorDanger : colorBorder),
				background: danger ? colorDanger : "transparent",
				color: danger ? "#fff" : colorLabel
			};
		}
		function monoStyle() {
			return {
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
				fontSize: "11px",
				lineHeight: "17px",
				color: colorMuted,
				wordBreak: "break-all"
			};
		}

		function readStatus() {
			return fetch(ROUTE_STATUS, { cache: "no-store" }).then(function (res) {
				if (!res.ok) {
					return { ok: false, code: "http-" + res.status, message: "状态接口返回 " + res.status };
				}
				return res.json();
			});
		}

		function restart(payload, token) {
			return fetch(ROUTE_RESTART, {
				method: "POST",
				cache: "no-store",
				headers: { "content-type": "application/json", "x-oneclick-restart-token": token },
				body: JSON.stringify(payload)
			}).then(function (res) {
				return res.json().then(function (json) {
					json._status = res.status;
					return json;
				});
			});
		}

		function OneClickRestartCard() {
			var stateHook = React.useState({ phase: "loading", data: null, error: null, message: null, ack: false, accepted: null, sent: null, done: null, restarted: false });
			var state = stateHook[0];
			var setState = stateHook[1];
			var aliveRef = React.useRef(true);

			function patch(next) {
				if (!aliveRef.current) return;
				setState(function (prev) {
					var merged = {};
					for (var key in prev) merged[key] = prev[key];
					for (var key2 in next) merged[key2] = next[key2];
					return merged;
				});
			}

			// 只更新数据，绝不回写 phase：原先这里用闭包里的旧 state.phase 覆盖，
			// 点「重启」后 refresh 一返回就把 confirm 打回 idle，确认面板一闪而过。
			function refresh() {
				return readStatus().then(function (json) {
					patch({ data: json, error: json && json.ok === false ? (json.message || json.code) : null });
					return json;
				}).catch(function (error) {
					patch({ error: String((error && error.message) || error), phase: "error" });
					return null;
				});
			}

			React.useEffect(function () {
				aliveRef.current = true;
				refresh().then(function (json) { if (json) patch({ phase: "idle" }); });
				return function () { aliveRef.current = false; };
			}, []);

			// 轮询：等待重启期间 1.2s 一次，其余 5s 一次。用 bootId 变化判断进程真的换了。
			React.useEffect(function () {
				var waiting = state.phase === "waiting";
				var period = waiting ? 1200 : 5000;
				var timer = setInterval(function () {
					readStatus().then(function (json) {
						if (!aliveRef.current) return;
						var wasBoot = state.accepted ? state.accepted.bootId : null;
						var nowBoot = json ? json.bootId : null;
						var restarted = !!(wasBoot && nowBoot && wasBoot !== nowBoot);
						var next = { data: json, restarted: restarted };
						if (restarted) { next.phase = "done"; next.done = Date.now(); }
						patch(next);
					}).catch(function () { /* 进程正在退出时连接会失败，保持等待态 */ });
				}, period);
				return function () { clearInterval(timer); };
			}, [state.phase, state.accepted]);

			var data = state.data;
			var running = data && Array.isArray(data.running) ? data.running : [];
			var pluginOk = !!(data && data.plugin === PLUGIN);
			var target = data && data.target ? data.target : null;
			var busy = state.phase === "sending";

			function onArm() {
				patch({ phase: "confirm", message: null, ack: false });
				refresh();
			}
			function onCancel() {
				patch({ phase: "idle", message: null, ack: false });
			}
			function onAck(event) {
				patch({ ack: !!event.target.checked });
			}

			function onSubmit() {
				if (busy) return;
				if (running.length > 0 && !state.ack) {
					patch({ message: "先勾选：我已知晓重启会中断这些对话" });
					return;
				}
				patch({ phase: "sending", message: "正在下发重启…" });
				fetch(ROUTE_TOKEN, { cache: "no-store" }).then(function (res) {
					return res.json();
				}).then(function (tokenJson) {
					var token = tokenJson && tokenJson.token;
					if (!token) throw new Error("取不到 CSRF token");
					return restart({
						confirm: "RESTART",
						acknowledgeRunning: running.length > 0 ? true : false,
						expectRunningIds: running
					}, token);
				}).then(function (json) {
					if (json && json.ok) {
						patch({
							phase: "waiting",
							accepted: json.accepted || null,
							sent: Date.now(),
							message: "已下发，进程正在退出并重启"
						});
						return;
					}
					if (json && json.code === "stale") {
						patch({ phase: "confirm", message: "运行中的对话有变化（出现了未确认的新对话），已刷新，请重新确认", ack: false });
						refresh();
						return;
					}
					if (json && json.code === "csrf") {
						patch({ phase: "confirm", message: "token 失效，请重新点一次确认" });
						return;
					}
					patch({ phase: "confirm", message: "重启被拒绝（HTTP " + String(json && json._status) + "）：" + ((json && (json.message || json.code)) || "未知原因") });
				}).catch(function (error) {
					// 请求可能在进程退出瞬间被断开，也可能根本没送到服务端。
					// 先核对服务端有没有真的记下一次 accepted，再决定进等待态还是报错。
					var text = String((error && error.message) || error);
					readStatus().then(function (json) {
						if (json && json.accepted) {
							patch({ phase: "waiting", accepted: json.accepted, sent: Date.now(), message: "连接已断开，等待新进程上线" });
							return;
						}
						patch({ phase: "confirm", message: "请求没送达：" + text });
					}).catch(function () {
						patch({ phase: "confirm", message: "请求没送达：" + text });
					});
				});
			}

			var children = [];
			children.push(jsxs("div", {
				style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" },
				children: [
					jsx("div", { style: headingStyle(), children: "一键重启" }),
					data && data.version
						? jsx("span", { style: textStyle(), children: "v" + data.version + " · " + UI_REV })
						: null
				]
			}));

			if (!data && state.phase === "loading") {
				children.push(jsx("div", { style: textStyle(), children: "读取状态…" }));
			}

			if (state.error) {
				children.push(jsxs("div", {
					style: { fontSize: "12px", lineHeight: "18px", color: colorDanger },
					children: [
						"状态接口不可用：",
						state.error,
						jsx("div", {
							style: textStyle(),
							children: "插件未加载或路由被占用时，这个卡片什么都不会做。"
						})
					]
				}));
			}

			if (data && !pluginOk) {
				children.push(jsx("div", {
					style: { fontSize: "12px", lineHeight: "18px", color: colorDanger },
					children: "路由冲突：/oneclick-restart/status 被其他插件占用（返回的 plugin 标识不匹配），本插件已自锁，不会执行重启。"
				}));
			}

			if (data && pluginOk && target) {
				children.push(jsxs("div", {
					style: { display: "flex", flexDirection: "column", gap: "2px" },
					children: [
						jsx("div", {
							style: textStyle(running.length > 0 ? colorDanger : colorMuted),
							children: running.length > 0
								? "检测到 " + running.length + " 个正在运行的对话：重启会中断它们"
								: "当前没有正在运行的对话"
						}),
						jsx("div", {
							style: monoStyle(),
							children: (target.mode === "desktop" ? "桌面主进程" : "Host 进程") + " pid " + target.pid + " · " + target.exe
						})
					]
				}));
			}

			if (data && pluginOk && (state.phase === "confirm" || state.phase === "sending")) {
				children.push(jsxs("div", {
					style: {
						border: "1px solid " + colorBorder,
						borderRadius: "8px",
						padding: "10px 12px",
						display: "flex",
						flexDirection: "column",
						gap: "8px"
					},
					children: [
						jsx("div", {
							style: { fontSize: "12px", lineHeight: "18px", color: colorLabel },
							children: "确认重启？窗口会关闭并在两秒内自动重新打开，未保存的输入与进行中的回合会丢失。"
						}),
						running.length > 0
							? jsxs("label", {
								style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", lineHeight: "18px", color: colorDanger, cursor: "pointer" },
								children: [
									jsx("input", { type: "checkbox", checked: !!state.ack, onChange: onAck }),
									jsx("span", { children: "我已知晓：会中断 " + running.length + " 个运行中的对话" })
								]
							})
							: null,
						jsxs("div", {
							style: { display: "flex", gap: "8px" },
							children: [
								jsx("button", {
									type: "button",
									style: buttonStyle("danger"),
									disabled: busy,
									onClick: onSubmit,
									children: busy ? "下发中…" : "确认重启"
								}),
								jsx("button", {
									type: "button",
									style: buttonStyle("plain"),
									disabled: busy,
									onClick: onCancel,
									children: "取消"
								})
							]
						})
					]
				}));
			}

			if (pluginOk && (state.phase === "idle" || state.phase === "error")) {
				children.push(jsxs("div", {
					style: { display: "flex", alignItems: "center", gap: "8px" },
					children: [
						jsx("button", {
							type: "button",
							style: buttonStyle("plain"),
							onClick: onArm,
							children: running.length > 0 ? "重启 DSH（有 " + running.length + " 个对话在跑）" : "重启 DSH"
						}),
						jsx("button", {
							type: "button",
							style: buttonStyle("plain"),
							onClick: function () { refresh(); },
							children: "刷新状态"
						})
					]
				}));
			}

			if (state.phase === "waiting") {
				children.push(jsx("div", {
					style: { fontSize: "12px", lineHeight: "18px", color: colorLabel },
					children: "已下发重启，等待新进程上线…（页面会自己断线，重启完成后本卡片会显示成功）"
				}));
			}

			if (state.phase === "done" || (state.restarted && state.accepted)) {
				children.push(jsx("div", {
					style: { fontSize: "12px", lineHeight: "18px", color: colorOk },
					children: "重启完成：检测到新的进程实例（bootId 已变化）。"
				}));
			}

			if (state.message) {
				children.push(jsx("div", {
					style: textStyle(),
					children: state.message
				}));
			}

			if (data && Array.isArray(data.logTail) && data.logTail.length > 0) {
				children.push(jsxs("details", {
					style: { display: "flex", flexDirection: "column", gap: "4px" },
					children: [
						jsx("summary", { style: { ...textStyle(), cursor: "pointer" }, children: "重启器日志" }),
						jsx("div", {
							style: monoStyle(),
							children: data.logTail.join("\n")
						})
					]
				}));
			}

			return jsx("div", { style: cardStyle(), children: children });
		}

		var inject = ["slots"];
		function apply(ctx) {
			ctx.slots.inject("settings.section", function () {
				return ctx.slots.register({
					name: "settings.section",
					id: "oneclick-restart",
					order: 260,
					label: "重启"
				}, function () { return jsx(OneClickRestartCard, {}); });
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.PLUGIN = PLUGIN;
		return module.exports;
	}
});
