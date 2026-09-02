/** `countdown` namespace dictionaries: the sidebar timer cell's copy. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'timer.hm': '{h} 小时 {m} 分钟',
  'timer.ms': '{m} 分 {s} 秒',
  'timer.m': '{m} 分钟',
  'timer.minute': '分',
  'action.restart': '重新开始',
  'action.start': '开始',
  'timer.settingsAria': '计时器时长设置',
  'timer.settingsTitle': '计时器时长',
  'timer.customMinutes': '自定义分钟数',
  'action.apply': '应用',
  'action.close': '关闭',
  'timer.restartTimer': '重新开始计时',
  'timer.startTimer': '开始计时',
  'timer.setDuration': '设置时长',
  'timer.clearTimer': '清除计时',
  'timer.running': '计时中…',
  'timer.done': '完成！',
  'timer.setMin': '设置 {n} 分钟',
  'timer.setTime': '设置时间',
} satisfies Record<string, string>

/** The countdown namespace key union. */
export type CountdownKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'timer.hm': '{h}h {m}m',
  'timer.ms': '{m}m {s}s',
  'timer.m': '{m}m',
  'timer.minute': 'm',
  'action.restart': 'Restart',
  'action.start': 'Start',
  'timer.settingsAria': 'Timer duration settings',
  'timer.settingsTitle': 'Timer duration',
  'timer.customMinutes': 'Custom minutes',
  'action.apply': 'Apply',
  'action.close': 'Close',
  'timer.restartTimer': 'Restart timer',
  'timer.startTimer': 'Start timer',
  'timer.setDuration': 'Set duration',
  'timer.clearTimer': 'Clear timer',
  'timer.running': 'running…',
  'timer.done': 'Done!',
  'timer.setMin': 'Set {n} min',
  'timer.setTime': 'Set time',
} satisfies Record<CountdownKey, string>
