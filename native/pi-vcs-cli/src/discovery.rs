//! Git repository discovery — a pure filesystem walk (no subprocess, no gix
//! open), faithful port of oh-my-pi `crates/pi-vcs/src/git/mod.rs` (MIT).
//!
//! Mirrors the battle-tested TypeScript walk it replaces: `.git` pointer
//! files, `commondir` indirection, reftable detection. Cheap enough for
//! synchronous render paths.

use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

/// Resolved git repository metadata, discovered by walking the filesystem —
/// never a subprocess.
#[allow(dead_code)] // kept whole for parity; only root/gitDir surface to JSON
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitRepoInfo {
	/// Checkout root: the directory containing the `.git` entry.
	pub repo_root: PathBuf,
	/// The `.git` entry itself (directory, or pointer file for linked
	/// worktrees).
	pub git_entry_path: PathBuf,
	/// Resolved git directory (worktree-private for linked worktrees).
	pub git_dir: PathBuf,
	/// Shared common directory (equals `git_dir` for primary checkouts).
	pub common_dir: PathBuf,
	/// Path of the `HEAD` file inside `git_dir`.
	pub head_path: PathBuf,
	/// Whether refs are stored in the reftable format (`extensions.refStorage`).
	pub is_reftable: bool,
}

/// Discover repository metadata for `dir` without opening gitoxide.
pub fn discover_info(dir: &Path) -> Result<Option<GitRepoInfo>> {
	let mut current = std::path::absolute(dir)?;
	loop {
		let git_entry = current.join(".git");
		if let Some(entry) = entry_type(&git_entry) {
			match resolve_info(&current, &git_entry, entry) {
				Ok(Some(info)) => return Ok(Some(info)),
				Ok(None) => {},
				Err(err)
					if entry == EntryType::File
						&& err.kind() == std::io::ErrorKind::PermissionDenied =>
				{
					return Ok(None);
				},
				Err(err) => return Err(err.into()),
			}
		}
		if !current.pop() {
			return Ok(None);
		}
	}
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum EntryType {
	Directory,
	File,
}

fn entry_type(path: &Path) -> Option<EntryType> {
	let meta = std::fs::metadata(path).ok()?;
	if meta.is_dir() {
		Some(EntryType::Directory)
	} else if meta.is_file() {
		Some(EntryType::File)
	} else {
		None
	}
}

fn resolve_info(
	repo_root: &Path,
	git_entry: &Path,
	entry: EntryType,
) -> std::io::Result<Option<GitRepoInfo>> {
	let git_dir = match entry {
		EntryType::Directory => git_entry.to_owned(),
		EntryType::File => {
			let content = std::fs::read_to_string(git_entry)?;
			let Some(target) = parse_gitdir_pointer(&content) else {
				return Ok(None);
			};
			let resolved = normalize_path(&git_entry.parent().unwrap_or(repo_root).join(target));
			if entry_type(&resolved) != Some(EntryType::Directory) {
				return Ok(None);
			}
			resolved
		},
	};
	let common_dir = resolve_common_dir(&git_dir);
	// A `.git` entry only counts when its resolved git dir contains `HEAD`
	// (omp PR #11389): an unpopulated `.git` was never initialized by git, so
	// discovery must skip it and keep walking to the enclosing repository
	// instead of adopting the fence and failing later on the missing HEAD.
	// Linked worktrees and submodules stay valid: their `HEAD` lives in the
	// resolved git dir. A fresh `git init` has an unborn HEAD file, so it is
	// still accepted.
	if !git_dir.join("HEAD").is_file() {
		return Ok(None);
	}
	let is_reftable =
		read_optional(&common_dir.join("config")).is_some_and(|config| config_has_reftable(&config));
	Ok(Some(GitRepoInfo {
		repo_root: repo_root.to_owned(),
		git_entry_path: git_entry.to_owned(),
		head_path: git_dir.join("HEAD"),
		git_dir,
		common_dir,
		is_reftable,
	}))
}

/// Parse the `gitdir: <path>` pointer written into linked-worktree `.git`
/// files.
fn parse_gitdir_pointer(content: &str) -> Option<&str> {
	let rest = content.trim().strip_prefix("gitdir:")?;
	let target = rest.trim();
	(!target.is_empty()).then_some(target)
}

fn resolve_common_dir(git_dir: &Path) -> PathBuf {
	match read_optional(&git_dir.join("commondir")) {
		Some(content) => {
			let relative = content.trim();
			if relative.is_empty() {
				git_dir.to_owned()
			} else {
				normalize_path(&git_dir.join(relative))
			}
		},
		None => git_dir.to_owned(),
	}
}

fn read_optional(path: &Path) -> Option<String> {
	std::fs::read_to_string(path).ok()
}

/// Lexically normalize `.`/`..` segments without touching the filesystem, so
/// relative `gitdir`/`commondir` pointers resolve the same way git does.
pub fn normalize_path(path: &Path) -> PathBuf {
	let mut out = PathBuf::new();
	for component in path.components() {
		match component {
			std::path::Component::CurDir => {},
			std::path::Component::ParentDir => {
				if !out.pop() {
					out.push(component);
				}
			},
			other => out.push(other),
		}
	}
	out
}

/// Whether a git config file selects the reftable ref storage.
///
/// Minimal INI scan of `[extensions] refstorage`, honoring quoted values and
/// `;`/`#` comments outside quotes — enough to classify a repo without a full
/// config parser (reftable repos never reach gitoxide, so its parser is not
/// available for them by construction).
fn config_has_reftable(content: &str) -> bool {
	let mut in_extensions = false;
	for line in content.lines() {
		let line = strip_config_comment(line);
		let line = line.trim();
		if let Some(section) = line
			.strip_prefix('[')
			.and_then(|rest| rest.strip_suffix(']'))
		{
			in_extensions = section.trim().eq_ignore_ascii_case("extensions");
			continue;
		}
		if !in_extensions {
			continue;
		}
		let Some((key, value)) = line.split_once('=') else {
			continue;
		};
		if !key.trim().eq_ignore_ascii_case("refstorage") {
			continue;
		}
		let mut value = value.trim();
		if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
			value = value[1..value.len() - 1].trim();
		}
		let value = value.to_ascii_lowercase();
		if value == "reftable" || value.starts_with("reftable:") {
			return true;
		}
	}
	false
}

