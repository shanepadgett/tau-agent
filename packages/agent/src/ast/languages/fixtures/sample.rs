use std::fmt::Debug;

/// Point in 2D.
#[derive(Debug, Clone)]
pub struct Point {
	pub x: i32,
	y: i32,
}

/// Drawable.
pub trait Draw {
	fn draw(&self);
}

impl Point {
	/// Origin.
	pub fn origin() -> Self {
		Self { x: 0, y: 0 }
	}

	pub fn translate(&mut self, dx: i32, dy: i32) {
		self.x += dx;
		self.y += dy;
	}
}

impl Draw for Point {
	fn draw(&self) {}
}

impl Default for Point {
	fn default() -> Self {
		Self::origin()
	}
}

pub mod nested {
	pub fn inner() {}
}

pub enum Color {
	Red,
	Green,
}

pub const MAX: i32 = 10;
pub type Alias = i32;

pub union Bits {
	i: i32,
	f: f32,
}

fn private_fn() {}
