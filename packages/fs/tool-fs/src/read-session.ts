/**
 * Session-aware transcript rendering for the model-facing `read` tool: when a
 * decoded zstd stream parses as a session log (a `session` header record
 * followed by `SessionEvent` rows), render it as a **readable transcript** —
 * the current (non-shadowed) surface projection plus compaction digests —
 * instead of the raw JSONL window. This is the "history as a file" half of
 * the read multi-format story: reading a session log reads a conversation,
 * not a blob of JSON.
 *
 * The renderer is read-only and defensive by construction: any record that
 * does not parse, any event shape `foldSurface` rejects, falls back to the
 * generic decoded-text window in read-zstd (the transcript is an upgrade,
 * never a gate). Rendering stays bounded (events cap, per-line text clamp).
 * @module @deepseek-ai/dsh-tool-fs/src/read-session
 */

import { foldSurface, type SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Structural event view: read-session consumes parsed JSON log rows, not the
 * typed merge-extensible union, so it works on `type` + `data` as plain values.
 * The full parsed record travels alongside because `foldSurface` needs every
 * original field (`surfaceOp`, `sourceEventSeqs`, ...) to replay the surface.
 */
interface TranscriptEvent {
  type: string
  seq: number
  data?: unknown
  /** The complete parsed record, verbatim — the fold boundary's input. */
  raw: unknown
}

/** Cap on surface + digest events rendered into one transcript. */
export const MAX_TRANSCRIPT_EVENTS = 4000

/** Cap on one rendered event's contribution to a single line (chars). */
export const MAX_TRANSCRIPT_LINE_CHARS = 300

/** Truncate one text value to a single bounded line. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  if (flat.length === 0) return ''
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** Best-effort render of a session event `data` payload as text lines. */
function dataTextLines(data: unknown): string[] {
  if (typeof data !== 'object' || data === null) return []
  const record = data as Record<string, unknown>
  // The three first-party payload shapes: a message's own `content`, the
  // `message` envelope's `content` (assistant/tool), or a compaction digest.
  const payload = Array.isArray(record.content) ? record.content
    : (typeof record.message === 'object' && record.message !== null && Array.isArray((record.message as { content?: unknown }).content)
      ? (record.message as { content: unknown[] }).content
      : (Array.isArray(record.summary) ? record.summary : undefined))
  if (payload === undefined) return []
  const out: string[] = []
  for (const block of payload) {
    if (typeof block !== 'object' || block === null) continue
    const recordBlock = block as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown }
    if (recordBlock.type === 'text' && typeof recordBlock.text === 'string') out.push(recordBlock.text)
    else if (recordBlock.type === 'tool-call' && typeof recordBlock.name === 'string') {
      const args = typeof recordBlock.arguments === 'string' ? recordBlock.arguments : ''
      out.push(`⚙ ${recordBlock.name}${args.length > 0 ? ` ${oneLine(args, MAX_TRANSCRIPT_LINE_CHARS)}` : ''}`)
    } else if (recordBlock.type === 'tool-result' && Array.isArray((recordBlock as { content?: unknown }).content)) {
      out.push(...dataTextLines(recordBlock))
    }
  }
  return out
}

/** One parsed JSON value from the log, tolerantly. */
interface ParsedValue {
  value: unknown
  type: string | undefined
}

/** Parse every non-empty line into a value; malformed lines are skipped. */
function parseValues(text: string): ParsedValue[] {
  const values: ParsedValue[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue // a malformed row is not part of a session log — skip it
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
    const type = typeof (parsed as { type?: unknown }).type === 'string'
      ? (parsed as { type: string }).type
      : undefined
    values.push({ value: parsed, type })
  }
  return values
}

/**
 * Tolerantly expand one stored log row into candidate events. The merged
 * persistence writes format-v3 rows (`{type, seq, time, data}`), which are
 * passed through verbatim; legacy fork chunk rows (`text-chunks` …) render as
 * their raw row rather than being expanded, so an old log still shows every
 * numbered event it carries natively.
 */
function decodeStorageRecord(value: unknown): unknown[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  const record = value as Record<string, unknown>
  if (record.type === 'event' && Array.isArray(record.events)) return record.events
  return [record]
}

/** Render one surface-current event into bounded transcript lines. */
function renderEvent(event: TranscriptEvent): string[] {
  const type = event.type
  const data = event.data as Record<string, unknown> | undefined
  switch (type) {
    case 'user/message':
      return ['# user', ...dataTextLines(data).map(line => oneLine(line, MAX_TRANSCRIPT_LINE_CHARS))]
    case 'assistant/message': {
      const interrupted = (data as { interrupted?: unknown } | undefined)?.interrupted === true
      const lines = dataTextLines(data).map(line => oneLine(line, MAX_TRANSCRIPT_LINE_CHARS))
      if (lines.length === 0) return []
      return ['# assistant', ...lines, ...interrupted ? ['  (interrupted)'] : []]
    }
    case 'tool/result': {
      const message = dataTextLines(data)
      const error = data?.error as { name?: unknown; code?: unknown } | undefined
      if (error !== undefined && (error.name !== undefined || error.code !== undefined) && message.length === 0) {
        const label = typeof error.name === 'string' ? error.name : typeof error.code === 'string' ? error.code : 'call failed'
        return [`  → error ${label}`]
      }
      const detail = typeof error?.name === 'string' ? ` [${error.name}]` : ''
      const first = message[0]
      return first === undefined || first.length === 0 ? [] : [`  → ${oneLine(first, MAX_TRANSCRIPT_LINE_CHARS)}${detail}`]
    }
    case 'todo/write': {
      const todos = Array.isArray(data?.todos) ? data.todos as unknown[] : []
      const completed = todos
        .map(todo => (typeof todo === 'object' && todo !== null ? (todo as { status?: unknown; content?: unknown }) : null))
        .filter(todo => todo !== null && todo.status === 'completed' && typeof todo.content === 'string')
        .map(todo => `  ☑ ${oneLine((todo as { content: string }).content, MAX_TRANSCRIPT_LINE_CHARS)}`)
      return completed
    }
    case 'turn/end': {
      const reason = data?.reason as { kind?: unknown } | undefined
      if (reason?.kind !== 'error' && reason?.kind !== 'aborted') return []
      const failure = reason.kind === 'error' && typeof reason === 'object'
        ? (reason as { error?: { message?: unknown } }).error
        : undefined
      const message = typeof failure?.message === 'string'
        ? oneLine(failure.message, MAX_TRANSCRIPT_LINE_CHARS)
        : ''
      return [`  ✗ turn ended: ${reason.kind}${message.length > 0 ? ` — ${message}` : ''}`]
    }
    default:
      return []
  }
}

