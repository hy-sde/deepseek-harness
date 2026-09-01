//! Error type shared by the CLI slice.
//!
//! Faithful port of oh-my-pi `crates/pi-vcs/src/error.rs` (MIT). Structured
//! failure modes map 1:1 to the VcsError taxonomy the TS layer matches on, so
//! a CLI failure crosses the process boundary as a machine-readable `code`
//! rather than message text.

use std::path::PathBuf;

/// Crate-wide result alias.
pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Unified error for all VCS operations.
#[allow(dead_code)] // taxonomy variants kept for parity with the fork VcsError codes
#[derive(Debug, thiserror::Error)]
pub enum Error {
	/// The directory is not inside a git repository.
	#[error("not a repository: {path}")]
	NotARepository {
		/// Directory the lookup started from.
		path: PathBuf,
	},

	/// A named ref (branch, tag, `refs/...`) does not exist.
	#[error("reference not found: {name}")]
	RefNotFound {
		/// The ref name as given by the caller.
		name: String,
	},

	/// A revision/object lookup failed (`rev-parse` style spec, blob path,
	/// tree).
	#[error("object not found: {spec}")]
	ObjectNotFound {
		/// The revision or object spec as given by the caller.
		spec: String,
	},

	/// A CLI-backed operation exited non-zero. Carries the captured stream
	/// tail for user-facing error surfaces.
	#[error("cli exited {exit_code}: {stderr}")]
	Cli {
		/// Rendered command line.
		command: String,
		/// Process exit code.
		exit_code: i32,
		/// Captured stdout (may be truncated).
		stdout: String,
		/// Captured stderr (may be truncated).
		stderr: String,
	},

	/// A CLI-backed operation exceeded its deadline and was killed.
	#[error("timed out: {command}")]
	CliTimeout {
		/// Rendered command line.
		command: String,
	},

	/// Filesystem error outside any more specific failure mode.
	#[error(transparent)]
	Io(#[from] std::io::Error),

	/// An underlying gix failure that has no dedicated variant.
	#[error("{context}: {message}")]
	Backend {
		/// Operation being performed (`"git diff"`, `"git open"`, …).
		context: &'static str,
		/// Backend error rendered as text (full source chain).
		message: String,
	},

	/// The operation has no implementation for this repository.
	#[error("`{operation}` is not supported")]
	Unsupported {
		/// Operation or feature name as exposed to JS (camelCase).
		operation: &'static str,
	},
}

impl Error {
	/// Wrap an arbitrary backend error with the operation it occurred in.
	pub fn backend(context: &'static str, err: impl std::fmt::Display) -> Self {
		Self::Backend { context, message: err.to_string() }
	}

	/// Stable machine-readable discriminant for this failure, used as the
	/// `code` property on the JSON error surface.
	pub const fn kind(&self) -> &'static str {
		match self {
			Self::NotARepository { .. } => "NotARepository",
			Self::RefNotFound { .. } => "RefNotFound",
			Self::ObjectNotFound { .. } => "ObjectNotFound",
			Self::Cli { .. } => "Cli",
			Self::CliTimeout { .. } => "CliTimeout",
			Self::Io(_) => "Io",
			Self::Backend { .. } => "Backend",
			Self::Unsupported { .. } => "Unsupported",
		}
	}
}
