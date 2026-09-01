//! Git-compatible patch generation over gitoxide — faithful port of
//! oh-my-pi `crates/pi-vcs/src/git/diff.rs` (MIT), restricted to the narrow
//! slice: two-revision diffs, staged (cached) diffs, worktree diffs (index vs
//! worktree and base vs worktree), and their unified-text / name-only /
//! numstat rendering. The `GIT binary patch` body machinery (delta/base85) is
//! dropped: binary changes render as the `Binary files … differ` marker,
//! matching the harness parser's expectations.

use std::fmt::Write as _;
use std::path::Path;

use gix::bstr::{BStr, BString, ByteSlice};

use crate::{
	discovery::normalize_path,
	error::{Error, Result},
};

/// Diff output mode: unified text (git-compatible), name-only, or numstat.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum OutputMode {
	Text,
	NameOnly,
	Numstat,
}

/// Plain status summary counts, matching the harness `ctx.git.status` shape.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct StatusSummary {
	pub staged: u32,
	pub unstaged: u32,
	pub untracked: u32,
}

/// Diff options: which comparison to render and with how much context.
pub struct DiffOptions {
	/// Base revision (rev-parse spec). `None` means the index or worktree.
	pub base: Option<String>,
	/// Head revision (rev-parse spec). `None` with a base renders base→worktree.
	pub head: Option<String>,
	/// Compare the index against HEAD (staged diff) instead of the worktree.
	pub cached: bool,
	/// Restrict the diff to these pathspecs.
	pub files: Vec<String>,
	/// Number of context lines (default 3).
	pub context: u32,
}

impl Default for DiffOptions {
	fn default() -> Self {
		Self { base: None, head: None, cached: false, files: Vec::new(), context: 3 }
	}
}

#[derive(Clone)]
struct FileChange {
	old_path: String,
	new_path: String,
	old_id: gix::ObjectId,
	new_id: gix::ObjectId,
	old_mode: Option<gix::objs::tree::EntryMode>,
	new_mode: Option<gix::objs::tree::EntryMode>,
	similarity: Option<u8>,
	worktree_new: bool,
}

/// Render the selected changes as a git patch (unified diff text).
pub fn diff_text(repo: &gix::Repository, options: &DiffOptions) -> Result<String> {
	let changes = collect_changes(repo, options)?;
	let rendered = render_changes(repo, changes, options.context)?;
	Ok(rendered.into_iter().map(|item| item.text).collect())
}

/// Dispatch one diff request to the requested output mode.
pub fn render_diff(
	repo: &gix::Repository,
	options: &DiffOptions,
	mode: OutputMode,
) -> Result<String> {
	match mode {
		OutputMode::Text => diff_text(repo, options),
		OutputMode::NameOnly => diff_name_only(repo, options),
		OutputMode::Numstat => diff_numstat(repo, options),
	}
}

/// Render just the changed file names (`git diff --name-only`), one per line,
/// quoting paths the way git does.
pub fn diff_name_only(repo: &gix::Repository, options: &DiffOptions) -> Result<String> {
	let changes = collect_changes(repo, options)?;
	let mut out = String::new();
	for change in changes {
		out.push_str(&quote_c_style(&change.new_path));
		out.push('\n');
	}
	Ok(out)
}

/// Render per-file line counts (`git diff --numstat`): `added\tremoved\tpath`
/// with `-` for binary and git's compact `{old => new}` rename form.
pub fn diff_numstat(repo: &gix::Repository, options: &DiffOptions) -> Result<String> {
	let changes = collect_changes(repo, options)?;
	let rendered = render_changes(repo, changes.clone(), 0)?;
	let mut out = String::new();
	for (change, item) in changes.iter().zip(rendered.iter()) {
		match (item.added, item.removed) {
			(None, None) => out.push_str("-\t-\t"),
			(Some(added), Some(removed)) => {
				let _ = write!(out, "{added}\t{removed}\t");
			},
			_ => return Err(Error::backend("git diff --numstat", "inconsistent diff counts")),
		}
		if change.old_path != change.new_path {
			out.push_str(&pprint_rename(&change.old_path, &change.new_path));
		} else {
			out.push_str(&quote_c_style(&change.new_path));
		}
		out.push('\n');
	}
	Ok(out)
}

/// Porcelain-derived status summary counts (`git status --porcelain`), one
/// entry per line: staged/unstaged from the two state columns, untracked from
/// `??`, with untracked directories collapsed to one entry.
pub fn status_summary(repo: &gix::Repository) -> Result<StatusSummary> {
	let text = status_porcelain(repo)?;
	let mut summary = StatusSummary { staged: 0, unstaged: 0, untracked: 0 };
	for line in text.lines().filter(|line| line.len() >= 2) {
		let bytes = line.as_bytes();
		if bytes[0] == b'?' && bytes[1] == b'?' {
			summary.untracked += 1;
		} else {
			if bytes[0] != b' ' {
				summary.staged += 1;
			}
			if bytes[1] != b' ' {
				summary.unstaged += 1;
			}
		}
	}
	Ok(summary)
}

fn collect_changes(repo: &gix::Repository, options: &DiffOptions) -> Result<Vec<FileChange>> {
	if let Some(base) = options.base.as_deref() {
		let old = revision_tree(repo, base)?;
		if let Some(head) = options.head.as_deref() {
			let new = revision_tree(repo, head)?;
			return tree_changes(repo, Some(&old), Some(&new), &options.files);
		}
		return base_worktree_changes(repo, old.id, &options.files);
	}
	if options.cached {
		return cached_changes(repo, &options.files);
	}
	worktree_changes(repo, &options.files)
}

