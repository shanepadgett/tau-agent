# Tau Go Extension System Notes

## Goal

Tau is a native Go coding-agent TUI.

The desired extension model should give users Pi-style control while keeping the host app native, fast, and full-screen.

Users should be able to:

- Add custom tools.
- Disable or replace built-in tools.
- Add commands.
- Add lifecycle hooks.
- Add custom TUI components.
- Customize tool renderers, panels, status bars, overlays, and session views.
- Use Go as the extension language where possible.
- Avoid a compile step for common extension work.
- Keep the host app performant.
- Allow deeper native extension paths later.

The core product goal is:

```text
Go app
Go-authored extensions
same Tau SDK
same UI concepts
hot reload
native-feeling full-screen TUI
trusted local customization
```

Pi took off partly because its extensions are written in the same language as the app, TypeScript, and can work with the same ecosystem. Tau should aim for the Go equivalent.

---

## Recommended High-Level Architecture

Use Go as the primary extension authoring language through an interpreted runtime, likely Yaegi.

Use Bubble Tea internally for the main app runtime.

Expose a Tau SDK instead of exposing Bubble Tea internals directly.

```text
Tau core
  Go
  Bubble Tea
  Lip Gloss / Bubbles
  native tools
  model providers
  permission engine
  event bus
  extension host

Trusted Tau extensions
  Go source
  Yaegi
  hot reload
  Tau SDK
  custom tools
  custom commands
  custom TUI components
  context hooks
  policy hooks

Later extension paths
  compiled Go sidecars
  WASM via wazero
  MCP / subprocess integrations
```

The first-class path should be trusted local Go extensions.

WASM is useful later for sandboxing or a marketplace, but it adds ABI and SDK complexity.

---

## Why Not Go's Standard `plugin` Package?

Go has a standard `plugin` package, but it is a poor fit for user-installed extensions.

Problems:

- Requires compiled `.so` plugins.
- Platform support is limited.
- Host and plugin must match Go versions, build flags, shared dependency versions, and build environment closely.
- Plugins cannot be unloaded.
- Deployment gets brittle.
- Better suited for first-party or tightly controlled builds.

Use it only if absolutely needed for internal, same-build native extensions.

---

## Primary Runtime: Yaegi

Yaegi is the best match for Pi-style ergonomics in Go.

It allows users to write Go source files and load them without compiling Tau.

Example extension layout:

```text
~/.tau/extensions/repo-health/main.go
.tau/extensions/repo-health/main.go
```

Example extension:

```go
package main

import (
    "github.com/tau-agent/sdk"
    "github.com/tau-agent/sdk/ui"
)

func Register(api sdk.API) {
    api.RegisterCommand("repo-health", func(ctx sdk.CommandContext, args []string) {
        ctx.UI().OpenPanel("repo-health", nil)
    })

    api.RegisterComponent("repo-health", func() ui.Component {
        return &RepoHealth{}
    })
}
```

The main value:

- Same language as Tau.
- No compile step.
- Hot reload possible.
- Good local customization story.
- Extension code can feel native to Go developers.

Tradeoff:

- Extensions run in-process.
- They should be treated as trusted code.
- Capabilities and host APIs still matter.
- Panics, infinite loops, memory growth, and blocking calls can affect Tau.

This is similar in spirit to Pi's trust tradeoff with TypeScript extensions.

---

## Secondary Runtime: WASM via wazero

WASM should be considered for a later sandboxed/plugin-marketplace path.

wazero is a strong Go-native WASM runtime:

- Pure Go.
- No CGO.
- Embeds directly into Go apps.
- Can sandbox modules.
- Supports languages that compile to WASM.

Good for:

- Marketplace plugins.
- Distribution without source.
- Stronger isolation.
- Language-neutral plugin support.
- Capability-controlled execution.

Downside:

- Harder authoring experience.
- Requires a stable ABI.
- More ceremony around strings, memory, calls, and data exchange.
- Custom TUI SDK becomes harder to make ergonomic.

Recommended split:

```text
Yaegi Go extensions
  trusted local customization
  best developer experience
  Pi-like feel

WASM extensions
  sandboxed distribution
  marketplace path
  stricter ABI
```

---

## Compiled Native Sidecar Extensions

For maximum flexibility and performance, support compiled sidecar binaries later.

