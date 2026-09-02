/**
 * The wiki drawer: a frame-wide floating panel (rendered into the
 * `shell.overlay` list slot) that browses and edits the LLM-wiki graph —
 * pages and blocks — with no desktop Logseq. When the store is closed the
 * drawer renders nothing, so the overlay stays clear.
 */

import { useState, useSyncExternalStore } from 'react'
import type { PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { BlockTree } from './BlockTree.tsx'
import { wikiStore } from './store.ts'
import css from './WikiDrawer.module.css'

/** The drawer panel body: list view or page view. */
function WikiBody({ t }: { t: TranslateNS<'wiki'> }) {
  const state = wikiStore.getState()

  if (state.loading && state.current === null && state.pages.length === 0) {
    return <div className={css.muted}>{t('drawer.loading')}</div>
  }

  if (state.current !== null) {
    const name = state.currentName ?? state.current.root.title
    return (
      <div className={css.pageView}>
        <div className={css.pageHeader}>
          <button className={css.back} onClick={() => { wikiStore.backToPages() }}>{t('drawer.backToPages')}</button>
          <div className={css.pageTitle}>{state.current.root.title}</div>
          <button
            className={css.danger}
            title={t('drawer.deletePageTitle')}
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
          <BlockTree blocks={state.current.root.children} pageName={name} t={t} />
        </div>
        <PageAppender name={name} t={t} />
        {state.current.linked.length > 0 && (
          <div className={css.linked}>
            <div className={css.linkedTitle}>{t('drawer.referencedFrom')}</div>
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

  return <PageList t={t} />
}

/** One page-append input at the page bottom. */
function PageAppender({ name, t }: { name: string; t: TranslateNS<'wiki'> }) {
  const [draft, setDraft] = useState('')
  return (
    <div className={css.addRow}>
      <input
        className={css.addInput}
        value={draft}
        placeholder={t('drawer.placeholder', { name })}
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
function PageList({ t }: { t: TranslateNS<'wiki'> }) {
  const state = wikiStore.getState()
  const [newTitle, setNewTitle] = useState('')

  return (
    <div className={css.pageList}>
      <div className={css.searchRow}>
        <input
          className={css.searchInput}
          value={state.searchQuery}
          placeholder={t('drawer.searchPlaceholder')}
          onChange={(e) => { wikiStore.setSearchQuery(e.target.value) }}
          onKeyDown={(e) => { if (e.key === 'Enter') void wikiStore.runSearch() }}
        />
        <button className={css.action} onClick={() => void wikiStore.runSearch()}>{t('drawer.search')}</button>
      </div>
      {state.searchQuery.trim() !== '' && state.searchResults.length > 0 && (
        <div className={css.results}>
          <div className={css.sectionTitle}>{t('drawer.results')}</div>
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
          <div className={css.sectionTitle}>{t('drawer.pages')}</div>
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
              placeholder={t('drawer.newPagePlaceholder')}
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
export type WikiDrawerProps = PropsLocale<'wiki'>

export function WikiDrawer({ t }: WikiDrawerProps) {
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
        <div className={css.title}>{t('drawer.title')}</div>
        <button className={css.close} title={t('drawer.closeTitle')} onClick={() => { wikiStore.close() }}>×</button>
      </div>
      {wikiStore.getState().error !== null && (
        <div className={css.errorBanner}>
          {wikiStore.getState().error}
          <button className={css.dismiss} onClick={() => { wikiStore.clearError() }} aria-label={t('drawer.dismiss')}>✕</button>
        </div>
      )}
      <div className={css.body}>
        <WikiBody t={t} />
      </div>
    </div>
  )
}
