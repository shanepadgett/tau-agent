// Clean-room oxlint JS plugin for the spike. Two syntax rules, scoped by config overrides.
const noModuleLet = {
	meta: { type: "problem", messages: { moduleLet: "Module-level `let` keeps state between turns. Put state in a service or an entry." } },
	create(context) {
		return {
			VariableDeclaration(node) {
				if (node.kind === "let" && node.parent?.type === "Program") {
					context.report({ node, messageId: "moduleLet" })
				}
			},
		}
	},
}

const noProcessEnv = {
	meta: { type: "problem", messages: { processEnv: "Read environment variables in `host` only and pass values in." } },
	create(context) {
		return {
			MemberExpression(node) {
				if (node.object.type === "Identifier" && node.object.name === "process" && node.property.type === "Identifier" && node.property.name === "env") {
					context.report({ node, messageId: "processEnv" })
				}
			},
		}
	},
}

export default {
	meta: { name: "tau" },
	rules: { "no-module-let": noModuleLet, "no-process-env": noProcessEnv },
}
