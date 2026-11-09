/** The editor gesture keymap bound through the keyboard face. */
import type { MutableRefObject } from 'react'
import type { LexicalEditor } from 'lexical'
import type { ComposerKeyboard, DraftViewGate } from '../../contract/draft-editor.ts'
import { resolveSubmitMode } from '../../submission-policy.ts'
import { registerComposerKeymap } from './keymap.ts'

/**
 * Bind editor gestures to the view's live guards and Session operations.
 * @param editor - the borrowed Session-owned editor.
 * @param keyboard - the existing composer keyboard operations.
 * @param gate - live view values read by the installed handlers.
 * @returns the keymap disposer.
 */
export function installDraftKeymap(
  editor: LexicalEditor,
  keyboard: ComposerKeyboard,
  gate: MutableRefObject<DraftViewGate>,
): () => void {
  return registerComposerKeymap(editor, {
    arbitrate: (key, composing) => keyboard.arbitrate(key, composing),
    space: () => {
      if (gate.current.machineBusy || gate.current.locked) return false
      return keyboard.space()
    },
    dismissPopup: () => { keyboard.dismissPopup() },
    canSubmit: () => !gate.current.locked && !gate.current.machineBusy,
    submit: (accelerated) => {
      const g = gate.current
      // Empty-draft accelerated Enter acts on the queue instead of the
      // (empty) draft: the machine rejects empty drafts, so the gesture
      // steers every still-pending queued message into the running turn.
      if (accelerated && g.canSteerQueue) {
        keyboard.steerQueue()
        return
      }
      if (g.uploadsPending) {
        g.showToast(g.uploadsHeldText)
        return
      }
      keyboard.submit(resolveSubmitMode(
        g.busyEnter,
        g.running,
        accelerated ? 'accelerated' : 'enter',
        g.steeringAvailable,
      ), 'enter')
    },
    intakeFiles: (files, directories) => { gate.current.intakeFiles(files, directories) },
    pasteText: (text) => {
      if (gate.current.machineBusy || gate.current.locked) return
      keyboard.paste(text)
    },
  })
}
