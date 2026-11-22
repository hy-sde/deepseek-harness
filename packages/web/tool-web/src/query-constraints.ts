/**
 * Query-constraint parsing and enforcement for `web_search`: the post-filter
 * layer that holds a query's scope directives (`site:`, `-site:`, `inurl:`,
 * `-inurl:`, and every exclusion directive) against the sources a provider
 * actually returned. The raw query reaches the provider verbatim, so an
 * engine that honors a directive natively keeps doing so; this layer only
 * decides what may come back. Scope directives are always enforced — even to
 * an empty result — while the remaining dimensions (`intitle:`, `filetype:`,
 * date bounds) relax with a note when enforcing them would remove every
 * source.
 */

import type { WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'

/**
 * A query decomposed into the constraint dimensions the post-filter can
 * evaluate. `site:` values are lowercased with scheme, `*.` wildcard, and
 * trailing slash/dot stripped; `filetype:` extensions are lowercased without
 * a leading dot; every other value stays verbatim.
 */
export interface QueryConstraints {
  /** The original query string. */
  readonly raw: string
  /** `site:`/`domain:`/`host:` includes — a source must match any one. */
  readonly sites: readonly string[]
  /** `-site:`/`-domain:`/`-host:` exclusions — a source must match none. */
  readonly excludedSites: readonly string[]
  /** `inurl:`/`url:` substrings — a source URL must contain every one. */
  readonly inUrl: readonly string[]
  /** `-inurl:`/`-url:` substrings — a source URL must contain none. */
  readonly excludedInUrl: readonly string[]
  /** `intitle:`/`title:` substrings — a source title must contain every one. */
  readonly inTitle: readonly string[]
  /** `-intitle:`/`-title:` substrings — a source title must contain none. */
  readonly excludedInTitle: readonly string[]
  /** `filetype:`/`ext:` extensions — a source URL path must end with any one. */
  readonly filetypes: readonly string[]
  /** `-filetype:`/`-ext:` extensions — a source URL path must end with none. */
  readonly excludedFiletypes: readonly string[]
  /** Inclusive lower publish-date bound from `after:`/`since:`, ISO `YYYY-MM-DD`. */
  readonly after?: string
  /** Exclusive upper publish-date bound from `before:`/`until:`, ISO `YYYY-MM-DD`. */
  readonly before?: string
  /** True when at least one dimension above is set. */
  readonly hasConstraints: boolean
}

/** Result of {@link applyQueryConstraints}. */
export interface ConstraintFilterResult {
  /**
   * Sources surviving the filter. Empty only when the input was empty or no
   * source matched the query's scope directives.
   */
  readonly sources: WebSearchSource[]
  /**
   * Directive renderings (`site:arxiv.org`, `before:2024-01-01`, …) of the
   * advisory dimensions that matched zero sources and were relaxed instead
   * of enforced.
   */
  readonly dropped: readonly string[]
}

/** A raw query token. */
interface RawToken {
  text: string
  /** The whole token was a quoted phrase. */
  quoted: boolean
  /** The token's directive value was quoted, as in `intitle:"budget tips"`. */
  quotedValue?: boolean
}

/** Canonical constraint field of a recognized directive. */
type ConstraintField = 'site' | 'inUrl' | 'inTitle' | 'inText' | 'filetype' | 'before' | 'after' | 'lang'

/** `name:value` directive token: optional sign, name, colon, remainder. */
const DIRECTIVE_PATTERN = /^([+-]?)([a-z][a-z-]*):(.*)$/i

/** Directive names mapped to their canonical constraint field. */
const DIRECTIVE_FIELDS: Readonly<Record<string, ConstraintField>> = {
  site: 'site',
  domain: 'site',
  host: 'site',
  inurl: 'inUrl',
  url: 'inUrl',
  intitle: 'inTitle',
  title: 'inTitle',
  intext: 'inText',
  inbody: 'inText',
  inanchor: 'inText',
  filetype: 'filetype',
  ext: 'filetype',
  before: 'before',
  until: 'before',
  after: 'after',
  since: 'after',
  lang: 'lang',
  language: 'lang',
}

/** `allin*:` directives that capture every following plain term into their field. */
const ALL_MODES: Readonly<Record<string, 'inTitle' | 'inUrl' | 'inText'>> = {
  allintitle: 'inTitle',
  allinurl: 'inUrl',
  allintext: 'inText',
}

/** Operator and grouping tokens a bare `name:` must not adopt as its value. */
const RESERVED_TOKENS = ['(', ')', 'OR', 'AND', 'NOT', '|', '||', '&&', '!']

function isQuote(ch: string): boolean {
  return ch === '"' || ch === '\u201c' || ch === '\u201d'
}

/** Unicode-aware whitespace (queries paste non-breaking spaces and friends). */
const WHITESPACE = /\s/

/** Split a raw query into whitespace-delimited tokens, honoring quoted spans. */
function tokenize(raw: string): RawToken[] {
  const tokens: RawToken[] = []
  let i = 0
  while (i < raw.length) {
    const ch = raw.charAt(i)
    if (WHITESPACE.test(ch)) {
      i += 1
      continue
    }
    if (isQuote(ch)) {
      let j = i + 1
      let buf = ''
      while (j < raw.length && !isQuote(raw.charAt(j))) {
        buf += raw.charAt(j)
        j += 1
      }
      if (buf.trim().length > 0) tokens.push({ text: buf.trim(), quoted: true })
      i = j + 1
      continue
    }
    // Bare word. A quote directly after `name:` swallows the quoted span into
    // the same token (`intitle:"budget tips"`); a quote elsewhere ends the word.
    let buf = ''
    let quotedValue = false
    while (i < raw.length && !WHITESPACE.test(raw.charAt(i))) {
      const c = raw.charAt(i)
      if (isQuote(c) && buf.endsWith(':')) {
        let j = i + 1
        while (j < raw.length && !isQuote(raw.charAt(j))) {
          buf += raw.charAt(j)
          j += 1
        }
        quotedValue = true
        i = j + 1
        continue
      }
      if (isQuote(c)) break
      buf += c
      i += 1
    }
    if (buf.length > 0) tokens.push({ text: buf, quoted: false, quotedValue })
  }
  return splitParens(tokens)
}

/**
 * Split leading `(` and unbalanced trailing `)` into standalone tokens so
 * `(site:a.com OR site:b.com)` parses while `site:wikipedia.org/Foo_(bar)`
 * stays whole.
 */
function splitParens(tokens: RawToken[]): RawToken[] {
  const out: RawToken[] = []
  for (const tok of tokens) {
    if (tok.quoted || tok.quotedValue === true) {
      out.push(tok)
      continue
    }
    let text = tok.text
    while (text.startsWith('(')) {
      out.push({ text: '(', quoted: false })
      text = text.slice(1)
    }
    let trailing = 0
    while (text.endsWith(')')) {
      // Only strip parens that do not close an opener inside the word.
      const body = text.slice(0, -1)
      let depth = 0
      for (const c of body) {
        if (c === '(') depth += 1
        else if (c === ')') depth -= 1
      }
      if (depth > 0) break
      text = body
      trailing += 1
    }
    if (text.length > 0) out.push({ text, quoted: false })
    for (let k = 0; k < trailing; k += 1) out.push({ text: ')', quoted: false })
  }
  return out
}

/** Convert year/month/day parts to a validated ISO date, or undefined. */
function isoDate(year: number, month: number, day: number): string | undefined {
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return undefined
  // Reject calendar-impossible dates (2023-02-29): Date.parse would yield NaN and
  // the bound would silently no-op in the predicate below.
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return undefined
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Parse a `before:`/`after:` value into ISO `YYYY-MM-DD`. Accepts `YYYY`,
 * `YYYY-MM`, and `YYYY-MM-DD` (also `/` and `.` separators) and `MM/DD/YYYY`
 * (interpreted day-first when the first field exceeds 12). Bare years and
 * months resolve to the first day of the period, matching Google's
 * `after:2024` ≙ `after:2024-01-01` semantics.
 *
 * @param value - raw directive value.
 * @returns the ISO date, or undefined when unparseable.
 */
export function parseDateValue(value: string): string | undefined {
  const t = value.trim()
  let m = /^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?$/.exec(t)
  if (m !== null) {
    return isoDate(Number(m[1]), m[2] === undefined ? 1 : Number(m[2]), m[3] === undefined ? 1 : Number(m[3]))
  }
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(t)
  if (m !== null) {
    let month = Number(m[1])
    let day = Number(m[2])
    if (month > 12 && day <= 12) [month, day] = [day, month]
    return isoDate(Number(m[3]), month, day)
  }
  return undefined
}

/** Lowercase a `site:` value and strip scheme, `*.` wildcard, and trailing slash/dot. */
function normalizeSite(value: string): string {
  let site = value.trim().toLowerCase()
  site = site.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  if (site.startsWith('*.')) site = site.slice(2)
  site = site.replace(/[/.]+$/, '')
  return site
}

/** True for operator/paren tokens and recognized directives. */
function isReservedToken(text: string): boolean {
  if (RESERVED_TOKENS.includes(text)) return true
  const m = DIRECTIVE_PATTERN.exec(text)
  if (m === null) return false
  const name = (m[2] ?? '').toLowerCase()
  return DIRECTIVE_FIELDS[name] !== undefined || ALL_MODES[name] !== undefined
}

/**
 * Parse a raw query into its post-filterable {@link QueryConstraints}.
 *
 * Lenient by construction: unknown `name:value` tokens (URLs, `C:\paths`,
 * error codes) stay in the query verbatim and constrain nothing here, and a
 * directive with an unparseable value (`before:someday`) degrades to a plain
 * term instead of a date bound.
 *
 * @param raw - the raw query string as sent to the provider.
 * @returns the parsed constraints.
 */
export function parseQueryConstraints(raw: string): QueryConstraints {
  const sites: string[] = []
  const excludedSites: string[] = []
  const inUrl: string[] = []
  const excludedInUrl: string[] = []
  const inTitle: string[] = []
  const excludedInTitle: string[] = []
  const filetypes: string[] = []
  const excludedFiletypes: string[] = []
  let after: string | undefined
  let before: string | undefined
  let negateNext = false
  let allMode: 'inTitle' | 'inUrl' | 'inText' | undefined

  const addConstraint = (field: ConstraintField, value: string, negated: boolean): void => {
    const v = value.trim()
    if (v.length === 0) return
    switch (field) {
      case 'site': {
        const site = normalizeSite(v)
        if (site.length > 0) {
          const target = negated ? excludedSites : sites
          target.push(site)
        }
        break
      }
      case 'inUrl': {
        const target = negated ? excludedInUrl : inUrl
        target.push(v)
        break
      }
      case 'inTitle': {
        const target = negated ? excludedInTitle : inTitle
        target.push(v)
        break
      }
      case 'inText':
        // Body-text matching stays provider-side; recognizing the field keeps
        // `allintext:` followers out of the title and URL scopes.
        break
      case 'filetype': {
        const ext = v.toLowerCase().replace(/^\.+/, '')
        if (ext.length > 0) {
          const target = negated ? excludedFiletypes : filetypes
          target.push(ext)
        }
        break
      }
      case 'before':
      case 'after':
      case 'lang':
        // Handled by the directive loop; `lang` is provider-side routing.
        break
    }
  }

  /** Consume a free-text term; only an active `allin*:` mode turns it into a constraint. */
  const addTerm = (text: string): void => {
    const negated = negateNext
    negateNext = false
    if (allMode !== undefined) addConstraint(allMode, text, negated)
  }

  const tokens = tokenize(raw)
  for (let idx = 0; idx < tokens.length; idx += 1) {
    const tok = tokens[idx]
    if (tok === undefined) continue
    if (tok.quoted) {
      addTerm(tok.text)
      continue
    }
    if (tok.text === '(' || tok.text === ')') continue
    if (tok.text === 'OR' || tok.text === '|' || tok.text === '||') continue
    if (tok.text === 'AND' || tok.text === '&&') continue
    if (tok.text === 'NOT' || tok.text === '!') {
      negateNext = true
      continue
    }
    if (tok.text === '-' || tok.text === '+') {
      // The tokenizer splits `-"exact phrase"` into `-` plus a phrase token;
      // carry the negation over to it.
      if (tok.text === '-' && tokens[idx + 1]?.quoted === true) negateNext = true
      continue
    }

    const match = DIRECTIVE_PATTERN.exec(tok.text)
    const name = match === null ? undefined : (match[2] ?? '').toLowerCase()
    const allMatch = name === undefined ? undefined : ALL_MODES[name]
    const field = name === undefined ? undefined : DIRECTIVE_FIELDS[name]

    if (match !== null && allMatch !== undefined) {
      allMode = allMatch
      // `allintitle:budget tips` — inline value plus every following term.
      const inline = (match[3] ?? '').trim()
      if (inline.length > 0) addConstraint(allMatch, inline, (match[1] ?? '') === '-')
      continue
    }

    if (match !== null && field !== undefined) {
      let value = (match[3] ?? '').trim()
      // `site: example.com` — lenient: adopt the next non-reserved token as the value.
      if (value.length === 0) {
        const next = tokens[idx + 1]
        // A sign-prefixed token is an exclusion/inclusion term, not the value
        // (`site: -example.com` reads as "site: then exclude example.com");
        // adopting it verbatim would make strict scope drop every source.
        if (next !== undefined && (next.quoted || (!isReservedToken(next.text) && !/^[-+]/.test(next.text)))) {
          value = next.text.trim()
          idx += 1
        }
      }
      if (value.length === 0) continue
      const negated = (match[1] ?? '') === '-' || negateNext
      negateNext = false
      if (field === 'before' || field === 'after') {
        const iso = parseDateValue(value)
        if (iso === undefined) {
          addTerm(tok.text) // Unparseable dates degrade to a plain term, not a bound.
          continue
        }
        if (field === 'before') before = iso
        else after = iso
        continue
      }
      if (field === 'lang') continue // The raw query already carries it to the provider.
      addConstraint(field, value, negated)
      continue
    }

    // Plain term with optional +/- prefix.
    let text = tok.text
    if (text.startsWith('-') && text.length > 1) {
      negateNext = true
      text = text.replace(/^-+/, '')
      if (text.length === 0) continue
      // A doubled dash (`--site:x`) blocks the directive pattern; re-check after stripping.
      const negMatch = DIRECTIVE_PATTERN.exec(text)
      const negName = negMatch === null ? undefined : (negMatch[2] ?? '').toLowerCase()
      const negField = negName === undefined ? undefined : DIRECTIVE_FIELDS[negName]
      if (negMatch !== null && negField !== undefined && negField !== 'before' && negField !== 'after' && negField !== 'lang') {
        negateNext = false
        addConstraint(negField, negMatch[3] ?? '', true)
        continue
      }
      addTerm(text)
      continue
    }
    if (text.startsWith('+') && text.length > 1) {
      // Legacy `+term`: verbatim/required upstream — a phrase with no filter effect here.
      addTerm(text.slice(1))
      continue
    }
    addTerm(text)
  }

  return {
    raw,
    sites,
    excludedSites,
    inUrl,
    excludedInUrl,
    inTitle,
    excludedInTitle,
    filetypes,
    excludedFiletypes,
    ...after !== undefined ? { after } : {},
    ...before !== undefined ? { before } : {},
    hasConstraints: sites.length > 0 || excludedSites.length > 0 || inUrl.length > 0 || excludedInUrl.length > 0 ||
      inTitle.length > 0 || excludedInTitle.length > 0 || filetypes.length > 0 || excludedFiletypes.length > 0 ||
      before !== undefined || after !== undefined,
  }
}

/** Hostname (lowercased) and pathname of a URL, or undefined when unparsable. */
function hostAndPath(url: string): { host: string; path: string } | undefined {
  if (!URL.canParse(url)) return undefined
  const parsed = new URL(url)
  return { host: parsed.hostname.toLowerCase(), path: parsed.pathname }
}

/**
 * `site:` matcher: the URL host is `site` or a subdomain of it; when `site`
 * carries a path (`github.com/anthropics`), the URL path must start with it.
 *
 * @param url - source URL.
 * @param site - normalized `site:` value.
 * @returns true when the URL is inside the site.
 */
export function matchesSite(url: string, site: string): boolean {
  const parsed = hostAndPath(url)
  if (parsed === undefined) return false
  const slash = site.indexOf('/')
  const siteHost = slash === -1 ? site : site.slice(0, slash)
  const sitePath = slash === -1 ? '' : site.slice(slash)
  if (parsed.host !== siteHost && !parsed.host.endsWith(`.${siteHost}`)) return false
  if (sitePath.length > 0 && !parsed.path.toLowerCase().startsWith(sitePath.toLowerCase())) return false
  return true
}

/** `filetype:` matcher: the URL pathname ends with `.ext`. */
function matchesFiletype(url: string, ext: string): boolean {
  const parsed = hostAndPath(url)
  if (parsed === undefined) return false
  return parsed.path.toLowerCase().endsWith(`.${ext}`)
}

/** Best-effort publish time (ms epoch) of a source from its `publishedAt` timestamp. */
function sourceTime(source: WebSearchSource): number | undefined {
  if (source.publishedAt === undefined || source.publishedAt.length === 0) return undefined
  const parsed = Date.parse(source.publishedAt)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** One evaluated constraint dimension of a parsed query. */
interface ConstraintDimension {
  /** Directive rendering for relaxation and scope notes (`site:arxiv.org`). */
  readonly label: string
  /**
   * Scope directives (`site:`, `inurl:`, and every exclusion) are enforced
   * even when nothing matches: a source outside the requested scope, or one
   * the query excluded, is never an answer. The rest relax.
   */
  readonly scope: boolean
  pred: (source: WebSearchSource) => boolean
}

/** Dimensions in evaluation order; a source must survive every dimension. */
function constraintDimensions(q: QueryConstraints): ConstraintDimension[] {
  const dims: ConstraintDimension[] = []
  const lower = (s: string | undefined): string => (s ?? '').toLowerCase()

  if (q.sites.length > 0) {
    dims.push({
      label: q.sites.map(site => `site:${site}`).join(' OR '),
      scope: true,
      pred: src => q.sites.some(site => matchesSite(src.url, site)),
    })
  }
  if (q.excludedSites.length > 0) {
    dims.push({
      label: q.excludedSites.map(site => `-site:${site}`).join(' '),
      scope: true,
      pred: src => !q.excludedSites.some(site => matchesSite(src.url, site)),
    })
  }
  if (q.inUrl.length > 0) {
    dims.push({
      label: q.inUrl.map(value => `inurl:${value}`).join(' '),
      scope: true,
      pred: src => q.inUrl.every(value => lower(src.url).includes(value.toLowerCase())),
    })
  }
  if (q.excludedInUrl.length > 0) {
    dims.push({
      label: q.excludedInUrl.map(value => `-inurl:${value}`).join(' '),
      scope: true,
      pred: src => !q.excludedInUrl.some(value => lower(src.url).includes(value.toLowerCase())),
    })
  }
  if (q.inTitle.length > 0) {
    dims.push({
      label: q.inTitle.map(value => `intitle:${value}`).join(' '),
      scope: false,
      pred: src => q.inTitle.every(value => lower(src.title).includes(value.toLowerCase())),
    })
  }
  if (q.excludedInTitle.length > 0) {
    dims.push({
      label: q.excludedInTitle.map(value => `-intitle:${value}`).join(' '),
      scope: true,
      pred: src => !q.excludedInTitle.some(value => lower(src.title).includes(value.toLowerCase())),
    })
  }
  if (q.filetypes.length > 0) {
    dims.push({
      label: q.filetypes.map(ext => `filetype:${ext}`).join(' OR '),
      scope: false,
      pred: src => q.filetypes.some(ext => matchesFiletype(src.url, ext)),
    })
  }
  if (q.excludedFiletypes.length > 0) {
    dims.push({
      label: q.excludedFiletypes.map(ext => `-filetype:${ext}`).join(' '),
      scope: true,
      pred: src => !q.excludedFiletypes.some(ext => matchesFiletype(src.url, ext)),
    })
  }
  if (q.after !== undefined || q.before !== undefined) {
    const afterMs = q.after !== undefined ? Date.parse(q.after) : undefined
    const beforeMs = q.before !== undefined ? Date.parse(q.before) : undefined
    const afterLabel = q.after !== undefined ? `after:${q.after}` : ''
    const beforeLabel = q.before !== undefined ? `before:${q.before}` : ''
    const label = [afterLabel, beforeLabel].filter(Boolean).join(' ')
    dims.push({
      label,
      scope: false,
      pred: (src) => {
        const time = sourceTime(src)
        if (time === undefined) return true // Undated: absence of a date is not proof of violation.
        if (afterMs !== undefined && time < afterMs) return false
        if (beforeMs !== undefined && time >= beforeMs) return false
        return true
      },
    })
  }
  return dims
}

/**
 * Post-filter: applies each constraint dimension of `q` in turn. A scope
 * directive (`site:`, `inurl:`, exclusions) is always enforced, so a source
 * outside the requested scope never comes back; any other dimension that
 * would eliminate every remaining source is skipped and reported, so a
 * mis-scoped `intitle:`, `filetype:`, or date bound degrades to a note
 * instead of a dead search.
 *
 * @param sources - sources the provider returned for the query.
 * @param q - the query's parsed constraints.
 * @returns surviving sources plus the relaxed dimensions' labels.
 */
export function applyQueryConstraints(
  sources: readonly WebSearchSource[],
  q: QueryConstraints,
): ConstraintFilterResult {
  let current: WebSearchSource[] = [...sources]
  const dropped: string[] = []
  if (current.length === 0) return { sources: current, dropped }
  for (const dim of constraintDimensions(q)) {
    const kept = current.filter(dim.pred)
    if (kept.length > 0 || dim.scope) current = kept
    else dropped.push(dim.label)
    if (current.length === 0) break
  }
  return { sources: current, dropped }
}

/**
 * The scope directives of `q` (`site:`, `inurl:`, and every exclusion) as one
 * rendering and one predicate, for provider material {@link
 * applyQueryConstraints} does not see — a result's answer text. Undefined
 * when `q` has no scope directives.
 *
 * @param q - the query's parsed constraints.
 * @returns the scope label and matcher, or undefined.
 */
export function scopeConstraints(
  q: QueryConstraints,
): { label: string; matches: (source: WebSearchSource) => boolean } | undefined {
  const dims = constraintDimensions(q).filter(dim => dim.scope)
  if (dims.length === 0) return undefined
  return {
    label: dims.map(dim => dim.label).join(' '),
    matches: source => dims.every(dim => dim.pred(source)),
  }
}

/**
 * Enforce one query's parsed constraints on its provider result. Scope
 * directives hold even when nothing survives: a result whose sources are all
 * outside the scope comes back as an empty source list plus a note, and the
 * provider answer is dropped with it — it can only have drawn on off-scope
 * material. Advisory dimensions (`intitle:`, `filetype:`, date bounds) relax
 * with a note when they would eliminate every remaining source. Queries
 * without constraints and results the provider already returned empty pass
 * through unchanged.
 *
 * @param query - the raw query whose constraints apply to this result.
 * @param result - one query's result from the web seam.
 * @returns the scoped result.
 */
export function enforceQueryScope(query: string, result: WebSearchResult): WebSearchResult {
  const parsed = parseQueryConstraints(query)
  if (!parsed.hasConstraints || result.sources.length === 0) return result
  const scope = scopeConstraints(parsed)
  const filtered = applyQueryConstraints(result.sources, parsed)
  if (filtered.sources.length === 0 && scope !== undefined) {
    // The provider answered, just outside the requested scope: report an
    // empty result, not an error, and drop the answer with it.
    return {
      notices: [`no results matched \`${scope.label}\`; scope directives are strictly enforced`],
      sources: [],
      truncated: false,
    }
  }
  const notices = [...(result.notices ?? [])]
  for (const label of filtered.dropped) {
    notices.push(`no results matched \`${label}\`; the constraint was relaxed`)
  }
  if (scope !== undefined) {
    const offScope = result.sources.filter(source => !scope.matches(source)).length
    if (result.content !== undefined && result.content.trim().length > 0 && offScope > 0) {
      const noun = offScope === 1 ? 'source' : 'sources'
      notices.push(`removed ${offScope} ${noun} outside \`${scope.label}\`; the answer text is unfiltered and may draw on them`)
    }
  }
  return {
    ...result.content !== undefined ? { content: result.content } : {},
    ...notices.length > 0 ? { notices } : {},
    sources: filtered.sources,
    truncated: result.truncated,
  }
}