/// Truncate a config line at the first `;`/`#` outside double quotes.
fn strip_config_comment(line: &str) -> &str {
	let mut in_quotes = false;
	for (index, ch) in line.char_indices() {
		match ch {
			'"' => in_quotes = !in_quotes,
			';' | '#' if !in_quotes => return &line[..index],
			_ => {},
		}
	}
	line
}

/// Return the filesystem target whose metadata changes when HEAD moves.
pub fn head_watch_target(info: &GitRepoInfo) -> PathBuf {
	if info.is_reftable {
		info.git_dir.join("reftable")
	} else {
		info.head_path.clone()
	}
}

/// Assert a repository exists at `dir` or fail with the `NotARepository`
/// taxonomy.
#[allow(dead_code)]
pub fn require_info(dir: &Path) -> Result<GitRepoInfo> {
	discover_info(dir)?.ok_or_else(|| Error::NotARepository { path: dir.to_owned() })
}

#[cfg(test)]
mod tests {
	use super::*;
	use tempfile::TempDir;

	#[test]
	fn reftable_detection_honors_quotes_and_comments() {
		assert!(config_has_reftable("[extensions]\n\trefStorage = reftable\n"));
		assert!(config_has_reftable("[extensions]\nrefstorage = \"reftable\" ; comment\n"));
		assert!(!config_has_reftable("[extensions]\nrefstorage = files\n"));
		assert!(!config_has_reftable("[core]\nrefstorage = reftable\n"));
		assert!(!config_has_reftable("[extensions]\n# refstorage = reftable\n"));
	}

	#[test]
	fn gitdir_pointer_parsing() {
		assert_eq!(
			parse_gitdir_pointer("gitdir: /a/b/.git/worktrees/x\n"),
			Some("/a/b/.git/worktrees/x")
		);
		assert_eq!(parse_gitdir_pointer("gitdir:../relative"), Some("../relative"));
		assert_eq!(parse_gitdir_pointer("not a pointer"), None);
		assert_eq!(parse_gitdir_pointer("gitdir:   "), None);
	}

	#[test]
	fn discovery_ignores_an_empty_dot_git_directory() {
		let tmp = TempDir::new().unwrap();
		let fence = tmp.path().join("fence");
		std::fs::create_dir_all(fence.join("project")).unwrap();
		std::fs::create_dir(fence.join(".git")).unwrap();
		assert_eq!(discover_info(&fence.join("project")).unwrap(), None);
	}

	#[test]
	fn discovery_walks_past_an_empty_dot_git_to_the_enclosing_repository() {
		let tmp = TempDir::new().unwrap();
		run_git(tmp.path(), &["init", "-q", "-b", "main"]);
		let fence = tmp.path().join("fence");
		std::fs::create_dir_all(fence.join("project")).unwrap();
		std::fs::create_dir(fence.join(".git")).unwrap();
		let info = discover_info(&fence.join("project")).unwrap().unwrap();
		assert_eq!(info.repo_root, std::path::absolute(tmp.path()).unwrap());
	}

	#[test]
	fn discovery_ignores_a_gitfile_whose_target_has_no_head() {
		let tmp = TempDir::new().unwrap();
		let fence = tmp.path().join("fence");
		std::fs::create_dir_all(fence.join("project")).unwrap();
		std::fs::create_dir(fence.join("store")).unwrap();
		std::fs::write(fence.join(".git"), "gitdir: store\n").unwrap();
		assert_eq!(discover_info(&fence.join("project")).unwrap(), None);
	}

	#[test]
	fn discovery_accepts_a_fresh_repository_with_an_unborn_head() {
		let tmp = TempDir::new().unwrap();
		run_git(tmp.path(), &["init", "-q", "-b", "main"]);
		let src = tmp.path().join("src");
		std::fs::create_dir(&src).unwrap();
		let info = discover_info(&src).unwrap().unwrap();
		assert_eq!(info.repo_root, std::path::absolute(tmp.path()).unwrap());
	}

	#[test]
	fn discovery_accepts_a_committed_repository() {
		let tmp = TempDir::new().unwrap();
		run_git(tmp.path(), &["init", "-q", "-b", "main"]);
		run_git(
			tmp.path(),
			&[
				"-c",
				"user.name=test",
				"-c",
				"user.email=test@example.com",
				"commit",
				"--allow-empty",
				"-q",
				"-m",
				"init",
			],
		);
		let info = discover_info(tmp.path()).unwrap().unwrap();
		assert!(info.head_path.is_file());
	}

	fn run_git(dir: &Path, args: &[&str]) {
		let output = std::process::Command::new("git")
			.args(args)
			.current_dir(dir)
			.output()
			.expect("git must be installed");
		assert!(
			output.status.success(),
			"git {:?} failed: {}",
			args,
			String::from_utf8_lossy(&output.stderr)
		);
	}
}
