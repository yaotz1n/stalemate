fn main() {
    // stockfish.rs finds the downloaded binary (binaries/stockfish-<triple>) by the target triple.
    println!("cargo:rustc-env=TARGET_TRIPLE={}", std::env::var("TARGET").unwrap());
    tauri_build::build()
}