fn revision_tree<'repo>(repo: &'repo gix::Repository, rev: &str) -> Result<gix::Tree<'repo>> {
	let id = repo
		.rev_parse_single(rev)
		.map_err(|err| Error::backend("git diff revision", err))?;
	let object = id
		.object()
		.map_err(|err| Error::backend("git diff revision", err))?;
	object
		.peel_to_tree()
		.map_err(|err| Error::backend("git diff revision", err))
}

fn tree_changes(
	repo: &gix::Repository,
	old: Option<&gix::Tree<'_>>,
	new: Option<&gix::Tree<'_>>,
	files: &[String],
) -> Result<Vec<FileChange>> {
	let changes = repo
		.diff_tree_to_tree(old, new, None)
		.map_err(|err| Error::backend("git diff-tree", err))?;
	let mut pathspec = make_pathspec(repo, files, false)?;
	let null = repo.object_hash().null();
	let mut out = Vec::with_capacity(changes.len());
	for change in changes {
		use gix::object::tree::diff::ChangeDetached;
		let item = match change {
			ChangeDetached::Addition { location, entry_mode, id, .. } => FileChange {
				old_path: path_string(location.as_ref()),
				new_path: path_string(location.as_ref()),
				old_id: null,
				new_id: id,
				old_mode: None,
				new_mode: Some(entry_mode),
				similarity: None,
				worktree_new: false,
			},
			ChangeDetached::Deletion { location, entry_mode, id, .. } => FileChange {
				old_path: path_string(location.as_ref()),
				new_path: path_string(location.as_ref()),
				old_id: id,
				new_id: null,
				old_mode: Some(entry_mode),
				new_mode: None,
				similarity: None,
				worktree_new: false,
			},
			ChangeDetached::Modification {
				location,
				previous_entry_mode,
				previous_id,
				entry_mode,
				id,
			} => FileChange {
				old_path: path_string(location.as_ref()),
				new_path: path_string(location.as_ref()),
				old_id: previous_id,
				new_id: id,
				old_mode: Some(previous_entry_mode),
				new_mode: Some(entry_mode),
				similarity: None,
				worktree_new: false,
			},
			ChangeDetached::Rewrite {
				source_location,
				source_entry_mode,
				source_id,
				diff,
				entry_mode,
				id,
				location,
				copy,
				..
			} => {
				if copy {
					continue;
				}
				FileChange {
					old_path: path_string(source_location.as_ref()),
					new_path: path_string(location.as_ref()),
					old_id: source_id,
					new_id: id,
					old_mode: Some(source_entry_mode),
					new_mode: Some(entry_mode),
					similarity: Some(diff.map_or(100, |stats| (stats.similarity * 100.0).floor() as u8)),
					worktree_new: false,
				}
			},
		};
		if item
			.old_mode
			.or(item.new_mode)
			.is_some_and(|mode| mode.kind() == gix::objs::tree::EntryKind::Tree)
		{
			continue;
		}
		if pathspec.as_mut().is_none_or(|spec| {
			spec.is_included(item.old_path.as_bytes().as_bstr(), Some(false))
				|| spec.is_included(item.new_path.as_bytes().as_bstr(), Some(false))
		}) {
			out.push(item);
		}
	}
	sort_changes(&mut out);
	Ok(out)
}

fn cached_changes(repo: &gix::Repository, files: &[String]) -> Result<Vec<FileChange>> {
	let tree_id = repo
		.head_tree_id_or_empty()
		.map_err(|err| Error::backend("git diff --cached", err))?;
	index_changes(repo, tree_id.detach(), files)
}

fn index_changes(
	repo: &gix::Repository,
	tree_id: gix::ObjectId,
	files: &[String],
) -> Result<Vec<FileChange>> {
	let index = load_index_or_empty(repo, "git diff --cached")?;
	let mut pathspec = make_pathspec(repo, files, false)?;
	let mut out = Vec::new();
	repo
		.tree_index_status(
			&tree_id,
			&index,
			pathspec.as_mut(),
			gix::status::tree_index::TrackRenames::AsConfigured,
			|change, _, _| -> Result<_> {
				out.push(index_change(repo, change.into_owned())?);
				Ok(std::ops::ControlFlow::Continue(()))
			},
		)
		.map_err(|err| Error::backend("git diff --cached", err))?;
	sort_changes(&mut out);
	Ok(out)
}

fn index_change(repo: &gix::Repository, change: gix::diff::index::Change) -> Result<FileChange> {
	use gix::diff::index::ChangeRef;
	let null = repo.object_hash().null();
	let result = match change {
		ChangeRef::Addition { location, entry_mode, id, .. } => FileChange {
			old_path: path_string(location.as_ref()),
			new_path: path_string(location.as_ref()),
			old_id: null,
			new_id: id.into_owned(),
			old_mode: None,
			new_mode: index_mode(entry_mode)?,
			similarity: None,
			worktree_new: false,
		},
		ChangeRef::Deletion { location, entry_mode, id, .. } => FileChange {
			old_path: path_string(location.as_ref()),
			new_path: path_string(location.as_ref()),
			old_id: id.into_owned(),
			new_id: null,
			old_mode: index_mode(entry_mode)?,
			new_mode: None,
			similarity: None,
			worktree_new: false,
		},
		ChangeRef::Modification {
			location,
			previous_entry_mode,
			previous_id,
			entry_mode,
			id,
			..
		} => FileChange {
			old_path: path_string(location.as_ref()),
			new_path: path_string(location.as_ref()),
			old_id: previous_id.into_owned(),
			new_id: id.into_owned(),
			old_mode: index_mode(previous_entry_mode)?,
			new_mode: index_mode(entry_mode)?,
			similarity: None,
			worktree_new: false,
		},
		ChangeRef::Rewrite {
			source_location,
			source_entry_mode,
			source_id,
			location,
			entry_mode,
			id,
			copy,
			..
		} => {
			if copy {
				return Err(Error::backend("git diff --cached", "unexpected copy tracking"));
			}
			let identical = source_id == id;
			FileChange {
				old_path: path_string(source_location.as_ref()),
				new_path: path_string(location.as_ref()),
				old_id: source_id.into_owned(),
				new_id: id.into_owned(),
				old_mode: index_mode(source_entry_mode)?,
				new_mode: index_mode(entry_mode)?,
				similarity: Some(if identical { 100 } else { u8::MAX }),
				worktree_new: false,
			}
		},
	};
	Ok(result)
}

