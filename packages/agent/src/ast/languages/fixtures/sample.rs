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
}

impl Draw for Point {
    fn draw(&self) {}
}

pub mod nested {
    pub fn inner() {}
}

pub const MAX: i32 = 10;
pub type Alias = i32;

fn private_fn() {}
