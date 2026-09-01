//! Git-compatible patch generation over gitoxide — faithful port of
//! oh-my-pi `crates/pi-vcs/src/git/diff.rs` (MIT), restricted to the narrow
//! slice: two-revision diffs, staged (cached) diffs, and their unified-text
//! rendering. The `GIT binary patch` body machinery (delta/base85) is dropped:
//! binary changes render as the `Binary files … differ` marker, matching the
//! harness parser's expectations.

use std::{fmt::Write as _, path::Path};

use gix::bstr::{BStr, BString, ByteSlice};

use crate::{
	discovery::{GitRepoInfo, normalize_path},
	error::{Error, Result},
};

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
pub fn diff_text(
	repo: &gix::Repository,
	_info: &GitRepoInfo,
	options: &DiffOptions,
) -> Result<String> {
	let changes = collect_changes(repo, options)?;
	let rendered = render_changes(repo, changes, options.context)?;
	Ok(rendered.into_iter().map(|item| item.text).collect())
}

fn collect_changes(repo: &gix::Repository, options: &DiffOptions) -> Result<Vec<FileChange>> {
	if let Some(base) = options.base.as_deref() {
		let old = revision_tree(repo, base)?;
		if let Some(head) = options.head.as_deref() {
			let new = revision_tree(repo, head)?;
			return tree_changes(repo, Some(&old), Some(&new), &options.files);
		}
		return tree_changes(repo, Some(&old), None, &options.files);
	}
	if options.cached {
		return cached_changes(repo, &options.files);
	}
	// Worktree diffs (base None, cached false) are out of the CLI slice:
	// the harness renders them through the git service.
	Ok(Vec::new())
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
	#[allow(dead_code)]
	added: Option<u32>,
	#[allow(dead_code)]
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
	text.push_str("diff --git a/");
	text.push_str(&change.old_path);
	text.push_str(" b/");
	text.push_str(&change.new_path);
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
			text.push_str("Binary files ");
			push_old_path(&mut text, change);
			text.push_str(" and ");
			push_new_path(&mut text, change);
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
				text.push_str("--- ");
				push_old_path(&mut text, change);
				text.push('\n');
				text.push_str("+++ ");
				push_new_path(&mut text, change);
				text.push('\n');
				let old_data = prepared.old.data.as_slice().unwrap_or_default();
				let sink = GitHunks { out: &mut text, old_data };
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
		out.push_str(&change.old_path);
		out.push('\n');
		out.push_str("rename to ");
		out.push_str(&change.new_path);
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
		if let Some(function) = function_context(self.old_data, header.before_hunk_start) {
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

fn push_old_path(out: &mut String, change: &FileChange) {
	if change.old_mode.is_some() {
		out.push_str("a/");
		out.push_str(&change.old_path);
	} else {
		out.push_str("/dev/null");
	}
}

fn push_new_path(out: &mut String, change: &FileChange) {
	if change.new_mode.is_some() {
		out.push_str("b/");
		out.push_str(&change.new_path);
	} else {
		out.push_str("/dev/null");
	}
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

fn function_context(data: &[u8], hunk_start: u32) -> Option<&[u8]> {
	let before = usize::try_from(hunk_start.saturating_sub(1)).ok()?;
	let mut candidate = None;
	for line in data.split(|&byte| byte == b'\n').take(before) {
		let line = line.strip_suffix(b"\r").unwrap_or(line);
		if line
			.first()
			.is_some_and(|byte| !byte.is_ascii_whitespace() && *byte != b'}')
		{
			candidate = Some(line);
		}
	}
	candidate
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
