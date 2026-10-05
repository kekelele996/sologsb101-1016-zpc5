/**
 * 卤水日观测状态管理（Solid 原生能力）
 * 用 createSignal 维护筛选条件与派生统计，供 /observations、/assays、/schedules 共用。
 */
import { createMemo, createRoot, createSignal } from 'solid-js';
import { liveQuery } from 'dexie';
import type { Observation, ObservationDraft, PanSource, ReportStatus } from '../types/observation';
import { hasValidPanReading } from '../types/observation';
import { db, initDatabase, remeasureObservation, removeObservation, upsertObservation, voidObservation, ROW_REVISION } from '../utils/db';
import { round1 } from '../utils/brine';
import { nowIso, today, uuid } from '../utils/id';

/** 观测筛选条件（关键字 + 池系 + 日期区间），同步到 URL query */
export interface ObservationFilters {
  keyword: string;
  seriesName: string | 'all';
  from: string;
  to: string;
}

const EMPTY_FILTERS: ObservationFilters = { keyword: '', seriesName: 'all', from: '', to: '' };

/** 批量录入的一行（蒸发皿读数可留空） */
export interface BatchRow {
  pondCode: string;
  date: string;
  densityGcm3: number;
  tempC: number;
  levelCm: number;
  windLevel: number;
  /** 蒸发皿读数；NaN 表示日报上还没读数 */
  panMm: number;
}

