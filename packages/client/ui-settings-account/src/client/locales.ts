/** Sidebar settings launcher copy, owned by the account feature. */
/** EN launcher copy. */
export const en = {
  settings: 'Settings', menu: 'Account menu', more: 'More',
} as const
/** ZH launcher copy. */
export const zh = {
  settings: '设置', menu: '账号菜单', more: '更多',
} as const
/** JA launcher copy. */
export const ja = {
  settings: '設定', menu: 'アカウントメニュー', more: 'その他',
} as const
/** ES launcher copy. */
export const es = {
  settings: 'Configuración', menu: 'Menú de cuenta', more: 'Más',
} as const
/** FR launcher copy. */
export const fr = {
  settings: 'Paramètres', menu: 'Menu du compte', more: 'Plus',
} as const
/** DE launcher copy. */
export const de = {
  settings: 'Einstellungen', menu: 'Kontomenü', more: 'Mehr',
} as const
/** RU launcher copy. */
export const ru = {
  settings: 'Настройки', menu: 'Меню аккаунта', more: 'Ещё',
} as const
/** PT launcher copy. */
export const pt = {
  settings: 'Configurações', menu: 'Menu da conta', more: 'Mais',
} as const
/** Launcher locale keys. */
export type AccountKey = keyof typeof en
