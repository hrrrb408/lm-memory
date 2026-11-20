window.__ModuleLoader__.load({
	id: "dsh-lm-memory",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const createElement = react.createElement;

		const inject = ["slots"];

		async function readJSON(url, signal) {
			const response = await fetch(url, { signal, redirect: "error", cache: "no-store" });
			if (!response.ok) throw new Error("HTTP " + response.status);
			return response.json();
		}

		async function postJSON(url, body, signal) {
			const response = await fetch(url, {
				method: "POST", signal, redirect: "error", cache: "no-store",
				headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(data?.error ?? "HTTP " + response.status);
			return data;
		}

		const SWITCHES = [
			{ key: "projectMemory", label: "项目记忆", hint: "按 Git 仓库隔离；开启后不再启用旧 MCP、旧采集与完整管理页" },
			{ key: "confirmedOutcomes", label: "确认结论入库", hint: "允许用「确认结论：/确认修复：」把上一轮助手原句存为项目事实或经验（需项目记忆）" },
			{ key: "allowRemote", label: "允许外发提炼", hint: "关闭时完全不出网；开启后才会把复盘交给模型提炼" },
		];

		function Switch(props) {
			return createElement("label", {
				style: { display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 0", cursor: "pointer" },
			},
				createElement("input", {
					type: "checkbox", checked: props.checked, disabled: props.disabled,
					onChange: (event) => props.onChange(event.target.checked),
					style: { marginTop: 3 },
				}),
				createElement("span", null,
					createElement("span", { style: { fontWeight: 500, fontSize: 13 } }, props.label),
					createElement("span", { style: { display: "block", fontSize: 12, color: "#777", lineHeight: 1.6 } }, props.hint))
			);
		}

		function MemorySection() {
			const [state, setState] = react.useState({ status: "loading", address: null, items: [] });
			const [form, setForm] = react.useState(null);
			const [notice, setNotice] = react.useState(null);
			const local = () => (window.location.protocol === "dsh-app:" && window.location.hostname === "app") ||
				["127.0.0.1", "localhost", "[::1]"].includes(window.location.hostname);
			react.useEffect(() => {
				if (!local()) {
					setState({ status: "remote", address: null, items: [] });
					return;
				}
				const controller = new AbortController();
				const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]);
				const update = (next) => { if (!controller.signal.aborted) setState(next); };
				let address = null;
				readJSON("./api/lm-memory-settings", signal).then((data) => {
					if (controller.signal.aborted) return;
					setForm({
						projectMemory: data?.settings?.projectMemory === true,
						confirmedOutcomes: data?.settings?.confirmedOutcomes === true,
						allowRemote: data?.settings?.allowRemote === true,
						taskRecallEnabled: data?.settings?.taskRecall?.enabled === true,
						sessionIds: (data?.settings?.taskRecall?.sessionIds ?? []).join(","),
					});
					if (data?.restartRequired) setNotice({ kind: "warn", text: "设置已保存，重启 DSH 后生效。" });
					else if (data?.error) setNotice({ kind: "warn", text: data.error });
				}).catch(() => { if (!controller.signal.aborted) setNotice({ kind: "warn", text: "无法读取功能开关" }); });
				readJSON("./api/lm-memory-viewer", signal).then(async ({ port, status }) => {
					if (status === "disabled" && port === null) { update({ status, address, items: [] }); return; }
					if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid viewer port");
					const configuredAddress = "http://127.0.0.1:" + port;
					if (status === "offline" || status === "stale") { update({ status, address, configuredAddress, items: [] }); return; }
					if (status !== "ready") throw new Error("invalid viewer status");
					address = configuredAddress;
					const data = await readJSON(address + "/api/memories", signal);
					if (!Array.isArray(data?.items) || !Number.isFinite(data?.total)) throw new Error("invalid viewer response");
					update({ status: "ok", address, total: data.total, items: data.items.slice(0, 6) });
				}).catch(() => update({ status: address ? "offline" : "unavailable", address, items: [] }));
				return () => controller.abort();
			}, []);
			const statusLabel = {
				loading: "读取中…",
				ok: "运行中 · " + state.total + " 条有效记忆",
				offline: "无法连接已配置的管理页：" + (state.configuredAddress ?? state.address),
				stale: "管理页配置或版本不匹配，请停止旧管理页后重启 DSH：" + state.configuredAddress,
				disabled: "管理页未启用",
				unavailable: "当前宿主未提供管理页地址",
				remote: "管理页仅限运行 DSH 的本机访问",
			};
			const kindLabel = { preference: "偏好", fact: "事实", procedure: "经验", todo: "待办", episode: "会话" };
			const update = (patch) => setForm({ ...form, ...patch });
			const save = async () => {
				const ids = String(form.sessionIds ?? "").split(/[\s,]+/).filter(Boolean);
				setNotice({ kind: "info", text: "保存中…" });
				try {
					const data = await postJSON("./api/lm-memory-settings", {
						projectMemory: form.projectMemory,
						confirmedOutcomes: form.confirmedOutcomes,
						allowRemote: form.allowRemote,
						taskRecall: { enabled: form.taskRecallEnabled, sessionIds: ids },
					});
					setNotice({ kind: "ok", text: data?.restartRequired === false ? "已保存（无需重启）。" : "已保存，重启 DSH 后生效。" });
				} catch (error) { setNotice({ kind: "warn", text: "保存失败：" + (error?.message ?? "未知错误") }); }
			};
			return createElement("div", { style: { display: "flex", flexDirection: "column", gap: 16, padding: "0 24px 24px" } },
				createElement("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
					createElement("div", { style: { fontWeight: 600, fontSize: 14 } }, "记忆库"),
					createElement("span", { style: { fontSize: 12, color: state.status === "ok" ? "#2e7d32" : "inherit" } }, statusLabel[state.status])),
				createElement("div", { style: { fontSize: 13, color: "#666", lineHeight: 1.7 } },
					"跨会话长期记忆：偏好 / 事实 / 经验 / 待办 / 会话索引，带版本化与审计。新会话自动注入基线，agent 可随时检索。"),
				state.address ? createElement("div", null,
					createElement("a", {
						style: { cursor: "pointer", fontSize: 13, padding: "6px 16px", borderRadius: 8, border: "1px solid rgba(128,128,128,.4)", background: "transparent", color: "inherit" },
						href: state.address, target: "_blank", rel: "noopener noreferrer",
					}, "打开完整管理页（搜索 · 修正 · 删除 · 用户画像）")) : null,
				form ? createElement("div", { style: { borderTop: "1px solid rgba(128,128,128,.25)", paddingTop: 12 } },
					createElement("div", { style: { fontWeight: 600, fontSize: 13, marginBottom: 4 } }, "功能开关"),
					createElement("div", { style: { fontSize: 12, color: "#777", marginBottom: 6 } }, "默认全部关闭，行为与旧版本一致。改动写入 memoryDir/settings.json，重启 DSH 后生效。"),
					SWITCHES.map((item) => createElement(Switch, {
						key: item.key, label: item.label, hint: item.hint,
						checked: form[item.key] === true, disabled: false,
						onChange: (value) => update({ [item.key]: value }),
					})),
					createElement("div", { style: { padding: "8px 0" } },
						createElement("label", { style: { display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" } },
							createElement("input", {
								type: "checkbox", checked: form.taskRecallEnabled,
								onChange: (event) => update({ taskRecallEnabled: event.target.checked }),
								style: { marginTop: 3 },
							}),
							createElement("span", null,
								createElement("span", { style: { fontWeight: 500, fontSize: 13 } }, "任务候选提示（实验）"),
								createElement("span", { style: { display: "block", fontSize: 12, color: "#777", lineHeight: 1.6 } },
									"回溯型任务出现唯一字面锚点时，追加一个候选编号。改述、同义提问基本不命中，收益未验证。"))),
						createElement("input", {
							type: "text", value: form.sessionIds,
							placeholder: "授权会话 ID，逗号分隔（留空即不生效）",
							onChange: (event) => update({ sessionIds: event.target.value }),
							style: { marginTop: 6, width: "100%", fontSize: 12, padding: "6px 8px", borderRadius: 6, border: "1px solid rgba(128,128,128,.4)", background: "transparent", color: "inherit" },
						})),
					createElement("div", { style: { display: "flex", gap: 10, alignItems: "center", marginTop: 4 } },
						createElement("button", {
							onClick: save,
							style: { cursor: "pointer", fontSize: 13, padding: "6px 16px", borderRadius: 8, border: "1px solid rgba(128,128,128,.4)", background: "transparent", color: "inherit" },
						}, "保存设置"),
						notice ? createElement("span", {
							style: { fontSize: 12, color: notice.kind === "warn" ? "#b26a00" : notice.kind === "ok" ? "#2e7d32" : "#666" },
						}, notice.text) : null)) : null,
				state.items.length ? createElement("div", { style: { fontSize: 12.5, color: "#666" } },
					"最近记忆：",
					createElement("div", { style: { marginTop: 6, display: "flex", flexDirection: "column", gap: 4 } },
						state.items.map((m) => createElement("div", { key: m.id },
							"[" + (kindLabel[m.kind] ?? m.kind) + "] " + String(m.content).slice(0, 60))))) : null
			);
		}

		function apply(ctx) {
			const register = () => ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "lm-memory",
				order: 45,
				label: "记忆库",
			}, MemorySection));
			if (ctx.effect) ctx.effect(register);
			else register();
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