function createObservationStore() {
  const [filters, setFilters] = createSignal<ObservationFilters>({ ...EMPTY_FILTERS });
  const [rows, setRows] = createSignal<Observation[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [lastMessage, setLastMessage] = createSignal('');

  // 建库/播种必须在 liveQuery 的 querier **之外**发起：
  // Dexie liveQuery 依赖「同一次微任务作用域」内的读操作来采集可观测性集合
  // （observability set）。若在 querier 里先 `await initDatabase()` 再查询，
  // 查询落在 await 之后的另一个微任务里，采集不到表/索引范围，
  // 数据库变更时 obsSetsOverlap 判定为空 → 订阅只产出一次结果、此后永不重查，
  // 表现为「观测条数」与新写入的记录都不刷新（整页刷新才正确）。
  // index.tsx 已 `void initDatabase()`，此处再次调用共用同一个 Promise（幂等）。
  void initDatabase();

  liveQuery(async () => {
    return db.observations.toArray();
  }).subscribe({
    next: (list) => {
      setRows([...list].sort((a, b) => b.date.localeCompare(a.date)));
      setLoading(false);
      setError('');
    },
    error: (err: unknown) => {
      setError(err instanceof Error ? err.message : '读取观测数据失败');
      setLoading(false);
    },
  });

  function patchFilters(patch: Partial<ObservationFilters>): void {
    setFilters({ ...filters(), ...patch });
  }

  function resetFilters(): void {
    setFilters({ ...EMPTY_FILTERS });
  }

  /** 滤波后的观测记录（供页面直接消费） */
  const visible = createMemo<Observation[]>(() => {
    const current = filters();
    const keyword = current.keyword.trim().toLowerCase();
    return rows().filter((row) => {
      if (current.from !== '' && row.date < current.from) return false;
      if (current.to !== '' && row.date > current.to) return false;
      if (keyword === '') return true;
      return row.date.includes(keyword) || String(row.densityGcm3).includes(keyword);
    });
  });

  /** 派生统计：观测条数、平均蒸发量、平均密度、最近观测日期、读数覆盖率 */
  const stats = createMemo(() => {
    const list = visible();
    if (list.length === 0) {
      return {
        count: 0,
        avgEvapMm: 0,
        avgDensity: 0,
        latestDate: '',
        latestDensity: 0,
        totalEvapMm: 0,
        validCount: 0,
        voidCount: 0,
        panCovered: 0,
        panPct: 0,
      };
    }
    const totalEvap = list.reduce((acc, row) => acc + row.evapMm, 0);
    const totalDensity = list.reduce((acc, row) => acc + row.densityGcm3, 0);
    const latest = list.reduce((acc, row) => (row.date > acc.date ? row : acc));
    const validCount = list.filter((row) => row.status === '有效').length;
    const voidCount = list.length - validCount;
    const panCovered = list.filter((row) => hasValidPanReading(row)).length;
    return {
      count: list.length,
      avgEvapMm: round1(totalEvap / list.length),
      avgDensity: Math.round((totalDensity / list.length) * 1000) / 1000,
      latestDate: latest.date,
      latestDensity: latest.densityGcm3,
      totalEvapMm: round1(totalEvap),
      validCount,
      voidCount,
      panCovered,
      panPct: Math.round((panCovered / list.length) * 1000) / 10,
    };
  });

  /** 批量录入：同池同日覆盖写入；带蒸发皿读数的行标记为「实测」，否则日报待读数 */
  async function batchUpsert(ponds: Array<{ id: string; code: string }>, list: BatchRow[]): Promise<number> {
    let count = 0;
    for (const row of list) {
      const pond = ponds.find((item) => item.code === row.pondCode);
      if (pond === undefined) continue;
      const hasPan = Number.isFinite(row.panMm) && row.panMm > 0;
      const stamp = nowIso();
      const draft: Observation = {
        id: uuid('obs'),
        pondId: pond.id,
        date: row.date === '' ? today() : row.date,
        densityGcm3: row.densityGcm3,
        tempC: row.tempC,
        levelCm: row.levelCm,
        windLevel: row.windLevel,
        evapMm: 0,
        panMm: hasPan ? row.panMm : null,
        panSource: hasPan ? '实测' : '估算',
        status: '有效',
        voidReason: '',
        createdAt: stamp,
        updatedAt: stamp,
        revision: ROW_REVISION,
      };
      await upsertObservation(draft);
      count += 1;
    }
    setLastMessage(count === 0 ? '没有可写入的行，请检查池号是否正确' : `已批量写入 ${count} 条气象日报，并按池号+日期重新对账走水`);
    return count;
  }

  /** 单条保存（同池同日覆盖），保存后调度侧自动对账；编辑时保留原 id */
  async function saveOne(draft: ObservationDraft, preserveId?: string): Promise<Observation> {
    const stamp = nowIso();
    const panSource: PanSource = draft.panMm === null ? '估算' : draft.panSource;
    const status: ReportStatus = draft.status === '作废' ? '作废' : '有效';
    const row = await upsertObservation({
      id: preserveId ?? uuid('obs'),
      pondId: draft.pondId,
      date: draft.date,
      densityGcm3: draft.densityGcm3,
      tempC: draft.tempC,
      levelCm: draft.levelCm,
      windLevel: draft.windLevel,
      evapMm: draft.evapMm,
      panMm: draft.panMm,
      panSource,
      status,
      voidReason: draft.voidReason,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    });
    setLastMessage(
      row.panMm === null
        ? `已保存 ${row.date} 的日报（蒸发皿读数待出）：该池当日走水已挂起`
        : `已保存 ${row.date} 的日报（同池同日自动覆盖），走水已按池号+日期对账`,
    );
    return row;
  }

  /** 蒸发皿复测：作废该条日报，调度侧重算 / 挂起未走完的编排 */
  async function voidReport(id: string, reason: string): Promise<void> {
    await voidObservation(id, reason);
    setLastMessage('日报已作废（蒸发皿复测）：未走的编排已按作废日报重算 / 挂起，已走完的水照旧保留');
  }

  /** 复测读数写回：日报恢复有效，挂起的编排恢复并重算 */
  async function remeasure(id: string, panMm: number): Promise<void> {
    await remeasureObservation(id, panMm);
    setLastMessage('复测读数已写回，日报恢复有效；挂起的走水已恢复并按新读数重算水量');
  }

  async function remove(id: string): Promise<void> {
    await removeObservation(id);
    setLastMessage('日报已删除，该池当日走水已重新对账');
  }

  return {
    filters,
    patchFilters,
    resetFilters,
    rows,
    visible,
    stats,
    loading,
    error,
    lastMessage,
    setLastMessage,
    batchUpsert,
    saveOne,
    voidReport,
    remeasure,
    remove,
  };
}

const store = createRoot(createObservationStore);

export function useObservationStore() {
  return store;
}
