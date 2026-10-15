/**
 * The chat's colors and the styles of Markdown and code. Every component takes its colors from
 * here, so the look changes in one place.
 */

import { SyntaxStyle, type ThemeTokenStyle } from "@opentui/core";
import { useRenderer } from "@opentui/solid";

/** One Dark's colors, by what each means on the chat screen. */
export const COLORS = {
  background: "#282c34",
  text: "#dddddd",
  muted: "#888888",
  border: "#555555",
  accent: "#61afef",
  success: "#98c379",
  warning: "#e5c07b",
  error: "#e06c75",
  keyword: "#c678dd",
  number: "#d19a66",
  type: "#56b6c2",
} as const;

type Color = (typeof COLORS)[keyof typeof COLORS];

/** The style of an `@` tag in the input. */
export const TAG_STYLE = "tau.file-tag";

const rule = (
  scope: string[],
  foreground: Color,
  style: Omit<ThemeTokenStyle["style"], "foreground"> = {},
): ThemeTokenStyle => ({ scope, style: { foreground, ...style } });

/**
 * OpenTUI hides Markdown's marks and styles the text by these scopes instead, so a scope with no
 * rule looks like body text. Code blocks use the tree-sitter scopes.
 */
const RULES: ThemeTokenStyle[] = [
  rule(["default"], COLORS.text),
  rule(["markup.heading"], COLORS.accent, { bold: true }),
  rule(["markup.heading.1"], COLORS.accent, { bold: true, underline: true }),
  rule(["markup.strong"], COLORS.text, { bold: true }),
  rule(["markup.italic"], COLORS.text, { italic: true }),
  rule(["markup.strikethrough"], COLORS.muted),
  rule(["markup.list"], COLORS.accent),
  rule(["markup.quote"], COLORS.muted, { italic: true }),
  rule(["markup.raw", "markup.raw.block"], COLORS.success),
  rule(["markup.link", "markup.link.url"], COLORS.type, { underline: true }),
  rule(["markup.link.label"], COLORS.accent, { underline: true }),
  rule(["comment"], COLORS.muted, { italic: true }),
  rule(["string", "character", "string.special"], COLORS.success),
  rule(["number", "float", "boolean", "constant", "constant.builtin"], COLORS.number),
  rule(["keyword", "keyword.return", "keyword.conditional", "keyword.repeat"], COLORS.keyword),
  rule(["keyword.import", "keyword.export", "keyword.function", "keyword.type"], COLORS.keyword),
  rule(["operator", "keyword.operator"], COLORS.type),
  rule(["function", "function.call", "function.method", "function.method.call"], COLORS.accent),
  rule(["function.builtin", "constructor"], COLORS.accent),
  rule(["type", "type.builtin", "class", "module", "namespace"], COLORS.warning),
  rule(["variable.builtin", "variable.parameter", "parameter"], COLORS.error),
  rule(["property", "variable.member", "field", "attribute", "tag.attribute"], COLORS.error),
  rule(["tag"], COLORS.error),
  rule(["punctuation", "punctuation.bracket", "punctuation.delimiter"], COLORS.text),
  rule(["diff.plus"], COLORS.success),
  rule(["diff.minus"], COLORS.error),
  rule([TAG_STYLE], COLORS.accent),
];

/** The style for Markdown and code. Make it once per renderer; it holds native memory until exit. */
export const useSyntaxStyle = () => SyntaxStyle.fromTheme(RULES, useRenderer().nativeScene);