A sidecar extension is a normal Go binary that talks to Tau over RPC or stdio.

Advantages:

- Extension authors can import anything.
- Full Go module support.
- Native compiled speed.
- Process isolation.
- No Yaegi package limitations.
- Easier crash containment than in-process plugins.

Disadvantages:

- Requires compilation.
- More complex lifecycle.
- RPC protocol needed.
- TUI integration needs a clean protocol.

Useful for:

- Heavy integrations.
- Complex dependencies.
- LSP-like services.
- Long-running background workers.
- Native tools that need performance.

---

## Bubble Tea Integration

Bubble Tea should remain Tau's internal app runtime.

Bubble Tea's native model is:

```go
type Model interface {
    Init() tea.Cmd
    Update(tea.Msg) (tea.Model, tea.Cmd)
    View() string
}
```

This is excellent inside Tau.

It is risky as a public extension API because:

- `tea.Msg` can be arbitrary Go values.
- `tea.Cmd` is a Go function.
- Plugins can emit messages Tau does not understand.
- Plugins can block or panic during `Update`.
- Extensions couple to Tau's internal message types.
- Refactors become harder.
- WASM or sidecar plugins cannot implement this cleanly.

Recommended approach:

Expose a Tau component interface that resembles Bubble Tea but remains stable.

```go
type Component interface {
    Init(ctx Context)
    Update(ctx Context, event Event)
    View(ctx Context) string
}
```

Tau internally adapts this to Bubble Tea.

This gives extension authors a familiar lifecycle without giving them direct ownership of the terminal runtime.

---

## Lip Gloss and Bubbles in Extensions

Lip Gloss should be usable by extensions.

It is mostly styling and string composition.

Example:

```go
func (w *Widget) View(ctx ui.Context) string {
    return lipgloss.NewStyle().
        Border(lipgloss.RoundedBorder()).
        Padding(1, 2).
        Render("hello from extension")
}
```

Practical issue:

Yaegi cannot always import arbitrary Go modules the same way compiled Go does.

For good UX, Tau should expose blessed SDK packages:

```go
import "github.com/tau-agent/sdk/ui"
import "github.com/tau-agent/sdk/lipgloss"
import "github.com/tau-agent/sdk/bubbles/list"
import "github.com/tau-agent/sdk/bubbles/spinner"
```

These can be wrappers, re-exports, or carefully exposed packages.

Recommended default:

- Let extensions use Tau UI helpers.
- Let them use Lip Gloss-like styling.
- Provide curated Bubbles wrappers.
- Avoid arbitrary dependency loading in the trusted interpreted path at first.

For arbitrary dependencies, use compiled sidecar extensions.

---

## Custom TUI Components

The desired extension authoring experience should feel like Go code, not JSON.

Do not make users hand-author render trees.

A component should look like:

```go
type RepoHealth struct {
    output  string
    running bool
}

func (r *RepoHealth) Init(ctx ui.Context) {
    ctx.Subscribe("tool.completed")
}

func (r *RepoHealth) Update(ctx ui.Context, ev ui.Event) {
    switch ev.Type {
    case ui.Key:
        if ev.Key == "r" {
            r.running = true
            ctx.CallTool("shell", map[string]any{
                "cmd": "go test ./...",
            })
        }

    case "tool.completed":
        r.running = false
        r.output = ev.Text
    }
}

func (r *RepoHealth) View(ctx ui.Context) string {
    b := ui.NewBuilder(ctx.Width())

    b.Title("Repo health")

    if r.running {
        b.Line("Running tests...")
    }

    b.CodeBlock(r.output)
    b.Help("r", "run tests")

    return b.String()
}
```

Or with a fluent builder:

```go
func (r *RepoHealth) View(ctx ui.Context) string {
    return ui.Panel(ctx.Width()).
        Title("Repo health").
        Row(
            ui.Badge("Tests", r.testStatus),
            ui.Badge("Lint", r.lintStatus),
            ui.Badge("Diff", r.diffStatus),
        ).
        Button("run", "Run checks").
        Log(r.output).
        Help("r", "run").
        String()
}
```

Internally, Tau can use strings, nodes, or render trees.

The user-facing API should be Go.

---

## Should Components Return Strings or Nodes?

