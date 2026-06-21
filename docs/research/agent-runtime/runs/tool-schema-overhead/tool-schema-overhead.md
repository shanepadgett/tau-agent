# Tool-schema overhead

Question: should the harness expose many small tools, grouped stable tools, mode-specific tools, or a dispatcher?

## Winner counts

| policy | cost wins | quality-gated wins |
|---|---:|---:|
| generic_dispatcher | 2 | 0 |
| mode_specific_tools | 2 | 4 |

## Session detail

| session | policy | schema total | cache misses | cached input | uncached input | retry turns | wrong risk | dollars | flags |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| single_file_edit_8 | mode_specific_tools | 36,000 | 1 | 591,500 | 84,500 | 0.10 | 1.8% | $0.5136 | winner, quality_winner |
| single_file_edit_8 | generic_dispatcher | 9,600 | 1 | 568,400 | 81,200 | 0.80 | 5.4% | $0.5186 |  |
| single_file_edit_8 | dynamic_generated_tools | 48,000 | 1 | 602,000 | 86,000 | 0.22 | 2.4% | $0.5252 |  |
| single_file_edit_8 | coherent_grouped_tools | 80,000 | 1 | 630,000 | 90,000 | 0.10 | 1.4% | $0.5414 |  |
| single_file_edit_8 | stable_all_tools_gated | 96,000 | 1 | 644,000 | 92,000 | 0.08 | 1.0% | $0.5505 |  |
| single_file_edit_8 | many_small_tools_all | 144,000 | 1 | 686,000 | 98,000 | 0.16 | 1.2% | $0.5840 |  |
| debug_20 | mode_specific_tools | 90,000 | 3 | 1,596,500 | 93,500 | 0.53 | 2.3% | $0.9711 | winner, quality_winner |
| debug_20 | coherent_grouped_tools | 200,000 | 1 | 1,710,000 | 90,000 | 0.38 | 1.9% | $0.9908 |  |
| debug_20 | generic_dispatcher | 24,000 | 1 | 1,542,800 | 81,200 | 3.40 | 7.0% | $0.9979 |  |
| debug_20 | dynamic_generated_tools | 120,000 | 3 | 1,622,000 | 98,000 | 0.84 | 3.1% | $1.0020 |  |
| debug_20 | stable_all_tools_gated | 240,000 | 1 | 1,748,000 | 92,000 | 0.29 | 1.2% | $1.0053 |  |
| debug_20 | many_small_tools_all | 360,000 | 1 | 1,862,000 | 98,000 | 0.75 | 1.6% | $1.0727 |  |
| refactor_40 | generic_dispatcher | 48,000 | 1 | 3,166,800 | 81,200 | 4.00 | 7.9% | $1.6968 | winner |
| refactor_40 | mode_specific_tools | 180,000 | 6 | 3,273,000 | 107,000 | 1.25 | 2.6% | $1.7296 | quality_winner |
| refactor_40 | coherent_grouped_tools | 400,000 | 1 | 3,510,000 | 90,000 | 0.90 | 2.1% | $1.7412 |  |
| refactor_40 | stable_all_tools_gated | 480,000 | 1 | 3,588,000 | 92,000 | 0.70 | 1.4% | $1.7645 |  |
| refactor_40 | dynamic_generated_tools | 240,000 | 6 | 3,324,000 | 116,000 | 2.00 | 3.5% | $1.7942 |  |
| refactor_40 | many_small_tools_all | 720,000 | 1 | 3,822,000 | 98,000 | 1.90 | 1.8% | $1.8919 |  |
| research_harness_80 | generic_dispatcher | 96,000 | 1 | 6,414,800 | 81,200 | 4.00 | 8.3% | $3.0616 | winner |
| research_harness_80 | mode_specific_tools | 360,000 | 10 | 6,635,000 | 125,000 | 2.70 | 2.8% | $3.2220 | quality_winner |
| research_harness_80 | coherent_grouped_tools | 800,000 | 1 | 7,110,000 | 90,000 | 1.94 | 2.2% | $3.2415 |  |
| research_harness_80 | stable_all_tools_gated | 960,000 | 1 | 7,268,000 | 92,000 | 1.51 | 1.5% | $3.2826 |  |
| research_harness_80 | dynamic_generated_tools | 480,000 | 10 | 6,740,000 | 140,000 | 4.00 | 3.7% | $3.3367 |  |
| research_harness_80 | many_small_tools_all | 1,440,000 | 1 | 7,742,000 | 98,000 | 4.00 | 1.9% | $3.5238 |  |

## Takeaways

- Generic dispatcher is cheap on schema tokens but loses once wrong-tool/retry risk is priced.
- Coherent grouped tools are the sane product shape: lower rent than many tiny tools, clearer than dispatcher.
- Mode-specific schemas are token-competitive and win the quality gate here, even with some switches.
- Stable all-tools plus deterministic gates remain safer when provider cache churn, policy enforcement, or mode confusion dominates.
- Do not generate tool schemas per turn. Put rare guidance in tool errors/results, not schema text.