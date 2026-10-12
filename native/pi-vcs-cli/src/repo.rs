//! Repository handle: lazy gitoxide open with environment-stripping that
//! mirrors the harness subprocess wrapper, faithful port of
//! oh-my-pi `crates/pi-vcs/src/git/open.rs` (MIT).

use std::path::Path;

use gix::{
	open::{Options, Permissions, permissions},
	sec::{Permission, Trust},
};

use crate::{
	discovery::{GitRepoInfo, discover_info, head_watch_target},
	error::{Error, Result},
};

/// Discovered repository + lazily opened gitoxide handle.
pub struct Repo {
	info: GitRepoInfo,
	gix: Option<gix::ThreadSafeRepository>,
}

/// Resolve `dir` to a discovered repository, or `None` outside any checkout.
pub fn discover(dir: &Path) -> Result<Option<Repo>> {
	let Some(info) = discover_info(dir)? else {
		return Ok(None);
	};
	Ok(Some(Repo { info, gix: None }))
}

/// Like [`discover`], but errors with `NotARepository` outside any checkout.
pub fn require(dir: &Path) -> Result<Repo> {
	discover(dir)?.ok_or_else(|| Error::NotARepository { path: dir.to_owned() })
}

impl Repo {
	/// Resolved repository metadata.
	pub fn info(&self) -> &GitRepoInfo {
		&self.info
	}

	/// Checkout root (may be a linked worktree root).
	#[allow(dead_code)] // kept for parity with upstream's GitRepo::root
	pub fn root(&self) -> &Path {
		&self.info.repo_root
	}

	/// Open (once) the gitoxide handle with env-stripping: `GIT_*` location
	/// overrides are denied so operations bind to the discovered repository,
	/// while user/system config stays allowed for identity and diff settings.
	pub fn gix(&mut self) -> Result<gix::Repository> {
		if self.info.is_reftable {
			return Err(Error::backend(
				"git open",
				"reftable repository cannot be opened in-process; use the CLI fallback",
			));
		}
		if let Some(repo) = &self.gix {
			return Ok(repo.to_thread_local());
		}
		let opened = open_discovered(self)?;
		self.gix = Some(opened.clone());
		Ok(opened.to_thread_local())
	}

	/// Current branch name (the ref target when HEAD is symbolic), or `None`
	/// on a detached HEAD.
	pub fn branch(&self) -> Option<String> {
		if self.info.is_reftable {
			return None;
		}
		let content = std::fs::read_to_string(&self.info.head_path).ok()?;
		let rest = content.trim().strip_prefix("ref: ")?;
		rest.strip_prefix("refs/heads/").map(str::to_owned)
	}

	/// Filesystem targets whose metadata changes when HEAD moves: the `HEAD`
	/// file plus, when HEAD is a symbolic ref and the ref file is writable,
	/// the branch ref itself (a plain `git commit` only touches the latter).
	pub fn watch_targets(&self) -> Vec<std::path::PathBuf> {
		let mut targets = vec![head_watch_target(&self.info)];
		if self.info.is_reftable {
			return targets;
		}
		let Ok(content) = std::fs::read_to_string(&self.info.head_path) else {
			return targets;
		};
		let Some(rest) = content.trim().strip_prefix("ref: ") else {
			return targets;
		};
		let ref_path = self.info.git_dir.join(rest);
		if ref_path.exists() {
			targets.push(ref_path);
		}
		targets
	}
}

/// Open the discovered `.git` entry (directory, or gitfile for linked
/// worktrees and separate git dirs).
///
/// Never pass the checkout root: gix treats any `*.git` path as the metadata
/// directory itself instead of probing `<path>/.git`, so a checkout named
/// `repo.git` would fail to open (upstream 3ea62462b4, #14553). The entry
/// also keeps gix deriving the work tree from it, which the resolved
/// `git_dir` alone cannot for separate git dirs.
fn open_discovered(repo: &Repo) -> Result<gix::ThreadSafeRepository> {
	open_options()
		.open(&repo.info.git_entry_path)
		.map_err(|err| Error::backend("git open", err))
}

/// Open options for repositories the agent operates on. Local dev tool on the
/// user's own checkout: full trust; location env overrides denied; config
/// (user/system/git) allowed without ever executing git for install-prefix
/// config.
fn open_options() -> Options {
	Options::default()
		.permissions(Permissions {
			env: permissions::Environment {
				xdg_config_home: Permission::Allow,
				home: Permission::Allow,
				http_transport: Permission::Deny,
				identity: Permission::Allow,
				objects: Permission::Deny,
				git_prefix: Permission::Deny,
				ssh_prefix: Permission::Deny,
			},
			config: permissions::Config::all(),
			attributes: permissions::Attributes::all(),
		})
		.with(Trust::Full)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn run_git(dir: &Path, args: &[&str]) {
		let output = std::process::Command::new("git")
			.args(args)
			.current_dir(dir)
			.output()
			.expect("git must be installed");
		assert!(
			output.status.success(),
			"git {args:?} failed: {}",
			String::from_utf8_lossy(&output.stderr)
		);
	}

	/// gix treats a `*.git` path as the metadata directory itself, so the
	/// checkout root must never be handed to it in place of the `.git`
	/// entry (upstream 3ea62462b4, #14553): a primary checkout and a linked
	/// worktree whose directory names end in `.git` must both open, with the
	/// work tree still derived from the entry.
	#[test]
	fn gix_opens_checkouts_whose_directory_name_ends_in_dot_git() {
		let temp = tempfile::TempDir::new().unwrap();
		let main = temp.path().join("repo.git");
		std::fs::create_dir_all(&main).unwrap();
		run_git(&main, &["init", "-q", "-b", "main"]);
		run_git(&main, &["config", "user.name", "VCS Test"]);
		run_git(&main, &["config", "user.email", "vcs@example.com"]);
		run_git(&main, &["commit", "-q", "--allow-empty", "-m", "init"]);
		let linked = temp.path().join("linked.git");
		run_git(&main, &["worktree", "add", "-q", linked.to_str().unwrap(), "-b", "wt"]);

		for (root, git_dir) in
			[(&main, main.join(".git")), (&linked, main.join(".git/worktrees/linked.git"))]
		{
			let mut repo = discover(root).unwrap().expect("checkout");
			let opened = repo.gix().unwrap();
			assert_eq!(
				std::fs::canonicalize(opened.git_dir()).unwrap(),
				std::fs::canonicalize(git_dir).unwrap()
			);
			assert_eq!(
				std::fs::canonicalize(opened.workdir().expect("non-bare checkout")).unwrap(),
				std::fs::canonicalize(root).unwrap()
			);
			opened.head_id().expect("HEAD resolves");
		}
	}
}
