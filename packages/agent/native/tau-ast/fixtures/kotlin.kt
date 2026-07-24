package fixture

interface Parser {
    fun parse(source: String): Result
}

data class Result(val ok: Boolean)

class FileParser : Parser {
    override fun parse(source: String): Result {
        return Result(source.isNotBlank())
    }
}

fun createParser(): Parser = FileParser()
