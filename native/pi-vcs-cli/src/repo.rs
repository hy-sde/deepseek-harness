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
		let opened = open_options()
			.open(self.root())
			.map_err(|err| Error::backend("git open", err))?;
		self.gix = Some(opened.clone());
		Ok(opened.to_thread_local())
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