fn base_worktree_changes(
	repo: &gix::Repository,
	base_tree: gix::ObjectId,
	files: &[String],
) -> Result<Vec<FileChange>> {
	let staged = index_changes(repo, base_tree, files)?;
	let worktree = worktree_changes(repo, files)?;
	let mut combined = std::collections::BTreeMap::new();
	for change in staged {
		combined.insert(change.new_path.clone(), change);
	}
	for change in worktree {
		if let Some(previous) = combined.get_mut(&change.old_path) {
			previous.new_id = change.new_id;
			previous.new_mode = change.new_mode;
			previous.new_path = change.new_path;
			previous.worktree_new = true;
		} else {
			combined.insert(change.new_path.clone(), change);
		}
	}
	let mut out = combined
		.into_values()
		.filter(|change| change.old_id != change.new_id || change.old_mode != change.new_mode)
		.collect::<Vec<_>>();
	sort_changes(&mut out);
	Ok(out)
}

fn worktree_changes(repo: &gix::Repository, files: &[String]) -> Result<Vec<FileChange>> {
	let patterns = bstring_patterns(files);
	let mut iter = status_with_fresh_index(repo, "git diff")?
		.untracked_files(gix::status::UntrackedFiles::None)
		.index_worktree_options_mut(|options| options.dirwalk_options = None)
		.into_index_worktree_iter(patterns)
		.map_err(|err| Error::backend("git diff", err))?;
	let mut pending = Vec::new();
	for item in &mut iter {
		let item = item.map_err(|err| Error::backend("git diff", err))?;
		if let gix::status::index_worktree::Item::Modification { entry, rela_path, status, .. } = item
		{
			pending.push((entry, rela_path, status));
		}
	}

	let (mut filter, filter_index) = repo
		.filter_pipeline(None)
		.map_err(|err| Error::backend("git diff filter", err))?;
	let null = repo.object_hash().null();
	let mut out = Vec::with_capacity(pending.len());
	for (entry, path, status) in pending {
		use gix::status::plumbing::index_as_worktree::{Change, EntryStatus};
		let mut old_id = entry.id;
		let mut old_mode = index_mode(entry.mode)?;
		let mut new_id = null;
		let mut new_mode = None;
		match status {
			EntryStatus::Change(Change::Removed) => {},
			EntryStatus::Change(Change::Type { .. } | Change::Modification { .. }) => {
				if let Some((id, kind, _)) = filter
					.worktree_file_to_object(path.as_ref(), &filter_index)
					.map_err(|err| Error::backend("git diff filter", err))?
				{
					new_id = id;
					new_mode = Some(kind.into());
				}
			},
			EntryStatus::IntentToAdd => {
				old_id = null;
				old_mode = None;
				if let Some((id, kind, _)) = filter
					.worktree_file_to_object(path.as_ref(), &filter_index)
					.map_err(|err| Error::backend("git diff filter", err))?
				{
					new_id = id;
					new_mode = Some(kind.into());
				}
			},
			EntryStatus::Conflict { .. }
			| EntryStatus::NeedsUpdate(_)
			| EntryStatus::Change(Change::SubmoduleModification(_)) => continue,
		}
		if new_mode.is_some() && old_id == new_id && old_mode == new_mode {
			continue;
		}
		let path = path_string(path.as_ref());
		out.push(FileChange {
			old_path: path.clone(),
			new_path: path,
			old_id,
			new_id,
			old_mode,
			new_mode,
			similarity: None,
			worktree_new: true,
		});
	}
	sort_changes(&mut out);
	Ok(out)
}

