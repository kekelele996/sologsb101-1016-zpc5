/**
 * 气象日报（WeatherReport）
 * 气象观测组按池号记录蒸发皿读数，出成气象日报；调度端按池号+日期与之对账。
 * 同池同日复测后旧报作废、新报有效，已出卤的走水编排保持不变（历史照旧）。
 */

/** 日报状态：有效 / 作废（复测后旧报作废） */
export type WeatherReportStatus = '有效' | '作废'

export const WEATHER_REPORT_STATUS_OPTIONS: WeatherReportStatus[] = ['有效', '作废']

export interface WeatherReport {
  id: string
  /** 所属蒸发池（按池号记录蒸发皿读数） */
  pondId: string
  /** 日报日期 YYYY-MM-DD */
  date: string
  /** 蒸发皿读数（mm/d）—— 气象站权威蒸发量，按当时气温风力反推或实测 */
  panEvapMm: number
  /** 日报状态：有效 / 作废 */
  status: WeatherReportStatus
  /** 备注（如「复测作废」「升级反推」） */
  note: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑气象日报的表单草稿 */
export interface WeatherReportDraft {
  pondId: string
  date: string
  panEvapMm: number
  status: WeatherReportStatus
  note: string
}
