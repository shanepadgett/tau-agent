# Appshot

Appshot gives Tau direct discovery and capture of macOS application windows. Tau can list visible windows as compact TOON with their application identity, title, process ID, bounds, and stable window ID; capture an exact window as a PNG for visual inspection; and bring an application forward when needed. Captures preserve aspect ratio and fit within 1568×1568 pixels to keep image payloads bounded.

The extension provides three tools:

- `list_windows` discovers visible normal windows.
- `screenshot_window` captures and inspects one listed window.
- `activate_app` brings a listed application to the foreground when visual validation requires it.

Appshot requires macOS 14 or newer. On first use, macOS asks for Screen & System Audio Recording access. If access is denied, open **System Settings → Privacy & Security → Screen & System Audio Recording** and grant access to the application running Tau, plus `tau-appshot` if macOS lists it separately.
