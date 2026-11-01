window.__ModuleLoader__.load({
	id: "dsh-lm-capture",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const createElement = react.createElement;

		const inject = ["slots"];

		const VIEWER = "http://127.0.0.1:7640";

		function MemorySection() {
			const [state, setState] = react.useState({ loaded: false, ok: false, total: 0, counts: {}, items: [] });
			react.useEffect(() => {
				let alive = true;
				fetch(VIEWER + "/api/memories")
					.then((r) => r.json())
					.then((d) => { if (alive) setState({ loaded: true, ok: true, total: d.total, counts: d.counts, items: d.items.slice(0, 6) }); })
					.catch(() => { if (alive) setState({ loaded: true, ok: false, total: 0, counts: {}, items: [] }); });
				return () => { alive = false; };
			}, []);
			const kindLabel = { preference: "偏好", fact: "事实", procedure: "经验", todo: "待办", episode: "会话" };
			return createElement("div", { style: { display: "flex", flexDirection: "column", gap: 16, padding: "0 24px 24px" } },
				createElement("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
					createElement("div", { style: { fontWeight: 600, fontSize: 14 } }, "记忆库"),
					createElement("span", { style: { fontSize: 12, color: state.ok ? "#2e7d32" : "#c62828" } },
						state.loaded ? (state.ok ? "运行中 · " + state.total + " 条有效记忆" : "viewer 未运行（DSH 启动时会自动拉起，或手动：node ~/.dsh/memory/server/viewer.mjs）") : "读取中…")),
				createElement("div", { style: { fontSize: 13, color: "#666", lineHeight: 1.7 } },
					"跨会话长期记忆：偏好 / 事实 / 经验 / 待办 / 会话索引，带版本化与审计。新会话自动注入基线，agent 可随时检索。"),
				createElement("div", null,
					createElement("button", {
						style: { cursor: "pointer", fontSize: 13, padding: "6px 16px", borderRadius: 8, border: "1px solid rgba(128,128,128,.4)", background: "transparent", color: "inherit" },
						onClick: () => window.open(VIEWER, "_blank"),
					}, "打开完整管理页（搜索 · 修正 · 删除 · 用户画像）")),
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
