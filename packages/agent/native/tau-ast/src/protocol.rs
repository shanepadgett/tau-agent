use crate::outline::{LanguageId, OutlineTarget, OutlineTargetResult, SymbolBatchResult};
use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};

pub const PROTOCOL_VERSION: u32 = 2;
const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase")]
pub enum Request {
    Handshake {
        #[serde(rename = "requestId")]
        request_id: u64,
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
    },
    Outline {
        #[serde(rename = "requestId")]
        request_id: u64,
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
        target: OutlineTarget,
        #[serde(rename = "includePrivate")]
        include_private: bool,
        names: Vec<String>,
    },
    Symbol {
        #[serde(rename = "requestId")]
        request_id: u64,
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
        locators: Vec<String>,
        #[serde(rename = "contextLines")]
        context_lines: usize,
    },
}

impl Request {
    pub fn request_id(&self) -> u64 {
        match self {
            Self::Handshake { request_id, .. }
            | Self::Outline { request_id, .. }
            | Self::Symbol { request_id, .. } => *request_id,
        }
    }

    pub fn protocol_version(&self) -> u32 {
        match self {
            Self::Handshake {
                protocol_version, ..
            }
            | Self::Outline {
                protocol_version, ..
            }
            | Self::Symbol {
                protocol_version, ..
            } => *protocol_version,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Response {
    Success(SuccessResponse),
    Error(ErrorResponse),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuccessResponse {
    pub request_id: u64,
    pub protocol_version: u32,
    pub success: bool,
    pub result: ResponseResult,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorResponse {
    pub request_id: u64,
    pub protocol_version: u32,
    pub success: bool,
    pub error: ProtocolError,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ResponseResult {
    Handshake {
        #[serde(rename = "engineVersion")]
        engine_version: &'static str,
        #[serde(rename = "supportedLanguages")]
        supported_languages: [LanguageId; 9],
    },
    Outline {
        #[serde(flatten)]
        outline: OutlineTargetResult,
    },
    Symbol {
        #[serde(flatten)]
        symbol: SymbolBatchResult,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolError {
    pub code: &'static str,
    pub message: String,
}

pub fn read_frame(reader: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut length_bytes = [0_u8; 4];
    let bytes_read = reader.read(&mut length_bytes[..1])?;
    if bytes_read == 0 {
        return Ok(None);
    }
    reader.read_exact(&mut length_bytes[1..])?;
    let length = u32::from_be_bytes(length_bytes) as usize;
    if length > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame length {length} exceeds {MAX_FRAME_BYTES} bytes"),
        ));
    }
    let mut payload = vec![0; length];
    reader.read_exact(&mut payload)?;
    Ok(Some(payload))
}

pub fn write_frame(writer: &mut impl Write, response: &Response) -> Result<(), serde_json::Error> {
    let mut payload = serde_json::to_vec(response)?;
    if payload.len() > MAX_FRAME_BYTES {
        let request_id = match response {
            Response::Success(response) => response.request_id,
            Response::Error(response) => response.request_id,
        };
        payload = serde_json::to_vec(&Response::Error(ErrorResponse {
            request_id,
            protocol_version: PROTOCOL_VERSION,
            success: false,
            error: ProtocolError {
                code: "response_too_large",
                message: format!(
                    "response frame exceeds the {MAX_FRAME_BYTES}-byte protocol limit; narrow the target"
                ),
            },
        }))?;
    }
    let length = u32::try_from(payload.len()).map_err(|_| {
        serde_json::Error::io(io::Error::new(
            io::ErrorKind::InvalidData,
            "response frame exceeds u32 length",
        ))
    })?;
    writer
        .write_all(&length.to_be_bytes())
        .and_then(|()| writer.write_all(&payload))
        .and_then(|()| writer.flush())
        .map_err(serde_json::Error::io)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn reads_length_prefixed_frame() {
        let payload = br#"{"operation":"handshake"}"#;
        let mut bytes = Vec::from((payload.len() as u32).to_be_bytes());
        bytes.extend_from_slice(payload);
        let mut cursor = Cursor::new(bytes);

        assert_eq!(
            read_frame(&mut cursor).expect("frame should read"),
            Some(payload.to_vec())
        );
        assert_eq!(read_frame(&mut cursor).expect("EOF should be clean"), None);
    }
}
