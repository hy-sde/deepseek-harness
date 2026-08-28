/**
 * The wiki drawer: a frame-wide floating panel (rendered into the
 * `shell.overlay` list slot) that browses and edits the LLM-wiki graph —
 * pages and blocks — with no desktop Logseq. When the store is closed the
 * drawer renders nothing, so the overlay stays clear.
 */

import { useState, useSyncExternalStore } from 'react'
import { BlockTree } from './BlockTree.tsx'
import { wikiStore } from './store.ts'
import css from './WikiDrawer.module.css'

/** The drawer panel body: list view or page view. */
function WikiBody() {
  const state = wikiStore.getState()

  if (state.loading && state.current === null && state.pages.length === 0) {
    return <div className={css.muted}>Loading…</div>
  }

  if (state.current !== null) {
    const name = state.currentName ?? state.current.root.title
    return (
      <div className={css.pageView}>
        <div className={css.pageHeader}>
          <button className={css.back} onClick={() => { wikiStore.backToPages() }}>‹ Pages</button>
          <div className={css.pageTitle}>{state.current.root.title}</div>
          <button
            className={css.danger}
            title="Delete this page (permanent)"
            onClick={() => { if (window.confirm(`Delete page "${name}" and all its blocks?`)) void wikiStore.deletePage(name) }}
          >
            🗑
          </button>
        </div>
        {state.current.root.tags.length > 0 && (
          <div className={css.tagRow}>
            {state.current.root.tags.map(tag => (
              <span key={tag.id} className={css.tag}>{tag.title ?? tag.name}</span>
            ))}
          </div>
        )}
        <div className={css.treeWrap}>
          <BlockTree blocks={state.current.root.children} pageName={name} />
        </div>
        <PageAppender name={name} />
        {state.current.linked.length > 0 && (
          <div className={css.linked}>
            <div className={css.linkedTitle}>Referenced from</div>
            {state.current.linked.map(block => (
              <button
                key={block.id}
                className={css.linkedRow}
                onClick={() => block.pageName !== null && void wikiStore.openPage(block.pageName)}
              >
                {block.content.length > 120 ? `${block.content.slice(0, 120)}…` : block.content}
                <span className={css.linkedPage}>{block.pageTitle ?? block.pageName}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  return <PageList />
}

/** One page-append input at the page bottom. */
function PageAppender({ name }: { name: string }) {
  const [draft, setDraft] = useState('')
  return (
    <div className={css.addRow}>
      <input
        className={css.addInput}
        value={draft}
        placeholder={`block on ${name}… Enter saves`}
        onChange={(e) => { setDraft(e.target.value) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            if (draft.trim() === '') return
            void wikiStore.addBlock(null, name, draft)
            setDraft('')
          }
        }}
      />
    </div>
  )
}

/** The page-list view with inline page creation + search. */
function PageList() {
  const state = wikiStore.getState()
  const [newTitle, setNewTitle] = useState('')

  return (
    <div className={css.pageList}>
      <div className={css.searchRow}>
        <input
          className={css.searchInput}
          value={state.searchQuery}
          placeholder="Search pages & blocks…"
          onChange={(e) => { wikiStore.setSearchQuery(e.target.value) }}
          onKeyDown={(e) => { if (e.key === 'Enter') void wikiStore.runSearch() }}
        />
        <button className={css.action} onClick={() => void wikiStore.runSearch()}>Search</button>
      </div>
      {state.searchQuery.trim() !== '' && state.searchResults.length > 0 && (
        <div className={css.results}>
          <div className={css.sectionTitle}>Results</div>
          {state.searchResults.map(item => (
            <button key={item.id} className={css.pageRow} onClick={() => void wikiStore.openPage(item.title)}>
              <span className={css.pageName}>{item.title}</span>
              {item.pageName !== null && <span className={css.pageHint}>{item.pageName}</span>}
            </button>
          ))}
        </div>
      )}
      {state.searchQuery.trim() === '' && (
        <>
          <div className={css.sectionTitle}>Pages</div>
          <div className={css.pageRows}>
            {state.pages.map(page => (
              <button key={page.id} className={css.pageRow} onClick={() => void wikiStore.openPage(page.title ?? String(page.id))}>
                <span className={css.pageName}>{page.title ?? `#${page.id}`}</span>
                {page.updatedAt !== null && (
                  <span className={css.pageDate}>{new Date(page.updatedAt).toLocaleDateString()}</span>
                )}
              </button>
            ))}
          </div>
          <div className={css.createRow}>
            <input
              className={css.addInput}
              value={newTitle}
              placeholder="New page title…"
              onChange={(e) => { setNewTitle(e.target.value) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newTitle.trim() !== '') {
                  void wikiStore.createPage(newTitle.trim())
                  setNewTitle('')
                }
              }}
            />
          </div>
        </>
      )}
    </div>
  )
}

/** The drawer shell: header + body. Renders nothing when closed. */
export function WikiDrawer() {
  const state = useSyncExternalStore(
    store => wikiStore.subscribe(store),
    () => wikiStore.getState(),
  )
  // Re-render whenever the connection-bound store data changes.
  void state

  if (!wikiStore.getState().open) return null

  return (
    <div className={css.drawer} data-wiki-drawer>
      <div className={css.header}>
        <div className={css.title}>LLM Wiki</div>
        <button className={css.close} title="Close wiki (or toggle from sidebar)" onClick={() => { wikiStore.close() }}>×</button>
      </div>
      {wikiStore.getState().error !== null && (
        <div className={css.errorBanner}>
          {wikiStore.getState().error}
          <button className={css.dismiss} onClick={() => { wikiStore.clearError() }} aria-label="dismiss">✕</button>
        </div>
      )}
      <div className={css.body}>
        <WikiBody />
      </div>
    </div>
  )
}
