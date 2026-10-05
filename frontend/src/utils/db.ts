/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbbrinepond
 * - v1：建立全部表与 pondId+date 复合索引
 * - v2：新增 evapMm 字段并写入升级迁移逻辑，旧记录自动补齐默认值
 * - v3：气象日报增加蒸发皿读数（panMm）/ 读数来源 / 日报状态，走水编排增加挂起与对账字段；
 *       旧日报没有蒸发皿读数的，升级时按当时气温风力反推一笔
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Pond } from '../types/pond';
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Assay } from '../types/assay';
import type { Schedule, ScheduleState } from '../types/schedule';
import { effectiveEvapMm, estimateEvapMm, inferPanMm } from './brine';
import { nowIso } from './id';
import { seedDatabase } from './seed';
import { reconcilePondDate } from './reconcile';

/** 数据库名 */
export const DB_NAME = 'gbbrinepond';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 3;

class BrinePondDatabase extends Dexie {
  ponds!: Table<Pond, string>;
  gates!: Table<Gate, string>;
  observations!: Table<Observation, string>;
  assays!: Table<Assay, string>;
  schedules!: Table<Schedule, string>;

  constructor() {
    super(DB_NAME);

    // ---------- v1：建立全部表与 pondId+date 复合索引 ----------
    this.version(1).stores({
      ponds: 'id, code, seriesName, stage, status, createdAt',
      gates: 'id, fromPondId, toPondId, state',
      observations: 'id, pondId, date, [pondId+date], densityGcm3',
      assays: 'id, pondId, date, [pondId+date], verdict',
      schedules: 'id, pondId, planDate, state, orderIndex',
    });

    // ---------- v2：新增 evapMm 字段，并为旧记录补齐默认值 ----------
    this.version(2)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules: 'id, pondId, planDate, state, orderIndex',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('ponds'),
          tx.table('gates'),
          tx.table('observations'),
          tx.table('assays'),
          tx.table('schedules'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
          });
        }
        // 迁移 2：卤水观测新增 evapMm，旧记录按密度/温度/水位/风力经验公式补齐
        await tx.table('observations').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.evapMm === 'number' && Number.isFinite(row.evapMm)) return;
          row.evapMm = estimateEvapMm(
            typeof row.densityGcm3 === 'number' ? row.densityGcm3 : 1.02,
            typeof row.tempC === 'number' ? row.tempC : 25,
            typeof row.levelCm === 'number' ? row.levelCm : 40,
            typeof row.windLevel === 'number' ? row.windLevel : 2,
          );
        });
        // 迁移 3：化验记录补齐人工覆盖标记
        await tx.table('assays').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.verdictManual !== 'boolean') row.verdictManual = false;
        });
        // 迁移 4：走水编排补齐排序序号（按计划日期兜底生成）
        await tx.table('schedules').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.orderIndex !== 'number') {
            const date = typeof row.planDate === 'string' ? row.planDate : '2026-01-01';
            row.orderIndex = Number(date.replace(/-/g, '')) || 1;
          }
        });
      });

    // ---------- v3：气象日报蒸发皿读数 + 走水挂起 / 对账字段 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm, panMm, status',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules: 'id, pondId, planDate, state, orderIndex, reconcileStatus',
      })
      .upgrade(async (tx) => {
        // 迁移 5：旧日报没有蒸发皿读数，升级时按当时气温 / 风力反推一笔
        await tx.table('observations').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.panSource !== 'string') {
            row.panSource = typeof row.panMm === 'number' && Number.isFinite(row.panMm) ? '实测' : '反推';
          }
          if (row.panSource === '反推' && !(typeof row.panMm === 'number' && Number.isFinite(row.panMm))) {
            const tempC = typeof row.tempC === 'number' ? row.tempC : 25;
            const windLevel = typeof row.windLevel === 'number' ? row.windLevel : 2;
            row.panMm = inferPanMm(tempC, windLevel);
          }
          if (typeof row.status !== 'string') row.status = '有效';
          if (typeof row.voidReason !== 'string') row.voidReason = '';
          // 有了读数后，调度侧蒸发量以读数折算为准
          if (typeof row.panMm === 'number' && Number.isFinite(row.panMm)) {
            row.evapMm = effectiveEvapMm({
              densityGcm3: typeof row.densityGcm3 === 'number' ? row.densityGcm3 : 1.02,
              tempC: typeof row.tempC === 'number' ? row.tempC : 25,
              levelCm: typeof row.levelCm === 'number' ? row.levelCm : 40,
              windLevel: typeof row.windLevel === 'number' ? row.windLevel : 2,
              panMm: row.panMm as number,
            });
          }
        });
        // 迁移 6：走水编排补齐挂起与对账字段
        await tx.table('schedules').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.stateBeforeHold !== 'string') row.stateBeforeHold = null;
          if (typeof row.holdReason !== 'string') row.holdReason = '';
          if (typeof row.reconcileStatus !== 'string') row.reconcileStatus = '';
          if (typeof row.basisReportId !== 'string') row.basisReportId = '';
          if (typeof row.recomputeCount !== 'number') row.recomputeCount = 0;
          if (typeof row.recomputedAt !== 'string') row.recomputedAt = '';
        });
      });
  }
}

