/**
 * /weather 气象日报录入台
 * 气象观测组按池号记录蒸发皿读数，出成气象日报；同池同日复测后旧报作废、新报有效。
 * 调度端按池号+日期与之对账：日报暂无当天读数时挂起该池走水，补录后自动解除并重算水量。
 * 消费模型：WeatherReport、Pond；复用组件：<FilterBar>、<StatBadge>、<EmptyPanel>、<AppDialog>
 */
import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import { createStore } from 'solid-js/store';
import AppDialog from '../components/common/AppDialog';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import { usePondStore } from '../stores/pondStore';
import { useWeatherStore } from '../stores/weatherStore';
import type { WeatherReport, WeatherReportDraft } from '../types/weather';
import { estimatePanEvapMm } from '../utils/brine';
import { today } from '../utils/id';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_DANGER = 'rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700';

const STATUS_STYLE: Record<WeatherReport['status'], string> = {
  有效: 'border-emerald-300 bg-emerald-50 text-emerald-700',
  作废: 'border-slate-300 bg-slate-100 text-slate-500',
};

function emptyDraft(pondId: string): WeatherReportDraft {
  return { pondId, date: today(), panEvapMm: 6.5, status: '有效', note: '' };
}

export default function WeatherReportPage() {
  const weatherStore = useWeatherStore();
  const pondStore = usePondStore();

  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [retestOpen, setRetestOpen] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [retestTarget, setRetestTarget] = createSignal<WeatherReport | null>(null);
  const [deleting, setDeleting] = createSignal<WeatherReport | null>(null);
  const [draft, setDraft] = createStore<WeatherReportDraft>(emptyDraft(''));
  // 估算蒸发皿读数用的临时气温 / 风力（不入库，仅用于反推建议值）
  const [estTemp, setEstTemp] = createSignal(28);
  const [estWind, setEstWind] = createSignal(2);

  onMount(() => {
    void pondStore.loadAll();
  });

  const pondOf = (pondId: string) => pondStore.state.ponds.find((pond) => pond.id === pondId) ?? null;
  const pondLabel = (pondId: string): string => {
    const pond = pondOf(pondId);
    return pond === null ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };

  /** 组合池系筛选 + 日期区间，供页面消费 */
  const filtered = createMemo<WeatherReport[]>(() => {
    const series = pondStore.state.currentSeries;
    if (series === null) return weatherStore.visible();
    const pondIds = new Set(
      pondStore.state.ponds.filter((pond) => pond.seriesName === series).map((pond) => pond.id),
    );
    return weatherStore.visible().filter((row) => pondIds.has(row.pondId));
  });

  const stats = (): ReturnType<typeof weatherStore.stats> => weatherStore.stats();

  const openCreate = (): void => {
    const pondId = pondStore.pondsOfSeries(pondStore.state.currentSeries)[0]?.id ?? pondStore.state.ponds[0]?.id ?? '';
    setEditingId(null);
    setDraft(emptyDraft(pondId));
    setEstTemp(28);
    setEstWind(2);
    setDialogOpen(true);
  };

  const openEdit = (row: WeatherReport): void => {
    setEditingId(row.id);
    setDraft({
      pondId: row.pondId,
      date: row.date,
      panEvapMm: row.panEvapMm,
      status: row.status,
      note: row.note,
    });
    setEstTemp(28);
    setEstWind(2);
    setDialogOpen(true);
  };

  const openRetest = (row: WeatherReport): void => {
    setRetestTarget(row);
    setDraft({
      pondId: row.pondId,
      date: row.date,
      panEvapMm: row.panEvapMm,
      status: '有效',
      note: '复测',
    });
    setEstTemp(28);
    setEstWind(2);
    setRetestOpen(true);
  };

  const applyEstimate = (): void => {
    setDraft('panEvapMm', estimatePanEvapMm(estTemp(), estWind()));
  };

  const submit = async (): Promise<void> => {
    if (draft.pondId === '') {
      weatherStore.setMessage('请选择蒸发池');
      return;
    }
    if (editingId() === null) {
      await weatherStore.saveOne({ ...draft });
    } else {
      // 编辑：直接更新原记录（不触发复测作废旧报）
      const existing = weatherStore.state.rows.find((row) => row.id === editingId());
      if (existing === undefined) return;
      await weatherStore.saveOne({ ...draft });
    }
    setDialogOpen(false);
  };

  const submitRetest = async (): Promise<void> => {
    const target = retestTarget();
    if (target === null) return;
    await weatherStore.saveOne({ ...draft, pondId: target.pondId, date: target.date, status: '有效', note: '复测' });
    setRetestOpen(false);
    setRetestTarget(null);
  };

  const confirmDelete = async (): Promise<void> => {
    const row = deleting();
    if (row === null) return;
    await weatherStore.remove(row.id);
    setDeleting(null);
  };

  return (
    <div class="space-y-3.5">
      <div class="flex flex-wrap gap-3">
        <StatBadge label="日报条数" value={stats().count} suffix="条" tone="primary" />
        <StatBadge label="有效日报" value={stats().valid} suffix="条" tone="success" />
        <StatBadge label="作废日报" value={stats().voided} suffix="条" tone="default" />
        <StatBadge label="平均蒸发皿读数" value={stats().avgPanEvapMm} suffix="mm/d" tone="info" />
        <StatBadge label="最新日报日期" value={stats().latestDate === '' ? '—' : stats().latestDate} tone="default" />
      </div>

      <Show when={weatherStore.state.lastMessage !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">
          {weatherStore.state.lastMessage}
        </div>
      </Show>

      <Show when={weatherStore.state.error !== ''}>
        <div class="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2 text-sm text-rose-700">
          {weatherStore.state.error}
        </div>
      </Show>

      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-[15px] font-semibold text-slate-800">气象日报录入台</h2>
          <button type="button" class={BTN_PRIMARY} onClick={openCreate} disabled={pondStore.state.ponds.length === 0}>
            + 录入日报
          </button>
        </header>

        <FilterBar
          keyword={weatherStore.filters().keyword}
          onKeyword={(value) => weatherStore.patchFilters({ keyword: value })}
          fields={[{ key: 'series', label: '池系', options: pondStore.seriesOptions() }]}
          values={{ series: pondStore.state.currentSeries ?? 'all' }}
          onChange={(key, value) => {
            if (key === 'series') pondStore.setCurrentSeries(value === 'all' ? null : value);
          }}
          onReset={() => {
            weatherStore.resetFilters();
            pondStore.setCurrentSeries(pondStore.seriesOptions()[0] ?? null);
          }}
          resultText={`命中 ${filtered().length} / ${weatherStore.state.rows.length} 条`}
        >
          <label class="flex items-center gap-1.5 text-[13px] text-slate-600">
            <span>日期区间</span>
            <input
              type="date"
              class="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
              value={weatherStore.filters().from}
              onInput={(event) => weatherStore.patchFilters({ from: event.currentTarget.value })}
            />
            <span class="text-slate-400">至</span>
            <input
              type="date"
              class="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
              value={weatherStore.filters().to}
              onInput={(event) => weatherStore.patchFilters({ to: event.currentTarget.value })}
            />
          </label>
        </FilterBar>

        <Show when={weatherStore.state.rows.length === 0 && !weatherStore.state.loading}>
          <EmptyPanel
            title="还没有气象日报记录"
            description="气象观测组按池号记录蒸发皿读数出成日报；调度端按池号+日期对账，日报暂无读数时会挂起该池走水。"
            actionText="录入第一条日报"
            onAction={openCreate}
          />
        </Show>

        <Show when={weatherStore.state.rows.length > 0}>
          <div class="overflow-x-auto">
            <table class="w-full min-w-[860px] border-collapse text-sm">
              <thead>
                <tr class="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                  <th class="px-3 py-2">蒸发池</th>
                  <th class="px-3 py-2">日报日期</th>
                  <th class="px-3 py-2 text-right">蒸发皿读数（mm/d）</th>
                  <th class="px-3 py-2">状态</th>
                  <th class="px-3 py-2">备注</th>
                  <th class="px-3 py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                <For each={filtered()}>
                  {(row) => (
                    <tr class={`border-b border-slate-100 hover:bg-slate-50/60 ${row.status === '作废' ? 'opacity-60' : ''}`}>
                      <td class="px-3 py-2.5">{pondLabel(row.pondId)}</td>
                      <td class="px-3 py-2.5">{row.date}</td>
                      <td class="px-3 py-2.5 text-right tabular-nums font-medium text-brine-700">{row.panEvapMm}</td>
                      <td class="px-3 py-2.5">
                        <span class={`rounded border px-2 py-0.5 text-[11px] ${STATUS_STYLE[row.status]}`}>{row.status}</span>
                      </td>
                      <td class="px-3 py-2.5 text-xs text-slate-500">{row.note || '—'}</td>
                      <td class="px-3 py-2.5">
                        <div class="flex gap-2">
                          <button class="text-xs text-brine-700 hover:underline" onClick={() => openEdit(row)}>
                            编辑
                          </button>
                          <Show when={row.status === '有效'}>
                            <button class="text-xs text-amber-700 hover:underline" onClick={() => openRetest(row)}>
                              复测
                            </button>
                          </Show>
                          <button class="text-xs text-rose-600 hover:underline" onClick={() => setDeleting(row)}>
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>

        <Show when={weatherStore.state.rows.length > 0 && filtered().length === 0}>
          <EmptyPanel
            title="没有符合筛选条件的气象日报"
            description="可以放宽日期区间或切换池系，或直接重置筛选。"
            actionText="重置筛选"
            onAction={() => weatherStore.resetFilters()}
          />
        </Show>
      </section>

      {/* 新建 / 编辑日报 */}
      <AppDialog
        open={dialogOpen()}
        title={editingId() === null ? '录入气象日报' : '编辑气象日报'}
        onClose={() => setDialogOpen(false)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDialogOpen(false)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submit()}>
              保存
            </button>
          </>
        }
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>蒸发池</span>
            <select class={INPUT} value={draft.pondId} onChange={(event) => setDraft('pondId', event.currentTarget.value)}>
              <option value="">请选择</option>
              <For each={pondStore.state.ponds}>
                {(pond) => (
                  <option value={pond.id}>
                    {pond.code} · {pond.seriesName} · {pond.stage}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>日报日期</span>
            <input type="date" class={INPUT} value={draft.date} onInput={(event) => setDraft('date', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>蒸发皿读数（mm/d）</span>
            <input
              type="number"
              step="0.1"
              min="0"
              class={INPUT}
              value={draft.panEvapMm}
              onInput={(event) => setDraft('panEvapMm', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>状态</span>
            <select
              class={INPUT}
              value={draft.status}
              onChange={(event) => setDraft('status', event.currentTarget.value as WeatherReport['status'])}
            >
              <For each={['有效', '作废'] as const}>{(status) => <option value={status}>{status}</option>}</For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600 sm:col-span-2">
            <span>备注</span>
            <input class={INPUT} value={draft.note} onInput={(event) => setDraft('note', event.currentTarget.value)} />
          </label>
        </div>
        <div class="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
          <p class="mb-1.5 font-medium text-slate-600">没有实测读数？按当时气温风力反推一笔：</p>
          <div class="flex flex-wrap items-center gap-2">
            <label class="flex items-center gap-1">
              气温
              <input
                type="number"
                step="0.5"
                class="w-20 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
                value={estTemp()}
                onInput={(event) => setEstTemp(Number(event.currentTarget.value))}
              />
              ℃
            </label>
            <label class="flex items-center gap-1">
              风力
              <input
                type="number"
                min="0"
                max="8"
                step="1"
                class="w-20 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
                value={estWind()}
                onInput={(event) => setEstWind(Number(event.currentTarget.value))}
              />
              级
            </label>
            <button type="button" class={BTN_GHOST} onClick={applyEstimate}>
              反推读数
            </button>
            <span class="text-slate-600">
              建议值 <span class="tabular-nums font-semibold text-brine-700">{estimatePanEvapMm(estTemp(), estWind())} mm/d</span>
            </span>
          </div>
        </div>
      </AppDialog>

      {/* 复测：旧报作废、新报有效 */}
      <AppDialog
        open={retestOpen()}
        title="蒸发皿复测"
        onClose={() => setRetestOpen(false)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setRetestOpen(false)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submitRetest()}>
              确认复测（旧报作废）
            </button>
          </>
        }
      >
        <p class="mb-3 text-sm leading-relaxed text-slate-600">
          将对「{pondLabel(retestTarget()?.pondId ?? '')}」在 {retestTarget()?.date} 的日报进行复测：
          旧日报作废，按新读数重算未出卤编排的计划走水量；已出卤的走水保持不变。
        </p>
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>复测蒸发皿读数（mm/d）</span>
            <input
              type="number"
              step="0.1"
              min="0"
              class={INPUT}
              value={draft.panEvapMm}
              onInput={(event) => setDraft('panEvapMm', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>反推（气温 / 风力）</span>
            <div class="flex items-center gap-1">
              <input
                type="number"
                step="0.5"
                class="w-20 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
                value={estTemp()}
                onInput={(event) => setEstTemp(Number(event.currentTarget.value))}
              />
              <input
                type="number"
                min="0"
                max="8"
                step="1"
                class="w-20 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
                value={estWind()}
                onInput={(event) => setEstWind(Number(event.currentTarget.value))}
              />
              <button type="button" class={BTN_GHOST} onClick={applyEstimate}>
                反推
              </button>
            </div>
          </label>
        </div>
      </AppDialog>

      <AppDialog
        open={deleting() !== null}
        title="确认删除气象日报？"
        width="max-w-lg"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDeleting(null)}>
              取消
            </button>
            <button class={BTN_DANGER} onClick={() => void confirmDelete()}>
              确认删除
            </button>
          </>
        }
      >
        <p class="text-sm leading-relaxed text-slate-600">
          将删除「{pondLabel(deleting()?.pondId ?? '')}」在 {deleting()?.date} 的气象日报，删除后该池该日未出卤编排可能因无有效读数而挂起。
        </p>
      </AppDialog>
    </div>
  );
}
