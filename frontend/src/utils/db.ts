/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbbrinepond
 * - v1：建立全部表与 pondId+date 复合索引
 * - v2：新增 evapMm 字段并写入升级迁移逻辑，旧记录自动补齐默认值
 * - v3：新增 weatherReports 气象日报表（蒸发皿读数），旧日报按气温风力反推读数；
 *        走水编排新增 suspended / suspendReason，按池号+日期与气象日报对账挂起
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Pond } from '../types/pond';
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Assay } from '../types/assay';
import type { Schedule, ScheduleState } from '../types/schedule';
import type { WeatherReport } from '../types/weather';
import { estimateEvapMm, estimatePanEvapMm, round1 } from './brine';
import { nowIso } from './id';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbbrinepond';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 2;

class BrinePondDatabase extends Dexie {
  ponds!: Table<Pond, string>;
  gates!: Table<Gate, string>;
  observations!: Table<Observation, string>;
  assays!: Table<Assay, string>;
  schedules!: Table<Schedule, string>;
  weatherReports!: Table<WeatherReport, string>;

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

    // ---------- v3：新增气象日报表，旧日报按气温风力反推蒸发皿读数 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules: 'id, pondId, planDate, state, orderIndex, suspended',
        weatherReports: 'id, pondId, date, [pondId+date], status, panEvapMm',
      })
      .upgrade(async (tx) => {
        // 迁移 5：走水编排补齐挂起标记（默认未挂起，后续按日报对账结果回写）
        await tx.table('schedules').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.suspended !== 'boolean') row.suspended = false;
          if (typeof row.suspendReason !== 'string') row.suspendReason = '';
        });
        // 迁移 6：旧气象日报没有蒸发皿读数，按当时气温风力反推一笔
        // （旧日报即升级前的卤水日观测：有 pondId / date / tempC / windLevel）。
        // 仅当该池该日还没有气象日报时反推，避免覆盖已有的实测 / 复测记录。
        const existing = new Set<string>();
        await tx.table('weatherReports').toCollection().modify((row: Record<string, unknown>) => {
          const key = `${String(row.pondId)}|${String(row.date)}`;
          existing.add(key);
          if (typeof row.panEvapMm !== 'number' || !Number.isFinite(row.panEvapMm)) {
            row.panEvapMm = estimatePanEvapMm(
              typeof row.tempC === 'number' ? row.tempC : 25,
              typeof row.windLevel === 'number' ? row.windLevel : 2,
            );
          }
          if (typeof row.status !== 'string') row.status = '有效';
        });
        const backfill: WeatherReport[] = [];
        await tx.table('observations').each((row: Observation) => {
          const key = `${row.pondId}|${row.date}`;
          if (existing.has(key)) return;
          existing.add(key);
          backfill.push({
            id: `weather-backfill-${row.pondId}-${row.date}`,
            pondId: row.pondId,
            date: row.date,
            panEvapMm: estimatePanEvapMm(row.tempC, row.windLevel),
            status: '有效',
            note: '升级反推',
            createdAt: nowIso(),
            updatedAt: nowIso(),
            revision: ROW_REVISION,
          });
        });
        if (backfill.length > 0) await tx.table('weatherReports').bulkPut(backfill);
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

