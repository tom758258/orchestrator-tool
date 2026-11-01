import type { BoundedChartData } from './chartData'

export type BackgroundReading = { value: number | null; unit: string | null; valid: boolean; reason: string | null }
export type BackgroundSample = { timestamp_utc: string; elapsed_s: number; captured: number;
  value?: number; unit?: string; values?: Record<string, BackgroundReading> }
export type BackgroundDataset = { id: string; background_id: string; worker_run_id: string; status: string; quality: string; row_count: number;
  min: number | null; max: number | null; avg: number | null; csv_path: string | null; error: string | null;
  fields?: string[]; field_stats?: Record<string, { valid: number; invalid: number; min: number | null; max: number | null; avg: number | null }> }
export type BackgroundOutputData = { datasets: BackgroundDataset[];
  workers: { id: string; state: string; stream_state: string | null; live_monitor: boolean; error: string | null }[];
  rows: BackgroundSample[]; monitor: BackgroundSample[] }
export type BackgroundChartPoint = { x: number; value: number; sample_index: number;
  timestamp_utc: string; elapsed_s: number; unit: string }
export type BackgroundChartSeries = { total_count: number; visible_count: number; returned_count: number;
  sampled: boolean; raw_limit: number; raw_limit_exceeded: boolean; domain: { min: number; max: number } | null;
  points: BackgroundChartPoint[] }

export function backgroundPlotData(points: BackgroundChartPoint[], domain: BoundedChartData['domain']): BoundedChartData {
  return { x: Float64Array.from(points, point => point.x), values: Float64Array.from(points, point => point.value), domain,
    hoverLabels: points.map(point => `Sample ${point.sample_index}\n${point.timestamp_utc}\nElapsed ${point.elapsed_s} s · ${point.unit}`) }
}
