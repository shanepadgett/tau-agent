/** The languages that code blocks are colored in, beyond the JavaScript, TypeScript, Markdown and Zig that OpenTUI has. */

// OpenTUI downloads each parser and query the first time a block needs it and keeps them in its
// data folder; offline, the block stays plain. The URLs are the ones OpenCode uses
// (`packages/tui/src/parsers-config.ts`).

import { addDefaultParsers, type FiletypeParserOptions } from "@opentui/core";

const NVIM_QUERIES =
  "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries";

const language = (
  filetype: string,
  wasm: string,
  highlights: string,
  aliases: string[] = [],
): FiletypeParserOptions => ({ filetype, aliases, wasm, queries: { highlights: [highlights] } });

const LANGUAGES: FiletypeParserOptions[] = [
  language(
    "python",
    "https://github.com/tree-sitter/tree-sitter-python/releases/download/v0.23.6/tree-sitter-python.wasm",
    "https://github.com/tree-sitter/tree-sitter-python/raw/refs/heads/master/queries/highlights.scm",
    ["py"],
  ),
  language(
    "rust",
    "https://github.com/tree-sitter/tree-sitter-rust/releases/download/v0.24.0/tree-sitter-rust.wasm",
    `${NVIM_QUERIES}/rust/highlights.scm`,
    ["rs"],
  ),
  language(
    "go",
    "https://github.com/tree-sitter/tree-sitter-go/releases/download/v0.25.0/tree-sitter-go.wasm",
    `${NVIM_QUERIES}/go/highlights.scm`,
  ),
  language(
    "bash",
    "https://github.com/tree-sitter/tree-sitter-bash/releases/download/v0.25.0/tree-sitter-bash.wasm",
    `${NVIM_QUERIES}/bash/highlights.scm`,
    ["sh", "shell", "zsh"],
  ),
  language(
    "html",
    "https://github.com/tree-sitter/tree-sitter-html/releases/download/v0.23.2/tree-sitter-html.wasm",
    "https://github.com/tree-sitter/tree-sitter-html/raw/refs/heads/master/queries/highlights.scm",
  ),
  language(
    "json",
    "https://github.com/tree-sitter/tree-sitter-json/releases/download/v0.24.8/tree-sitter-json.wasm",
    `${NVIM_QUERIES}/json/highlights.scm`,
    ["jsonc"],
  ),
  language(
    "yaml",
    "https://github.com/tree-sitter-grammars/tree-sitter-yaml/releases/download/v0.7.2/tree-sitter-yaml.wasm",
    `${NVIM_QUERIES}/yaml/highlights.scm`,
    ["yml"],
  ),
  language(
    "css",
    "https://github.com/tree-sitter/tree-sitter-css/releases/download/v0.25.0/tree-sitter-css.wasm",
    `${NVIM_QUERIES}/css/highlights.scm`,
  ),
  language(
    "toml",
    "https://github.com/tree-sitter-grammars/tree-sitter-toml/releases/download/v0.7.0/tree-sitter-toml.wasm",
    `${NVIM_QUERIES}/toml/highlights.scm`,
  ),
  language(
    "diff",
    "https://github.com/tree-sitter-grammars/tree-sitter-diff/releases/download/v0.1.0/tree-sitter-diff.wasm",
    "https://raw.githubusercontent.com/tree-sitter-grammars/tree-sitter-diff/2520c3f934b3179bb540d23e0ef45f75304b5fed/queries/highlights.scm",
    ["udiff", "patch"],
  ),
];

/** Call once before the chat draws its first code block. */
export const addCodeLanguages = () => {
  addDefaultParsers(LANGUAGES);
};
