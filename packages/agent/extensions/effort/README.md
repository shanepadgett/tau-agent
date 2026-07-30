# Effort Extension

Switches active chat model and thinking level as one effort tier. Available providers come from current logins, and each provider can fall back through its ranked models.

Run `/effort` to choose a tier and provider. `/effort quick`, `/effort standard`, and `/effort deep` skip the tier prompt. Press `Ctrl+Shift+E` to cycle tiers on current provider.

If selected provider has no usable model for tier, current model stays active. Footer shows an effort label whenever current provider, model, and thinking level match a configured tier; otherwise it shows no label.
