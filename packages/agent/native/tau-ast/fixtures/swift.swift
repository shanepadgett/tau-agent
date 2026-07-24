import Foundation

protocol Parser {
    func parse(source: String) -> Result
}

struct Result {
    let ok: Bool
}

final class FileParser: Parser {
    func parse(source: String) -> Result {
        Result(ok: !source.trimmingCharacters(in: .whitespaces).isEmpty)
    }
}

func createParser() -> some Parser {
    FileParser()
}
