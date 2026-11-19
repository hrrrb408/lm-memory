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

		function MemorySection() {
			const [state, setState] = react.useState({ status: "loading", address: null, items: [] });
			react.useEffect(() => {
				if (!((window.location.protocol === "dsh-app:" && window.location.hostname === "app") ||
					["127.0.0.1", "localhost", "[::1]"].includes(window.location.hostname))) {
					setState({ status: "remote", address: null, items: [] });
					return;
				}
				const controller = new AbortController();
				const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]);
				const update = (next) => { if (!controller.signal.aborted) setState(next); };
				let address = null;
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
