/**
 * Standalone CLI availability probe for `@deepseek-ai/dsh-tool-agentsview`.
 * Spawns `<cli> version --json` once with an 8s budget (the CLI needs no
 * daemon, configuration, or database for `version`).
 * @module @deepseek-ai/dsh-tool-agentsview/cli-check
 */

import { execFile } from 'node:child_process'

/**
 * Verify the `agentsview` CLI resolves and runs.
 * @param cliPath - CLI executable to verify (default `agentsview` on PATH).
 * @returns a promise settling once the probe succeeds.
 * @throws a descriptive error with an install hint when the probe fails.
 */
export function checkAgentsviewCli(cliPath: string = 'agentsview'): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(cliPath, ['version', '--json'], { timeout: 8000, windowsHide: true }, (err, _stdout, stderr) => {
      if (!err) {
        resolve()
        return
      }
      const code = typeof (err as { code?: unknown }).code === 'number'
      const hint = code
        ? `the \`${cliPath}\` CLI exited with code ${(err as { code: number }).code}: ${(stderr || '').trim().slice(0, 200)}`
        : `\`${cliPath}\` was not found on PATH`
      reject(new Error(`tool-agentsview: ${hint}. Install the agentsview CLI from https://agentsview.io/install.sh (\`curl -fsSL https://agentsview.io/install.sh | bash\`, or \`brew install --cask agentsview\`), or set config.cliPath.`))
    })
  })
}
