# Tau

Tau utility commands for configuration setup and diagnostics.

## Usage

```text
/tau
/tau init [--global|--project]
/tau doctor
```

## Behavior

- `/tau` opens a TUI picker when available.
- `/tau init` writes a Tau settings file if one does not already exist.
- `/tau doctor` checks the running Pi version, Tau settings JSON, and extension settings sections.
- Startup and reload report an unsupported Pi version with the required version and an installation command. Tau does not install or upgrade Pi automatically.
