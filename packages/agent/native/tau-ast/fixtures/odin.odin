package fixture

import "core:math"
import fmt "core:fmt"
import unused "core:strings"
foreign import libc "system:c"

// Smallest useful tolerance.
// Used by geometry comparisons.
EPSILON :: 1e-6
Vec2 :: distinct [2]f32
Radians :: f32
Callback :: #type proc "contextless"(value: Vec2) -> bool

Circle :: struct {
	center: Vec2,
	radius: f32,
	bounds_min, bounds_max: Vec2,
}

Shape_Kind :: enum {
	Circle,
	Segment = Circle,
}

Shape_Set :: bit_set[Shape_Kind]
Value :: union {
	int,
	string,
	fmt.Formatter,
}

Permissions :: bit_field u8 {
	Read: u8 | 0,
	Write: u8 | 1,
}

debug_iterations: int
initialized: int = 3
typed_limit: int : 4
@(private="file")
hidden_cache: int
first_count, second_count := 1, 2

vec2_length :: proc(v: Vec2) -> f32 {
	return math.sqrt(v.x * v.x + v.y * v.y)
}

lerp :: proc {
	lerp_f32,
	lerp_vec2,
}

@(require_results)
map_value :: proc "contextless"($T: typeid, value: T, fallback := value) -> (result: T, ok: bool) {
	fmt.println(value)
	return fallback, true
}

foreign libc {
	strlen :: proc "c"(text: cstring) -> uintptr ---
}

@(private)
hidden_length :: proc(v: Vec2) -> f32 {
	return v.x * v.x + v.y * v.y
}
