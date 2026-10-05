/**
 * 气象日报（卤水日观测 + 蒸发皿读数）
 *
 * 气象观测组按池号记蒸发皿读数，出成气象日报：同池同日仅保留一条。
 * 蒸发皿复测后该条日报作废（status = '作废'），复测读数补回后恢复有效。
 *
 * - panMm：气象站蒸发皿读数（mm/d）；日报出成时尚未读数时为 null
 * - panSource：读数来源——实测 / 复测 / 升级时按气温风力反推
 * - evapMm：调度侧用于水量台账的蒸发量；有蒸发皿读数时以读数为准，否则按经验公式估算
 */

/** 读数来源：蒸发皿实测 / 复测补读 / 升级时按气温风力反推 / 经验公式估算 */
export type PanSource = '实测' | '复测' | '反推' | '估算'

/** 日报状态：有效（可参与对账）/ 作废（复测前的旧日报，对账忽略） */
export type ReportStatus = '有效' | '作废'

export const PAN_SOURCE_OPTIONS: PanSource[] = ['实测', '复测', '反推', '估算']
export const REPORT_STATUS_OPTIONS: ReportStatus[] = ['有效', '作废']

export interface Observation {
  id: string
  /** 所属蒸发池（按池号对账） */
  pondId: string
  /** 日报日期 YYYY-MM-DD（按日期对账） */
  date: string
  /** 密度（g/cm³） */
  densityGcm3: number
  /** 温度（℃） */
  tempC: number
  /** 水位（cm） */
  levelCm: number
  /** 风力等级（0–8） */
  windLevel: number
  /** 估算蒸发量（mm/d）——v2 新增字段，旧记录在升级迁移中自动补齐 */
  evapMm: number
  /** 气象站蒸发皿读数（mm/d）；日报上还没当天读数时为 null ——v3 新增 */
  panMm: number | null
  /** 蒸发皿读数来源 ——v3 新增 */
  panSource: PanSource
  /** 气象日报状态：有效 / 作废 ——v3 新增 */
  status: ReportStatus
  /** 日报作废 / 复测原因（作废时填，例如「蒸发皿复测」） */
  voidReason: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑气象日报（卤水日观测）的表单草稿 */
export interface ObservationDraft {
  pondId: string
  date: string
  densityGcm3: number
  tempC: number
  levelCm: number
  windLevel: number
  evapMm: number
  /** 蒸发皿读数：空字符串表示日报上还没当天读数 */
  panMm: number | null
  panSource: PanSource
  status: ReportStatus
  voidReason: string
}

/** 判断一条日报是否可参与调度对账：状态有效且带有蒸发皿读数 */
export function hasValidPanReading(row: Pick<Observation, 'status' | 'panMm'>): boolean {
  return row.status === '有效' && typeof row.panMm === 'number' && Number.isFinite(row.panMm) && row.panMm > 0
}
