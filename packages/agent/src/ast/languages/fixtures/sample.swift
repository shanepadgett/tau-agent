import Foundation

/// Greeter type
public class Greeter {
    public var name: String = ""
    public init() {}
    public func hello() {}
}

extension Greeter {
    public func shout() {}
}

public protocol Named {
    func name()
}

internal struct Box {
    var value: Int
}

private enum Color {
    case red
    case green
}
