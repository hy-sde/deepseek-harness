/**
 * The launch-arg list carries exactly one `--disable-features` switch: Chromium honors a single
 * occurrence of that switch, so folding the darwin renderer-priority feature into the existing
 * value is what keeps the other disabled features active.
 */

import { describe, expect, it } from 'vitest'
import { STEALTH_LAUNCH_ARGS } from '../src/stealth.ts'

describe('STEALTH_LAUNCH_ARGS', () => {
  it('folds the darwin renderer-priority feature into the single --disable-features value', () => {
    const featureArgs = STEALTH_LAUNCH_ARGS.filter(arg => arg.startsWith('--disable-features='))
    expect(featureArgs).toHaveLength(1)
    const features = featureArgs[0]!.slice('--disable-features='.length).split(',')
    expect(features).toContain('Translate')
    expect(features).toContain('PrivacySandboxSettings4')
    if (process.platform === 'darwin') {
      expect(features).toContain('MacAllowBackgroundingRenderProcesses')
    } else {
      expect(features).not.toContain('MacAllowBackgroundingRenderProcesses')
    }
  })
})
