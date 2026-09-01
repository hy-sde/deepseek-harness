//! `pi-vcs` — thin pi-vcs CLI front for the DeepSeek Harness `ctx.vcs` host
//! service (port_omp.md: adopt the AV pattern for the narrow native slice).
//!
//! Narrow slice only: `repo-info`, `rev-diff`, `staged-diff`, `worktree-diff`,
//! `status`, `watch`, and
//! `--version`. No jj backend, no mutation verbs — those stay on the harness
//! git service (the TS path remains the default).
//!
//! Protocol (matched by `@deepseek-ai/dsh-vcs`):
//! - `repo-info` prints one JSON line `{"root":"...","gitDir":"..."}`.
//! - `rev-diff`/`staged-diff` print git-compatible unified diff text.
//! - Errors print one JSON line `{"code":"...","message":"..."}` on stderr
//!   and exit non-zero.
//! - `watch` is long-running: one JSON line `{"event":"head"}` per HEAD move
//!   (stat-polling the watch target every `--interval-ms`), and exits 0 on
//!   SIGTERM/SIGINT.

mod diff;
mod discovery;
mod error;
mod repo;

use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use crate::error::{Error, Result};

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Set by the SIGTERM/SIGINT handler; the watch loop checks it each tick.
static SHUTDOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn main() -> ExitCode {
	match run(std::env::args().skip(1).collect()) {
		Ok(()) => ExitCode::SUCCESS,
		Err(err) => {
			let kind = err.kind();
			let message = err.to_string();
			let json = serde_json::json!({ "code": kind, "message": message }).to_string();
			let _ = writeln!(std::io::stderr(), "{json}");
			ExitCode::from(1)
		},
	}
}

fn run(args: Vec<String>) -> Result<()> {
	let Some(sub) = args.first().map(String::as_str) else {
		print_usage();
		return Ok(());
	};
	match sub {
		"--version" | "-V" => {
			println!("pi-vcs {VERSION}");
			Ok(())
		},
		"--help" | "-h" | "help" => {
			print_usage();
			Ok(())
		},
		"repo-info" => {
			let dir = arg(&args, 1, "repo-info <dir>")?;
			let r = repo::require(&dir)?;
			let root = r.info().repo_root.to_string_lossy().into_owned();
			let git_dir = r.info().git_dir.to_string_lossy().into_owned();
			let branch = r.branch();
			println!("{}", serde_json::json!({ "root": root, "gitDir": git_dir, "branch": branch }));
			Ok(())
		},
		"rev-diff" => {
			// rev-diff <dir> <base> [<head>] [--name-only|--numstat]
			let dir = arg(&args, 1, "rev-diff <dir> <base> [<head>] [--name-only|--numstat]")?;
			let base = arg_str(&args, 2, "rev-diff <dir> <base> [<head>] [--name-only|--numstat]")?;
			let head = args.get(3).filter(|a| !a.starts_with("--")).cloned();
			let mode = output_mode(&args)?;
			let mut r = repo::require(&dir)?;
			let gix = r.gix()?;
			let text = diff::render_diff(
				&gix,
				&diff::DiffOptions { base: Some(base), head, ..Default::default() },
				mode,
			)?;
			print!("{text}");
			Ok(())
		},
		"staged-diff" => {
			// staged-diff <dir> [--name-only|--numstat]
			let dir = arg(&args, 1, "staged-diff <dir> [--name-only|--numstat]")?;
			let mode = output_mode(&args)?;
			let mut r = repo::require(&dir)?;
			let gix = r.gix()?;
			let text = diff::render_diff(
				&gix,
				&diff::DiffOptions { cached: true, ..Default::default() },
				mode,
			)?;
			print!("{text}");
			Ok(())
		},
		"worktree-diff" => {
			// worktree-diff <dir> [--name-only|--numstat]
			let dir = arg(&args, 1, "worktree-diff <dir> [--name-only|--numstat]")?;
			let mode = output_mode(&args)?;
			let mut r = repo::require(&dir)?;
			let gix = r.gix()?;
			let text = diff::render_diff(&gix, &diff::DiffOptions::default(), mode)?;
			print!("{text}");
			Ok(())
		},
		"status" => {
			// status <dir>
			let dir = arg(&args, 1, "status <dir>")?;
			let mut r = repo::require(&dir)?;
			let gix = r.gix()?;
			let summary = diff::status_summary(&gix)?;
			println!(
				"{}",
				serde_json::json!({
					"staged": summary.staged,
					"unstaged": summary.unstaged,
					"untracked": summary.untracked,
				})
			);
			Ok(())
		},
		"watch" => {
			// watch <dir> [--interval-ms N]
			let dir = PathBuf::from(arg(&args, 1, "watch <dir> [--interval-ms N]")?);
			let mut interval_ms = 1000_u64;
			if let Some(pos) = args.iter().position(|arg| arg == "--interval-ms") {
				interval_ms = args
					.get(pos + 1)
					.and_then(|value| value.parse().ok())
					.ok_or_else(|| Error::backend("watch", "invalid --interval-ms value"))?;
			}
			watch(&dir, interval_ms)
		},
		_ => {
			print_usage();
			Err(Error::Unsupported { operation: "unknown-subcommand" })
		},
	}
}

