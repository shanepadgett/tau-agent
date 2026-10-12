import { relative, sep } from "node:path";
import type { Rule } from "@oxlint/plugins";

const GENERIC_NAMES = new Set(["common", "helper", "helpers", "misc", "util", "utils"]);

export const noGenericFilenames: Rule = {
  meta: { type: "suggestion" },
  create(context) {
    return {
      Program(node) {
        const segments = relative(context.cwd, context.filename).split(sep);

        const generic = segments.find((segment) => {
          const stem = segment.split(".")[0] ?? segment;
          return GENERIC_NAMES.has(stem.toLowerCase());
        });

        if (generic === undefined) return;

        context.report({
          node,
          message: `\`${generic}\` does not name a concept. Name the file or folder after what it owns.`,
        });
      },
    };
  },
};
