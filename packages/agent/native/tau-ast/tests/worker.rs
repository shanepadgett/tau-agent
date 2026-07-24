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
            "protocolVersion": 2,
            "target": { "kind": "file", "path": typescript_path, "language": "typeScript" },
            "includePrivate": true,
            "names": []
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
            "protocolVersion": 2
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
            "protocolVersion": 2,
            "target": { "kind": "file", "path": typescript_path, "language": "typeScript" },
            "includePrivate": true,
            "names": []
        }),
    );
    let typescript = read_response(&mut stdout);
    assert_eq!(typescript["success"], true);
    let typescript_file = &typescript["result"]["files"][0];
    assert_eq!(typescript_file["diagnostics"]["errorNodes"], 0);
    assert!(
        typescript_file["items"]
            .as_array()
            .is_some_and(|items| !items.is_empty())
    );
    let item = &typescript_file["items"][0];
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
            "protocolVersion": 2,
            "locators": [locator],
            "contextLines": 0
        }),
    );
    let symbol = read_response(&mut stdout);
    let typescript_source = std::fs::read_to_string(&typescript_path)
        .expect("TypeScript source should remain readable");
    assert_eq!(symbol["success"], true);
    assert_eq!(symbol["result"]["kind"], "symbol");
    assert_eq!(
        symbol["result"]["blocks"][0]["source"],
        &typescript_source[start..end]
    );
    assert_eq!(
        symbol["result"]["declarations"][0]["sourceFingerprint"],
        typescript_file["sourceFingerprint"]
    );

    send_request(
        &mut worker,
        json!({
            "operation": "outline",
            "requestId": 5,
            "protocolVersion": 2,
            "target": { "kind": "file", "path": odin_path, "language": "odin" },
            "includePrivate": true,
            "names": []
        }),
    );
    let odin = read_response(&mut stdout);
    assert_eq!(odin["success"], true);
    assert_eq!(odin["result"]["files"][0]["diagnostics"]["errorNodes"], 0);
    assert!(
        odin["result"]["files"][0]["items"]
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
                "protocolVersion": 2,
                "target": {
                    "kind": "file",
                    "path": manifest_dir.join("fixtures").join(fixture),
                    "language": language
                },
                "includePrivate": true,
                "names": []
            }),
        );
        let response = read_response(&mut stdout);
        assert_eq!(response["success"], true, "{fixture}");
        assert_eq!(
            response["result"]["files"][0]["language"], language,
            "{fixture}"
        );
        assert!(
            response["result"]["files"][0]["items"]
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item["name"] == expected_name)),
            "{fixture} omitted {expected_name}"
        );
    }

    let local_export_path = std::env::temp_dir().join(format!(
        "tau-ast-worker-local-export-{}.ts",
        std::process::id()
    ));
    std::fs::write(
        &local_export_path,
        "function createThing(name: string): string {\n    return name;\n}\n\nexport { createThing };\n",
    )
    .expect("local export fixture should be writable");
    send_request(
        &mut worker,
        json!({
            "operation": "outline",
            "requestId": 12,
            "protocolVersion": 2,
            "target": { "kind": "file", "path": local_export_path, "language": "typeScript" },
            "includePrivate": false,
            "names": []
        }),
    );
    let local_export = read_response(&mut stdout);
    assert_eq!(local_export["success"], true);
    let local_item = &local_export["result"]["files"][0]["items"][0];
    assert_eq!(local_item["name"], "createThing");
    let local_locator = local_item["locator"]
        .as_str()
        .expect("resolved local export should have a locator");
    let local_start = local_item["range"]["startByte"]
        .as_u64()
        .expect("resolved local export should have a start byte") as usize;
    let local_end = local_item["range"]["endByte"]
        .as_u64()
        .expect("resolved local export should have an end byte") as usize;
    let local_source = std::fs::read_to_string(&local_export_path)
        .expect("local export source should remain readable");
    assert_eq!(
        &local_source[local_start..local_end],
        "function createThing(name: string): string {\n    return name;\n}"
    );

    send_request(
        &mut worker,
        json!({
            "operation": "symbol",
            "requestId": 13,
            "protocolVersion": 2,
            "locators": [local_locator],
            "contextLines": 0
        }),
    );
    let local_symbol = read_response(&mut stdout);
    assert_eq!(local_symbol["success"], true);
    assert_eq!(
        local_symbol["result"]["blocks"][0]["source"],
        &local_source[local_start..local_end]
    );
    std::fs::remove_file(local_export_path).expect("local export fixture should be removable");

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
