/**
 * 调度端 ⇄ 气象日报对账与作废重算
 *
 * 排走水时两边按「池号 + 日期」对账：
 * - 找不到当日气象日报、日报已作废、或日报上还没蒸发皿读数 → 先挂起这口池的走水，
 *   原走水状态保留在 stateBeforeHold；
 * - 读数补回（复测 / 新日报出成）→ 挂起自动恢复，按新读数重算水量；
 * - 已经走完的水（走水中 / 已出卤）照旧留着，不参与挂起与重算。
 */
import { db } from './db';
import type { Observation } from '../types/observation';
import { hasValidPanReading } from '../types/observation';
import type { Pond } from '../types/pond';
import type { ReconcileStatus, Schedule } from '../types/schedule';
import { isScheduleLocked, RECONCILE_STATUS_LABEL } from '../types/schedule';
import { effectiveEvapMm } from './brine';
import { nowIso } from './id';

/** 单次对账的动作统计 */
export interface ReconcileCounts {
  /** 新挂起 / 仍挂起的条数 */
  held: number;
  /** 从挂起恢复的条数 */
  resumed: number;
  /** 水量被重算的条数 */
  recomputed: number;
  /** 已对账且无变化的条数 */
  unchanged: number;
  /** 已走完、照旧不动的条数 */
  locked: number;
}

export const EMPTY_RECONCILE_COUNTS: ReconcileCounts = { held: 0, resumed: 0, recomputed: 0, unchanged: 0, locked: 0 };

/** 某口池某日的日报情况：有效日报 / 仅作废日报 */
export function findDailyReport(
  observations: Observation[],
  pondId: string,
  date: string,
): { report?: Observation; voided?: Observation } {
  const sameDay = observations.filter((row) => row.pondId === pondId && row.date === date);
  return {
    report: sameDay.find((row) => row.status !== '作废'),
    voided: sameDay.find((row) => row.status === '作废'),
  };
}

/** 纯函数：给出一条编排与日报对账后的结论 */
export function reconcileDecision(
  schedule: Schedule,
  observations: Observation[],
): { status: ReconcileStatus; hold: boolean; reason: string; report?: Observation } {
  const { report, voided } = findDailyReport(observations, schedule.pondId, schedule.planDate);
  if (report === undefined) {
    return voided === undefined
      ? { status: '无日报', hold: true, reason: RECONCILE_STATUS_LABEL.无日报 }
      : { status: '日报作废', hold: true, reason: RECONCILE_STATUS_LABEL.日报作废, report: voided };
  }
  if (!hasValidPanReading(report)) {
    return { status: '待读数', hold: true, reason: RECONCILE_STATUS_LABEL.待读数, report };
  }
  return { status: '已对账', hold: false, reason: '', report };
}

/** 由当日日报蒸发量折算单池蒸发水量（m³） */
export function volumeFromReport(report: Observation, pond: Pond | undefined): number | null {
  if (pond === undefined) return null;
  const evapMm = effectiveEvapMm(report);
  return Math.round((evapMm * pond.areaM2) / 1000 * 10) / 10;
}

type ReconcileAction = 'held' | 'resumed' | 'recomputed' | 'unchanged' | 'locked';

/**
 * 对一条编排应用对账结论（必须在 rw 事务内调用）。
 * @param forceRecompute 日报刚发生变化（作废 / 复测 / 覆盖写入）时为 true，
 *                       即使编排没挂起也要按新读数重算水量
 */