/** Compact the surface fold's current nodes + the digest events into transcript lines. */
function renderTranscript(events: TranscriptEvent[], header: Record<string, unknown>): string | undefined {
  let folded: { nodes: number[] }
  try {
    folded = foldSurface(events.map(event => event.raw) as unknown as SessionEvent[])
  } catch {
    return undefined // malformed/partial log — let the generic decode window serve it
  }
  const bySeq = new Map<number, TranscriptEvent>()
  for (const event of events) bySeq.set(event.seq, event)

  const headerLines: string[] = []
  const id = typeof header.id === 'string' ? header.id : '?'
  headerLines.push(`SESSION ${id}`)
  const facts: string[] = []
  if (typeof header.createdAt === 'number') facts.push(`created ${new Date(header.createdAt).toISOString()}`)
  if (typeof header.cwd === 'string') facts.push(`cwd ${header.cwd}`)
  if (typeof header.parentSession === 'string') facts.push(`parent ${header.parentSession}`)
  if (facts.length > 0) headerLines.push(facts.join(' · '))

  const lines: string[] = headerLines
  let rendered = 0
  for (const seq of folded.nodes) {
    if (rendered >= MAX_TRANSCRIPT_EVENTS) break
    const event = bySeq.get(seq)
    if (event === undefined) continue
    rendered += 1
    lines.push(...renderEvent(event))
  }
  // Log-only annotations after the surface projection: compaction digests and
  // failed turn ends carry conversation-level facts the surface itself hides,
  // plus the latest todo snapshot (only completed entries — the list is a
  // whole-list snapshot, so only the final write has meaning).
  let latestTodo: TranscriptEvent | undefined
  for (const event of events) {
    if (event.type === 'todo/write' && (latestTodo === undefined || event.seq > latestTodo.seq)) latestTodo = event
  }
  if (latestTodo !== undefined) lines.push(...renderEvent(latestTodo))
  for (const event of events) {
    const isAnnotation = event.type === 'compaction/summary' || event.type === 'turn/end'
    if (!isAnnotation) continue
    if (rendered >= MAX_TRANSCRIPT_EVENTS) break
    if (event.type === 'turn/end') {
      const reason = (event.data as { reason?: { kind?: unknown } } | undefined)?.reason
      if (reason?.kind !== 'error' && reason?.kind !== 'aborted') continue
    }
    rendered += 1
    if (event.type !== 'compaction/summary') {
      lines.push(...renderEvent(event))
      continue
    }
    const digestData = event.data as { summary?: unknown[]; shadowedSeqs?: unknown[] } | undefined
    const summary = dataTextLines(digestData)
    const digest = summary[0]
    const count = digestData?.shadowedSeqs?.length ?? 0
    lines.push(`  📦 compacted ${count} events${digest !== undefined && digest.length > 0 ? `: ${oneLine(digest, MAX_TRANSCRIPT_LINE_CHARS)}` : ''}`)
  }
  // A header with nothing recognizably rendered is not a transcript yet —
  // the caller falls back to the raw JSONL window for such a young log.
  if (rendered === 0) return undefined
  return lines.join('\n')
}

/**
 * Try to render `decodedText` as a session-log transcript.
 * @param decodedText - fully decoded text of one zstd stream.
 * @returns the rendered transcript, or undefined when the text is not a session log.
 */
export function tryRenderSessionTranscript(decodedText: string): string | undefined {
  const values = parseValues(decodedText)
  const header = values.find(value => value.type === 'session')
  if (header === undefined) return undefined
  if (typeof (header.value as { id?: unknown }).id !== 'string') return undefined // a `session` row with no id is not a header

  // Expand every storage record (chunk rows → the original events) and keep
  // only numbered events. `decodeStorageRecord` is lossless and layout-blind,
  // and the full parsed record is retained so `foldSurface` sees every field.
  const events: TranscriptEvent[] = []
  for (const line of values) {
    if (line === header) continue
    for (const event of decodeStorageRecord(line.value) as Array<Record<string, unknown>>) {
      if (typeof event.seq !== 'number' || !Number.isSafeInteger(event.seq) || event.seq < 0) continue
      events.push({
        type: typeof event.type === 'string' ? event.type : '',
        seq: event.seq,
        data: (event as { data?: unknown }).data,
        raw: event,
      })
    }
  }
  events.sort((a, b) => a.seq - b.seq)
  if (events.length === 0) return undefined
  return renderTranscript(events, header.value as Record<string, unknown>)
}
