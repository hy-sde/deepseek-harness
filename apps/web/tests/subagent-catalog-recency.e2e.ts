// Focused e2e for the subagent header catalog:
// 1. entry ordering must be newest-first (latest wave on top);
// 2. an open catalog must survive wheel-scrolling inside the menu and a
//    subsequent pointer move to a row (no premature dismissal).
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  SessionLogOffset, SESSION_FORMAT_VERSION, SessionId as sessionId,
  type SessionEvent, type SessionHeader, type SessionId,
} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import {
  launchWebScaffold, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const BASE_FIXTURE = fileURLToPath(new URL('../../../snapshots/web/live-interactions/session.jsonl', import.meta.url))
const MODE = webSnapshotMode()
const PARENT_PROMPT = 'Ask a research subagent to explain event sourcing.'

interface ChildSpec {
  id: string
  label: string
  createdAgoMs: number
}

/** Newest first: latest wave must sit on top of the catalog. */
const CHILDREN: ChildSpec[] = Array.from({ length: 14 }, (_unused, index) => ({
  id: `recorded-task-${String(index).padStart(2, '0')}`,
  label: `task-${String(index).padStart(2, '0')}`,
  createdAgoMs: (14 - index) * 3_600_000,
}))

async function waitForCacheRow(
  scaffold: WebScaffold,
  header: SessionHeader,
): Promise<void> {
  const deadline = Date.now() + 10_000
  while (scaffold.ctx.sessionProjectionCache.cachedSnapshot(header, SessionLogOffset(0)) === undefined) {
    if (Date.now() >= deadline) throw new Error(`cache row for "${header.id}" did not land`)
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
}

/** Publish one durable settled subagent session (no Agent runs). */
async function publishChild(
  scaffold: WebScaffold,
  parent: SessionId,
  spec: ChildSpec,
): Promise<void> {
  const createdAt = Date.now() - spec.createdAgoMs
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: sessionId(spec.id),
    createdAt,
    isSeeded: false,
    cwd: scaffold.workspaceCwd,
    parentSession: parent,
    origin: 'subagent',
    delegationDepth: 1,
  }
  const handle = await scaffold.ctx.sessionPersistence.create(header)
  const events = [
    { type: 'turn/start', seq: 0, time: createdAt, data: { turn: 1 } },
    {
      type: 'user/message', seq: 1, time: createdAt + 1,
      data: {
        id: `00000000-0000-4000-9000-00000000${spec.id.slice(-4)}`,
        role: 'user',
        content: [{ type: 'text', text: `work on ${spec.label}` }],
        source: { kind: 'user' },
      },
      surfaceOp: 'append',
    },
    {
      type: 'subagent/descriptor', seq: 2, time: createdAt + 2,
      data: snapshotSubagentDescriptor({
        mode: 'continuable', provider: 'spawn', label: spec.label,
      }),
    },
    { type: 'turn/end', seq: 3, time: createdAt + 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as SessionEvent[]
  await handle.append(events)
  await handle.close()
  scaffold.ctx.sessionProjectionCache.coldSnapshot(header, SessionLogOffset(0), events)
  await waitForCacheRow(scaffold, header)
}

describe('web e2e: subagent catalog recency and scroll persistence', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let sidecarRoot: string
  let parentSessionId: SessionId

  beforeAll(async () => {
    if (MODE === 'record') throw new Error('subagent catalog recency is a keyless assembled snapshot')
    sidecarRoot = await mkdtemp(join(tmpdir(), 'dsh-web-subagent-catalog-'))
    scaffold = await launchWebScaffold({
      replayFixture: BASE_FIXTURE,
      compareReplaySession: false,
      paceMs: 25,
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)

    const parent = scaffold.ctx.agents.roots()[0]
    if (parent === undefined) throw new Error('fresh workspace did not publish its parent Agent')
    parentSessionId = parent.id
    const parentSettled = scaffold.whenTurnSettled()
    const parentInput = page.locator('[data-composer-input][contenteditable="true"]').first()
    await parentInput.fill(PARENT_PROMPT)
    await parentInput.press('Enter')
    expect(await parentSettled).toBe(parent.id)

    // Newest-last publication order on the host; the catalog must still show newest first.
    for (const spec of CHILDREN) await publishChild(scaffold, parentSessionId, spec)

    // Cold fixtures land after the page's initial session.list; reload so the
    // restart baseline discovers them and the header counts them.
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: `${CHILDREN.length} subagents`, exact: true })
      .waitFor({ timeout: 15_000 })
  }, 180_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (sidecarRoot !== undefined) {
      await rm(sidecarRoot, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'subagent catalog teardown failed')
  })

  it('lists direct children newest-first in the header catalog', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-catalog-order'))
    const hostOrder = await scaffold.ctx.subagents.listChildren(parentSessionId)
    // Host contract stays ascending (stable): the client catalog flips it.
    expect(hostOrder.map(entry => entry.kind === 'child' ? entry.label : entry.id)).toEqual(
      CHILDREN.map(spec => spec.label),
    )

    const trigger = page.getByRole('button', { name: `${CHILDREN.length} subagents`, exact: true })
    await trigger.hover()
    const tree = page.getByRole('tree', { name: 'Subagent sessions' })
    await tree.getByRole('treeitem').nth(CHILDREN.length - 1).waitFor({ timeout: 15_000 })
    const labels = await tree.getByRole('treeitem').evaluateAll(items =>
      items.map(item => item.getAttribute('aria-label') ?? ''))
    // Newest child first: task-13 was created most recently.
    expect(labels[0]).toContain('task-13')
    expect(labels[1]).toContain('task-12')
    expect(labels[labels.length - 1]).toContain('task-00')
    await tree.press('Escape')
    // Leave the trigger so the next test's hover produces a fresh mouseenter.
    await page.mouse.move(10, 10)
  })

  it('survives a brief pointer excursion outside the open catalog', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-catalog-return'))

    await page.mouse.move(10, 10)
    const trigger = page.getByRole('button', { name: `${CHILDREN.length} subagents`, exact: true })
    await trigger.hover()
    const tree = page.getByRole('tree', { name: 'Subagent sessions' })
    await tree.getByRole('treeitem').nth(CHILDREN.length - 1).waitFor({ timeout: 15_000 })

    const box = await tree.boundingBox()
    if (box === null) throw new Error('catalog tree has no bounding box')
    // Outside but adjacent: briefly dip out (longer than the old 120ms close,
    // shorter than the 200ms grace), then return onto a row.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.move(box.x + box.width + 24, box.y + 12)
    await page.waitForTimeout(150)
    const row = tree.getByRole('treeitem').nth(0)
    const rowBox = await row.boundingBox()
    if (rowBox === null) throw new Error('first row has no bounding box')
    await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2, { steps: 8 })
    await page.waitForTimeout(400)
    expect(await tree.count()).toBe(1)
    await tree.press('Escape')
    await page.mouse.move(10, 10)
  })

  it('keeps the catalog open while scrolling inside it and reaching a row', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-catalog-scroll'))

    const trigger = page.getByRole('button', { name: `${CHILDREN.length} subagents`, exact: true })
    await trigger.hover()
    const tree = page.getByRole('tree', { name: 'Subagent sessions' })
    await tree.getByRole('treeitem').nth(CHILDREN.length - 1).waitFor({ timeout: 15_000 })

    // Instrument: every leave/out crossing on the tree is recorded for the failure report.
    await page.evaluate(() => {
      const log: string[] = []
      const treeNode = document.querySelector('[role="tree"][aria-label="Subagent sessions"]')
      if (treeNode === null) return
      for (const name of ['mouseleave', 'mouseout']) {
        treeNode.addEventListener(name, (event) => {
          const related = event.relatedTarget as Node | null
          log.push(`${name} -> related=${related?.nodeName ?? 'null'} inside=${related !== null && treeNode.contains(related)}`)
        }, true)
      }
      window.__catalogLeaveLog = log
    })

    const box = await tree.boundingBox()
    if (box === null) throw new Error('catalog tree has no bounding box')
    // Park the pointer inside the menu, then wheel-scroll its content hard.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    for (let turn = 0; turn < 8; turn++) {
      await page.mouse.wheel(0, 240)
      await page.waitForTimeout(40)
    }
    await page.waitForTimeout(150)
    expect(await tree.count(), JSON.stringify({
      leaveLog: await page.evaluate(() => (window as { __catalogLeaveLog?: string[] }).__catalogLeaveLog ?? []),
    })).toBe(1)

    // Bring the newest (first) row back into view and reach it with many steps.
    const newest = tree.getByRole('treeitem').nth(0)
    await newest.scrollIntoViewIfNeeded()
    const rowBox = await newest.boundingBox()
    if (rowBox === null) throw new Error('first row has no bounding box')
    await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2, { steps: 24 })
    await page.waitForTimeout(600)

    const leaveLog = await page.evaluate(() => (window as { __catalogLeaveLog?: string[] }).__catalogLeaveLog ?? [])
    expect(await tree.count(), JSON.stringify({ leaveLog })).toBe(1)
    // The row is still hoverable/clickable right after the scroll.
    await newest.click()
    await page.getByRole('button', { name: /Switch subagent: task-13/ }).waitFor({ timeout: 15_000 })
  })
})

declare global {
  interface Window {
    __catalogLeaveLog?: string[]
  }
}
