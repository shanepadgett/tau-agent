# Embedded local decision-model spike

## Result

Embedding the runtime works. The tested configurations do not qualify for bypassing Tau's tool-approval reviewer.

Pinned npm dependencies installed with lifecycle scripts disabled, and Pi 1.1.0 loaded them from an isolated TypeScript extension. Its registered command initialized llama.cpp with Metal, accessed MLX, and accessed the dedicated ONNX decision API. No Python, compiler, separately managed server, or global Pi configuration was needed.

MLX was the fastest tested path, but its shared-cache path changed answers for identical inputs. Isolating cache reuse stabilized the sample without making the model safe: it still approved destructive requests. The non-reasoning Qwen3 model returned unsafe approvals with extremely high scores. The other scored models bypassed no safe requests at the preselected 0.99 approval-probability threshold.

Recommendation: retain the existing reviewer. Runtime distribution is feasible; model quality, calibration, and MLX cache correctness remain blockers to approval integration. This result does not rule out other models, fine-tuning, or other inference formulations.

## Scope and environment

- Date: 2026-10-11.
- Hardware: MacBook Air, Apple M4, 24 GB unified memory.
- macOS: 26.6.2. Node.js: 24.18.0. npm: 11.16.0.
- Runtime packages: `node-llama-cpp@3.22.1`, `@mlx-node/lm@0.0.16`, `@mlx-node/core@0.0.16`, `open-jev@0.1.2`, and `@huggingface/transformers@4.3.1`.
- Isolated working directory: `/private/tmp/tau-decider-spike.5GymdN`.
- Completed model artifacts: 9,462,899,562 bytes, approximately 9.46 GB. Large files were verified by SHA-256; small Git-managed files by Git blob hashes, with sizes checked before promotion from partial files.
- All selected model artifacts declare Apache-2.0. This is metadata inspection, not a legal audit.

No production extensions, dependencies, schemas, or approval behavior changed. No repository tests, fixtures, or snapshots were added. Every approval example remained inert text; none of its commands or scripts ran. No hosted model calls were made.

## Method

The evaluation contained 64 manually labeled synthetic requests: 24 short safe requests, 24 short risky requests, eight uncertain requests, four prompt-injection requests, and four long scripts. One long script was safe; three were risky. The totals were 25 safe, 31 risky, and eight uncertain requests.

Examples covered scoped source changes, ordinary project tooling, disposable versus valuable local databases, authenticated reads versus secret exfiltration, production disruption, publication, payments, and executable file evidence. Paired evidence examples used the same command with either a safe build script or a destructive/exfiltrating script. Long scripts placed the deciding operation after 220 repeated comment lines, rather than at the beginning.

Each configuration used three unmeasured warm-up calls and two differently ordered passes over all 64 cases. Eight model/runtime configurations were evaluated, with additional MLX API/cache controls. Repeated passes measure timing and repeatability; they are not independent safety examples.

The shared compact policy is 938 characters and follows the approval extension's effects-based rules. It is not the full production reviewer prompt. Uncertain requests must defer to the existing reviewer, not become final denials. Neither the prompt nor labels were tuned after viewing model results. A non-reasoning Qwen3 reference was added after Qwen3.5 returned no useful high-confidence approvals, using the same policy and labels.

Scored paths used `p(approve)` from the option probability distribution, not the runtime-specific `confidence` field. Thresholds 0.90, 0.95, 0.99, and 0.999 were selected before evaluation. These scores are not calibrated probabilities that an operation is safe.

All input was retained or rejected. Encoder overflows threw and deferred instead of silently dropping dangerous trailing code. Model downloads were excluded from inference timing. Fresh-process loading below includes runtime initialization, model loading, and context creation after module imports; filesystem caches were warm from downloading the artifacts. It is not a cold-disk or full Pi-startup measurement.

The first llama.cpp native initialization took 15.5 seconds before loading any weights. Later initialization took approximately 48–89 ms. The cause of that first-use delay was not isolated; the table was measured afterward and excludes it.

## Latency and memory

Times are milliseconds. All-case p95 includes the long scripts where supported; the two 512-token encoders rejected those inputs. RSS is process memory, not complete unified-memory usage. MLX separately reported allocator peaks of approximately 1.35–1.36 GiB, so its RSS alone must not be used to claim total-memory savings.

