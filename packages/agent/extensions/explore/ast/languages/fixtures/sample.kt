package com.demo

/** Greeter */
class Greeter(val name: String) {
    fun hello() {}
    companion object {
        fun create() = Greeter("x")
    }
}

internal fun top() {}

object Singleton

enum class Color { RED, GREEN }
