package demo

import "core:fmt"

// Add two ints
add :: proc(a: int, b: int) -> int {
	return a + b
}

Point :: struct {
	x: int,
	y: int,
}

Color :: enum {
	Red,
	Green,
}

Value :: union {
	int,
	f32,
}

PI :: 3.14

@(private)
secret :: proc() {}
