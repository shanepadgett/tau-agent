import AppKit
import CoreGraphics
import Darwin
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

enum AppshotError: LocalizedError {
    case invalidArguments
    case unsupportedOS
    case processNotFound(pid_t)
    case activationFailed(pid_t)
    case permissionDenied
    case windowNotFound(CGWindowID)
    case imageDestination
    case imageWrite

    var errorDescription: String? {
        switch self {
        case .invalidArguments:
            return "Usage: tau-appshot <list|capture|activate> [arguments]"
        case .unsupportedOS:
            return "Appshot requires macOS 14 or newer"
        case let .processNotFound(pid):
            return "No running application found for PID \(pid)"
        case let .activationFailed(pid):
            return "Could not activate application PID \(pid)"
        case .permissionDenied:
            return "Screen recording permission is required. In System Settings > Privacy & Security > Screen & System Audio Recording, grant access to the application running Tau (and tau-appshot if listed), then try again"
        case let .windowNotFound(windowID):
            return "No visible normal window found for window ID \(windowID); call list_windows again"
        case .imageDestination:
            return "Could not create the PNG destination"
        case .imageWrite:
            return "Could not write the captured PNG"
        }
    }
}

@main
struct TauAppshot {
    static func main() async {
        do {
            guard #available(macOS 14.0, *) else {
                throw AppshotError.unsupportedOS
            }
            let application = NSApplication.shared
            application.setActivationPolicy(.prohibited)
            application.finishLaunching()

            guard CommandLine.arguments.count >= 2 else {
                throw AppshotError.invalidArguments
            }
            switch CommandLine.arguments[1] {
            case "list":
                try await listWindows()
            case "capture":
                try await captureWindow()
            case "activate":
                try await activateApplication()
            default:
                throw AppshotError.invalidArguments
            }
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            FileHandle.standardError.write(Data("\(message)\n".utf8))
            exit(EXIT_FAILURE)
        }
    }

    static func requireScreenCapturePermission() throws {
        guard CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() else {
            throw AppshotError.permissionDenied
        }
    }

    @available(macOS 14.0, *)
    static func listWindows() async throws {
        guard CommandLine.arguments.count == 2 else {
            throw AppshotError.invalidArguments
        }
        try requireScreenCapturePermission()
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        let windows: [[String: Any]] = content.windows
            .filter({ window in
                window.windowLayer == 0
                    && window.frame.width > 0
                    && window.frame.height > 0
                    && window.owningApplication != nil
            })
            .sorted(by: { lhs, rhs in
                let leftName = lhs.owningApplication?.applicationName ?? ""
                let rightName = rhs.owningApplication?.applicationName ?? ""
                if leftName != rightName {
                    return leftName.localizedCaseInsensitiveCompare(rightName) == .orderedAscending
                }
                return lhs.windowID < rhs.windowID
            })
            .map({ window in
                let owner = window.owningApplication
                return [
                    "window_id": Int(window.windowID),
                    "title": window.title ?? "",
                    "app_name": owner?.applicationName ?? "",
                    "bundle_id": owner?.bundleIdentifier ?? "",
                    "pid": Int(owner?.processID ?? 0),
                    "bounds": [
                        "x": window.frame.origin.x,
                        "y": window.frame.origin.y,
                        "width": window.frame.width,
                        "height": window.frame.height,
                    ],
                ]
            })
        let data = try JSONSerialization.data(withJSONObject: windows, options: [.sortedKeys])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }

    @available(macOS 14.0, *)
    static func captureWindow() async throws {
        guard CommandLine.arguments.count == 4,
              let windowID = CGWindowID(CommandLine.arguments[2]),
              windowID > 0
        else {
            throw AppshotError.invalidArguments
        }
        let outputPath = CommandLine.arguments[3]
        try requireScreenCapturePermission()

        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let window = content.windows.first(where: {
            $0.windowID == windowID
                && $0.windowLayer == 0
                && $0.frame.width > 0
                && $0.frame.height > 0
        }) else {
            throw AppshotError.windowNotFound(windowID)
        }

        let filter = SCContentFilter(desktopIndependentWindow: window)
        let configuration = SCStreamConfiguration()
        let pixelWidth = filter.contentRect.width * CGFloat(filter.pointPixelScale)
        let pixelHeight = filter.contentRect.height * CGFloat(filter.pointPixelScale)
        let scale = min(1, 1568 / max(pixelWidth, pixelHeight))
        configuration.width = max(1, Int(floor(pixelWidth * scale)))
        configuration.height = max(1, Int(floor(pixelHeight * scale)))
        configuration.showsCursor = false
        configuration.ignoreShadowsSingleWindow = true

        let image = try await SCScreenshotManager.captureImage(
            contentFilter: filter,
            configuration: configuration
        )
        let outputURL = URL(fileURLWithPath: outputPath)
        guard let destination = CGImageDestinationCreateWithURL(
            outputURL as CFURL,
            UTType.png.identifier as CFString,
            1,
            nil
        ) else {
            throw AppshotError.imageDestination
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw AppshotError.imageWrite
        }
    }

    static func activateApplication() async throws {
        guard CommandLine.arguments.count == 3,
              let pid = pid_t(CommandLine.arguments[2]),
              pid > 0
        else {
            throw AppshotError.invalidArguments
        }
        guard let application = NSRunningApplication(processIdentifier: pid) else {
            throw AppshotError.processNotFound(pid)
        }
        guard application.activate(options: [.activateAllWindows]) else {
            throw AppshotError.activationFailed(pid)
        }
        for _ in 0..<20 where !application.isActive {
            try await Task.sleep(for: .milliseconds(100))
        }
        guard application.isActive else {
            throw AppshotError.activationFailed(pid)
        }
    }
}
