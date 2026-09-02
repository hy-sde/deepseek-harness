/**
 * The recursive outliner: renders each block of a page tree with inline text
 * edits, add-child, delete. Content lines starting
 * `key:: value` are drawn as property rows (Logseq property syntax stored in
 * the block's raw text).
 */

import { useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WikiBlockNode } from './api.ts'
import { wikiStore } from './store.ts'
import css from './BlockTree.module.css'

const KEY_VALUE_LINE = /^([\w-]+)::\s*(.*)$/

/** Render one block's content lines with property styling. */
export function BlockContent({ content }: { content: string }) {
  const lines = content.split('\n')
  return (
    <div className={css.content}>
      {lines.map((line, index) => {
        const m = KEY_VALUE_LINE.exec(line)
        if (m) {
          return (
            <div key={index} className={css.propLine}>
              <span className={css.propKey}>{m[1]}</span>
              <span className={css.propValue}>{m[2]}</span>
            </div>
          )
        }
        return <div key={index} className={css.textLine}>{line || '\u00A0'}</div>
      })}
    </div>
  )
}

interface BlockRowProps {
  node: WikiBlockNode
  pageName: string
  depth: number
  t: TranslateNS<'wiki'>
}

/** One outliner row: content + hover actions + nested children. */
export function BlockRow({ node, pageName, depth, t }: BlockRowProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(node.content)
  const [adding, setAdding] = useState(false)
  const [addDraft, setAddDraft] = useState('')

  const commitEdit = (): void => {
    void wikiStore.saveBlockContent(node.id, draft)
    setEditing(false)
  }

  const commitAdd = (): void => {
    if (addDraft.trim() === '') {
      setAdding(false)
      return
    }
    void wikiStore.addBlock(node.id, pageName, addDraft)
    setAddDraft('')
    setAdding(false)
  }

  return (
    <div className={css.row} style={{ '--wiki-depth': depth } as React.CSSProperties}>
      <div className={css.line}>
        <span className={css.bullet} />
        <div className={css.body} onDoubleClick={() => { setDraft(node.content); setEditing(true) }}>
          {editing ? (
            <textarea
              className={css.editor}
              value={draft}
              onChange={(e) => { setDraft(e.target.value) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commitEdit()
                if (e.key === 'Escape') setEditing(false)
              }}
              autoFocus
              rows={Math.max(2, draft.split('\n').length)}
            />
          ) : (
            <BlockContent content={node.content} />
          )}
        </div>
        <div className={css.actions}>
          {!editing && (
            <>
              <button className={css.action} title={t('block.addChild')} onClick={() => { setAdding(v => !v) }}>＋</button>
              <button className={css.action} title={t('block.editText')} onClick={() => { setDraft(node.content); setEditing(true) }}>✎</button>
              <button className={css.action} title={t('block.deleteBlock')} onClick={() => { if (window.confirm(`Delete block #${node.id}?`)) void wikiStore.deleteBlock(node.id) }}>🗑</button>
            </>
          )}
          {editing && (
            <>
              <button className={css.action} title={t('block.saveShortcut')} onClick={commitEdit}>{t('block.save')}</button>
              <button className={css.action} title={t('block.cancelShortcut')} onClick={() => { setEditing(false) }}>{t('block.cancel')}</button>
            </>
          )}
        </div>
      </div>
      {node.children.length > 0 && (
        <div className={css.children}>
          {node.children.map(child => <BlockRow key={child.id} node={child} pageName={pageName} depth={depth + 1} t={t} />)}
        </div>
      )}
      {adding && (
        <div className={css.addRow}>
          <input
            className={css.addInput}
            value={addDraft}
            placeholder={t('block.placeholder', { id: node.id })}
            onChange={(e) => { setAddDraft(e.target.value) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitAdd()
              if (e.key === 'Escape') setAdding(false)
            }}
            autoFocus
          />
          <button className={css.action} onClick={commitAdd}>{t('block.save')}</button>
          <button className={css.action} onClick={() => { setAdding(false) }}>{t('block.cancel')}</button>
        </div>
      )}
    </div>
  )
}

/** A tree of blocks with an "add top-level child" affordance. */
export function BlockTree({ blocks, pageName, t }: { blocks: WikiBlockNode[]; pageName: string; t: TranslateNS<'wiki'> }) {
  return (
    <div className={css.tree}>
      {blocks.map(node => <BlockRow key={node.id} node={node} pageName={pageName} depth={0} t={t} />)}
    </div>
  )
}
