import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { bindingHint, rawHint, textHint } from "../../../../src/shared/tui/tool-key-hints.ts";
import { ToolPanel, type ToolPanelFooter } from "../../../../src/shared/tui/tool-panel.ts";

export function createToolPanelPreviewWidget(_tui: TUI, _cwd: string, theme: Theme): Container {
	const container = new Container();
	container.addChild(new Text(theme.fg("text", theme.bold("Tool Panel Preview")), 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(
		new ToolPanel(theme, {
			title: "title: required panel title",
			secondary: "secondary: optional context line under the title",
			header: [
				theme.fg("muted", "// header: optional string[] or Component"),
				theme.fg("muted", "// caller owns tabs, filters, status rows, warnings"),
			],
			body: new Text(
				[
					"// body: required Component",
					"// render any tool-specific content here",
					"// ToolPanel supplies frame, title, optional header, body, footer",
				].join("\n"),
			),
			footer: {
				kind: "hints",
				hints: [rawHint("key", "footer action hint"), textHint("plain footer note")],
			},
		}),
	);
	container.addChild(new Spacer(1));
	container.addChild(createAckPreviewPanel(theme, "destructiveAck"));
	container.addChild(new Spacer(1));
	container.addChild(createAckPreviewPanel(theme, "infoAck"));
	return container;
}

function createAckPreviewPanel(theme: Theme, kind: "destructiveAck" | "infoAck"): ToolPanel {
	const footer: ToolPanelFooter = {
		kind,
		message: `${kind} message text`,
		hints: [bindingHint("tui.select.confirm", "confirm"), rawHint("esc", "cancel")],
	};
	return new ToolPanel(theme, {
		title: `footer.kind: ${kind}`,
		secondary: "ack footer locks the panel until confirm or cancel",
		header: [theme.fg("muted", "// header remains optional")],
		body: new Text("// body can describe the pending acknowledged action"),
		footer,
	});
}
