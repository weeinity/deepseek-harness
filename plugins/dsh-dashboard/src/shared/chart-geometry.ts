/** Zero-based SVG geometry shared by the ADO client and self-contained HTML export. */
import { area, curveStepAfter, line, stack } from 'd3-shape'
import type { HistoryPoint } from './ado-analytics-model.ts'
import { categories } from './selection.ts'

/** Daily occupancy includes not-yet-created cohort members, separately from unknown states. */
export const historySeries = [...categories, 'notCreated'] as const
export type HistorySeries = typeof historySeries[number]

export interface HistoryGeometry {
  width: number
  height: number
  left: number
  right: number
  top: number
  bottom: number
  maxCount: number
  maxEvents: number
  line: string | null
  areas: { key: HistorySeries; path: string | null }[]
  x: number[]
  completedY: number[]
  yTicks: { value: number; y: number }[]
  eventTicks: { value: number; y: number }[]
  events: { x: number; completed: { y: number; height: number }; reopened: { y: number; height: number } }[]
}

/**
 * Places daily observations without interpolation between state changes or future extension.
 * @param points Ordered daily observations from the shared analytics report.
 * @param width SVG viewBox width, at least 100.
 * @param height SVG viewBox height, at least 100.
 * @returns Step-after paths, zero-based integer axes, and daily event bars; empty input has no paths.
 */
export function historyGeometry(points: readonly HistoryPoint[], width = 640, height = 220): HistoryGeometry {
  const left = 40
  const right = width - 16
  const top = 16
  const bottom = height - 30
  const x = points.map((_point, index) => points.length === 1 ? (left + right) / 2
    : left + index / (points.length - 1) * (right - left))
  const totals = points.map(point => categories.reduce((sum, key) => sum + point.counts[key], point.notCreated))
  const maxCount = Math.max(1, ...totals)
  const maxEvents = Math.max(1, ...points.flatMap(point => [point.completedItemIds.length, point.reopenedItemIds.length]))
  const scale = (value: number, max: number) => bottom - value / max * (bottom - top)
  const ticks = (max: number) => [...new Set([0, Math.ceil(max / 2), max])].map(value => ({
    value, y: scale(value, max),
  }))
  const occupancy = stack<HistoryPoint, HistorySeries>().keys(historySeries)
    .value((point, key) => key === 'notCreated' ? point.notCreated : point.counts[key])([...points])
  return {
    width, height, left, right, top, bottom, maxCount, maxEvents, x,
    completedY: points.map(point => scale(point.counts.Completed, maxCount)),
    line: line<HistoryPoint>().x((_point, index) => x[index]!)
      .y(point => scale(point.counts.Completed, maxCount)).curve(curveStepAfter)(points),
    areas: occupancy.map(series => ({
      key: series.key,
      path: area<typeof series[number]>().x((_point, index) => x[index]!)
        .y0(point => scale(point[0], maxCount)).y1(point => scale(point[1], maxCount))
        .curve(curveStepAfter)(series),
    })),
    yTicks: ticks(maxCount),
    eventTicks: ticks(maxEvents),
    events: points.map((point, index) => ({
      x: left + (index + .5) / points.length * (right - left),
      completed: { y: scale(point.completedItemIds.length, maxEvents), height: bottom - scale(point.completedItemIds.length, maxEvents) },
      reopened: { y: scale(point.reopenedItemIds.length, maxEvents), height: bottom - scale(point.reopenedItemIds.length, maxEvents) },
    })),
  }
}
