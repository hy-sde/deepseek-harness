/** PDF body injection and props shared by the builtin and Office document registrations. */
import type { Context } from '@deepseek-ai/cordis'
import type { ComponentType } from 'react'
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { PropsLocale, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DocumentPreviewProps } from './contract/document.ts'
import { retainDocumentTabs } from './document-tab-lifetime.ts'
import { createPdfStore, type PdfStore } from './pdf-store.ts'
import { ZoomViewport, zoomSurfaceClass, type ZoomViewportProps } from './ZoomViewport.tsx'

/** A record's viewing preferences survive body unmounts and leave with the tab. */
export interface PdfBodyInjected {
  /**
   * Retain viewing preferences until the tab record ends.
   * @param tabId - owning tab.
   * @param signal - tab-record lifetime, not body visibility.
   */
  readonly retainTab: (tabId: TabId, signal: AbortSignal) => void
  /** Main-bundle viewport reused by the lazy PDF body. */
  readonly ZoomViewport: ComponentType<ZoomViewportProps>
  /** Main-bundle class implementing fit-width and fixed-size surfaces. */
  readonly zoomSurfaceClass: string
}

/** Standard document props plus the PDF entry's locale, viewing store, and lifetime callback. */
export type PdfBodyProps = DocumentPreviewProps & PropsLocale<'sidebarPdf'> & PropsStore<PdfStore> & PdfBodyInjected

/**
 * Retain PDF viewing state for a document entry's tab lifetime.
 * @param ctx - owning registration context.
 * @returns the store and injection shared by ordinary and Office PDF registrations.
 */
export function pdfBodyRegistration(ctx: Context): {
  store: PdfStore
  inject: (sessionId: SessionId, actions: BoundActions<PdfStore>) => PdfBodyInjected
} {
  const store = createPdfStore()
  const retainTab = retainDocumentTabs(ctx)
  return {
    store,
    inject: (_sessionId, actions): PdfBodyInjected => ({
      retainTab: (tabId, signal) => { retainTab(tabId, signal, actions.forget) },
      ZoomViewport,
      zoomSurfaceClass,
    }),
  }
}