/// Parse the optional `--name-only` / `--numstat` output-mode flag (default
/// unified text); a mode flag appearing twice is an error.
fn output_mode(args: &[String]) -> Result<diff::OutputMode> {
	let mut mode = None;
	for flag in args.iter().skip(1) {
		let candidate = match flag.as_str() {
			"--name-only" => Some(diff::OutputMode::NameOnly),
			"--numstat" => Some(diff::OutputMode::Numstat),
			_ => None,
		};
		if let Some(candidate) = candidate {
			if mode.replace(candidate).is_some() {
				return Err(Error::backend("diff", "conflicting output mode flags"));
			}
		}
	}
	Ok(mode.unwrap_or(diff::OutputMode::Text))
}
fn arg(args: &[String], index: usize, usage: &str) -> Result<PathBuf> {
	args
		.get(index)
		.map(PathBuf::from)
		.ok_or_else(|| Error::backend("usage", &format!("{usage}: missing argument")))
}

/// String variant of [`arg`] for revision specs and other text parameters.
fn arg_str(args: &[String], index: usize, usage: &str) -> Result<String> {
	args
		.get(index)
		.cloned()
		.ok_or_else(|| Error::backend("usage", &format!("{usage}: missing argument")))
}

/// Install a SIGTERM/SIGINT handler that flips a global flag; the poll loop
/// checks it each tick and exits 0 when set.
fn install_shutdown_flag() -> Shutdown {
	unsafe extern "C" fn handle(_: libc::c_int) {
		SHUTDOWN.store(true, std::sync::atomic::Ordering::SeqCst);
	}
	unsafe {
		libc::signal(libc::SIGINT, handle as *const () as libc::sighandler_t);
		libc::signal(libc::SIGTERM, handle as *const () as libc::sighandler_t);
	}
	Shutdown { _private: () }
}

struct Shutdown {
	_private: (),
}

impl Shutdown {
	fn requested(&self) -> bool {
		SHUTDOWN.load(std::sync::atomic::Ordering::SeqCst)
	}
}

fn watch(dir: &std::path::Path, interval_ms: u64) -> Result<()> {
	let shutdown = install_shutdown_flag();
	let r = repo::require(dir)?;
	let targets = r.watch_targets();
	let mtime = |path: &std::path::Path| {
		std::fs::metadata(path)
			.and_then(|meta| meta.modified())
			.ok()
	};
	let mut last_mtimes: Vec<_> = targets.iter().map(|path| mtime(path)).collect();
	let mut stdout = std::io::stdout();
	let mut seq = 0_u64;
	loop {
		if shutdown.requested() {
			return Ok(());
		}
		let now: Vec<_> = targets.iter().map(|path| mtime(path)).collect();
		let changed = now != last_mtimes;
		last_mtimes = now;
		if changed {
			seq += 1;
			let line = serde_json::json!({ "event": "head", "seq": seq });
			writeln!(stdout, "{line}")?;
			stdout.flush()?;
		}
		std::thread::sleep(Duration::from_millis(interval_ms));
	}
}

fn print_usage() {
	println!(
		"pi-vcs {VERSION} — thin native vcs slice for the harness ctx.vcs service.\n\
\n\
USAGE:\n\
  pi-vcs --version\n\
  pi-vcs repo-info <dir>\n\
  pi-vcs rev-diff <dir> <base> [<head>]\n\
  pi-vcs staged-diff <dir>\n\
  pi-vcs worktree-diff <dir> [--name-only|--numstat]
  pi-vcs status <dir>
  pi-vcs watch <dir> [--interval-ms N]\n"
	);
}
