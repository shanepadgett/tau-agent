#![allow(dead_code)]

use std::{fmt::Debug, path::Path};
use std::collections::*;
pub use std::io::Result as IoResult;
extern crate alloc as allocation;

mod hidden_mod {
    pub struct Reexported;
}

pub use hidden_mod::Reexported;

/// Default parser capacity.
pub const DEFAULT_LIMIT: usize = 10;
pub(crate) static INTERNAL_LIMIT: usize = 2;

pub type Value<T> = Option<T>;

#[derive(Debug)]
pub struct Pair<T>
where
    T: Debug,
{
    pub left: T,
    right: T,
}

pub struct Tuple<T>(pub T, String) where T: Clone;
pub struct Unit;

pub union Bits {
    pub value: u32,
    bytes: [u8; 4],
}

pub enum State<T> {
    Ready,
    Data(T),
    Named { value: T },
}

pub trait Parser {
    type Output;
    const LIMIT: usize;

    fn parse(&self, source: &Path) -> Self::Output;

    fn ready(&self) -> bool {
        true
    }
}

pub struct FileParser;

impl Parser for FileParser {
    type Output = Value<bool>;
    const LIMIT: usize = DEFAULT_LIMIT;

    fn parse(&self, source: &Path) -> Self::Output {
        Some(source.exists())
    }
}

impl FileParser {
    pub async fn parse_async<T>(&self, source: T) -> Value<bool>
    where
        T: AsRef<Path>,
    {
        Some(source.as_ref().exists())
    }

    pub(crate) fn internal(&self) {}
}

pub mod nested {
    pub struct Public;
    struct Private;

    impl Public {
        pub fn build() -> Self {
            Self
        }
    }
}

struct Hidden;

impl Hidden {
    pub fn exposed() -> Self {
        Self
    }
}

impl Parser for Hidden {
    type Output = ();
    const LIMIT: usize = 0;

    fn parse(&self, _source: &Path) -> Self::Output {}
}

trait PrivateTrait {
    fn secret(&self);
}

impl PrivateTrait for FileParser {
    fn secret(&self) {}
}

#[macro_export]
macro_rules! parser_name {
    () => {
        "fixture"
    };
}

#[macro_export(local_inner_macros)]
macro_rules! parser_tuple (
    () => {};
);

unsafe extern "C" {
    pub fn fixture_open(path: *const u8) -> i32;
    static FIXTURE_VERSION: i32;
}

pub fn create_parser() -> FileParser {
    FileParser
}

pub(crate) fn internal_parser() -> FileParser {
    FileParser
}

register_fixture!();
