package com.demo

import kotlin.collections.List

/** Greeter */
class Greeter(val name: String) {
	fun hello() {}

	companion object {
		fun create(): Greeter = Greeter("x")
	}
}

internal fun top() {}

object Singleton {
	const val ID = 1
}

enum class Color {
	RED,
	GREEN,
}

interface Named {
	fun name(): String
}

data class Point(val x: Int, val y: Int)

typealias Alias = Greeter