async function applyOne(
  schedule: Schedule,
  observations: Observation[],
  ponds: Pond[],
  forceRecompute: boolean,
): Promise<ReconcileAction> {
  // 已经走完的水照旧留着：不挂起、不重算
  if (isScheduleLocked(schedule.state)) return 'locked';

  const decision = reconcileDecision(schedule, observations);

  if (decision.hold) {
    const patch: Partial<Schedule> = {
      reconcileStatus: decision.status,
      holdReason: decision.reason,
      basisReportId: decision.report?.id ?? schedule.basisReportId ?? '',
      updatedAt: nowIso(),
    };
    if (schedule.state !== '挂起') {
      patch.state = '挂起';
      patch.stateBeforeHold = schedule.state;
    }
    await db.schedules.update(schedule.id, patch);
    return 'held';
  }

  const report = decision.report as Observation;
  const pond = ponds.find((item) => item.id === schedule.pondId);
  const wasHeld = schedule.state === '挂起';
  const shouldRecompute = forceRecompute || wasHeld;

  const patch: Partial<Schedule> = {
    state: wasHeld ? schedule.stateBeforeHold ?? '已排' : schedule.state,
    stateBeforeHold: wasHeld ? null : schedule.stateBeforeHold,
    reconcileStatus: '已对账',
    holdReason: '',
    basisReportId: report.id,
    updatedAt: nowIso(),
  };
  if (shouldRecompute) {
    const volume = volumeFromReport(report, pond);
    if (volume !== null) {
      patch.volumeM3 = volume;
      patch.recomputeCount = schedule.recomputeCount + 1;
      patch.recomputedAt = nowIso();
    }
  }
  await db.schedules.update(schedule.id, patch);
  if (wasHeld) return 'resumed';
  return shouldRecompute ? 'recomputed' : 'unchanged';
}

function bump(counts: ReconcileCounts, action: ReconcileAction): void {
  if (action === 'held') counts.held += 1;
  else if (action === 'resumed') counts.resumed += 1;
  else if (action === 'recomputed') counts.recomputed += 1;
  else if (action === 'locked') counts.locked += 1;
  else counts.unchanged += 1;
}

/**
 * 按「池号 + 日期」重对一口池某一天的全部编排。
 * 日报作废、复测补读、覆盖录入后调用：未走完的按新日报重算 / 挂起，已走完的不动。
 */
export async function reconcilePondDate(pondId: string, date: string): Promise<ReconcileCounts> {
  const counts: ReconcileCounts = { ...EMPTY_RECONCILE_COUNTS };
  await db.transaction('rw', db.schedules, db.observations, db.ponds, async () => {
    const [schedules, observations, ponds] = await Promise.all([
      db.schedules.toArray(),
      db.observations.toArray(),
      db.ponds.toArray(),
    ]);
    for (const schedule of schedules.filter((row) => row.pondId === pondId && row.planDate === date)) {
      bump(counts, await applyOne(schedule, observations, ponds, true));
    }
  });
  return counts;
}

/** 全量对账（调度端手动触发）：缺日报 / 缺读数的挂起，新补读数的恢复；不改动已对账编排的水量 */
export async function reconcileAll(): Promise<ReconcileCounts> {
  const counts: ReconcileCounts = { ...EMPTY_RECONCILE_COUNTS };
  await db.transaction('rw', db.schedules, db.observations, db.ponds, async () => {
    const [schedules, observations, ponds] = await Promise.all([
      db.schedules.toArray(),
      db.observations.toArray(),
      db.ponds.toArray(),
    ]);
    for (const schedule of schedules) {
      bump(counts, await applyOne(schedule, observations, ponds, false));
    }
  });
  return counts;
}

/** 对单条编排重新对账（编排单上的「对账」按钮） */
export async function reconcileSchedule(scheduleId: string): Promise<ReconcileCounts> {
  const counts: ReconcileCounts = { ...EMPTY_RECONCILE_COUNTS };
  await db.transaction('rw', db.schedules, db.observations, db.ponds, async () => {
    const [schedule, observations, ponds] = await Promise.all([
      db.schedules.get(scheduleId),
      db.observations.toArray(),
      db.ponds.toArray(),
    ]);
    if (schedule !== undefined) bump(counts, await applyOne(schedule, observations, ponds, false));
  });
  return counts;
}
