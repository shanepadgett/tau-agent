// Rewrites src/ai/catalog-snapshot.json: the models.dev entries for the providers Tau's built-in
// routes read, and the latest Claude Code version, which becomes the floor the Claude
// subscription route never goes below. Run with `mise run catalog`.
import { join } from "node:path";

const MODELS_DEV_URL = "https://models.dev/api.json";
const CLAUDE_CODE_URL = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";

// The `catalogProvider` of each built-in route in src/ai/routes.ts. Tools cannot import src/.
const CATALOG_PROVIDERS = ["anthropic", "openai", "openrouter", "opencode-go"];

const OUTPUT = join(import.meta.dir, "../src/ai/catalog-snapshot.json");

const fetchJson = async (url: string): Promise<unknown> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
};

type ModelsDev = Record<string, { models: Record<string, unknown> } | undefined>;

const [modelsDev, claudeCode] = (await Promise.all([
  fetchJson(MODELS_DEV_URL),
  fetchJson(CLAUDE_CODE_URL),
])) as [ModelsDev, { version: string }];

const providers = Object.fromEntries(
  CATALOG_PROVIDERS.map((id) => {
    const provider = modelsDev[id];
    if (provider === undefined) throw new Error(`models.dev has no provider ${id}`);
    return [id, { models: provider.models }];
  }),
);

const snapshot = {
  fetchedAt: Date.now(),
  claudeCodeVersion: claudeCode.version,
  modelsDev: providers,
};

await Bun.write(OUTPUT, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`Wrote ${OUTPUT}: Claude Code ${claudeCode.version}.`);
