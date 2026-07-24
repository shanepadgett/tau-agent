mod language;
mod outline;
mod protocol;

use crate::{
    outline::{LanguageId, OutlineEngine},
    protocol::{
        ErrorResponse, PROTOCOL_VERSION, ProtocolError, Request, Response, ResponseResult,
        SuccessResponse, read_frame, write_frame,
    },
};
use std::{error::Error, io};

fn main() {
    if let Err(error) = run() {
        eprintln!("tau-ast worker failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = stdin.lock();
    let mut writer = stdout.lock();
    let mut handshake_complete = false;
    let mut engine = None;

    while let Some(payload) = read_frame(&mut reader)? {
        let request: Request = serde_json::from_slice(&payload)?;
        let request_id = request.request_id();
        let response = if request.protocol_version() != PROTOCOL_VERSION {
            error_response(
                request_id,
                "incompatible_protocol",
                format!(
                    "worker protocol is {PROTOCOL_VERSION}, request used {}",
                    request.protocol_version()
                ),
            )
        } else {
            match request {
                Request::Handshake { .. } => {
                    handshake_complete = true;
                    Response::Success(SuccessResponse {
                        request_id,
                        protocol_version: PROTOCOL_VERSION,
                        success: true,
                        result: ResponseResult::Handshake {
                            engine_version: env!("CARGO_PKG_VERSION"),
                            supported_languages: [
                                LanguageId::TypeScript,
                                LanguageId::Tsx,
                                LanguageId::Odin,
                                LanguageId::Go,
                                LanguageId::Rust,
                                LanguageId::CSharp,
                                LanguageId::Java,
                                LanguageId::Kotlin,
                                LanguageId::Swift,
                            ],
                        },
                    })
                }
                Request::Outline { .. } if !handshake_complete => error_response(
                    request_id,
                    "handshake_required",
                    "complete the protocol handshake before outline requests".to_owned(),
                ),
                Request::Symbol { .. } if !handshake_complete => error_response(
                    request_id,
                    "handshake_required",
                    "complete the protocol handshake before symbol requests".to_owned(),
                ),
                Request::Outline {
                    target,
                    include_private,
                    names,
                    ..
                } => {
                    if engine.is_none() {
                        match OutlineEngine::new() {
                            Ok(new_engine) => engine = Some(new_engine),
                            Err(error) => {
                                write_frame(
                                    &mut writer,
                                    &error_response(
                                        request_id,
                                        "rule_initialization_failed",
                                        error.to_string(),
                                    ),
                                )?;
                                continue;
                            }
                        }
                    }
                    match engine
                        .as_ref()
                        .expect("engine is initialized above")
                        .outline(target, include_private, &names)
                    {
                        Ok(outline) => Response::Success(SuccessResponse {
                            request_id,
                            protocol_version: PROTOCOL_VERSION,
                            success: true,
                            result: ResponseResult::Outline { outline },
                        }),
                        Err(error) => {
                            error_response(request_id, "outline_failed", error.to_string())
                        }
                    }
                }
                Request::Symbol {
                    locators,
                    context_lines,
                    ..
                } => {
                    if engine.is_none() {
                        match OutlineEngine::new() {
                            Ok(new_engine) => engine = Some(new_engine),
                            Err(error) => {
                                write_frame(
                                    &mut writer,
                                    &error_response(
                                        request_id,
                                        "rule_initialization_failed",
                                        error.to_string(),
                                    ),
                                )?;
                                continue;
                            }
                        }
                    }
                    match engine
                        .as_ref()
                        .expect("engine is initialized above")
                        .symbol(&locators, context_lines)
                    {
                        Ok(symbol) => Response::Success(SuccessResponse {
                            request_id,
                            protocol_version: PROTOCOL_VERSION,
                            success: true,
                            result: ResponseResult::Symbol { symbol },
                        }),
                        Err(error) => error_response(request_id, error.code, error.message),
                    }
                }
            }
        };
        write_frame(&mut writer, &response)?;
    }
    Ok(())
}

fn error_response(request_id: u64, code: &'static str, message: String) -> Response {
    Response::Error(ErrorResponse {
        request_id,
        protocol_version: PROTOCOL_VERSION,
        success: false,
        error: ProtocolError { code, message },
    })
}
