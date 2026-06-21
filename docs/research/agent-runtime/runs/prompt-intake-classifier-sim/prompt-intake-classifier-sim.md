# Prompt-intake classifier simulation

Question: is a cheap side classifier worth running on each user prompt?

## Winner counts

| policy | cost wins | quality-gated wins |
|---|---:|---:|
| always_ask_user | 4 | 2 |
| classifier_confirm_high_impact | 1 | 3 |

## Session detail

| session | policy | classifier tokens | confirmations | recall | false durable | missed correction | annoyance | retry turns | dollars | flags |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| small_edit | always_ask_user | 276 | 0.75 | 87.1% | 0.01 | 0.00 | 0.09 | 0.01 | $0.0003 | winner, quality_winner |
| small_edit | classifier_confirm_high_impact | 828 | 0.18 | 81.2% | 0.02 | 0.00 | 0.00 | 0.01 | $0.0003 |  |
| small_edit | cheap_prompt_classifier | 756 | 0.00 | 77.2% | 0.15 | 0.00 | 0.00 | 0.03 | $0.0010 |  |
| small_edit | regex_only | 144 | 0.00 | 44.6% | 0.29 | 0.00 | 0.00 | 0.06 | $0.0015 |  |
| small_edit | none | 0 | 0.00 | 43.0% | 0.30 | 0.00 | 0.00 | 0.07 | $0.0016 |  |
| debug_with_correction | always_ask_user | 736 | 3.75 | 84.9% | 0.02 | 0.45 | 0.45 | 0.13 | $0.0033 | winner, quality_winner |
| debug_with_correction | classifier_confirm_high_impact | 2,208 | 0.90 | 79.1% | 0.03 | 0.63 | 0.02 | 0.12 | $0.0035 |  |
| debug_with_correction | cheap_prompt_classifier | 2,016 | 0.00 | 75.3% | 0.16 | 0.74 | 0.00 | 0.17 | $0.0046 |  |
| debug_with_correction | regex_only | 384 | 0.00 | 43.4% | 0.30 | 1.70 | 0.00 | 0.37 | $0.0090 |  |
| debug_with_correction | none | 0 | 0.00 | 38.0% | 0.30 | 1.86 | 0.00 | 0.40 | $0.0096 |  |
| long_research | always_ask_user | 2,208 | 13.50 | 83.2% | 0.09 | 1.85 | 1.62 | 0.52 | $0.0129 | winner |
| long_research | classifier_confirm_high_impact | 6,624 | 3.24 | 77.5% | 0.14 | 2.48 | 0.07 | 0.48 | $0.0133 | quality_winner |
| long_research | cheap_prompt_classifier | 6,048 | 0.00 | 73.7% | 0.71 | 2.89 | 0.00 | 0.68 | $0.0178 |  |
| long_research | regex_only | 1,152 | 0.00 | 42.5% | 1.25 | 6.32 | 0.00 | 1.41 | $0.0342 |  |
| long_research | none | 0 | 0.00 | 34.0% | 1.20 | 7.26 | 0.00 | 1.57 | $0.0377 |  |
| preference_heavy | classifier_confirm_high_impact | 4,416 | 2.34 | 78.3% | 0.20 | 1.08 | 0.05 | 0.24 | $0.0070 | winner, quality_winner |
| preference_heavy | always_ask_user | 1,472 | 9.75 | 84.0% | 0.12 | 0.80 | 1.17 | 0.29 | $0.0072 |  |
| preference_heavy | cheap_prompt_classifier | 4,032 | 0.00 | 74.5% | 1.03 | 1.28 | 0.00 | 0.46 | $0.0119 |  |
| preference_heavy | regex_only | 768 | 0.00 | 43.0% | 1.84 | 2.85 | 0.00 | 0.92 | $0.0222 |  |
| preference_heavy | none | 0 | 0.00 | 36.0% | 1.80 | 3.20 | 0.00 | 0.97 | $0.0233 |  |
| scope_churn | always_ask_user | 1,656 | 12.75 | 82.3% | 0.05 | 2.30 | 1.53 | 0.58 | $0.0143 | winner |
| scope_churn | classifier_confirm_high_impact | 4,968 | 3.06 | 76.7% | 0.08 | 3.03 | 0.06 | 0.57 | $0.0149 | quality_winner |
| scope_churn | cheap_prompt_classifier | 4,536 | 0.00 | 72.9% | 0.37 | 3.52 | 0.00 | 0.71 | $0.0183 |  |
| scope_churn | regex_only | 864 | 0.00 | 42.1% | 0.64 | 7.53 | 0.00 | 1.50 | $0.0361 |  |
| scope_churn | none | 0 | 0.00 | 32.0% | 0.60 | 8.84 | 0.00 | 1.72 | $0.0414 |  |

## Takeaways

- No classifier is cheap only until missed corrections/scope changes cause retries or bad compaction.
- Regex-only is useful as a floor but misses reversals and nuanced corrections.
- Cheap prompt-only classifier is worth testing; token cost is tiny compared with one retry turn.
- High-impact confirmation is the safer product shape for durable preferences and reversals.
- Always asking users is accurate but annoying. Gate confirmations by confidence and impact.