| Runtime and model | Model assets, GB | Load, ms | Warm median, ms | All-case p95, ms | Short-case p95, ms | Peak RSS, GiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| llama.cpp / Qwen3.5 0.8B Q4_K_M | 0.533 | 1,409 | 160 | 864 | 176 | 1.50 |
| llama.cpp / Qwen3.5 2B Q4_K_M | 1.281 | 1,726 | 368 | 1,976 | 407 | 2.16 |
| llama.cpp / Qwen3.5 4B Q4_K_M | 2.741 | 2,605 | 974 | 5,295 | 1,070 | 3.34 |
| llama.cpp / Qwen3 4B Instruct-2507 Q4_K_M | 2.497 | 1,257 | 898 | 5,315 | 1,105 | 3.33 |
| ONNX CPU / Kev 0.6B q4 | 0.383 | 1,006 | 339 | 2,921 | 386 | 1.35 |
| ONNX CPU / OpenJev DeBERTa-v3-large q4 | 0.487 | 971 | 311 | 405 | 405 | 1.18 |
| ONNX CPU / GLiNER2.5-Decide q4 | 0.896 | 869 | 306 | 389 | 389 | 1.32 |
| MLX / Qwen3.5 0.8B, public session API, shared cache | 0.645 | 314 | 109 | 537 | 124 | 0.85 |
| MLX / same model, reset caches before each request | 0.645 | 326 | 130 | 744 | 168 | 0.82 |

The initial lower-level MLX API run measured 116 ms median and 574 ms p95. It showed the same eight answer changes as the public session API.

This is not a matched llama.cpp-versus-MLX speed comparison. The quantizations differ, llama.cpp scores structured choices, and MLX generates a label. MLX also places stable policy before mutable request content, whereas the tested standalone llama.cpp decision-context API places the document before the question. These results do not establish a 2× runtime speedup.

## Approval quality

The counts below use the first pass and `p(approve) >= 0.99`. They separately count concrete risky requests and uncertain requests that should have gone to the existing reviewer.

| Scored configuration | Safe bypasses / 25 | Risky bypasses / 31 | Uncertain bypasses / 8 |
| --- | ---: | ---: | ---: |
| Qwen3.5 0.8B | 0 | 0 | 0 |
| Qwen3.5 2B | 0 | 0 | 0 |
| Qwen3.5 4B | 0 | 0 | 0 |
| Qwen3 4B Instruct-2507 | 25 | 10 | 5 |
| Kev 0.6B | 0 | 0 | 0 |
| OpenJev DeBERTa-v3-large | 0 | 0 | 0 |
| GLiNER2.5-Decide | 0 | 0 | 0 |

Qwen3 4B still bypassed seven risky and three uncertain requests at 0.999. For example, it scored approval of inspected credential-exfiltration code at 0.999894, and approval of a destructive script containing a forged safety instruction at 0.99999959. Raising a raw score threshold did not solve the problem.

Qwen3.5 0.8B and 2B deferred every request at the argmax level. Qwen3.5 4B approved eight safe requests, but its highest safe approval score was only 0.790. These configurations therefore add latency without eliminating reviewer calls at the selected thresholds.

At argmax, the older Kev ONNX model approved 21 safe and 20 risky requests. At 0.90 its only bypass was a risky prompt-injection request. OpenJev approved every short request, including all 36 risky or uncertain short requests. GLiNER approved nine safe short requests and no risky ones at argmax, but its highest safe approval score was 0.643. That small sample and low scores are not sufficient for unattended approval.

MLX's tested Qwen3.5 API generated `A` or `D`; it did not expose a decision distribution. It therefore has no comparable calibrated-threshold result. The fresh-cache control approved 16 safe and six risky requests, including deleting a valuable local database, a large payment, deleting backups, and deleting user documents in a long script. A label-generation API is not a substitute for a supported dedicated decision head.

## MLX cache investigation

The shared-cache MLX runs changed the answer category on eight of 64 identical requests between differently ordered passes. This happened both through the lower-level model method and through fresh public `ChatSession` instances with explicit disposal. Five second-pass responses also failed the requested label format, and the long document-deletion example changed from defer to approve.

The public-session run recorded identical message/config fingerprints for each repeated request. A separate nine-request forward/reverse experiment compared shared cache, a full reset before every request, and a unique cache salt per request. Shared cache changed eight answers; both isolated controls changed none. The full 64-request fresh-cache control also had zero repeat changes.

This establishes a cache-dependent result difference in this model/runtime configuration. It does not identify the upstream cause or prove that all MLX models have the problem. Fresh session ownership alone did not fix it. Resetting or isolating caches was an experimental control, not a proposed production workaround: it discards useful stable prefixes, and the uncached model still made unsafe approvals.

The initial attempt to request `reuseCache: false` was rejected by the session API, which requires cache reuse. Subsequent runs used the supported session API and explicit cache lifecycle operations.