/// `git status --porcelain` (untracked=normal) built from a fresh index; the
/// byte-level shape mirrors git, including path quoting, untracked-directory
/// collapse, and empty-directory invisibility. Port of omp's `status_porcelain`.
fn status_porcelain(repo: &gix::Repository) -> Result<String> {
	let platform = status_with_fresh_index(repo, "git status")?
		.untracked_files(gix::status::UntrackedFiles::Collapsed);
	let iter = platform
		.into_iter(std::iter::empty::<gix::bstr::BString>())
		.map_err(|err| Error::backend("git status", err))?;
	let mut states: std::collections::BTreeMap<String, (char, char, Option<String>)> =
		std::collections::BTreeMap::new();
	let mut untracked_paths: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
	for item in iter {
		let item = item.map_err(|err| Error::backend("git status", err))?;
		use gix::status::{Item, index_worktree};
		match item {
			Item::TreeIndex(change) => {
				use gix::diff::index::ChangeRef;
				match change {
					ChangeRef::Addition { location, .. } => {
						set_index(&mut states, &location, 'A', None);
					},
					ChangeRef::Deletion { location, .. } => {
						set_index(&mut states, &location, 'D', None);
					},
					ChangeRef::Modification { location, .. } => {
						set_index(&mut states, &location, 'M', None);
					},
					ChangeRef::Rewrite { source_location, location, copy, .. } => {
						set_index(
							&mut states,
							&location,
							if copy { 'C' } else { 'R' },
							Some(bytes_to_path(&source_location)),
						);
					},
				}
			},
			Item::IndexWorktree(change) => match change {
				index_worktree::Item::Modification { rela_path, status, .. } => {
					use gix::status::plumbing::index_as_worktree::{Change, EntryStatus};
					// git renders a conflicted path as `UU`: both the index
					// (stage entries) and the worktree are marked unresolved.
					if let EntryStatus::Conflict { .. } = status {
						states
							.entry(bytes_to_path(rela_path.as_bstr()))
							.and_modify(|s| {
								s.0 = 'U';
								s.1 = 'U';
							})
							.or_insert(('U', 'U', None));
						continue;
					}
					let code = match status {
						EntryStatus::Change(Change::Removed) => 'D',
						EntryStatus::Change(Change::Type { .. }) => 'T',
						EntryStatus::Change(
							Change::Modification { .. } | Change::SubmoduleModification(_),
						) => 'M',
						EntryStatus::IntentToAdd => 'A',
						EntryStatus::NeedsUpdate(_) => continue,
						EntryStatus::Conflict { .. } => unreachable!(),
					};
					set_worktree(&mut states, rela_path.as_bstr(), code);
				},
				index_worktree::Item::DirectoryContents { entry, .. }
					if entry.status == gix::dir::entry::Status::Untracked =>
				{
					let mut path = bytes_to_path(entry.rela_path.as_bstr());
					if entry.disk_kind == Some(gix::dir::entry::Kind::Directory) {
						let joined = repo
							.workdir()
							.ok_or_else(|| Error::backend("git status", "worktree has no workdir"))?
							.join(&path);
						if !dir_contains_file(&joined) {
							continue;
						}
						path.push('/');
					}
					untracked_paths.insert(path);
				},
				index_worktree::Item::Rewrite { source, dirwalk_entry, copy, .. } => {
					let old = match source {
						index_worktree::RewriteSource::RewriteFromIndex { source_rela_path, .. } => {
							bytes_to_path(source_rela_path.as_bstr())
						},
						index_worktree::RewriteSource::CopyFromDirectoryEntry {
							source_dirwalk_entry,
							..
						} => bytes_to_path(source_dirwalk_entry.rela_path.as_bstr()),
					};
					let new = bytes_to_path(dirwalk_entry.rela_path.as_bstr());
					states.insert(new, (' ', if copy { 'C' } else { 'R' }, Some(old)));
				},
				_ => {},
			},
		}
	}
	let mut out = String::new();
	for (path, (x, y, old)) in states.into_iter().chain(
		untracked_paths
			.into_iter()
			.map(|path| (path, ('?', '?', None))),
	) {
		out.push(x);
		out.push(y);
		out.push(' ');
		if let Some(old) = old {
			out.push_str(&quote_path_status(&old));
			out.push_str(" -> ");
		}
		out.push_str(&quote_path_status(&path));
		out.push('\n');
	}
	Ok(out)
}

fn set_index(
	states: &mut std::collections::BTreeMap<String, (char, char, Option<String>)>,
	path: &gix::bstr::BStr,
	code: char,
	old: Option<String>,
) {
	states
		.entry(bytes_to_path(path))
		.and_modify(|s| {
			s.0 = code;
			s.2.clone_from(&old);
		})
		.or_insert((code, ' ', old));
}

fn set_worktree(
	states: &mut std::collections::BTreeMap<String, (char, char, Option<String>)>,
	path: &gix::bstr::BStr,
	code: char,
) {
	states
		.entry(bytes_to_path(path))
		.and_modify(|s| s.1 = code)
		.or_insert((' ', code, None));
}

/// Whether any regular file (or symlink) exists beneath `dir`; git omits
/// untracked directories that hold nothing but empty directories.
fn dir_contains_file(dir: &std::path::Path) -> bool {
	let Ok(entries) = std::fs::read_dir(dir) else {
		return false;
	};
	for entry in entries.flatten() {
		match entry.file_type() {
			Ok(kind) if kind.is_dir() => {
				if dir_contains_file(&entry.path()) {
					return true;
				}
			},
			Ok(_) => return true,
			Err(_) => {},
		}
	}
	false
}

/// A fresh-index status platform: the persisted index loaded straight from
/// disk (bypassing gix's mtime-gated snapshot), then status walking from it.
fn status_with_fresh_index<'repo>(
	repo: &'repo gix::Repository,
	op: &'static str,
) -> Result<gix::status::Platform<'repo, gix::progress::Discard>> {
	let index = load_index_or_empty(repo, op)?;
	Ok(repo
		.status(gix::progress::Discard)
		.map_err(|err| Error::backend(op, err))?
		.index(index.into()))
}

fn bytes_to_path(value: &gix::bstr::BStr) -> String {
	value.to_str_lossy().into_owned()
}

/// Whether a path needs C-quoting under git's `core.quotePath` (default on):
/// any byte outside printable ASCII, plus `"` and `\`. A plain space never
/// triggers quoting — that matches git's diff outputs (`quote_c_style`).
fn needs_quote(path: &str) -> bool {
	path
		.bytes()
		.any(|b| !(0x20..0x7f).contains(&b) || b == b'"' || b == b'\\')
}

