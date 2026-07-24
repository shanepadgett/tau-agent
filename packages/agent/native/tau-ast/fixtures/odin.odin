package fixture

import "core:math"

EPSILON :: 1e-6
Vec2 :: distinct [2]f32
Radians :: f32

Circle :: struct {
	center: Vec2,
	radius: f32,
}

Shape_Kind :: enum {
	Circle,
	Segment,
}

Shape_Set :: bit_set[Shape_Kind]
debug_iterations: int

vec2_length :: proc(v: Vec2) -> f32 {
	return math.sqrt(v.x * v.x + v.y * v.y)
}

lerp :: proc {
	lerp_f32,
	lerp_vec2,
}

@(private)
hidden_length :: proc(v: Vec2) -> f32 {
	return v.x * v.x + v.y * v.y
}