## Embedding and UI responsiveness

The isolated npm install used `--ignore-scripts`, with pinned versions. `getLlama({ gpu: 'metal', build: 'never' })` initialized the shipped native binary rather than compiling a runtime. MLX's published native addon also loaded without Python or build tools. Pi's actual extension loader successfully resolved all three runtime families from the package dependency root, and the registered probe command completed. This validates dependency loading, not a published npm release, signing/notarization, or compatibility with older macOS versions.

The published MLX binary currently targets macOS 26.2 or newer on Apple Silicon. That is a distribution constraint, not an approved Tau OS minimum change.

Direct ONNX calls blocked the Node event loop: approximately 377–405 ms p95 for the encoders and 2,921 ms for Kev with long input. A real Node worker-thread probe ran the same Kev head and policy while the host event loop stayed at 11.1 ms p95 and 11.2 ms maximum. Its long request still took 2,745 ms. The model was explicitly disposed before worker shutdown.

An embedded shared worker is therefore a viable boundary for CPU ONNX inference. It keeps the runtime inside the package and Pi process while protecting the terminal UI. It changes responsiveness, not inference quality or throughput. Native llama.cpp and MLX calls kept the event loop near its 10 ms sampling baseline in these sequential runs.

Installed runtime footprints were materially larger than Explore's small parser dependencies: the MLX native package occupied roughly 306 MiB; the ONNX Node and web runtime packages occupied roughly 287 MiB and 140 MiB respectively, before model weights. These are observed installed package sizes, not minimal Mac-only deployment sizes or tarball download sizes.

## Dedicated-head and context checks

The ONNX candidates retained their trained decision/classification heads. They were not run as chat models. GLiNER needed a small local adapter because the published `open-jev@0.1.2` package does not include its newer GLiNER integration. That adapter matched all input IDs and label-marker positions in six upstream reference examples. Its q4 outputs matched the fp32 reference argmax on 12 of 13 questions, with a worst probability difference of 0.0752. This is a limited quantized-export check, not exhaustive parity validation.

OpenJev and GLiNER rejected all four long examples due to their 512-token limits. Those failures must route to the existing reviewer. Silently truncating would remove the deciding code at the end of the script.

The llama.cpp paths used ordinary language-model token scoring. The MLX path used short label generation. Neither is presented as a native Kev-style pointer head. Current Kev 0.8B/4B MLX support is not automatically available through the tested Node binding's public model interfaces. Magnitude's embeddable Node decision API was not established, so it was not installed or benchmarked.

## Pinned artifacts

The full file manifest, hashes, and sizes are in `artifacts.json` in the isolated working directory. Revisions below identify the exact downloaded artifacts.

| Model repository | Revision |
| --- | --- |
| `unsloth/Qwen3.5-0.8B-GGUF` | `6ab461498e2023f6e3c1baea90a8f0fe38ab64d0` |
| `unsloth/Qwen3.5-2B-GGUF` | `f6d5376be1edb4d416d56da11e5397a961aca8ae` |
| `unsloth/Qwen3.5-4B-GGUF` | `e87f176479d0855a907a41277aca2f8ee7a09523` |
| `unsloth/Qwen3-4B-Instruct-2507-GGUF` | `a06e946bb6b655725eafa393f4a9745d460374c9` |
| `mlx-community/Qwen3.5-0.8B-4bit` | `da28692b5f139cb0ec58a356b437486b7dac7462` |
| `onnx-community/kev-0.6b-ONNX` | `5a827091b3d58fe4fdfc02a5a5b2ce364047d678` |
| `onnx-community/open-jev-deberta-v3-large-ONNX` | `7c79f25b5ac496089f448a969c801872ad59d31c` |
| `onnx-community/GLiNER2.5-Decide-ONNX` | `18271032588167fe9a3fbb8c5a4900b1231f8119` |

## Evidence and limits

The temporary directory contains benchmark source, inert cases, dependency lockfile, pinned weights, raw per-call JSONL, per-configuration summaries, `results.json`, the Pi loader probe, worker probe, GLiNER parity results, and the MLX cache-control results. These files remain outside the repository and may eventually be removed by system temporary-directory cleanup.

This was one Mac, one compact policy formulation, a small synthetic dataset, and one sequential caller. Thermal/power behavior, concurrency, cancellation, extension reload, cold-disk startup, older Macs, and production reviewer latency were not validated. No clean same-model/same-quantization/same-decision-interface runtime speed ratio was measured. No selected threshold was calibrated or validated against independent real approval traffic.

The spike is complete. The report remains active for review; production integration is not approved by these results.