Start with strings for maximum flexibility.

```go
View(ctx ui.Context) string
```

This allows extensions to:

- Use Lip Gloss.
- Use Tau builders.
- Compose raw terminal output.
- Use their own formatting logic.

For structured components, Tau can also support an optional node API:

```go
ViewNode(ctx ui.Context) ui.Node
```

But do not force users into a declarative JSON-like surface.

Recommended approach:

```go
type Component interface {
    Init(ctx Context)
    Update(ctx Context, event Event)
    View(ctx Context) string
}
```

Later, optionally add:

```go
type NodeComponent interface {
    Init(ctx Context)
    Update(ctx Context, event Event)
    ViewNode(ctx Context) Node
}
```

Tau can render both.

---

## Event Model

Normalize Bubble Tea messages into Tau UI events.

Example event types:

```text
key
mouse
resize
focus
blur
tick
component.action
tool.started
tool.completed
tool.failed
session.loaded
message.received
model.response.delta
model.response.complete
workspace.changed
file.changed
```

Example:

```go
func (r *RepoHealth) Update(ctx ui.Context, ev ui.Event) {
    switch ev.Type {
    case ui.Key:
        if ev.Key == "r" {
            ctx.CallTool("shell", map[string]any{
                "cmd": "go test ./...",
            })
        }

    case "tool.completed":
        r.output = ev.Text
    }
}
```

Tau owns:

- Focus.
- Key routing.
- Mouse routing.
- Global layout.
- Terminal rendering.
- Command scheduling.
- Tool execution.
- Permissions.

Extensions respond to normalized events.

---

## Effects and Commands

Bubble Tea commands are functions.

Do not expose raw `tea.Cmd` as the extension API.

Instead, components should call Tau context methods or return declarative effects.

Examples:

```go
ctx.CallTool("shell", map[string]any{
    "cmd": "go test ./...",
})

ctx.UI().OpenPanel("repo-health", nil)
ctx.UI().Toast("Running tests")
ctx.Workspace().ReadFile("go.mod")
```

Tau converts these into internal Bubble Tea commands.

This keeps async work under Tau's scheduler and permission system.

---

## Extension Surfaces

Tau should expose four major extension surfaces.

### 1. Tools

Users can add or replace agent tools.

```go
api.RegisterTool(sdk.Tool{
    Name:        "safe-test",
    Description: "Runs the project test suite",
    Schema: sdk.Schema{
        "package": sdk.String().Optional(),
    },
    Execute: func(ctx sdk.ToolContext, args sdk.Args) (sdk.ToolResult, error) {
        return ctx.RunCommand("go test ./...")
    },
})
```

Disable built-ins:

```go
api.DisableTool("shell")
api.DisableTool("edit")
api.RegisterTool(MyShell{})
```

### 2. Events

Users can hook into agent lifecycle events.

```go
api.On("before_tool_call", func(ctx sdk.Context, ev sdk.ToolCallEvent) sdk.Decision {
    if ev.Tool == "shell" && strings.Contains(ev.Command(), "rm -rf") {
        return sdk.Block("blocked dangerous command")
    }

    return sdk.Allow()
})
```

Recommended events:

```text
session.start
session.restore
message.before_send
message.after_receive
context.build
context.compact
tool.before_call
tool.after_call
tool.failed
model.before_request
model.after_response
ui.focus_changed
workspace.changed
file.changed
```

### 3. Commands

Users can add slash commands or command palette entries.

```go
api.RegisterCommand("tests", func(ctx sdk.CommandContext, args []string) {
    ctx.UI().OpenPanel("repo-health", nil)
})
```

### 4. TUI Components

Users can register UI components.

```go
api.RegisterComponent("repo-health", func() ui.Component {
    return &RepoHealth{}
})
```

Mount options:

```go
ctx.UI().OpenPanel("repo-health", nil)
ctx.UI().OpenOverlay("review-dialog", nil)
ctx.UI().SetStatusWidget("token-meter")
ctx.UI().SetToolRenderer("go-test", "go-test-viewer")
```

---

## Tool Renderers

This is a high-value customization point.

Extensions should be able to replace how tool results render.

Example:

```go
api.RegisterToolRenderer("shell", func(call sdk.ToolCall) ui.Component {
    if strings.Contains(call.Command, "go test") {
        return &GoTestRenderer{Call: call}
    }

    return nil
})
```

