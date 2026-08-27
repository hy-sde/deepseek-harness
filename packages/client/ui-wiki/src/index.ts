/**
 * Wiki surfaces plugin, node half. The empty apply exists so the plugin
 * appears in the host cordis.yml / Loader; the browser half ships the wiki
 * drawer (sidebar-foot toggle + frame-wide overlay panel) through
 * exports["./client"], discovered from the package.json dsh.client declaration.
 */

/** Host plugin body — the host side lives in @deepseek-ai/dsh-logseq-graph + the apiproxy wiki domain. */
export function apply(): void {}
