/**
 * Sidebar countdown timer cell: a compact clock next to Settings at the
 * sidebar foot. Wide shows a clock plus Start/Restart/clear and a duration
 * popover; the collapsed rail shows a mini clock whose click starts or
 * restarts. Completion plays a Web-Audio chime and raises a Web notification
 * (permission requested on the first start), and the cell self-corrects from
 * the absolute endAt timestamp so background-tab throttling cannot drift it.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { countdown } from './timer.ts'
import css from './CountdownCell.module.css'

const MINUTE_MS = 60_000
const PRESETS_MIN = [25, 45, 60, 90]
const CUSTOM_MAX_MIN = 24 * 60

/** Whether this context exposes the Web Notification API. */
function hasNotifications(): boolean {
  return typeof Notification !== 'undefined'
}

/** Ask for notification permission once (first user start). */
function requestPermission(): void {
  if (!hasNotifications()) return
  try {
    if (Notification.permission === 'default') Notification.requestPermission().catch(() => {})
  } catch (error) {
    console.error(error)
  }
}

/** Synthesize a gentle three-note ascending chime with Web Audio (no asset). */
function playChime(): void {
  try {
    const context = new AudioContext()
    const schedule = (): void => {
      const t0 = context.currentTime
      const notes = [660, 880, 990]
      for (const [i, frequency] of notes.entries()) {
        const oscillator = context.createOscillator()
        const gain = context.createGain()
        oscillator.type = 'sine'
        oscillator.frequency.value = frequency
        const start = t0 + i * 0.32
        gain.gain.setValueAtTime(0.0001, start)
        gain.gain.linearRampToValueAtTime(0.16, start + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.85)
        oscillator.connect(gain).connect(context.destination)
        oscillator.start(start)
        oscillator.stop(start + 0.9)
      }
    }
    if (context.state === 'suspended') void context.resume().then(schedule).catch(() => {})
    else schedule()
  } catch (error) {
    console.error(error)
  }
}

/** Raise the "time is up" Web notification when permission allows. */
function showNotification(durationMs: number): void {
  if (!hasNotifications()) return
  const body = `${formatLong(durationMs)} is up — time to take a break!`
  const notify = (): void => {
    new Notification('⏰ Timer finished', { body, tag: 'dsh-countdown-done' })
  }
  try {
    if (Notification.permission === 'granted') {
      notify()
    } else if (Notification.permission === 'default') {
      void Notification.requestPermission().then((permission) => {
        if (permission === 'granted') notify()
      }).catch(() => {})
    }
  } catch (error) {
    console.error(error)
  }
}

/** Human duration: "45m", "1h 10m", "25m 30s"… */
function formatLong(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  if (seconds > 0) return `${minutes}m ${seconds}s`
  return `${minutes}m`
}

/** Countdown clock: "45:00", "1:05:00" for hour-plus runs. */
function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const two = (value: number): string => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`
}

const timeClass = (running: boolean, finished: boolean): string | undefined =>
  running ? css.running : finished ? css.done : undefined

/** Sidebar footer cell: wide row with controls, compact chip on the rail. */
export function CountdownCell({ wide }: SidebarFooterActionOwnerProps) {
  const snapshot = useSyncExternalStore(countdown.subscribe, countdown.getSnapshot)
  const [panel, setPanel] = useState(false)
  const [custom, setCustom] = useState(() => Math.round(snapshot.durationMs / MINUTE_MS))
  const [, force] = useState(0)

  useEffect(() => {
    // A freshly-elapsed deadline fires chime + notification exactly once.
    const maybeFinish = (): void => {
      const live = countdown.getSnapshot()
      if (live.running && live.endAt !== null && Date.now() >= live.endAt && live.finishedAt === null) {
        countdown.complete()
        playChime()
        showNotification(live.durationMs)
      }
    }
    const tickId = window.setInterval(() => {
      maybeFinish()
      force(value => value + 1)
    }, 1000)
    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible') return
      maybeFinish()
      force(value => value + 1)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(tickId)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  const running = snapshot.running
  const finished = snapshot.finishedAt !== null && !running
  const remaining = countdown.remainingMs()
  const primaryLabel = running || finished ? 'Restart' : 'Start'
  const onPrimary = (): void => {
    requestPermission()
    if (running || finished) countdown.restart()
    else countdown.start()
  }
  const onClear = (): void => { countdown.stop() }
  const onApplyCustom = (): void => { countdown.setDuration(custom * MINUTE_MS); setPanel(false) }

  const popover = panel ? (
    <div className={css.popover} role="dialog" aria-label="Timer duration settings">
      <div className={css.popoverTitle}>Timer duration</div>
      <div className={css.presets}>
        {PRESETS_MIN.map(minutes => (
          <button
            key={String(minutes)}
            type="button"
            className={clsx(css.chip, snapshot.durationMs === minutes * MINUTE_MS && css.chipOn)}
            onClick={() => { countdown.setDuration(minutes * MINUTE_MS); setCustom(minutes) }}
          >
            {minutes}m
          </button>
        ))}
      </div>
      <label className={css.customLabel} htmlFor="countdown-custom-minutes">Custom minutes</label>
      <input
        id="countdown-custom-minutes"
        type="number"
        min={1}
        max={CUSTOM_MAX_MIN}
        value={custom}
        onChange={(event) => {
          const parsed = Number(event.target.value)
          setCustom(Number.isNaN(parsed) ? 1 : Math.max(1, Math.min(CUSTOM_MAX_MIN, Math.round(parsed))))
        }}
      />
      <div className={css.popoverActions}>
        <button type="button" className={clsx(css.btn, css.btnPrimary)} onClick={onApplyCustom}>Apply</button>
        <button type="button" className={css.btn} onClick={() => { setPanel(false) }}>Close</button>
      </div>
    </div>
  ) : null

  if (!wide) {
    return (
      <div className={css.rail}>
        <button
          type="button"
          className={css.railPrimary}
          title={running || finished ? 'Restart timer' : 'Start timer'}
          aria-label={running || finished ? 'Restart timer' : 'Start timer'}
          onClick={onPrimary}
        >
          <span className={clsx(css.railTime, timeClass(running, finished))}>{formatClock(remaining)}</span>
        </button>
        <button
          type="button"
          className={css.railGear}
          title="Set duration"
          aria-label="Set duration"
          onClick={() => { setPanel(open => !open) }}
        >
          ⚙
        </button>
        {popover}
      </div>
    )
  }

  return (
    <div className={css.cell}>
      <div className={css.row}>
        <span className={clsx(css.time, timeClass(running, finished))}>{formatClock(remaining)}</span>
        <button type="button" className={clsx(css.btn, css.btnPrimary)} onClick={onPrimary}>{primaryLabel}</button>
        <button
          type="button"
          className={css.btn}
          title="Clear timer"
          aria-label="Clear timer"
          onClick={onClear}
          disabled={!running && !finished}
        >
          ✕
        </button>
      </div>
      <div className={clsx(css.row, css.subRow)}>
        <span className={css.hint}>
          {running ? 'running…' : finished ? 'Done!' : `Set ${Math.round(snapshot.durationMs / MINUTE_MS)} min`}
        </span>
        <button type="button" className={css.btn} onClick={() => { setPanel(open => !open) }}>Set time</button>
      </div>
      {popover}
    </div>
  )
}
