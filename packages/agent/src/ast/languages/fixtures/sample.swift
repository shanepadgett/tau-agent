import Foundation

/// Greeter type
public class Greeter: Named {
	public var name: String = ""

	public init() {}

	public init(name: String) {
		self.name = name
	}

	public func hello() {
		print("hi \(name)")
	}

	deinit {}
}

extension Greeter {
	public func shout() {
		print(name.uppercased())
	}
}

public protocol Named {
	var name: String { get }
	func nameLabel()
}

internal struct Box {
	var value: Int
}

private enum Color {
	case red
	case green
}

public typealias Alias = Greeter

public enum Result {
	case ok(Int)
	case err(String)
}