export const db = new BrinePondDatabase();

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null;

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open();
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.ponds.count()) === 0) {
        await seedDatabase();
      }
    })();
  }
  return initPromise;
}

/* -------------------------------- 蒸发池 -------------------------------- */

export async function listPonds(): Promise<Pond[]> {
  const rows = await db.ponds.toArray();
  return rows.sort((a, b) => a.seriesName.localeCompare(b.seriesName, 'zh-Hans-CN') || a.code.localeCompare(b.code));
}

export async function putPond(row: Pond): Promise<void> {
  await db.ponds.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 删除蒸发池，并级联清理相关闸门、观测、化验与走水计划 */
export async function removePond(id: string): Promise<void> {
  await db.transaction('rw', db.ponds, db.gates, db.observations, db.assays, db.schedules, async () => {
    const gates = await db.gates.toArray();
    const related = gates.filter((gate) => gate.fromPondId === id || gate.toPondId === id).map((gate) => gate.id);
    if (related.length > 0) await db.gates.bulkDelete(related);
    await db.observations.where('pondId').equals(id).delete();
    await db.assays.where('pondId').equals(id).delete();
    await db.schedules.where('pondId').equals(id).delete();
    await db.ponds.delete(id);
  });
}

/* -------------------------------- 闸门 -------------------------------- */

export async function listGates(): Promise<Gate[]> {
  return db.gates.toArray();
}

export async function putGate(row: Gate): Promise<void> {
  await db.gates.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 就地调整开度：同步推导闸门状态 */
export async function updateGateOpening(id: string, openingPct: number, state: Gate['state']): Promise<void> {
  await db.gates.update(id, { openingPct, state, updatedAt: nowIso() });
}

export async function removeGate(id: string): Promise<void> {
  await db.gates.delete(id);
}

/* ------------------------------ 卤水日观测 ------------------------------ */

export async function listObservations(): Promise<Observation[]> {
  const rows = await db.observations.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function listObservationsByPond(pondId: string): Promise<Observation[]> {
  const rows = await db.observations.where('pondId').equals(pondId).toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 写入气象日报（卤水日观测）：同池同日仅保留一条（存在即覆盖原记录）。
 * 蒸发量优先采用蒸发皿读数折算，读数缺失时按经验公式自动估算。
 * 写入后按「池号 + 日期」重对该日走水编排（挂起 / 恢复 / 重算）。
 */
export async function upsertObservation(row: Observation): Promise<Observation> {
  const existing = await db.observations.where('[pondId+date]').equals([row.pondId, row.date]).first();
  const panMm =
    typeof row.panMm === 'number' && Number.isFinite(row.panMm) && row.panMm > 0 ? row.panMm : null;
  const status: Observation['status'] = row.status === '作废' ? '作废' : '有效';
  const panSource: Observation['panSource'] = panMm === null ? '估算' : row.panSource ?? '实测';
  const evapMm =
    Number.isFinite(row.evapMm) && row.evapMm > 0
      ? row.evapMm
      : effectiveEvapMm({
          densityGcm3: row.densityGcm3,
          tempC: row.tempC,
          levelCm: row.levelCm,
          windLevel: row.windLevel,
          panMm,
        });
  const next: Observation = {
    ...row,
    id: existing === undefined ? row.id : existing.id,
    panMm,
    panSource,
    status,
    voidReason: typeof row.voidReason === 'string' ? row.voidReason : '',
    evapMm,
    createdAt: existing === undefined ? row.createdAt : existing.createdAt,
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  };
  await db.observations.put(next);
  // 事务提交后再触发对账（对账内部另开事务，避免嵌套事务）
  await reconcilePondDate(next.pondId, next.date);
  return next;
}

/**
 * 蒸发皿复测：该条日报作废。由它算出的水量与「没走」的编排随后由调度端重算 / 挂起，
 * 已走完（走水中 / 已出卤）的水照旧留着。
 */
export async function voidObservation(id: string, reason: string): Promise<void> {
  const row = await db.observations.get(id);
  if (!row) return;
  await db.observations.update(id, {
    status: '作废',
    voidReason: reason.trim() !== '' ? reason.trim() : '蒸发皿复测',
    updatedAt: nowIso(),
  });
  await reconcilePondDate(row.pondId, row.date);
}

/**
 * 复测读数写回：日报恢复有效，读数来源记为「复测」，挂起的走水自动恢复并重算水量。
 */
export async function remeasureObservation(id: string, panMm: number): Promise<void> {
  const row = await db.observations.get(id);
  if (!row) return;
  const value = Number.isFinite(panMm) && panMm > 0 ? panMm : 0;
  if (value <= 0) return;
  await db.observations.update(id, {
    panMm: value,
    panSource: '复测',
    status: '有效',
    voidReason: '',
    evapMm: effectiveEvapMm({
      densityGcm3: row.densityGcm3,
      tempC: row.tempC,
      levelCm: row.levelCm,
      windLevel: row.windLevel,
      panMm: value,
    }),
    updatedAt: nowIso(),
  });
  await reconcilePondDate(row.pondId, row.date);
}

/** 删除日报后，对该池该日重新对账（可能把对应走水挂起） */
export async function removeObservation(id: string): Promise<void> {
  const row = await db.observations.get(id);
  if (!row) return;
  const { pondId, date } = row;
  await db.observations.delete(id);
  await reconcilePondDate(pondId, date);
}

/* ------------------------------ 离子组分分析 ------------------------------ */

export async function listAssays(): Promise<Assay[]> {
  const rows = await db.assays.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function listAssaysByPond(pondId: string): Promise<Assay[]> {
  const rows = await db.assays.where('pondId').equals(pondId).toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function putAssay(row: Assay): Promise<void> {
  await db.assays.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeAssay(id: string): Promise<void> {
  await db.assays.delete(id);
}

/* ------------------------------ 走水编排 ------------------------------ */

export async function listSchedules(): Promise<Schedule[]> {
  const rows = await db.schedules.toArray();
  return rows.sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate));
}

export async function putSchedule(row: Schedule): Promise<void> {
  await db.schedules.put({
    ...row,
    stateBeforeHold: row.stateBeforeHold ?? null,
    holdReason: row.holdReason ?? '',
    reconcileStatus: row.reconcileStatus ?? '',
    basisReportId: row.basisReportId ?? '',
    recomputeCount: typeof row.recomputeCount === 'number' ? row.recomputeCount : 0,
    recomputedAt: row.recomputedAt ?? '',
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  });
}

export async function removeSchedule(id: string): Promise<void> {
  await db.schedules.delete(id);
}

/** 按给定 id 顺序重写排序序号（拖拽排序后调用） */
export async function reorderSchedules(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.schedules, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.schedules.update(orderedIds[index], { orderIndex: index + 1, updatedAt: nowIso() });
    }
  });
}

/**
 * 出卤完成回写：把蒸发池推进到下一阶段，并把最新一次观测的密度对齐到实际密度。
 */
export async function applyDischarge(scheduleId: string, actualDensity: number): Promise<void> {
  await db.transaction('rw', db.ponds, db.schedules, db.observations, async () => {
    const schedule = await db.schedules.get(scheduleId);
    if (!schedule) return;
    await db.schedules.update(scheduleId, { state: '已出卤', updatedAt: nowIso() });
    const pond = await db.ponds.get(schedule.pondId);
    if (!pond) return;
    const nextStage: Pond['stage'] = pond.stage === '钠盐' ? '钾盐' : pond.stage === '钾盐' ? '锂盐' : '锂盐';
    await db.ponds.update(pond.id, { stage: nextStage, updatedAt: nowIso() });
    const list = await db.observations.where('pondId').equals(pond.id).toArray();
    if (list.length === 0) return;
    const latest = list.reduce((acc, item) => (item.date > acc.date ? item : acc));
    const density = actualDensity > 0 ? actualDensity : latest.densityGcm3;
    await db.observations.update(latest.id, {
      densityGcm3: density,
      evapMm: effectiveEvapMm({
        densityGcm3: density,
        tempC: latest.tempC,
        levelCm: latest.levelCm,
        windLevel: latest.windLevel,
        panMm: latest.panMm,
      }),
      updatedAt: nowIso(),
    });
  });
}

/** 推进走水状态 */
export async function advanceScheduleState(scheduleId: string, next: ScheduleState, actualDensity: number): Promise<void> {
  if (next === '已出卤') {
    await applyDischarge(scheduleId, actualDensity);
    return;
  }
  await db.schedules.update(scheduleId, { state: next, updatedAt: nowIso() });
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  ponds: Pond[];
  gates: Gate[];
  observations: Observation[];
  assays: Assay[];
  schedules: Schedule[];
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [ponds, gates, observations, assays, schedules] = await Promise.all([
    db.ponds.toArray(),
    db.gates.toArray(),
    db.observations.toArray(),
    db.assays.toArray(),
    db.schedules.toArray(),
  ]);
  return { name: DB_NAME, schemaVersion: DB_SCHEMA_VERSION, exportedAt: nowIso(), ponds, gates, observations, assays, schedules };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction('rw', db.ponds, db.gates, db.observations, db.assays, db.schedules, async () => {
    await Promise.all([
      db.ponds.clear(),
      db.gates.clear(),
      db.observations.clear(),
      db.assays.clear(),
      db.schedules.clear(),
    ]);
    await db.ponds.bulkPut(snapshot.ponds.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.gates.bulkPut(snapshot.gates.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.observations.bulkPut(snapshot.observations.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.assays.bulkPut(snapshot.assays.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.schedules.bulkPut(snapshot.schedules.map((row) => ({ ...row, revision: ROW_REVISION })));
  });
}

export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', db.ponds, db.gates, db.observations, db.assays, db.schedules, async () => {
    await Promise.all([
      db.ponds.clear(),
      db.gates.clear(),
      db.observations.clear(),
      db.assays.clear(),
      db.schedules.clear(),
    ]);
  });
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [ponds, gates, observations, assays, schedules] = await Promise.all([
    db.ponds.count(),
    db.gates.count(),
    db.observations.count(),
    db.assays.count(),
    db.schedules.count(),
  ]);
  return { ponds, gates, observations, assays, schedules };
}
