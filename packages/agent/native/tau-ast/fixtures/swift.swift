@_implementationOnly import Foundation
import struct Foundation.Date
import struct Foundation.URL
import Collections

/// Parses source values.
@available(macOS 14, *)
public protocol Parser<Input>: Sendable where Input: Hashable {
    associatedtype Output: Sendable = String
    var current: Output { get set }
    func parse(_ source: borrowing Input) async throws -> Output
    subscript(index: Int) -> Output { get }
}

public struct Result<Value: Sendable>: Sendable {
    public let value: Value
    package let packageValue: Value
    internal var cached: Value? = nil
    private var hidden: Value? = nil

    public init(_ value: consuming Value) {
        self.value = value
        self.packageValue = value
    }
}

open class FileParser: Parser {
    public typealias Input = String
    public typealias Output = String
    public var current: String { "" }
    private var secret = "hidden"

    public init() {}

    open func parse(_ source: borrowing String) async throws -> String {
        source.trimmingCharacters(in: .whitespaces)
    }

    public subscript(index: Int) -> String {
        String(index)
    }

    deinit {
        print(secret)
    }
}

public actor Store {
    public func load() async -> String { "loaded" }
}

public enum State<Value> {
    case idle
    case loaded(Value)
    fileprivate case failed(Error)
}

public typealias Handler<Value> = @Sendable (Value) async throws -> Void

public func createParser() -> some Parser {
    FileParser()
}

public func makeDate() -> Date {
    Date()
}

public prefix func ! (value: Result<Bool>) -> Bool {
    !value.value
}

prefix operator ~~~

public extension Result where Value == String {
    var text: String { value }

    func mapped() async -> String {
        value.uppercased()
    }
}

package struct PackageOnly {}
internal func internalHelper() {}
