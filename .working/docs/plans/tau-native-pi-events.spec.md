When a Tau Agent extension emits an internal Tau event, Tau Agent shall send that event through Pi's `pi.events.emit` bus.

When a Tau Agent extension subscribes to an internal Tau event, Tau Agent shall subscribe through Pi's `pi.events.on` bus.

When an external Pi extension emits `tau:autoread.requested` with the documented payload in the same Pi runtime as Tau Agent, Tau Agent shall read the requested files and inject visible `tau.autoread` messages.

When a requested autoread file cannot be read, Tau Agent shall inject a visible failed `tau.autoread` message for that file instead of throwing through the external emitter.

When `tau:autoread.requested` carries malformed payload data, Tau Agent shall ignore the malformed event instead of throwing through the external emitter.

When Tau Agent records autoread message details, Tau Agent shall preserve the caller-provided `source` string.

When Tau Agent builds Rok's system prompt, Tau Agent shall include guidance for where to find installed Tau Agent docs.

When Rok is asked about Tau Agent, Rok, Tau extensions, Tau event APIs, harness behavior, or extending Tau Agent, Rok shall read the relevant installed Tau Agent docs first.

When Rok is asked about external Tau Agent integration, Rok shall read `docs/extending-tau-agent.md` under the installed Tau Agent docs path first.

When Rok is working on normal coding tasks unrelated to Tau Agent itself, Rok shall not read Tau Agent docs just because they exist.

The public Tau Agent extension contract shall be Pi-native event channels and documented payloads.

External Pi extensions shall not need to import Tau Agent internals to trigger documented Tau Agent behavior.

Tau Agent shall document only the current public event surface needed for external integration.
