# Validator-cost simulation

Question: should validation output be raw, compacted, or quiet harness-managed?

## Winner counts

| policy | cost wins | quality-gated wins |
|---|---:|---:|
| quiet_validators | 1 | 1 |
| quiet_validators_auto_format | 5 | 5 |

## Scenario detail

| scenario | policy | visible | hidden bytes | rent | retry turns | missed risk | dollars | flags |
|---|---|---:|---:|---:|---:|---:|---:|---|
| format_pass_only | quiet_validators | 0 | 4,800 | 0 | 0.00 | 1.5% | $0.0025 | winner, quality_winner |
| format_pass_only | quiet_validators_auto_format | 220 | 4,800 | 1,100 | 0.00 | 1.2% | $0.0030 |  |
| format_pass_only | compact_command_capsules | 120 | 4,800 | 600 | 0.00 | 2.0% | $0.0040 |  |
| format_pass_only | manual_raw_checks | 1,200 | 0 | 6,000 | 0.00 | 1.0% | $0.0073 |  |
| format_pass_only | no_validation | 0 | 0 | 0 | 0.60 | 18.0% | $0.0427 |  |
| typescript_three_errors | quiet_validators_auto_format | 265 | 18,000 | 1,325 | 0.04 | 1.2% | $0.0042 | winner, quality_winner |
| typescript_three_errors | quiet_validators | 265 | 18,000 | 1,325 | 0.05 | 1.5% | $0.0049 |  |
| typescript_three_errors | compact_command_capsules | 265 | 18,000 | 1,325 | 0.08 | 2.0% | $0.0066 |  |
| typescript_three_errors | manual_raw_checks | 4,500 | 0 | 22,500 | 0.15 | 1.0% | $0.0258 |  |
| typescript_three_errors | no_validation | 0 | 0 | 0 | 0.85 | 18.0% | $0.0487 |  |
| test_long_failure | quiet_validators_auto_format | 440 | 72,000 | 2,200 | 0.08 | 1.2% | $0.0059 | winner, quality_winner |
| test_long_failure | quiet_validators | 440 | 72,000 | 2,200 | 0.10 | 1.5% | $0.0069 |  |
| test_long_failure | compact_command_capsules | 440 | 72,000 | 2,200 | 0.16 | 2.0% | $0.0093 |  |
| test_long_failure | no_validation | 0 | 0 | 0 | 1.10 | 18.0% | $0.0547 |  |
| test_long_failure | manual_raw_checks | 18,000 | 0 | 90,000 | 0.38 | 1.0% | $0.0920 |  |
| lint_autofix_then_pass | quiet_validators_auto_format | 555 | 30,000 | 2,775 | 0.00 | 1.2% | $0.0045 | winner, quality_winner |
| lint_autofix_then_pass | quiet_validators | 335 | 30,000 | 1,675 | 0.05 | 1.5% | $0.0053 |  |
| lint_autofix_then_pass | compact_command_capsules | 455 | 30,000 | 2,275 | 0.08 | 2.0% | $0.0074 |  |
| lint_autofix_then_pass | manual_raw_checks | 7,500 | 0 | 37,500 | 0.15 | 1.0% | $0.0393 |  |
| lint_autofix_then_pass | no_validation | 0 | 0 | 0 | 0.85 | 18.0% | $0.0487 |  |
| multi_loop_debug | quiet_validators_auto_format | 2,160 | 168,000 | 10,800 | 0.12 | 1.2% | $0.0146 | winner, quality_winner |
| multi_loop_debug | quiet_validators | 2,160 | 168,000 | 10,800 | 0.15 | 1.5% | $0.0159 |  |
| multi_loop_debug | compact_command_capsules | 2,280 | 168,000 | 11,400 | 0.24 | 2.0% | $0.0195 |  |
| multi_loop_debug | no_validation | 0 | 0 | 0 | 1.35 | 18.0% | $0.0607 |  |
| multi_loop_debug | manual_raw_checks | 42,000 | 0 | 210,000 | 0.65 | 1.0% | $0.2065 |  |
| flaky_fail_then_pass | quiet_validators_auto_format | 300 | 48,000 | 1,500 | 0.12 | 1.2% | $0.0062 | winner, quality_winner |
| flaky_fail_then_pass | quiet_validators | 300 | 48,000 | 1,500 | 0.13 | 1.5% | $0.0070 |  |
| flaky_fail_then_pass | compact_command_capsules | 540 | 48,000 | 2,700 | 0.08 | 2.0% | $0.0078 |  |
| flaky_fail_then_pass | no_validation | 0 | 0 | 0 | 0.85 | 22.0% | $0.0545 |  |
| flaky_fail_then_pass | manual_raw_checks | 12,000 | 0 | 60,000 | 0.15 | 1.0% | $0.0595 |  |

## Takeaways

- Passing logs should be hidden/status-only. Keeping them visible is pure context rent.
- Failure capsules need diagnostic lines, not entire logs. Hidden full log handle preserves auditability.
- Quiet validators beat manual raw checks by cutting both visible rent and model-run validation loops.
- Auto-format integration matters because formatter changes must refresh file capsules without asking the model to reread.
- Skipping validation is cheapest only before pricing missed failures; quality gate rejects it.