/// Push the C-quoted body of `path` (escapes but no surrounding quotes),
/// matching git's `quote_c_style`: named escapes for `\b \t \n \v \f \r`,
/// `\\` and `\"`, octal for every other non-printable byte (and for every
/// byte of multi-byte UTF-8, exactly like git).
fn push_quoted_body(out: &mut String, path: &str) {
	let mut pending = 0;
	for (index, ch) in path.char_indices() {
		if ch.is_ascii() {
			let byte = ch as u8;
			if (0x20..0x7f).contains(&byte) && byte != b'"' && byte != b'\\' {
				continue;
			}
			out.push_str(&path[pending..index]);
			pending = index + 1;
			match byte {
				b'\\' => out.push_str("\\\\"),
				b'"' => out.push_str("\\\""),
				b'\n' => out.push_str("\\n"),
				b'\r' => out.push_str("\\r"),
				b'\t' => out.push_str("\\t"),
				0x08 => out.push_str("\\b"),
				0x0b => out.push_str("\\v"),
				0x0c => out.push_str("\\f"),
				_ => {
					let _ = write!(out, "\\{byte:03o}");
				},
			}
		} else {
			// Every byte of a multi-byte char is escaped as octal, like git.
			out.push_str(&path[pending..index]);
			pending = index + ch.len_utf8();
			for byte in path[index..index + ch.len_utf8()].bytes() {
				let _ = write!(out, "\\{byte:03o}");
			}
		}
	}
	out.push_str(&path[pending..]);
}

/// git's `quote_c_style(path)`: the path C-quoted with surrounding double
/// quotes when any byte needs it, else the bare path.
fn quote_c_style(path: &str) -> String {
	if !needs_quote(path) {
		return path.to_owned();
	}
	let mut out = String::from("\"");
	push_quoted_body(&mut out, path);
	out.push('"');
	out
}

/// git's `quote_two(prefix, path)` used for `a/`/`b/` header labels: when
/// either needs quoting both are joined inside one pair of quotes, and each
/// is escaped verbatim (`"a/sp \304\203ce.txt"`), else `prefix + path` plainly.
fn quote_two(prefix: &str, path: &str) -> String {
	if needs_quote(prefix) || needs_quote(path) {
		let mut out = String::from("\"");
		out.push_str(prefix);
		push_quoted_body(&mut out, path);
		out.push('"');
		out
	} else {
		let mut out = String::with_capacity(prefix.len() + path.len());
		out.push_str(prefix);
		out.push_str(path);
		out
	}
}

/// git's `quote_path()` for porcelain status: like `quote_c_style` but a
/// space anywhere forces the quoted form (`QUOTE_PATH_QUOTE_SP`).
fn quote_path_status(path: &str) -> String {
	if !needs_quote(path) && !path.contains(' ') {
		return path.to_owned();
	}
	let mut out = String::from("\"");
	push_quoted_body(&mut out, path);
	out.push('"');
	out
}

/// git's `pprint_rename`: `pfx{mid-a => mid-b}sfx` when a common directory
/// prefix or slash-bounded suffix exists, else `a => b`. When either path
/// needs C-quoting, both full paths are quoted and the compact form is
/// skipped (git fast-paths to that), matching numstat output.
fn pprint_rename(a: &str, b: &str) -> String {
	if a
		.bytes()
		.any(|byte| !(0x20..0x7f).contains(&byte) || byte == b'"' || byte == b'\\')
		|| b
			.bytes()
			.any(|byte| !(0x20..0x7f).contains(&byte) || byte == b'"' || byte == b'\\')
	{
		return format!("{} => {}", quote_c_style(a), quote_c_style(b));
	}
	let len_a = a.len();
	let len_b = b.len();
	let a_bytes = a.as_bytes();
	let b_bytes = b.as_bytes();
	// git's pfx_length: longest common prefix, remembered through the LAST
	// `/` seen (the prefix always ends at a directory boundary).
	let mut pfx_length = 0;
	let mut i = 0;
	while i < len_a && i < len_b && a_bytes[i] == b_bytes[i] {
		if a_bytes[i] == b'/' {
			pfx_length = i + 1;
		}
		i += 1;
	}
	// git's sfx_length: common suffix scanned from the end; every `/` seen
	// overwrites it (the LAST, leftmost slash-bounded suffix wins), and the
	// walk may run one position into the common prefix when one exists, so
	// `p/q` -> `r/q` yields `{p => r}/q` and `p/q/r` -> `s/q/r` yields
	// `{p => s}/q/r`.
	let pfx_adjust = i32::from(pfx_length > 0);
	let mut sfx_length = 0;
	let mut ai = len_a;
	let mut bi = len_b;
	while ai > 0
		&& bi > 0
		&& ai as i32 - pfx_adjust >= pfx_length as i32
		&& bi as i32 - pfx_adjust >= pfx_length as i32
		&& a_bytes[ai - 1] == b_bytes[bi - 1]
	{
		ai -= 1;
		bi -= 1;
		if a_bytes[ai] == b'/' {
			sfx_length = len_a - ai;
		}
	}
	let a_midlen = len_a - pfx_length - sfx_length;
	let b_midlen = len_b - pfx_length - sfx_length;
	if pfx_length + sfx_length > 0 {
		let mut out = String::new();
		out.push_str(&a[..pfx_length]);
		out.push('{');
		out.push_str(&a[pfx_length..pfx_length + a_midlen]);
		out.push_str(" => ");
		out.push_str(&b[pfx_length..pfx_length + b_midlen]);
		out.push('}');
		out.push_str(&a[len_a - sfx_length..]);
		out
	} else {
		format!("{a} => {b}")
	}
}

fn render_changes(
	repo: &gix::Repository,
	changes: Vec<FileChange>,
	context: u32,
) -> Result<Vec<Rendered>> {
	let roots = if changes.iter().any(|change| change.worktree_new) {
		gix::diff::blob::pipeline::WorktreeRoots {
			old_root: None,
			new_root: repo.workdir().map(Path::to_owned),
		}
	} else {
		Default::default()
	};
	let mut cache = repo
		.diff_resource_cache(gix::diff::blob::pipeline::Mode::ToGit, roots)
		.map_err(|err| Error::backend("git diff", err))?;
	let mut out = Vec::with_capacity(changes.len());
	for change in changes {
		out.push(render_change(repo, &mut cache, &change, context)?);
		cache.clear_resource_cache_keep_allocation();
	}
	Ok(out)
}

