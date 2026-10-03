// Protocol I-1 robustness, through the real binary: one response per request, in order,
// per-request errors, the process survives bad input, and no viewing key is ever printed.

use serde_json::{Value, json};
use std::io::Write;
use std::process::{Command, Stdio};

const TX_1_2_2: &[u8] = include_bytes!("fixtures/v9_tx_1_2_2.raw");
const TX_V8_1_2_2: &[u8] = include_bytes!("fixtures/v8_tx_1_2_2.raw");

// Seed 00…01 on `undeployed` (node toolkit known answer, show_viewing_key.rs test case 1).
const KEY_1: &str =
    "mn_shield-esk_undeployed1dlyj7u8juj68fd4psnkqhjxh32sec0q480vzswg8kd485e2kljcs9ete5h";
// Seed 00…02 on `devnet` (toolkit test case 2): valid key, wrong network for `undeployed`.
const KEY_DEVNET: &str =
    "mn_shield-esk_devnet1w0dctw9zhe2ffqw4s5qks7rnl29wy5mhl957fv9nnhtxulent80q5dejklr";

struct Run {
    responses: Vec<Value>,
    stdout: String,
    stderr: String,
    success: bool,
}

fn run(input: &[u8]) -> Run {
    let mut child = Command::new(env!("CARGO_BIN_EXE_midnight-esk-decrypt"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("binary starts");
    // Write stdin from another thread: the child's stdout/stderr pipes would fill up (and
    // deadlock both sides) if all input were written before reading any output.
    let mut stdin = child.stdin.take().unwrap();
    let input = input.to_vec();
    let writer = std::thread::spawn(move || stdin.write_all(&input));
    let output = child.wait_with_output().unwrap();
    writer.join().unwrap().expect("stdin written");
    let stdout = String::from_utf8(output.stdout).expect("stdout is UTF-8");
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let responses = stdout
        .lines()
        .map(|line| serde_json::from_str(line).expect("every stdout line is JSON"))
        .collect();
    Run { responses, stdout, stderr, success: output.status.success() }
}

fn line(value: Value) -> String {
    format!("{value}\n")
}

#[test]
fn mixed_session_answers_every_request_in_order() {
    let raw = hex::encode(TX_1_2_2);
    let mut input = String::new();
    input += &line(json!({"id": "r1", "op": "version"}));
    input += &line(json!({"id": "r2", "op": "validateKey", "networkId": "undeployed", "viewingKey": KEY_1}));
    input += &line(json!({"id": "r3", "op": "decrypt", "networkId": "undeployed", "viewingKey": KEY_1, "raw": raw}));
    input += "{this is not json\n";
    input += "\n"; // blank line: not a request, no response
    input += &line(json!(["an", "array"]));
    input += &line(json!({"id": "r4", "op": "frobnicate"}));
    input += &line(json!({"id": "r5", "op": "decrypt", "networkId": "undeployed", "viewingKey": KEY_1, "raw": "zz-not-hex"}));
    input += &line(json!({"id": "r6", "op": "validateKey", "networkId": "undeployed", "viewingKey": KEY_DEVNET}));
    input += &line(json!({"id": "r7", "op": "decrypt", "networkId": "undeployed", "viewingKey": KEY_1, "raw": hex::encode(TX_V8_1_2_2)}));
    input += &line(json!({"id": "r8", "op": "decrypt", "networkId": "undeployed", "viewingKey": KEY_1}));
    input += &line(json!({"id": "r9", "op": "validateKey", "networkId": "Undeployed", "viewingKey": KEY_1}));
    input += &line(json!({"id": "r10", "op": "validateKey", "networkId": "undeployed", "viewingKey": "garbage"}));
    input += &line(json!({"id": 11, "op": 7}));
    input += &line(json!({"op": "version"}));
    // Cached key, `0x` prefix accepted.
    input += &line(json!({"id": "r12", "op": "decrypt", "networkId": "undeployed", "viewingKey": KEY_1, "raw": format!("0x{raw}")}));
    let mut bytes = input.into_bytes();
    bytes.extend_from_slice(b"\xff\xfe not utf-8\n");
    bytes.extend_from_slice(line(json!({"id": "r13", "op": "version"})).as_bytes());

    let run = run(&bytes);
    assert!(run.success, "process exits 0 at EOF; stderr: {}", run.stderr);

    let r = &run.responses;
    assert_eq!(r.len(), 17, "one response per non-blank line: {r:#?}");

    assert_eq!(r[0], json!({"id": "r1", "ok": true, "version": "0.1.0", "ledger": "9.1.0.0-rc.3"}));
    assert_eq!(r[1], json!({"id": "r2", "ok": true}));

    assert_eq!(r[2]["id"], "r3");
    assert_eq!(r[2]["ok"], true);
    assert_eq!(
        r[2]["coins"],
        json!([{
            "segment": 0,
            "outputIndex": 1,
            "commitment": "467db84988f3a772d50ca905b98991ab5b9ecd31df3c7cb97277a240ff186d50",
            "tokenType": "0000000000000000000000000000000000000000000000000000000000000000",
            "value": "49999999999990"
        }])
    );

    let failed = |i: usize, id: Value, needle: &str| {
        assert_eq!(r[i]["id"], id, "response {i}: {}", r[i]);
        assert_eq!(r[i]["ok"], false, "response {i}: {}", r[i]);
        let error = r[i]["error"].as_str().expect("error message");
        assert!(error.contains(needle), "response {i}: {error:?} should contain {needle:?}");
    };
    failed(3, Value::Null, "malformed request");
    failed(4, Value::Null, "not a JSON object");
    failed(5, json!("r4"), "unknown op: frobnicate");
    failed(6, json!("r5"), "invalid raw: not hex");
    failed(7, json!("r6"), "invalid viewing key: hrp mismatch");
    failed(8, json!("r7"), "invalid transaction: cannot deserialize as ledger v9 transaction");
    failed(9, json!("r8"), "missing raw");
    failed(10, json!("r9"), "invalid network id");
    failed(11, json!("r10"), "invalid viewing key");
    failed(12, json!(11), "op must be a string");
    assert_eq!(r[13]["ok"], true);
    assert_eq!(r[13]["id"], Value::Null);
    assert_eq!(r[14]["id"], "r12");
    assert_eq!(r[14]["coins"], r[2]["coins"]);
    failed(15, Value::Null, "not valid UTF-8");
    assert_eq!(r[16]["id"], "r13");
    assert_eq!(r[16]["ok"], true);

    // No viewing key is ever printed, on stdout or stderr.
    for key in [KEY_1, KEY_DEVNET] {
        assert!(!run.stdout.contains(key));
        assert!(!run.stderr.contains(key));
    }
}

#[test]
fn empty_input_exits_cleanly() {
    let run = run(b"");
    assert!(run.success);
    assert!(run.responses.is_empty());
}

#[test]
fn last_line_without_newline_is_answered() {
    let run = run(br#"{"id":"x","op":"version"}"#);
    assert!(run.success);
    assert_eq!(run.responses.len(), 1);
    assert_eq!(run.responses[0]["id"], "x");
}

#[test]
fn version_flag() {
    let output = Command::new(env!("CARGO_BIN_EXE_midnight-esk-decrypt"))
        .arg("--version")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        "midnight-esk-decrypt 0.1.0 (ledger 9.1.0.0-rc.3)"
    );
}

#[test]
fn corrupted_transactions_never_kill_the_process() {
    // Deterministic corruption of the fixture: single-byte flips across the whole transaction,
    // and truncations. Every line must get a response and the process must exit 0.
    let mut state: u64 = 0x5eed_0056;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    let mut input = String::new();
    let mut count = 0;
    for _ in 0..300 {
        let mut tx = TX_1_2_2.to_vec();
        let pos = (next() as usize) % tx.len();
        tx[pos] ^= 1 << (next() % 8);
        input += &line(json!({"id": count, "op": "decrypt", "networkId": "undeployed", "viewingKey": KEY_1, "raw": hex::encode(&tx)}));
        count += 1;
    }
    for cut in (0..TX_1_2_2.len()).step_by(997) {
        input += &line(json!({"id": count, "op": "decrypt", "networkId": "undeployed", "viewingKey": KEY_1, "raw": hex::encode(&TX_1_2_2[..cut])}));
        count += 1;
    }
    input += &line(json!({"id": "last", "op": "version"}));

    let run = run(input.as_bytes());
    assert!(run.success, "stderr: {}", run.stderr);
    assert_eq!(run.responses.len(), count + 1);
    for (i, response) in run.responses.iter().take(count).enumerate() {
        assert_eq!(response["id"], json!(i));
    }
    assert_eq!(run.responses[count]["id"], "last");
    let rejected = run.responses.iter().filter(|r| r["ok"] == false).count();
    let panics = run.stderr.matches("panic caught").count();
    println!("corrupted inputs: {count}, rejected: {rejected}, accepted: {}, panics caught: {panics}", count - rejected);
    assert!(!run.stdout.contains(KEY_1) && !run.stderr.contains(KEY_1));
}
