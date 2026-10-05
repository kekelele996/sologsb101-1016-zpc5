/**
 * 走水编排（Schedule）
 * 按日期排序的走水与出卤计划，可通过拖拽调整先后顺序。
 *
 * 调度端管蒸发池水量台账与走水编排单：排走水时按「池号 + 日期」与气象日报对账。
 * 日报上还没当天的蒸发皿读数时，先把这口池的走水挂起（state = '挂起'，
 * 原状态保留在 stateBeforeHold）；读数补回后自动恢复到原状态。
 * 日报作废时，由该报算出的水量与未走的编排由调度端本侧重算；
 * 已经走完（走水中 / 已出卤）的水照旧留着，不参与重算。
 */

/** 走水状态：待排 / 已排 / 挂起（等日报读数）/ 走水中 / 已出卤 */
export type ScheduleState = '待排' | '已排' | '挂起' | '走水中' | '已出卤'

export const SCHEDULE_STATE_OPTIONS: ScheduleState[] = ['待排', '已排', '挂起', '走水中', '已出卤']

/** 状态推进顺序（挂起为对账插入态，不参与人工推进） */
export const SCHEDULE_STATE_FLOW: ScheduleState[] = ['待排', '已排', '走水中', '已出卤']

/** 调度端与气象日报对账结果 */
export type ReconcileStatus = '已对账' | '待读数' | '无日报' | '日报作废'

export const RECONCILE_STATUS_LABEL: Record<ReconcileStatus, string> = {
  已对账: '已对账',
  待读数: '日报缺蒸发皿读数',
  无日报: '缺少当日气象日报',
  日报作废: '当日日报已作废',
}

/** 已经走完、水量照旧不重算的状态 */
export const LOCKED_SCHEDULE_STATES: ScheduleState[] = ['走水中', '已出卤']

/** 判断一条编排是否已经走完（水已在走 / 已出卤），作废重算时不动它 */
export function isScheduleLocked(state: ScheduleState): boolean {
  return LOCKED_SCHEDULE_STATES.includes(state)
}

export interface Schedule {
  id: string
  /** 所属蒸发池 */
  pondId: string
  /** 计划走水日期 YYYY-MM-DD（对账日） */
  planDate: string
  /** 目标密度（g/cm³） */
  targetDensity: number
  /** 计划量（m³） */
  volumeM3: number
  /** 调度员 */
  operator: string
  /** 走水状态 */
  state: ScheduleState
  /** 手工拖拽后的排序序号，越小越先走水 */
  orderIndex: number
  /** 挂起前的状态；挂起恢复时回到该状态 ——v3 新增 */
  stateBeforeHold: ScheduleState | null
  /** 挂起 / 对账原因（对不上日报时的说明） ——v3 新增 */
  holdReason: string
  /** 最近一次对账结果 ——v3 新增 */
  reconcileStatus: ReconcileStatus | ''
  /** 当前水量依据的气象日报 id ——v3 新增 */
  basisReportId: string
  /** 水量重算次数（日报作废 / 复测每次 +1） ——v3 新增 */
  recomputeCount: number
  /** 上次重算时间 ISO ——v3 新增 */
  recomputedAt: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑走水编排的表单草稿 */
export interface ScheduleDraft {
  pondId: string
  planDate: string
  targetDensity: number
  volumeM3: number
  operator: string
  state: ScheduleState
  orderIndex: number
}
