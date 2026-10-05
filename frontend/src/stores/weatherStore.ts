/**
 * 气象日报状态管理（Solid 原生能力）
 * 用 createStore 维护气象日报列表与筛选条件；复测后旧报作废、新报有效，
 * 并触发调度端按池号+日期重算未出卤编排的计划走水量（已出卤保持不变）。
 */
import { createMemo, createRoot, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { liveQuery } from 'dexie';
import type { WeatherReport, WeatherReportDraft } from '../types/weather';
import { db, initDatabase, listWeatherReports, reconcileSchedulesForPondDate, removeWeatherReport, upsertWeatherReport } from '../utils/db';
import { nowIso, uuid } from '../utils/id';

/** 气象日报筛选条件（关键字 + 池系 + 日期区间） */
export interface WeatherFilters {
  keyword: string;
  seriesName: string | 'all';
  from: string;
  to: string;
}

const EMPTY_FILTERS: WeatherFilters = { keyword: '', seriesName: 'all', from: '', to: '' };

interface WeatherState {
  rows: WeatherReport[];
  loading: boolean;
  error: string;
  lastMessage: string;
}

function createWeatherStore() {
  const [state, setState] = createStore<WeatherState>({
    rows: [],
    loading: true,
    error: '',
    lastMessage: '',
  });
  const [filters, setFilters] = createSignal<WeatherFilters>({ ...EMPTY_FILTERS });

  // 建库 / 播种必须在 liveQuery 的 querier 之外发起（与 observationStore 同理），
  // 否则采集不到可观测性集合，数据库变更后订阅不会重查。
  void initDatabase();

  liveQuery(async () => {
    return db.weatherReports.toArray();
  }).subscribe({
    next: (list) => {
      setState('rows', [...list].sort((a, b) => b.date.localeCompare(a.date) || a.pondId.localeCompare(b.pondId)));
      setState('loading', false);
      setState('error', '');
    },
    error: (err: unknown) => {
      setState({ loading: false, error: err instanceof Error ? err.message : '读取气象日报失败' });
    },
  });

  function patchFilters(patch: Partial<WeatherFilters>): void {
    setFilters({ ...filters(), ...patch });
  }

  function resetFilters(): void {
    setFilters({ ...EMPTY_FILTERS });
  }

  function setMessage(message: string): void {
    setState('lastMessage', message);
  }

  /** 滤波后的气象日报（供页面直接消费） */
  const visible = createMemo<WeatherReport[]>(() => {
    const current = filters();
    const keyword = current.keyword.trim().toLowerCase();
    return state.rows.filter((row) => {
      if (current.from !== '' && row.date < current.from) return false;
      if (current.to !== '' && row.date > current.to) return false;
      if (keyword === '') return true;
      return row.date.includes(keyword) || row.note.includes(keyword) || String(row.panEvapMm).includes(keyword);
    });
  });

  /** 派生统计：日报条数、有效 / 作废条数、平均蒸发皿读数 */
  const stats = createMemo(() => {
    const list = visible();
    const valid = list.filter((row) => row.status === '有效');
    const voided = list.filter((row) => row.status === '作废');
    const avgPan = valid.length === 0 ? 0 : Math.round((valid.reduce((acc, row) => acc + row.panEvapMm, 0) / valid.length) * 10) / 10;
    return {
      count: list.length,
      valid: valid.length,
      voided: voided.length,
      avgPanEvapMm: avgPan,
      latestDate: list.length === 0 ? '' : list.reduce((acc, row) => (row.date > acc ? row.date : acc), ''),
    };
  });

  /**
   * 保存气象日报（同池同日复测：旧报作废、新报有效）。
   * 写入后触发对账：未出卤编排按新读数重算水量 / 解除挂起，已出卤保持不变。
   */
  async function saveOne(draft: WeatherReportDraft): Promise<WeatherReport> {
    const stamp = nowIso();
    const row: WeatherReport = {
      id: uuid('weather'),
      pondId: draft.pondId,
      date: draft.date,
      panEvapMm: draft.panEvapMm,
      status: draft.status,
      note: draft.note.trim(),
      createdAt: stamp,
      updatedAt: stamp,
      revision: 2,
    };
    const saved = await upsertWeatherReport(row);
    setState('lastMessage', `已保存 ${row.date} 的气象日报（蒸发皿读数 ${row.panEvapMm} mm/d），走水编排已对账重算`);
    return saved;
  }

  /** 删除气象日报 */
  async function remove(id: string): Promise<void> {
    const row = state.rows.find((item) => item.id === id);
    await removeWeatherReport(id);
    if (row !== undefined) {
      // 删除后重新对账：该池该日未出卤编排可能因无有效读数而挂起
      await reconcileSchedulesForPondDate(row.pondId, row.date);
    }
    setState('lastMessage', '气象日报已删除，走水编排已重新对账');
  }

  return {
    state,
    filters,
    patchFilters,
    resetFilters,
    setMessage,
    visible,
    stats,
    saveOne,
    remove,
    listWeatherReports,
  };
}

const store = createRoot(createWeatherStore);

export function useWeatherStore() {
  return store;
}
