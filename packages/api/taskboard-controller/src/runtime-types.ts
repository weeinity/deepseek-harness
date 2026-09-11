/** Browser-safe runtime and power-protection observations for Taskboard. */

/** Persisted Taskboard switches exposed through the settings service. */
export interface TaskboardSettings {
  readonly enabled: boolean
  readonly announceToAgent: boolean
  readonly preventIdleSleep: boolean
}

/** Host idle-sleep protection, independent of display sleep and explicit suspension. */
export interface TaskboardPowerState {
  readonly phase: 'disabled' | 'idle' | 'acquiring' | 'active' | 'unsupported' | 'error'
  readonly platform: string
  readonly runningSessions: number
  readonly enabledSchedules: number
  readonly sessionStateKnown: boolean
  readonly error?: string
}

/** Host-owned execution and scheduler state accompanying the task feed. */
export interface TaskboardRuntimeState {
  readonly settings: TaskboardSettings
  readonly timeZone: string
  readonly power: TaskboardPowerState
  /** Last Host monitoring or ownership failure; never a successful execution outcome. */
  readonly error?: string
  readonly scheduler: {
    readonly lastTickAt?: string
    readonly error?: string
  }
}
