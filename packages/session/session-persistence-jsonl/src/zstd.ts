/**
 * Zstandard frame primitives — now owned by the shared
 * `@deepseek-ai/dsh-zstd-frame` utility package. This module is a compatibility
 * facade so existing in-package imports keep resolving; the implementation
 * lives in the util so the session backend and the memory bank share one codec.
 * @module dsh-session-persistence-jsonl/zstd
 */

export * from '@deepseek-ai/dsh-zstd-frame'
