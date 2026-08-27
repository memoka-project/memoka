use memoka_desktop::portable_mirror::{restore_portable_mirror, verify_portable_mirror};
use std::path::PathBuf;

fn main() {
    if let Err(error) = run(std::env::args().skip(1).collect()) {
        eprintln!("memoka-cli: {error}");
        std::process::exit(1);
    }
}

fn run(arguments: Vec<String>) -> Result<(), String> {
    let Some(command) = arguments.first().map(String::as_str) else {
        return Err(usage());
    };
    let source = option_path(&arguments[1..], "--source")?;
    match command {
        "verify" => {
            reject_unknown_options(&arguments[1..], &["--source"])?;
            let manifest = verify_portable_mirror(&source).map_err(|error| error.to_string())?;
            println!(
                "verified Workspace {}: {} files, {} notes, {} attachments",
                manifest.workspace_id,
                manifest.files.len(),
                manifest
                    .documents
                    .iter()
                    .filter(|entry| entry.kind == "note")
                    .count(),
                manifest.attachments.len()
            );
            Ok(())
        }
        "restore" => {
            reject_unknown_options(&arguments[1..], &["--source", "--target"])?;
            let target = option_path(&arguments[1..], "--target")?;
            restore_portable_mirror(&source, &target).map_err(|error| error.to_string())?;
            println!("restored Workspace to {}", target.display());
            Ok(())
        }
        _ => Err(usage()),
    }
}

fn option_path(arguments: &[String], name: &str) -> Result<PathBuf, String> {
    let index = arguments
        .iter()
        .position(|argument| argument == name)
        .ok_or_else(|| format!("missing {name}\n{}", usage()))?;
    arguments
        .get(index + 1)
        .filter(|value| !value.starts_with("--"))
        .map(PathBuf::from)
        .ok_or_else(|| format!("missing value for {name}"))
}

fn reject_unknown_options(arguments: &[String], allowed: &[&str]) -> Result<(), String> {
    let mut index = 0;
    while index < arguments.len() {
        let option = &arguments[index];
        if !allowed.contains(&option.as_str()) {
            return Err(format!("unknown option: {option}\n{}", usage()));
        }
        if arguments.get(index + 1).is_none() {
            return Err(format!("missing value for {option}"));
        }
        index += 2;
    }
    Ok(())
}

fn usage() -> String {
    "usage:\n  memoka-cli verify --source <backup-directory>\n  memoka-cli restore --source <backup-directory> --target <data-area>".to_owned()
}