struct Rendered {
	text: String,
	added: Option<u32>,
	removed: Option<u32>,
}

fn render_change(
	repo: &gix::Repository,
	cache: &mut gix::diff::blob::Platform,
	change: &FileChange,
	context: u32,
) -> Result<Rendered> {
	let old_kind = change
		.old_mode
		.or(change.new_mode)
		.ok_or_else(|| Error::backend("git diff", "change has no file mode"))?
		.kind();
	let new_kind = change
		.new_mode
		.or(change.old_mode)
		.ok_or_else(|| Error::backend("git diff", "change has no file mode"))?
		.kind();
	cache
		.set_resource(
			change.old_id,
			old_kind,
			change.old_path.as_bytes().as_bstr(),
			gix::diff::blob::ResourceKind::OldOrSource,
			repo,
		)
		.map_err(|err| Error::backend("git diff", err))?;
	cache
		.set_resource(
			change.new_id,
			new_kind,
			change.new_path.as_bytes().as_bstr(),
			gix::diff::blob::ResourceKind::NewOrDestination,
			repo,
		)
		.map_err(|err| Error::backend("git diff", err))?;
	let prepared = cache
		.prepare_diff()
		.map_err(|err| Error::backend("git diff", err))?;

	let mut text = String::new();
	text.push_str("diff --git ");
	text.push_str(&quote_two("a/", &change.old_path));
	text.push(' ');
	text.push_str(&quote_two("b/", &change.new_path));
	text.push('\n');
	let is_binary = matches!(
		prepared.operation,
		gix::diff::blob::platform::prepare_diff::Operation::SourceOrDestinationIsBinary
	);
	let _ = is_binary; // slice renders the marker only; no binary patch bodies
	let similarity = if change.similarity == Some(u8::MAX) {
		compute_similarity(&prepared)
	} else {
		change.similarity
	};
	// Upstream renders full ids only for `binary_patch && is_binary`; the slice
	// never emits binary bodies, so ids stay abbreviated like `git diff`.
	append_metadata(&mut text, change, similarity, false);

	match prepared.operation {
		gix::diff::blob::platform::prepare_diff::Operation::SourceOrDestinationIsBinary => {
			let (old_label, new_label) = pair_labels(change);
			text.push_str("Binary files ");
			text.push_str(&old_label);
			text.push_str(" and ");
			text.push_str(&new_label);
			text.push_str(" differ\n");
			Ok(Rendered { text, added: None, removed: None })
		},
		gix::diff::blob::platform::prepare_diff::Operation::InternalDiff { algorithm } => {
			// Tokenize with line terminators kept: git's xdiff treats the
			// terminator as part of the line, so CRLF content diffs with
			// literal `\r` bytes and a final line without a newline is a
			// different line than the same text with one. The convenience
			// `prepared.interned_input()` strips LF/CRLF and would lose both.
			let input = gix::diff::blob::InternedInput::new(
				prepared.old.intern_source(),
				prepared.new.intern_source(),
			);
			let diff = gix::diff::blob::diff_with_slider_heuristics(algorithm, &input);
			let added = diff.count_additions();
			let removed = diff.count_removals();
			if added != 0 || removed != 0 {
				let (old_label, new_label) = pair_labels(change);
				text.push_str("--- ");
				text.push_str(&old_label);
				text.push_str(if old_label.contains(' ') { "\t" } else { "" });
				text.push('\n');
				text.push_str("+++ ");
				text.push_str(&new_label);
				text.push_str(if new_label.contains(' ') { "\t" } else { "" });
				text.push('\n');
				let old_data = prepared.old.data.as_slice().unwrap_or_default();
				let sink = GitHunks {
					out: &mut text,
					old_data,
					next_line: 0,
					next_offset: 0,
					candidate: None,
				};
				gix::diff::blob::UnifiedDiff::new(
					&diff,
					&input,
					sink,
					gix::diff::blob::unified_diff::ContextSize::symmetrical(context),
				)
				.consume()
				.map_err(|err| Error::backend("git diff", err))?;
			}
			Ok(Rendered { text, added: Some(added), removed: Some(removed) })
		},
		gix::diff::blob::platform::prepare_diff::Operation::ExternalCommand { .. } => {
			Err(Error::backend("git diff", "external diff drivers cannot be rendered in-process"))
		},
	}
}

fn append_metadata(out: &mut String, change: &FileChange, similarity: Option<u8>, full_ids: bool) {
	if let Some(similarity) = similarity {
		let _ = writeln!(out, "similarity index {similarity}%");
		out.push_str("rename from ");
		out.push_str(&quote_c_style(&change.old_path));
		out.push('\n');
		out.push_str("rename to ");
		out.push_str(&quote_c_style(&change.new_path));
		out.push('\n');
	}
	match (change.old_mode, change.new_mode) {
		(None, Some(mode)) => {
			let _ = writeln!(out, "new file mode {:06o}", mode.value());
		},
		(Some(mode), None) => {
			let _ = writeln!(out, "deleted file mode {:06o}", mode.value());
		},
		(Some(old), Some(new)) if old != new => {
			let _ = writeln!(out, "old mode {:06o}", old.value());
			let _ = writeln!(out, "new mode {:06o}", new.value());
		},
		_ => {},
	}
	if change.old_id != change.new_id {
		let old = display_id(change.old_id, full_ids);
		let new = display_id(change.new_id, full_ids);
		out.push_str("index ");
		out.push_str(&old);
		out.push_str("..");
		out.push_str(&new);
		if let (true, Some(mode)) = (change.old_mode == change.new_mode, change.old_mode) {
			let _ = write!(out, " {:06o}", mode.value());
		}
		out.push('\n');
	}
}

