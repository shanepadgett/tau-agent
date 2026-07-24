use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    path::Path,
    process::{Child, ChildStdout, Command, Stdio},
};

fn start_worker() -> Child {
    Command::new(env!("CARGO_BIN_EXE_tau-ast"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("worker should start")
}

fn send_request(worker: &mut Child, request: Value) {
    let payload = serde_json::to_vec(&request).expect("request should serialize");
    let stdin = worker.stdin.as_mut().expect("worker stdin should be open");
    stdin
        .write_all(&(payload.len() as u32).to_be_bytes())
        .and_then(|()| stdin.write_all(&payload))
        .and_then(|()| stdin.flush())
        .expect("request frame should write");
}

fn read_response(stdout: &mut ChildStdout) -> Value {
    let mut length = [0_u8; 4];
    stdout
        .read_exact(&mut length)
        .expect("response length should read");
    let mut payload = vec![0_u8; u32::from_be_bytes(length) as usize];
    stdout
        .read_exact(&mut payload)
        .expect("response payload should read");
    serde_json::from_slice(&payload).expect("response should contain JSON")
}

#[test]
fn worker_requires_handshake_then_outlines_and_retrieves_a_symbol() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let typescript_path = manifest_dir.join("../../extensions/explore/index.ts");
    let odin_path = manifest_dir.join("fixtures/odin.odin");
    let mut worker = start_worker();
    let mut stdout = worker.stdout.take().expect("worker stdout should be open");

    send_request(
        &mut worker,
        json!({
            "operation": "outline",
            "requestId": 1,
            "protocolVersion": 1,
            "path": typescript_path,
            "language": "typeScript"
        }),
    );
    let before_handshake = read_response(&mut stdout);
    assert_eq!(before_handshake["success"], false);
    assert_eq!(before_handshake["error"]["code"], "handshake_required");

    send_request(
        &mut worker,
        json!({
            "operation": "handshake",
            "requestId": 2,
            "protocolVersion": 1
        }),
    );
    let handshake = read_response(&mut stdout);
    assert_eq!(handshake["success"], true);
    assert_eq!(handshake["result"]["kind"], "handshake");
    assert_eq!(
        handshake["result"]["supportedLanguages"]
            .as_array()
            .map(Vec::len),
        Some(9)
    );

    send_request(
        &mut worker,
        json!({
            "operation": "outline",
            "requestId": 3,
            "protocolVersion": 1,
            "path": typescript_path,
            "language": "typeScript"
        }),
    );
    let typescript = read_response(&mut stdout);
    assert_eq!(typescript["success"], true);
    assert_eq!(typescript["result"]["diagnostics"]["errorNodes"], 0);
    assert!(
        typescript["result"]["items"]
            .as_array()
            .is_some_and(|items| !items.is_empty())
    );
    let item = &typescript["result"]["items"][0];
    let locator = item["locator"]
        .as_str()
        .expect("outline item should have a locator");
    let start = item["range"]["startByte"]
        .as_u64()
        .expect("outline item should have a start byte") as usize;
    let end = item["range"]["endByte"]
        .as_u64()
        .expect("outline item should have an end byte") as usize;

    send_request(
        &mut worker,
        json!({
            "operation": "symbol",
            "requestId": 4,
            "protocolVersion": 1,
            "locator": locator
        }),
    );
    let symbol = read_response(&mut stdout);
    let typescript_source = std::fs::read_to_string(&typescript_path)
        .expect("TypeScript source should remain readable");
    assert_eq!(symbol["success"], true);
    assert_eq!(symbol["result"]["kind"], "symbol");
    assert_eq!(symbol["result"]["source"], &typescript_source[start..end]);
    assert_eq!(
        symbol["result"]["sourceFingerprint"],
        typescript["result"]["sourceFingerprint"]
    );

    send_request(
        &mut worker,
        json!({
            "operation": "outline",
            "requestId": 5,
            "protocolVersion": 1,
            "path": odin_path,
            "language": "odin"
        }),
    );
    let odin = read_response(&mut stdout);
    assert_eq!(odin["success"], true);
    assert_eq!(odin["result"]["diagnostics"]["errorNodes"], 0);
    assert!(
        odin["result"]["items"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["name"] == "Circle"))
    );

    let bundled_languages = [
        ("go.go", "go", "FileParser"),
        ("rust.rs", "rust", "FileParser"),
        ("csharp.cs", "cSharp", "FileParser"),
        ("java.java", "java", "FileParser"),
        ("kotlin.kt", "kotlin", "FileParser"),
        ("swift.swift", "swift", "FileParser"),
    ];
    for (index, (fixture, language, expected_name)) in bundled_languages.into_iter().enumerate() {
        send_request(
            &mut worker,
            json!({
                "operation": "outline",
                "requestId": index + 6,
                "protocolVersion": 1,
                "path": manifest_dir.join("fixtures").join(fixture),
                "language": language
            }),
        );
        let response = read_response(&mut stdout);
        assert_eq!(response["success"], true, "{fixture}");
        assert_eq!(response["result"]["language"], language, "{fixture}");
        assert!(
            response["result"]["items"]
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item["name"] == expected_name)),
            "{fixture} omitted {expected_name}"
        );
    }

    drop(worker.stdin.take());
    let output = worker
        .wait_with_output()
        .expect("worker should exit after stdin closes");
    assert!(
        output.status.success(),
        "worker stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
