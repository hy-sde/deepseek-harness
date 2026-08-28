/**
 * Module store for the wiki drawer: listener-subscription state + actions that
 * call the WikiClient face. Pure TS, no React — components subscribe via
 * useSyncExternalStore. The store is intentionally dumb about the two slots:
 * index.ts mounts the toggle and the drawer, both read here.
 */

import { WikiClient, type WikiGetPageValue, type WikiSearchItem } from './api.ts'

/** Snapshot of the drawer store. */
export interface WikiState {
  /** Drawer open. */
  open: boolean
  /** Loaded page list (built-ins excluded). */
  pages: { id: number; title: string | null; updatedAt: number | null }[]
  /** Search hit list for the active query. */
  searchQuery: string
  searchResults: WikiSearchItem[]
  /** The open page (root + linked refs), null on the list view. */
  current: WikiGetPageValue | null
  /** Name of the open page (for the 'back' affordance). */
  currentName: string | null
  /** General loading flag. */
  loading: boolean
  /** Transient error banner content. */
  error: string | null
  /** An edit/upsert is in flight — guards double-submits. */
  busy: boolean
}

const INITIAL: WikiState = {
  open: false,
  pages: [],
  searchQuery: '',
  searchResults: [],
  current: null,
  currentName: null,
  loading: false,
  error: null,
  busy: false,
}

type Listener = () => void

class WikiStore {
  private state: WikiState = { ...INITIAL }
  private listeners = new Set<Listener>()
  private client: WikiClient | null = null

  /**
   * Bind the wire face once the connection exists. Returns the initial page
   * load so callers/tests can await it.
   */
  bind(client: WikiClient): Promise<void> {
    this.client = client
    return this.refreshPages()
  }

  getState(): WikiState {
    return this.state
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(patch: Partial<WikiState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  private openError(error: unknown): void {
    this.set({ error: error instanceof Error ? error.message : String(error) })
  }

  // ---- navigation ----

  toggleOpen(): void {
    this.set({ open: !this.state.open })
  }

  close(): void {
    this.set({ open: false, error: null })
  }

  clearError(): void {
    this.set({ error: null })
  }

  async refreshPages(): Promise<void> {
    if (this.client === null) return
    this.set({ loading: true, error: null })
    try {
      const { pages } = await this.client.listPages({})
      this.set({ pages, loading: false })
    } catch (error) {
      this.set({ loading: false, error: `page list failed: ${String(error)}` })
    }
  }

  async openPage(name: string): Promise<void> {
    if (this.client === null) return
    this.set({ loading: true, error: null, currentName: name })
    try {
      const current = await this.client.getPage({ page: name })
      this.set({ current, loading: false })
    } catch (error) {
      this.set({ loading: false, error: `read "${name}" failed: ${String(error)}` })
    }
  }

  backToPages(): void {
    this.set({ current: null, currentName: null, error: null })
  }

  // ---- search ----

  setSearchQuery(query: string): void {
    this.set({ searchQuery: query })
  }

  async runSearch(): Promise<void> {
    const query = this.state.searchQuery.trim()
    if (query === '' || this.client === null) {
      this.set({ searchResults: [] })
      return
    }
    this.set({ loading: true, error: null })
    try {
      const pageHits = await this.client.search({ type: 'page', content: query, limit: 25 })
      const blockHits = await this.client.search({ type: 'block', content: query, limit: 25 })
      const seen = new Set<number>()
      const items: WikiSearchItem[] = []
      for (const hit of [...pageHits.items, ...blockHits.items]) {
        if (seen.has(hit.id)) continue
        seen.add(hit.id)
        items.push(hit)
      }
      this.set({ searchResults: items, loading: false })
    } catch (error) {
      this.set({ loading: false, error: `search failed: ${String(error)}` })
    }
  }

  // ---- writes (guarded by busy) ----

  async createPage(title: string, firstBlock?: string): Promise<void> {
    if (this.client === null) return
    this.set({ busy: true, error: null })
    try {
      await this.client.upsert({
        entityType: 'page',
        page: title,
        ...(firstBlock !== undefined && firstBlock !== '' ? { content: firstBlock } : {}),
      })
      await this.refreshPages()
      await this.openPage(title)
    } catch (error) {
      this.openError(error)
    } finally {
      this.set({ busy: false })
    }
  }

  async saveBlockContent(id: number, content: string): Promise<void> {
    if (this.client === null) return
    this.set({ busy: true, error: null })
    try {
      await this.client.upsert({ entityType: 'block', id, content })
      if (this.state.current !== null) {
        const current = await this.client.getPage({ id })
        this.set({ current })
      }
    } catch (error) {
      this.openError(error)
    } finally {
      this.set({ busy: false })
    }
  }

  async addBlock(parentId: number | null, pageName: string, content: string): Promise<void> {
    if (this.client === null) return
    if (content.trim() === '') return
    this.set({ busy: true, error: null })
    try {
      if (parentId === null) {
        // Append to the page's last child block (pos last-child on the page
        // root requires a target — the CLI treats --target-page + --pos
        // last-child as a page append).
        await this.client.upsert({ entityType: 'block', content, targetPage: pageName, pos: 'last-child' })
      } else {
        await this.client.upsert({ entityType: 'block', content, targetId: parentId, pos: 'last-child' })
      }
      const current = await this.client.getPage({ page: pageName })
      this.set({ current })
    } catch (error) {
      this.openError(error)
    } finally {
      this.set({ busy: false })
    }
  }

  async deleteBlock(id: number): Promise<void> {
    if (this.client === null) return
    this.set({ busy: true, error: null })
    try {
      await this.client.remove({ entityType: 'block', id })
      const current = this.state.current
      if (current !== null) {
        const name = this.state.currentName
        if (name === null) return
        const refreshed = await this.client.getPage({ page: name })
        this.set({ current: refreshed })
      }
    } catch (error) {
      this.openError(error)
    } finally {
      this.set({ busy: false })
    }
  }

  async deletePage(name: string): Promise<void> {
    if (this.client === null) return
    this.set({ busy: true, error: null })
    try {
      await this.client.remove({ entityType: 'page', page: name })
      this.set({ current: null, currentName: null })
      await this.refreshPages()
    } catch (error) {
      this.openError(error)
    } finally {
      this.set({ busy: false })
    }
  }
}

/** Singleton store for the wiki drawer. */
export const wikiStore = new WikiStore()
