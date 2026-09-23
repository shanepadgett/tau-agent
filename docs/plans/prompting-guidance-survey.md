# Model prompting guidance — survey notes

Snapshot from September 2026. Covers vendor prompting guides and current general advice. Not a plan.

## Vendor guides

None of the three models below ships a prompting guide like OpenAI or Anthropic.

- **xAI Grok 4.7** — no guide. The model page covers `prompt_cache_key`, context compaction, and encrypted reasoning. xAI's only "prompting guide" is for Realtime speech-to-speech. The Grok Code Fast 1 guide and the January 2026 general Grok guide are gone (old URLs 404).
- **DeepSeek V4.1 Flash** (`deepseek-flash`) — no guide. The Hugging Face model card's `encoding/README.md` is the prompt-format reference (tokens, DSML tool calls, thinking mode, numeric `reasoning_effort` 1–100). The API docs cover thinking mode and tool calls only.
- **Z.ai GLM 5.3 / 5.3-Flash** — no guide. Docs cover parameters: thinking always on, `reasoning_effort` `low`/`high`/`max` (default `max`), `clear_thinking=true` for chat. The "Best Practice" page is coding-agent workflow, not prompting.

## General guidance (current)

Reasoning models think on their own. Drop "think step by step", CoT examples, and requests to show work. Set depth with the effort parameter (`reasoning_effort`, thinking level). Google: no need to have the model outline reasoning in the response. Microsoft: the classic prompt techniques are not recommended for reasoning models.

Personas are not an accuracy lift and can hurt. Zheng et al. (EMNLP 2024): 162 personas, 2,410 factual questions, no average gain. PRISM (2026): MMLU fell 71.6 → 68.0 with a short persona and 66.3 with a long one. Principled Personas (EMNLP 2025): irrelevant details, even a swapped name, swung results by up to 30 points. A May 2026 study found personas add expert framing and jargon while cutting clarity; good for advisory settings, bad for plain explanation. Google warns the model will sometimes ignore instructions to stay in character.

Keep a light role line when tone matters. Skip the expert biography when accuracy matters. Voice and personality agents still want personas; xAI's Realtime guide builds its prompt structure around them.

What replaced the old advice: state the goal, not the procedure; give context, constraints, output shape, and evaluation criteria; put critical and negative constraints at the end of long prompts; ask for verbosity explicitly; drop flattery and emotional pressure; use examples for format, not reasoning; leave temperature alone (Gemini 3 wants its default 1.0).

## Sources

- [Gemini 3 prompting guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/gemini-3-prompting-guide)
- [Gemini prompt design strategies](https://ai.google.dev/gemini-api/docs/prompting-strategies)
- [Microsoft: prompt engineering techniques](https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/prompt-engineering)
- [promptingguide.ai: Reasoning LLMs](https://www.promptingguide.ai/guides/reasoning-llms)
- [llmbestpractices: prompting reasoning models](https://llmbestpractices.com/prompt-engineering/reasoning-model-prompting)
- [xAI Grok 4.7](https://docs.x.ai/developers/grok-4-7)
- [DeepSeek V4.1-Flash model card](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash)
- [Z.ai GLM-5.3](https://docs.z.ai/guides/llm/glm-5.3)
