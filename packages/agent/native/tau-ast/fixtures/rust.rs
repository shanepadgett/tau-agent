use std::path::Path;

pub trait Parser {
    fn parse(&self, source: &Path) -> Result;
}

pub struct Result {
    pub ok: bool,
}

pub struct FileParser;

impl Parser for FileParser {
    fn parse(&self, source: &Path) -> Result {
        Result {
            ok: source.exists(),
        }
    }
}

pub fn create_parser() -> FileParser {
    FileParser
}

pub(crate) fn internal_parser() -> FileParser {
    FileParser
}