This enables:

- Custom test output viewers.
- Git diff viewers.
- Log viewers.
- Diagnostic renderers.
- Approval cards.
- File previewers.
- Build status panels.

This will make Tau feel more customizable than a basic plugin system.

---

## Regions and Layout

Tau should own global layout.

Extensions should mount into named regions.

Example config:

```toml
[[ui.widgets]]
plugin = "repo-health"
component = "repo-health"
region = "right_panel"

[ui.widgets.props]
watch = ["go.mod", "internal/**"]
```

Possible regions:

```text
left_panel
right_panel
bottom_panel
status_bar
message_header
message_footer
tool_result
overlay
command_palette
session_sidebar
```

Tau sends components context:

```go
type Context interface {
    Width() int
    Height() int
    Focused() bool
    Theme() Theme
}
```

Extensions should not own the whole screen unless explicitly opened as a full-screen view.

---

## Permissions and Trust

Pi-style control implies trusted code.

Tau should be honest about that.

Suggested docs language:

```text
Tau Go extensions are trusted local code.
They can alter agent behavior, UI, tool execution, and project state through granted APIs.
Only install extensions you trust.
```

Use capability gates anyway.

Example manifest:

```toml
name = "repo-health"
version = "0.1.0"
tau = ">=0.3 <0.5"

capabilities = [
  "ui",
  "tools.register",
  "workspace.read",
  "shell.run",
]
```

Runtime API:

```go
func Register(api sdk.API) {
    api.Require(
        sdk.CapUI,
        sdk.CapTools,
        sdk.CapReadWorkspace,
        sdk.CapRunCommands,
    )
}
```

Tau should prompt before enabling project-local extensions:

```text
Extension repo-health wants:
  read workspace files
  run shell commands
  register tools
  add UI panels

Enable for this project?
```

---

## Avoid Ambient OS Access by Default

Do not expose these to Yaegi extensions by default:

```go
os
os/exec
net/http
syscall
unsafe
```

Instead expose Tau APIs:

```go
ctx.Workspace().ReadFile(path)
ctx.Workspace().WriteFile(path, data)
ctx.Tools().Call("shell", args)
ctx.HTTP().Get(url)
ctx.Secrets().Get(name)
```

That allows Tau to:

- Prompt.
- Log.
- Deny.
- Replay.
- Audit.
- Apply project trust settings.

Optionally allow unsafe mode:

```toml
[extensions.repo-health]
unsafe = true
```

Unsafe mode can expose more raw packages for users who explicitly want full local automation.

---

## Hot Reload and Dev UX

Hot reload is critical.

Target workflow:

```text
edit .tau/extensions/foo/main.go
/tau reload
component remounts
errors appear in extension inspector
```

CLI commands:

```text
tau extensions list
tau extensions trust
tau extensions reload
tau extensions logs foo
tau extensions scaffold component repo-health
```

TUI commands:

```text
/reload
/extensions
/logs foo
/dev inspect-ui
```

Extension inspector should show:

- Loaded extensions.
- Registered tools.
- Registered commands.
- Registered components.
- Mounted components.
- Event handlers.
- Capabilities.
- Last panic/error.
- Render duration.
- Update duration.
- Tool calls made by extension.

Debugging needs to be first-class if Tau wants an ecosystem.

---

## Versioning

Keep Tau internals private.

Stabilize the SDK.

Manifest:

```go
func Manifest() sdk.Manifest {
    return sdk.Manifest{
        Name:       "repo-health",
        Version:    "0.1.0",
        TauVersion: ">=0.3 <0.5",
    }
}
```

Or TOML:

```toml
name = "repo-health"
version = "0.1.0"
tau = ">=0.3 <0.5"
```

Do not promise Bubble Tea internals are stable.

Promise `sdk`, `sdk/ui`, and selected extension APIs are stable.

---

## Alternative Go TUI Frameworks

Bubble Tea is not the only full-screen TUI framework in Go.

Options:

### Bubble Tea

Elm-style architecture.

Great for modern full-screen TUIs, async commands, composition, and the Charm ecosystem.

Best fit for Tau if the app wants a polished modern agent UI.

### Lip Gloss