fn compute_similarity(
	prepared: &gix::diff::blob::platform::prepare_diff::Outcome<'_>,
) -> Option<u8> {
	let gix::diff::blob::platform::prepare_diff::Operation::InternalDiff { algorithm } =
		prepared.operation
	else {
		return Some(50);
	};
	let input = gix::diff::blob::InternedInput::new(
		prepared.old.intern_source(),
		prepared.new.intern_source(),
	);
	let diff = gix::diff::blob::Diff::compute(algorithm, &input);
	let removed_bytes = diff
		.hunks()
		.flat_map(|hunk| &input.before[hunk.before.start as usize..hunk.before.end as usize])
		.map(|token| input.interner[*token].len())
		.sum::<usize>();
	let old_len = prepared.old.data.as_slice()?.len();
	let new_len = prepared.new.data.as_slice()?.len();
	if old_len.max(new_len) == 0 {
		return Some(100);
	}
	Some((((old_len.saturating_sub(removed_bytes)) * 100) / old_len.max(new_len)) as u8)
}

struct GitHunks<'a> {
	out: &'a mut String,
	old_data: &'a [u8],
	/// Monotonic scan state for function context: index of the next
	/// unexamined old-file line, its byte offset, and the most recent
	/// qualifying line seen. `consume_hunk` is invoked in ascending hunk
	/// order, so advancing this cursor forward keeps a single O(n) pass
	/// over each file (git's xdiff bounds its per-hunk backward scan the
	/// same way with `funclineprev`); recomputing the context from line 1
	/// for every hunk would be O(hunks x file size).
	next_line: usize,
	next_offset: usize,
	candidate: Option<&'a [u8]>,
}

impl gix::diff::blob::unified_diff::ConsumeHunk for GitHunks<'_> {
	type Out = ();

	fn consume_hunk(
		&mut self,
		header: gix::diff::blob::unified_diff::HunkHeader,
		lines: &[(gix::diff::blob::unified_diff::DiffLineKind, &[u8])],
	) -> std::io::Result<()> {
		let old_start = zero_start(header.before_hunk_start, header.before_hunk_len);
		let new_start = zero_start(header.after_hunk_start, header.after_hunk_len);
		self.out.push_str("@@ -");
		push_range(self.out, old_start, header.before_hunk_len);
		self.out.push_str(" +");
		push_range(self.out, new_start, header.after_hunk_len);
		self.out.push_str(" @@");
		if let Some(function) = self.advance_function_context(header.before_hunk_start) {
			self.out.push(' ');
			self.out.push_str(&String::from_utf8_lossy(function));
		}
		self.out.push('\n');
		for &(kind, content) in lines {
			self.out.push(kind.to_prefix());
			self.out.push_str(&String::from_utf8_lossy(content));
			// Tokens carry their terminator; a token without one is the
			// final line of a file that does not end in a newline.
			if content.last() != Some(&b'\n') {
				self.out.push('\n');
				self.out.push_str("\\ No newline at end of file\n");
			}
		}
		Ok(())
	}

	fn finish(self) {}
}

fn make_pathspec<'repo>(
	repo: &'repo gix::Repository,
	files: &[String],
	worktree: bool,
) -> Result<Option<gix::Pathspec<'repo>>> {
	if files.is_empty() {
		return Ok(None);
	}
	let index = load_index_or_empty(repo, "git diff pathspec")?;
	repo
		.pathspec(
			false,
			bstring_patterns(files),
			worktree,
			&index,
			if worktree {
				gix::worktree::stack::state::attributes::Source::WorktreeThenIdMapping
			} else {
				gix::worktree::stack::state::attributes::Source::IdMapping
			},
		)
		.map(Some)
		.map_err(|err| Error::backend("git diff pathspec", err))
}

fn sort_changes(changes: &mut [FileChange]) {
	changes.sort_unstable_by(|left, right| {
		left
			.new_path
			.as_bytes()
			.cmp(right.new_path.as_bytes())
			.then_with(|| left.old_path.as_bytes().cmp(right.old_path.as_bytes()))
	});
}

/// The `---`/`+++`/`Binary files` header labels for one change, mirroring
/// git's `lbl[0..2]`: `quote_two("a/", path)` (or `/dev/null` when a side is
/// absent) with the whole label inside one pair of quotes when escaped.
fn pair_labels(change: &FileChange) -> (String, String) {
	let old = if change.old_mode.is_some() {
		quote_two("a/", &change.old_path)
	} else {
		String::from("/dev/null")
	};
	let new = if change.new_mode.is_some() {
		quote_two("b/", &change.new_path)
	} else {
		String::from("/dev/null")
	};
	(old, new)
}

fn index_mode(mode: gix::index::entry::Mode) -> Result<Option<gix::objs::tree::EntryMode>> {
	mode
		.to_tree_entry_mode()
		.map(Some)
		.ok_or_else(|| Error::backend("git diff", "invalid index entry mode"))
}

fn display_id(id: gix::ObjectId, full: bool) -> String {
	if id.is_null() {
		if full {
			"0".repeat(id.kind().len_in_hex())
		} else {
			"0000000".to_owned()
		}
	} else if full {
		id.to_string()
	} else {
		id.to_string().chars().take(7).collect()
	}
}

const fn zero_start(start: u32, len: u32) -> u32 {
	if len == 0 {
		start.saturating_sub(1)
	} else {
		start
	}
}

fn push_range(out: &mut String, start: u32, len: u32) {
	out.push_str(&start.to_string());
	if len != 1 {
		out.push(',');
		out.push_str(&len.to_string());
	}
}

