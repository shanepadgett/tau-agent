# JSON payload format simulation

Question: what visible format should arbitrary JSON-like tool payloads compile to?

## Winner counts

| format | cost wins | quality-gated wins |
|---|---:|---:|
| columnar_interned | 1 | 1 |
| projection_hidden_raw | 5 | 5 |

## Case detail

| case | format | visible | hidden bytes | rent | retry | dollars | flags |
|---|---|---:|---:|---:|---:|---:|---|
| package_metadata_12 | projection_hidden_raw | 109 | 3,275 | 228 | 0.04 | $0.0013 | winner, quality_winner |
| package_metadata_12 | minified_json | 819 | 0 | 3,767 | 0.01 | $0.0038 |  |
| package_metadata_12 | jsonl_objects | 819 | 0 | 3,603 | 0.01 | $0.0039 |  |
| package_metadata_12 | tuple_rows | 101 | 0 | 343 | 0.19 | $0.0049 |  |
| package_metadata_12 | path_delta_rows | 204 | 0 | 489 | 0.18 | $0.0050 |  |
| package_metadata_12 | columnar_interned | 133 | 0 | 345 | 0.20 | $0.0054 |  |
| package_metadata_12 | pretty_json | 1,197 | 0 | 5,985 | 0.01 | $0.0055 |  |
| git_status_80 | projection_hidden_raw | 791 | 6,369 | 1,661 | 0.02 | $0.0034 | winner, quality_winner |
| git_status_80 | tuple_rows | 783 | 0 | 2,662 | 0.03 | $0.0039 |  |
| git_status_80 | columnar_interned | 907 | 0 | 2,358 | 0.05 | $0.0046 |  |
| git_status_80 | jsonl_objects | 1,592 | 0 | 7,004 | 0.01 | $0.0072 |  |
| git_status_80 | minified_json | 1,593 | 0 | 7,327 | 0.01 | $0.0072 |  |
| git_status_80 | path_delta_rows | 1,527 | 0 | 3,664 | 0.07 | $0.0072 |  |
| git_status_80 | pretty_json | 2,193 | 0 | 10,965 | 0.01 | $0.0100 |  |
| lsp_diagnostics_120 | columnar_interned | 665 | 0 | 1,729 | 0.05 | $0.0037 | winner, quality_winner |
| lsp_diagnostics_120 | projection_hidden_raw | 1,788 | 17,731 | 3,754 | 0.02 | $0.0070 |  |
| lsp_diagnostics_120 | tuple_rows | 1,780 | 0 | 6,052 | 0.03 | $0.0079 |  |
| lsp_diagnostics_120 | jsonl_objects | 4,433 | 0 | 19,505 | 0.01 | $0.0195 |  |
| lsp_diagnostics_120 | minified_json | 4,433 | 0 | 20,391 | 0.01 | $0.0197 |  |
| lsp_diagnostics_120 | path_delta_rows | 5,265 | 0 | 12,636 | 0.07 | $0.0211 |  |
| lsp_diagnostics_120 | pretty_json | 6,863 | 0 | 34,315 | 0.01 | $0.0310 |  |
| test_failures_40 | projection_hidden_raw | 982 | 11,463 | 2,062 | 0.02 | $0.0041 | winner, quality_winner |
| test_failures_40 | columnar_interned | 816 | 0 | 2,121 | 0.19 | $0.0076 |  |
| test_failures_40 | tuple_rows | 974 | 0 | 3,311 | 0.17 | $0.0080 |  |
| test_failures_40 | path_delta_rows | 1,463 | 0 | 3,511 | 0.17 | $0.0094 |  |
| test_failures_40 | jsonl_objects | 2,866 | 0 | 12,610 | 0.01 | $0.0127 |  |
| test_failures_40 | minified_json | 2,866 | 0 | 13,183 | 0.01 | $0.0128 |  |
| test_failures_40 | pretty_json | 3,676 | 0 | 18,380 | 0.01 | $0.0167 |  |
| repo_profile_500 | projection_hidden_raw | 1,682 | 41,582 | 3,532 | 0.02 | $0.0066 | winner, quality_winner |
| repo_profile_500 | path_delta_rows | 2,137 | 0 | 5,128 | 0.07 | $0.0095 |  |
| repo_profile_500 | tuple_rows | 4,211 | 0 | 14,317 | 0.03 | $0.0177 |  |
| repo_profile_500 | columnar_interned | 4,432 | 0 | 11,523 | 0.05 | $0.0180 |  |
| repo_profile_500 | jsonl_objects | 10,395 | 0 | 45,738 | 0.05 | $0.0462 |  |
| repo_profile_500 | minified_json | 10,396 | 0 | 47,821 | 0.05 | $0.0467 |  |
| repo_profile_500 | pretty_json | 14,896 | 0 | 74,480 | 0.05 | $0.0681 |  |
| provider_usage_30 | projection_hidden_raw | 262 | 3,439 | 550 | 0.03 | $0.0017 | winner, quality_winner |
| provider_usage_30 | minified_json | 860 | 0 | 3,956 | 0.01 | $0.0040 |  |
| provider_usage_30 | jsonl_objects | 860 | 0 | 3,784 | 0.01 | $0.0041 |  |
| provider_usage_30 | tuple_rows | 255 | 0 | 867 | 0.18 | $0.0054 |  |
| provider_usage_30 | columnar_interned | 218 | 0 | 566 | 0.20 | $0.0056 |  |
| provider_usage_30 | pretty_json | 1,333 | 0 | 6,665 | 0.01 | $0.0061 |  |
| provider_usage_30 | path_delta_rows | 709 | 0 | 1,701 | 0.17 | $0.0066 |  |

## Takeaways

- Default arbitrary JSON should not be dumped raw into provider context.
- For row-like payloads, tuple/columnar formats save large tokens; use tuple unless repeated strings make interning worthwhile.
- For nested/high-fidelity payloads, compact projection plus hidden raw JSON handle is the safer default.
- Pretty JSON is a debug/expand view, not normal model context.
- Path-delta rows are niche: useful for nested diffs, too weird as generic output.