Not a full TUI framework.

Styling and layout library for terminal strings.

Useful with Bubble Tea or other renderers.

Extensions should probably be allowed to use it or a Tau wrapper around it.

### Bubbles

Component library from Charm.

Includes widgets like lists, spinners, progress bars, text inputs, textareas, viewports, etc.

Good source of building blocks.

### tview

Traditional widget toolkit built on tcell.

Includes forms, tables, trees, flex/grid layouts, pages, modals.

Good if Tau wants a batteries-included widget toolkit instead of Bubble Tea's Elm-style architecture.

### tcell

Lower-level terminal screen library.

More control, more work.

Useful if Tau eventually wants to own the terminal rendering layer completely.

### gocui

View-manager style library with rectangular panes.

Simpler and older-feeling.

Could work, but probably less appealing for a modern agent TUI.

### termui

Dashboard-style widgets.

Good for charts, gauges, lists, and tables.

Less ideal for a rich coding-agent interface.

### go-tui

Newer declarative TUI framework with template-style UI ideas.

Worth evaluating, but Bubble Tea has more mindshare and ecosystem.

Recommendation:

Use Bubble Tea + Lip Gloss + selected Bubbles unless Tau wants a more traditional widget toolkit, in which case evaluate tview.

---

## Main Design Decisions

### 1. Extension language

Primary: Go via Yaegi.

Later: WASM via wazero, compiled sidecars.

### 2. TUI API

Do not expose raw Bubble Tea as the public contract.

Expose Tau's own component interface.

Allow Lip Gloss-style rendering inside component `View`.

### 3. Plugin trust

Treat interpreted Go extensions as trusted local code.

Add capability gates for dangerous Tau APIs.

### 4. Performance

Keep heavy work in native Tau core.

Extensions coordinate and render.

Use compiled sidecars for heavy plugin workloads.

### 5. Flexibility

Let users customize tools, commands, events, context hooks, component regions, tool renderers, and panels.

### 6. UX

Hot reload, good errors, extension inspector, scaffold commands, and stable SDK matter as much as runtime choice.

---

## Proposed Minimal v1

### Runtime

- Yaegi extension loader.
- Global extension directory.
- Project-local extension directory gated by trust.
- `/reload` command.

### SDK

- `sdk.API`
- `sdk.Tool`
- `sdk.CommandContext`
- `sdk.ToolContext`
- `sdk.Event`
- `sdk.Decision`
- `ui.Component`
- `ui.Context`
- `ui.Event`
- `ui.Panel`
- Basic UI helpers.

### Extension capabilities

- Register tools.
- Disable tools.
- Register commands.
- Register components.
- Open panel/overlay/status widget.
- Subscribe to basic events.
- Read workspace through Tau API.
- Call tools through Tau API.

### TUI

- Bubble Tea internal host.
- Tau component adapter.
- Lip Gloss-style rendering.
- Named layout regions.

### Safety

- Manifest capabilities.
- Project trust prompt.
- No raw OS packages by default.
- Extension logs and panic recovery.

---

## Proposed v1.5

- Tool result renderers.
- Hot reload state preservation.
- Extension inspector.
- Better Bubbles wrappers.
- Component snapshot tests.
- Extension scaffold generator.
- Extension packaging format.
- Per-extension config.
- Extension-level telemetry timings.

---

## Proposed v2

- WASM runtime via wazero.
- Compiled sidecar extension protocol.
- Marketplace/distribution story.
- More complete UI component kit.
- Plugin dependency management.
- Signed extension packages.
- Advanced policy hooks.
- First-class MCP integration.

---

## Core Recommendation

Build Tau's extension system around trusted Go source extensions interpreted by Yaegi.

Keep Bubble Tea internal.

Expose a Tau UI SDK that feels Go-native and lets users use Lip Gloss-style rendering.

Support deep customization:

- Tools.
- Tool replacement.
- Commands.
- Event hooks.
- Context hooks.
- Panels.
- Status widgets.
- Tool renderers.
- Full-screen extension views.

Add WASM and compiled sidecars later for sandboxing, distribution, and high-performance advanced plugins.

The product bet:

```text
Go is the extension language.
Bubble Tea is the internal runtime.
Tau SDK is the stable contract.
Extensions are trusted local customization by default.
```