/** 删除蒸发池，并级联清理相关闸门、观测、化验、走水计划与气象日报 */
export async function removePond(id: string): Promise<void> {
  await db.transaction('rw', [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.weatherReports], async () => {
    const gates = await db.gates.toArray();
    const related = gates.filter((gate) => gate.fromPondId === id || gate.toPondId === id).map((gate) => gate.id);
    if (related.length > 0) await db.gates.bulkDelete(related);
    await db.observations.where('pondId').equals(id).delete();
    await db.assays.where('pondId').equals(id).delete();
    await db.schedules.where('pondId').equals(id).delete();
    await db.weatherReports.where('pondId').equals(id).delete();
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
 * 写入卤水日观测：同池同日仅保留一条（存在即覆盖原记录）。
 * evapMm 若未显式给出，则按经验公式自动估算。
 */
export async function upsertObservation(row: Observation): Promise<Observation> {
  const evapMm =
    Number.isFinite(row.evapMm) && row.evapMm > 0
      ? row.evapMm
      : estimateEvapMm(row.densityGcm3, row.tempC, row.levelCm, row.windLevel);
  const existing = await db.observations.where('[pondId+date]').equals([row.pondId, row.date]).first();
  const next: Observation = {
    ...row,
    id: existing === undefined ? row.id : existing.id,
    evapMm,
    createdAt: existing === undefined ? row.createdAt : existing.createdAt,
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  };
  await db.observations.put(next);
  return next;
}

export async function removeObservation(id: string): Promise<void> {
  await db.observations.delete(id);
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
  await db.schedules.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
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
      evapMm: estimateEvapMm(density, latest.tempC, latest.levelCm, latest.windLevel),
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

/* ------------------------------ 气象日报 ------------------------------ */

export async function listWeatherReports(): Promise<WeatherReport[]> {
  const rows = await db.weatherReports.toArray();
  return rows.sort((a, b) => b.date.localeCompare(a.date) || a.pondId.localeCompare(b.pondId));
}

export async function listWeatherReportsByPond(pondId: string): Promise<WeatherReport[]> {
  const rows = await db.weatherReports.where('pondId').equals(pondId).toArray();
  return rows.sort((a, b) => b.date.localeCompare(a.date));
}

/** 取某池某日的有效蒸发皿读数（无有效日报时返回 null，供对账挂起判断） */
export async function getValidPanEvapMm(pondId: string, date: string): Promise<number | null> {
  const rows = await db.weatherReports.where('[pondId+date]').equals([pondId, date]).toArray();
  const valid = rows
    .filter((row) => row.status === '有效' && row.panEvapMm > 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return valid.length > 0 ? valid[0].panEvapMm : null;
}

/**
 * 写入气象日报（同池同日复测：旧报作废、新报有效）。
 * - 新建：直接写入；
 * - 复测：把该池该日已有日报全部置为「作废」，再写入一条「有效」新报。
 * 写入后触发对账：未出卤的走水编排按新读数重算水量 / 解除挂起。
 */
export async function upsertWeatherReport(row: WeatherReport): Promise<WeatherReport> {
  const stamp = nowIso();
  const isRetest = row.note.includes('复测') || row.status === '有效';
  await db.transaction('rw', db.weatherReports, db.schedules, db.ponds, async () => {
    let existing: WeatherReport[] = [];
    if (isRetest) {
      // 复测：该池该日旧日报（含作废）统一保留，仅把仍有效的置为作废
      existing = await db.weatherReports.where('[pondId+date]').equals([row.pondId, row.date]).toArray();
      for (const old of existing) {
        if (old.status === '有效') {
          await db.weatherReports.update(old.id, { status: '作废', updatedAt: stamp });
        }
      }
    }
    const next: WeatherReport = { ...row, updatedAt: stamp, revision: ROW_REVISION };
    await db.weatherReports.put(next);

    // 对账：未出卤编排按新读数重算水量（比例 = 新读数 / 旧读数），并解除挂起
    const oldPan = existingPanEvapMm(existing);
    await recalcSchedulesForRetest(row.pondId, row.date, row.panEvapMm, oldPan);
  });
  return row;
}

/** 从一组旧日报记录里取最近一条有效读数（用于复测比例重算） */
function existingPanEvapMm(rows: WeatherReport[]): number | null {
  const valid = rows
    .filter((row) => row.status === '有效' && row.panEvapMm > 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return valid.length > 0 ? valid[0].panEvapMm : null;
}

/**
 * 对账：仅按池号+日期检查气象日报是否有有效读数，回写未出卤编排的挂起标记。
 * 不重算水量（水量重算见 recalcSchedulesForRetest）。
 */
export async function reconcileSchedulesForPondDate(
  pondId: string,
  date: string,
): Promise<{ reconciled: number; suspended: number }> {
  const validPan = await getValidPanEvapMm(pondId, date);
  const list = await db.schedules
    .where('pondId')
    .equals(pondId)
    .filter((row) => row.planDate === date && row.state !== '已出卤')
    .toArray();

  let reconciled = 0;
  let suspended = 0;
  for (const row of list) {
    if (validPan !== null && validPan > 0) {
      await db.schedules.update(row.id, { suspended: false, suspendReason: '', updatedAt: nowIso() });
      reconciled += 1;
    } else {
      await db.schedules.update(row.id, {
        suspended: true,
        suspendReason: '日报暂无有效蒸发皿读数，走水已挂起',
        updatedAt: nowIso(),
      });
      suspended += 1;
    }
  }
  return { reconciled, suspended };
}

/**
 * 复测重算：按新读数比例重算该池该日未出卤编排的计划走水量，并解除挂起。
 * 已出卤的编排保持不变（历史照旧）。
 * - 水量 = 旧水量 × (newPan / oldPan)；无旧读数时按日蒸发补水量 = newPan × 面积 / 1000。
 * - newPan 为 null 时挂起（复测后仍无有效读数）。
 */
async function recalcSchedulesForRetest(
  pondId: string,
  date: string,
  newPan: number | null,
  oldPan: number | null,
): Promise<{ reconciled: number; suspended: number }> {
  const pond = await db.ponds.get(pondId);
  const list = await db.schedules
    .where('pondId')
    .equals(pondId)
    .filter((row) => row.planDate === date && row.state !== '已出卤')
    .toArray();

  let reconciled = 0;
  let suspended = 0;
  for (const row of list) {
    if (newPan !== null && newPan > 0) {
      let volumeM3 = row.volumeM3;
      if (oldPan !== null && oldPan > 0) {
        volumeM3 = round1(row.volumeM3 * (newPan / oldPan));
      } else if (pond !== undefined && pond.areaM2 > 0) {
        volumeM3 = round1((newPan * pond.areaM2) / 1000);
      }
      await db.schedules.update(row.id, {
        volumeM3,
        suspended: false,
        suspendReason: '',
        updatedAt: nowIso(),
      });
      reconciled += 1;
    } else {
      await db.schedules.update(row.id, {
        suspended: true,
        suspendReason: '复测后日报仍无有效读数，走水已挂起',
        updatedAt: nowIso(),
      });
      suspended += 1;
    }
  }
  return { reconciled, suspended };
}

/** 全量对账：遍历所有未出卤编排，按池号+日期与气象日报对账（升级迁移 / 播种后调用） */
export async function reconcileAllSchedules(): Promise<{ reconciled: number; suspended: number }> {
  const schedules = await db.schedules.filter((row) => row.state !== '已出卤').toArray();
  const pairs = new Map<string, { pondId: string; date: string }>();
  for (const row of schedules) {
    pairs.set(`${row.pondId}|${row.planDate}`, { pondId: row.pondId, date: row.planDate });
  }
  let reconciled = 0;
  let suspended = 0;
  for (const { pondId, date } of pairs.values()) {
    const result = await reconcileSchedulesForPondDate(pondId, date);
    reconciled += result.reconciled;
    suspended += result.suspended;
  }
  return { reconciled, suspended };
}

export async function removeWeatherReport(id: string): Promise<void> {
  await db.weatherReports.delete(id);
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
  weatherReports: WeatherReport[];
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [ponds, gates, observations, assays, schedules, weatherReports] = await Promise.all([
    db.ponds.toArray(),
    db.gates.toArray(),
    db.observations.toArray(),
    db.assays.toArray(),
    db.schedules.toArray(),
    db.weatherReports.toArray(),
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    ponds,
    gates,
    observations,
    assays,
    schedules,
    weatherReports,
  };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction('rw', [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.weatherReports], async () => {
    await Promise.all([
      db.ponds.clear(),
      db.gates.clear(),
      db.observations.clear(),
      db.assays.clear(),
      db.schedules.clear(),
      db.weatherReports.clear(),
    ]);
    await db.ponds.bulkPut(snapshot.ponds.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.gates.bulkPut(snapshot.gates.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.observations.bulkPut(snapshot.observations.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.assays.bulkPut(snapshot.assays.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.schedules.bulkPut(snapshot.schedules.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.weatherReports.bulkPut(snapshot.weatherReports.map((row) => ({ ...row, revision: ROW_REVISION })));
  });
}

export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.weatherReports], async () => {
    await Promise.all([
      db.ponds.clear(),
      db.gates.clear(),
      db.observations.clear(),
      db.assays.clear(),
      db.schedules.clear(),
      db.weatherReports.clear(),
    ]);
  });
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [ponds, gates, observations, assays, schedules, weatherReports] = await Promise.all([
    db.ponds.count(),
    db.gates.count(),
    db.observations.count(),
    db.assays.count(),
    db.schedules.count(),
    db.weatherReports.count(),
  ]);
  return { ponds, gates, observations, assays, schedules, weatherReports };
}
