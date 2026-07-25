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
            "protocolVersion": 4,
            "target": { "kind": "file", "path": typescript_path, "language": "typeScript" },
            "includePrivate": true,
            "includeDocs": false,
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
            "protocolVersion": 4
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
            "protocolVersion": 4,
            "target": { "kind": "file", "path": typescript_path, "language": "typeScript" },
            "includePrivate": true,
            "includeDocs": false,
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
    let item = typescript_file["items"]
        .as_array()
        .and_then(|items| items.iter().find(|item| item["locator"].is_string()))
        .expect("outline should contain a declaration locator");
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
            "protocolVersion": 4,
            "locators": [locator],
            "view": "declaration",
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
            "protocolVersion": 4,
            "target": { "kind": "file", "path": odin_path, "language": "odin" },
            "includePrivate": true,
            "includeDocs": false,
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
    let odin_items = odin["result"]["files"][0]["items"]
        .as_array()
        .expect("Odin items should be an array");
    assert_eq!(odin_items[0]["rowKind"], "package");
    let mapped = odin_items
        .iter()
        .find(|item| item["name"] == "map_value")
        .expect("Odin model should contain map_value");
    assert!(mapped["bodyRange"].is_object());
    assert!(mapped["signature"]
        .as_str()
        .is_some_and(|signature| signature.contains("$T: typeid") && !signature.contains("fmt.println")));
    let mapped_locator = mapped["locator"]
        .as_str()
        .expect("Odin procedure should have a locator");
    send_request(
        &mut worker,
        json!({
            "operation": "symbol",
            "requestId": 100,
            "protocolVersion": 4,
            "locators": [mapped_locator],
            "view": "declarationWithImports",
            "contextLines": 0
        }),
    );
    let mapped_symbol = read_response(&mut stdout);
    assert_eq!(mapped_symbol["success"], true);
    let mapped_source = mapped_symbol["result"]["blocks"][0]["source"]
        .as_str()
        .expect("Odin symbol should contain source");
    assert!(mapped_source.contains("import fmt \"core:fmt\""));
    assert!(!mapped_source.contains("import unused"));

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
                "protocolVersion": 4,
                "target": {
                    "kind": "file",
                    "path": manifest_dir.join("fixtures").join(fixture),
                    "language": language
                },
                "includePrivate": true,
                "includeDocs": false,
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
        if language == "go" {
            let items = response["result"]["files"][0]["items"]
                .as_array()
                .expect("Go items should be an array");
            assert_eq!(items[0]["rowKind"], "package");
            assert!(items[0].get("locator").is_none());
            let method = items
                .iter()
                .find(|item| item["qualifiedName"] == "FileParser.Parse")
                .expect("Go model should contain a qualified method");
            assert_eq!(method["role"], "member");
            assert!(method["receiverRange"].is_object());
            assert!(method["bodyRange"].is_object());
            assert_eq!(
                method["signature"],
                "func (parser *FileParser) Parse(source string) Result"
            );
        }
        if language == "rust" {
            let items = response["result"]["files"][0]["items"]
                .as_array()
                .expect("Rust items should be an array");
            assert_eq!(items[0]["rowKind"], "import");
            assert!(items[0].get("locator").is_none());
            let implementation = items
                .iter()
                .find(|item| {
                    item["qualifiedName"] == "FileParser"
                        && item["members"].as_array().is_some_and(|members| {
                            members.iter().any(|member| member["name"] == "parse_async")
                        })
                })
                .expect("Rust model should contain the inherent impl");
            let method = implementation["members"]
                .as_array()
                .and_then(|members| {
                    members
                        .iter()
                        .find(|member| member["name"] == "parse_async")
                })
                .expect("Rust impl should contain parse_async");
            assert_eq!(method["qualifiedName"], "FileParser.parse_async");
            assert!(method["bodyRange"].is_object());
            assert!(
                method["signature"]
                    .as_str()
                    .is_some_and(|signature| !signature.contains("Some("))
            );
        }
        if language == "cSharp" {
            let items = response["result"]["files"][0]["items"]
                .as_array()
                .expect("C# items should be an array");
            assert_eq!(items[0]["rowKind"], "import");
            let parser = items
                .iter()
                .find(|item| item["name"] == "FileParser")
                .expect("C# model should contain FileParser");
            let method = parser["members"]
                .as_array()
                .and_then(|members| members.iter().find(|member| member["name"] == "Parse"))
                .expect("C# class should contain Parse");
            assert_eq!(method["qualifiedName"], "Fixture.Parsing.FileParser.Parse");
            assert!(method["bodyRange"].is_object());
            assert!(method["signature"]
                .as_str()
                .is_some_and(|signature| !signature.contains("return")));
        }
        if language == "java" {
            let items = response["result"]["files"][0]["items"]
                .as_array()
                .expect("Java items should be an array");
            assert_eq!(items[0]["rowKind"], "package");
            assert!(items[0].get("locator").is_none());
            let parser = items
                .iter()
                .find(|item| item["name"] == "Parser")
                .expect("Java model should contain Parser");
            let nested_method = parser["members"]
                .as_array()
                .and_then(|members| {
                    members
                        .iter()
                        .find(|member| member["qualifiedName"] == "Parser.Nested.name")
                })
                .expect("Java model should contain a qualified nested method");
            assert_eq!(nested_method["role"], "member");
            assert!(nested_method["bodyRange"].is_object());
            assert!(
                nested_method["signature"]
                    .as_str()
                    .is_some_and(|signature| !signature.contains("return"))
            );
        }
        if language == "kotlin" {
            let items = response["result"]["files"][0]["items"]
                .as_array()
                .expect("Kotlin items should be an array");
            assert_eq!(items[1]["rowKind"], "package");
            let parser = items
                .iter()
                .find(|item| item["name"] == "FileParser")
                .expect("Kotlin model should contain FileParser");
            let method = parser["members"]
                .as_array()
                .and_then(|members| members.iter().find(|member| member["name"] == "parse"))
                .expect("Kotlin class should contain parse");
            assert_eq!(method["qualifiedName"], "FileParser.parse");
            assert!(method["bodyRange"].is_object());
            assert_eq!(
                method["signature"],
                "override fun parse(source: String): Result"
            );
        }
        if language == "swift" {
            let items = response["result"]["files"][0]["items"]
                .as_array()
                .expect("Swift items should be an array");
            assert_eq!(items[0]["rowKind"], "import");
            assert!(items[0].get("locator").is_none());
            let parser = items
                .iter()
                .find(|item| item["name"] == "FileParser")
                .expect("Swift model should contain FileParser");
            let method = parser["members"]
                .as_array()
                .and_then(|members| members.iter().find(|member| member["name"] == "parse"))
                .expect("Swift class should contain parse");
            assert_eq!(method["qualifiedName"], "FileParser.parse");
            assert!(method["bodyRange"].is_object());
            assert_eq!(
                method["signature"],
                "open func parse(_ source: borrowing String) async throws -> String"
            );
            assert!(items.iter().any(|item| {
                item["symbolType"] == "namespace"
                    && item["qualifiedName"]
                        .as_str()
                        .is_some_and(|name| name.starts_with("extension Result"))
            }));
        }
    }

    let java_path = manifest_dir.join("fixtures/java.java");
    for (request_id, include_docs) in [(14, false), (15, true)] {
        send_request(
            &mut worker,
            json!({
                "operation": "outline",
                "requestId": request_id,
                "protocolVersion": 4,
                "target": { "kind": "file", "path": java_path, "language": "java" },
                "includePrivate": true,
                "includeDocs": include_docs,
                "names": ["parse"]
            }),
        );
        let response = read_response(&mut stdout);
        assert_eq!(response["success"], true);
        let implementation = response["result"]["files"][0]["items"]
            .as_array()
            .and_then(|items| items.iter().find(|item| item["name"] == "FileParser"))
            .and_then(|item| item["members"].as_array())
            .and_then(|members| members.iter().find(|member| member["name"] == "parse"))
            .expect("name-filtered worker outline should retain FileParser.parse");
        let signature = implementation["signature"]
            .as_str()
            .expect("filtered method should have a signature");
        assert!(signature.contains("@Override"));
        assert_eq!(signature.contains("Parses one source value."), include_docs);
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
            "protocolVersion": 4,
            "target": { "kind": "file", "path": local_export_path, "language": "typeScript" },
            "includePrivate": false,
            "includeDocs": false,
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
            "protocolVersion": 4,
            "locators": [local_locator],
            "view": "declaration",
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
