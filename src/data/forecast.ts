import { useQuery } from '@tanstack/react-query'
import { select } from '@/lib/backend'

/**
 * Phase 10 — prediction.
 *
 * Every type here carries `observations` and a `confidence` that can read
 * "too few to say". That is not decoration: it is the condition this phase was
 * built under, because the live project has no production history and a figure
 * from two days looks identical on screen to one from two hundred.
 */

export type Readiness = {
  declarations: number
  days_recorded: number
  first_day: string | null
  last_day: string | null
  rates_measured: number
  rates_seen: number
  articles_measured: number
  articles_seen: number
  threshold: number
}

export function useForecastReadiness() {
  return useQuery({
    queryKey: ['forecast-readiness'],
    queryFn: async () => (await select<Readiness>('forecast_readiness'))[0],
  })
}

export type MeasuredRate = {
  department_code: string
  department_name: string
  component_code: string
  observations: number
  standing_rate: number | null
  measured_rate: number | null
  against_plan_pct: number | null
  worst_day: number
  best_day: number
  first_seen: string
  last_seen: string
  confidence: 'measured' | 'too few to say'
}

export function useMeasuredRates() {
  return useQuery({
    queryKey: ['measured-rate'],
    queryFn: () =>
      select<MeasuredRate>('measured_rate', { order: ['department_code'] }),
  })
}

export type LeadTime = {
  article_code: string
  article_name: string
  observations: number
  planned_span: number
  measured_span: number | null
  fastest: number | null
  slowest: number | null
  confidence: 'measured' | 'too few to say'
}

export function useLeadTimes() {
  return useQuery({
    queryKey: ['predicted-lead-time'],
    queryFn: () =>
      select<LeadTime>('predicted_lead_time', { order: ['article_code'] }),
  })
}

export type Risk = {
  erp_order_no: string
  line_no: number
  article_code: string
  customer_name: string
  stuffing_date: string
  days_to_stuffing: number
  qty_planned: number
  qty_made: number
  observations: number
  window_elapsed_pct: number | null
  work_done_pct: number | null
  infeasible: number
  band: 'on track' | 'at risk' | 'likely late' | 'not started'
  because: string
}

export function useShipmentRisk() {
  return useQuery({
    queryKey: ['shipment-risk'],
    queryFn: () =>
      select<Risk>('shipment_risk', { order: ['days_to_stuffing'] }),
  })
}
