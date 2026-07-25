@file:Suppress("unused")

package fixture

import fixture.types.Input
import fixture.types.Output as ResultAlias
import fixture.types.*
import kotlin.collections.Set

/** Parses source values. */
interface Parser {
    fun parse(source: String): Result
}

data class Result(val ok: Boolean)

/** File-backed parser. */
@Deprecated("fixture")
sealed class FileParser<T : Any> internal constructor(
    val input: Input,
    private var hidden: Int = 1,
) : Parser where T : Comparable<T> {
    init {
        check(hidden >= 0)
    }

    internal constructor(input: Input) : this(input, 2) {
        run {
            check(input.toString().isNotEmpty())
        }
    }

    protected val computed: String
        get() = input.toString()

    private var mutable: Int = 0
        get() = field
        set(value) {
            field = value
        }

    override fun parse(source: String): Result {
        return Result(source.isNotBlank())
    }

    fun alias(output: ResultAlias): ResultAlias = output

    fun String.memberExtension(): String = trim()

    companion object Named {
        const val LIMIT = 3
        fun create(input: Input): FileParser<String> = FileParser(input)
    }

    object Nested {
        val marker = true
    }
}

enum class State {
    READY,
    FAILED {
        override fun toString(): String = "failed"
    };

    fun done(): Boolean = true
}

public object Defaults {
    val enabled = true
}

typealias ParserFactory = (Input) -> Parser

internal val String.trimmed: String
    get() = trim()

fun createParser(input: Input): Parser = FileParser<String>(input)