impl<'a> GitHunks<'a> {
	/// Advance the function-context cursor over the old-file lines that
	/// precede the hunk starting at 1-based old-file line `hunk_start`,
	/// returning the most recent qualifying line among them (identical to a
	/// from-scratch backward scan, but O(n) total across all hunks).
	///
	/// Qualifying = line's first byte is not ASCII whitespace and is not
	/// `}`; a trailing `\r` is ignored for the test and omitted from the
	/// returned slice (matching the previous implementation).
	///
	/// Local divergence from the omp port's `function_context`
	/// (crates/pi-vcs/src/git/diff.rs, which rescan the whole file from
	/// line 1 for every hunk - O(hunks x file size)): hunks are consumed in
	/// ascending order here, so a single forward cursor reproduces the exact
	/// same result in one pass per file.
	fn advance_function_context(&mut self, hunk_start: u32) -> Option<&'a [u8]> {
		let before = usize::try_from(hunk_start.saturating_sub(1)).ok()?;
		while self.next_line < before {
			let rest = &self.old_data[self.next_offset..];
			let newline = rest.iter().position(|&byte| byte == b'\n');
			let line_end = newline.map_or(self.old_data.len(), |i| self.next_offset + i);
			let line = &self.old_data[self.next_offset..line_end];
			self.next_offset = newline.map_or(self.old_data.len(), |_| line_end + 1);
			self.next_line += 1;
			let line = line.strip_suffix(b"\r").unwrap_or(line);
			if let Some(&first) = line.first() {
				if !first.is_ascii_whitespace() && first != b'}' {
					self.candidate = Some(line);
				}
			}
		}
		self.candidate
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn probe(data: &[u8], hunk_starts: &[u32]) -> Vec<Option<String>> {
		let mut out = String::new();
		let mut hunks = GitHunks {
			out: &mut out,
			old_data: data,
			next_line: 0,
			next_offset: 0,
			candidate: None,
		};
		hunk_starts
			.iter()
			.map(|&start| {
				hunks
					.advance_function_context(start)
					.map(|line| String::from_utf8_lossy(line).into_owned())
			})
			.collect()
	}

	#[test]
	fn forward_cursor_matches_from_scratch_pick() {
		let data = b"one\ntwo\nthree\nfour\n";
		// hunk at line 2 -> lines before it: ["one"]
		assert_eq!(probe(data, &[2]), vec![Some("one".into())]);
		// hunk at line 4 -> lines before it: ["one","two","three"], last qualifying "three"
		assert_eq!(probe(data, &[4]), vec![Some("three".into())]);
		// two hunks ascending: shared cursor must keep the from-scratch result
		assert_eq!(probe(data, &[2, 4]), vec![Some("one".into()), Some("three".into())]);
		// hunk at line 1 has no preceding lines
		assert_eq!(probe(data, &[1]), vec![None]);
	}

	#[test]
	fn qualifying_line_predicate() {
		// indented lines and `}` never qualify; the nearest qualifying line wins
		let data = b"  indented\nnot indented\n  indented\n}\n";
		assert_eq!(probe(data, &[2]), vec![None]); // before: ["  indented"]
		assert_eq!(probe(data, &[4]), vec![Some("not indented".into())]); // before: [..., "}"]
		assert_eq!(probe(data, &[5]), vec![Some("not indented".into())]); // before ends at "}"
	}

	#[test]
	fn trailing_cr_stripped_and_last_line_without_newline() {
		let data = b"one\r\ntwo\r\nlast";
		// split on \n keeps the terminator; \r is stripped before the test
		assert_eq!(probe(data, &[2]), vec![Some("one".into())]); // before: ["one\r"]
		assert_eq!(probe(data, &[3]), vec![Some("two".into())]); // before: ["one\r","two\r"]
		assert_eq!(probe(data, &[4]), vec![Some("last".into())]); // before also includes bare "last"
	}

	#[test]
	fn empty_and_trailing_newline_files() {
		assert_eq!(probe(b"", &[1]), vec![None]);
		assert_eq!(probe(b"\n", &[1]), vec![None]);
		let data = b"a\n";
		assert_eq!(probe(data, &[2]), vec![Some("a".into())]);
		assert_eq!(probe(data, &[1, 2]), vec![None, Some("a".into())]);
	}
}

fn path_string(path: &BStr) -> String {
	String::from_utf8_lossy(path).into_owned()
}

fn bstring_patterns(files: &[String]) -> Vec<BString> {
	files
		.iter()
		.map(|path| BString::from(path.as_bytes()))
		.collect()
}

/// Load the persisted worktree index straight from disk, falling back to an
/// empty index (never `HEAD^{tree}`) when no index file exists.
///
/// Reads bypass gix's shared, mtime-gated index snapshot so mutate→read is
/// deterministic regardless of filesystem timestamp granularity.
fn load_index_or_empty(repo: &gix::Repository, op: &'static str) -> Result<gix::index::File> {
	match repo.open_index() {
		Ok(index) => Ok(index),
		Err(gix::worktree::open_index::Error::IndexFile(gix::index::file::init::Error::Io(err)))
			if err.kind() == std::io::ErrorKind::NotFound =>
		{
			Ok(repo
				.index_or_empty()
				.map_err(|err| Error::backend(op, err))?
				.into_owned_or_cloned())
		},
		Err(err) => Err(Error::backend(op, err)),
	}
}

/// Resolve a repo path for rendered output (currently unused by the slice;
/// kept for parity with the upstream renderer's contract).
#[allow(dead_code)]
fn normalize_repo_path(path: &str) -> String {
	normalize_path(std::path::Path::new(path))
		.to_string_lossy()
		.into_owned()
}
