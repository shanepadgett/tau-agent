use ast_grep_core::{
    Language, Pattern, PatternError,
    matcher::PatternBuilder,
    tree_sitter::{LanguageExt, StrDoc, TSLanguage},
};
use serde::{Deserialize, Deserializer, de};
use std::borrow::Cow;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OdinLanguage {
    Odin,
}

impl<'de> Deserialize<'de> for OdinLanguage {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let language = String::deserialize(deserializer)?;
        if language.eq_ignore_ascii_case("odin") {
            Ok(Self::Odin)
        } else {
            Err(de::Error::custom(format!(
                "unsupported Odin rule language `{language}`"
            )))
        }
    }
}

impl Language for OdinLanguage {
    fn kind_to_id(&self, kind: &str) -> u16 {
        self.get_ts_language().id_for_node_kind(kind, true)
    }

    fn field_to_id(&self, field: &str) -> Option<u16> {
        self.get_ts_language()
            .field_id_for_name(field)
            .map(|field| field.get())
    }

    fn expando_char(&self) -> char {
        'µ'
    }

    fn pre_process_pattern<'query>(&self, query: &'query str) -> Cow<'query, str> {
        let mut result = String::with_capacity(query.len());
        let mut dollar_count = 0;
        for character in query.chars() {
            if character == '$' {
                dollar_count += 1;
                continue;
            }
            let sigil = if matches!(character, 'A'..='Z' | '_') || dollar_count == 3 {
                self.expando_char()
            } else {
                '$'
            };
            result.extend(std::iter::repeat_n(sigil, dollar_count));
            dollar_count = 0;
            result.push(character);
        }
        let sigil = if dollar_count == 3 {
            self.expando_char()
        } else {
            '$'
        };
        result.extend(std::iter::repeat_n(sigil, dollar_count));
        Cow::Owned(result)
    }

    fn build_pattern(&self, builder: &PatternBuilder) -> Result<Pattern, PatternError> {
        builder.build(|source| StrDoc::try_new(source, *self))
    }
}

impl LanguageExt for OdinLanguage {
    fn get_ts_language(&self) -> TSLanguage {
        tree_sitter_odin::LANGUAGE.into()
    }
}
