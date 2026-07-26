mod csharp;
mod discovery;
mod go;
mod java;
mod kotlin;
mod language;
mod markdown;
mod odin;
mod outline;
mod protocol;
mod relationships;
mod rust;
mod search;
mod source;
mod swift;
mod typescript;

use crate::{
    outline::{
        LanguageId, OutlineEngine, OutlineFileError, OutlineTarget, RecursiveDiagnostic,
        RecursiveOutlineEvent,
    },
    protocol::{
        ErrorResponse, PROTOCOL_VERSION, ProtocolError, Request, Response, ResponseResult,
        SuccessResponse, read_frame, response_fits_frame, write_frame,
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
                                LanguageId::Markdown,
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
                Request::ApiDiscover { .. } if !handshake_complete => error_response(
                    request_id,
                    "handshake_required",
                    "complete the protocol handshake before API discovery requests".to_owned(),
                ),
                Request::AstSearch { .. } if !handshake_complete => error_response(
                    request_id,
                    "handshake_required",
                    "complete the protocol handshake before ast_search requests".to_owned(),
                ),
                Request::Relationships { .. } if !handshake_complete => error_response(
                    request_id,
                    "handshake_required",
                    "complete the protocol handshake before relationship requests".to_owned(),
                ),
                Request::Outline {
                    target,
                    include_private,
                    include_docs,
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
                    match target {
                        OutlineTarget::RecursiveDirectory { path, budgets } => {
                            write_frame(
                                &mut writer,
                                &success_response(
                                    request_id,
                                    ResponseResult::RecursiveStart {
                                        path: path.clone(),
                                        budgets,
                                    },
                                ),
                            )?;
                            let mut oversized_frames = 0;
                            let traversal = engine
                                .as_ref()
                                .expect("engine is initialized above")
                                .outline_recursive(
                                    &path,
                                    budgets,
                                    include_private,
                                    include_docs,
                                    &names,
                                     None,
                                    &mut |event| {
                                        let response = match event {
                                            RecursiveOutlineEvent::File {
                                                relative_path,
                                                file,
                                            } => {
                                                    let language = file.language;
                                                    let source_fingerprint =
                                                        file.source_fingerprint.clone();
                                                let response = success_response(
                                                    request_id,
                                                    ResponseResult::RecursiveFile {
                                                        relative_path: relative_path.clone(),
                                                        file,
                                                    },
                                                );
                                                if response_fits_frame(&response)? {
                                                    response
                                                } else {
                                                    oversized_frames += 1;
                                                    success_response(
                                                        request_id,
                                                        ResponseResult::RecursiveDiagnostic {
                                                            diagnostic: RecursiveDiagnostic {
                                                                relative_path,
                                                                language: Some(language),
                                                                code: "resultFrameTooLarge",
                                                                message: "rendered AST result exceeds the 8 MiB worker frame limit; outline this file directly"
                                                                    .to_owned(),
                                                                source_fingerprint: Some(
                                                                    source_fingerprint,
                                                                ),
                                                            },
                                                        },
                                                    )
                                                }
                                            }
                                            RecursiveOutlineEvent::Diagnostic(diagnostic) => {
                                                success_response(
                                                    request_id,
                                                    ResponseResult::RecursiveDiagnostic {
                                                        diagnostic,
                                                    },
                                                )
                                            }
                                        };
                                        write_frame(&mut writer, &response)?;
                                        Ok(())
                                    },
                                );
                            match traversal {
                                Ok(mut summary) => {
                                    summary.emitted_files =
                                        summary.emitted_files.saturating_sub(oversized_frames);
                                    summary.failed_files += oversized_frames;
                                    write_frame(
                                        &mut writer,
                                        &success_response(
                                            request_id,
                                            ResponseResult::RecursiveComplete { summary },
                                        ),
                                    )?;
                                }
                                Err(error) => write_frame(
                                    &mut writer,
                                    &error_response(
                                        request_id,
                                        "recursive_outline_failed",
                                        error.to_string(),
                                    ),
                                )?,
                            }
                            continue;
                        }
                        target => match engine
                            .as_ref()
                            .expect("engine is initialized above")
                            .outline(target, include_private, include_docs, &names)
                        {
                            Ok(outline) => {
                                success_response(request_id, ResponseResult::Outline { outline })
                            }
                            Err(error) => error_response_with_fingerprint(
                                request_id,
                                "outline_failed",
                                error.to_string(),
                                error
                                    .downcast_ref::<OutlineFileError>()
                                    .and_then(|failure| failure.source_fingerprint.clone()),
                            ),
                        },
                    }
                }
                Request::Symbol {
                    locators,
                    view,
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
                        .symbol(&locators, view, context_lines)
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
                Request::ApiDiscover {
                    path,
                    budgets,
                    query,
                    surface,
                    result_limit,
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
                        .discover_api(&path, budgets, query, surface, result_limit)
                    {
                        Ok(discovery) => {
                            success_response(request_id, ResponseResult::ApiDiscovery { discovery })
                        }
                        Err(error) => {
                            error_response(request_id, "api_discovery_failed", error.to_string())
                        }
                    }
                }
                Request::AstSearch {
                    path,
                    language,
                    budgets,
                    pattern,
                    result_limit,
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
                        .search(&path, language, budgets, &pattern, result_limit)
                    {
                        Ok(search) => {
                            success_response(request_id, ResponseResult::AstSearch { search })
                        }
                        Err(error) => error_response(request_id, error.code, error.message),
                    }
                }
                Request::Relationships {
                    path,
                    budgets,
                    locator,
                    relationship,
                    result_limit,
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
                        .relationships(&path, budgets, &locator, relationship, result_limit)
                    {
                        Ok(relationships) => success_response(
                            request_id,
                            ResponseResult::Relationships { relationships },
                        ),
                        Err(error) => {
                            error_response(request_id, "relationship_failed", error.to_string())
                        }
                    }
                }
            }
        };
        write_frame(&mut writer, &response)?;
    }
    Ok(())
}

fn error_response(request_id: u64, code: &'static str, message: String) -> Response {
    error_response_with_fingerprint(request_id, code, message, None)
}

fn error_response_with_fingerprint(
    request_id: u64,
    code: &'static str,
    message: String,
    source_fingerprint: Option<String>,
) -> Response {
    Response::Error(ErrorResponse {
        request_id,
        protocol_version: PROTOCOL_VERSION,
        success: false,
        error: ProtocolError {
            code,
            message,
            source_fingerprint,
        },
    })
}

fn success_response(request_id: u64, result: ResponseResult) -> Response {
    Response::Success(SuccessResponse {
        request_id,
        protocol_version: PROTOCOL_VERSION,
        success: true,
        result,
    })
}
