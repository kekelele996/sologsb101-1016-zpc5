/**
 * /observations 气象观测组录入台（卤水日观测 + 蒸发皿读数）
 * 单条录入 + 批量粘贴录入；同池同日仅保留一条（覆盖写入），出成气象日报。
 * 蒸发皿读数优先作为调度侧水量依据；日报出成时读数可缺（调度侧先挂起该池走水）。
 * 复测时可作废日报、写回复测读数；作废 / 复测会触发调度端按池号+日期重算未走的编排。
 * 消费模型：Observation、Pond；复用组件：<FilterBar>、<StatBadge>、<EmptyPanel>
 */
import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import { createStore } from 'solid-js/store';
import AppDialog from '../components/common/AppDialog';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import { useObservationStore, type BatchRow } from '../stores/observationStore';
import { usePondStore } from '../stores/pondStore';
import type { Observation, ObservationDraft } from '../types/observation';
import { effectiveEvapMm } from '../utils/brine';
import { today } from '../utils/id';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_DANGER = 'rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700';
const BTN_WARN = 'rounded-md bg-amber-500 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-amber-600';

function emptyDraft(pondId: string): ObservationDraft {
  return {
    pondId,
    date: today(),
    densityGcm3: 1.05,
    tempC: 28,
    levelCm: 40,
    windLevel: 2,
    evapMm: 0,
    panMm: null,
    panSource: '实测',
    status: '有效',
    voidReason: '',
  };
}

/** 读数来源徽标 */
const PAN_SOURCE_STYLE: Record<string, string> = {
  实测: 'border-emerald-300 bg-emerald-50 text-emerald-700',
  复测: 'border-sky-300 bg-sky-50 text-sky-700',
  反推: 'border-violet-300 bg-violet-50 text-violet-700',
  估算: 'border-slate-300 bg-slate-100 text-slate-500',
};

export default function ObservationEntry() {
  const observationStore = useObservationStore();
  const pondStore = usePondStore();

  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [batchOpen, setBatchOpen] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [deleting, setDeleting] = createSignal<Observation | null>(null);
  const [voiding, setVoiding] = createSignal<Observation | null>(null);
  const [remeasuring, setRemeasuring] = createSignal<Observation | null>(null);
  const [voidReason, setVoidReason] = createSignal('蒸发皿复测');
  const [panInput, setPanInput] = createSignal<number>(0);
  const [batchText, setBatchText] = createSignal('');
  const [draft, setDraft] = createStore<ObservationDraft>(emptyDraft(''));

  onMount(() => {
    void pondStore.loadAll();
  });

  const pondOf = (pondId: string) => pondStore.state.ponds.find((pond) => pond.id === pondId) ?? null;
  const pondLabel = (pondId: string): string => {
    const pond = pondOf(pondId);
    return pond === null ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };

  /** 组合 store 的日期区间筛选 + 池系筛选，供页面消费 */
  const filtered = createMemo<Observation[]>(() => {
    const series = pondStore.state.currentSeries;
    if (series === null) return observationStore.visible();
    const pondIds = new Set(
      pondStore.state.ponds.filter((pond) => pond.seriesName === series).map((pond) => pond.id),
    );
    return observationStore.visible().filter((row) => pondIds.has(row.pondId));
  });

  /** \u8C03\u5EA6\u4FA7\u91C7\u7528\u7684\u84B8\u53D1\u91CF\u9884\u89C8\uFF1A\u6709\u84B8\u53D1\u76BF\u8BFB\u6570\u65F6\u4EE5\u8BFB\u6570\u6298\u7B97\uFF0C\u5426\u5219\u7ECF\u9A8C\u516C\u5F0F\u4F30\u7B97 */
  const previewEvap = createMemo<number>(() =>
    effectiveEvapMm({
      densityGcm3: draft.densityGcm3,
      tempC: draft.tempC,
      levelCm: draft.levelCm,
      windLevel: draft.windLevel,
      panMm: draft.panMm,
    }),
  );

  const batchPreview = createMemo<BatchRow[]>(() => {
    const rows: BatchRow[] = [];
    batchText()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      .forEach((line) => {
        const parts = line.split(/[,\uFF0C\t]+/).map((item) => item.trim());
        if (parts.length < 3) return;
        rows.push({
          pondCode: parts[0],
          date: parts[1] === '' || parts[1] === undefined ? today() : parts[1],
          densityGcm3: Number(parts[2]) || 1.05,
          tempC: Number(parts[3]) || 28,
          levelCm: Number(parts[4]) || 40,
          windLevel: Number(parts[5]) || 2,
          panMm: parts[6] === undefined || parts[6] === '' ? Number.NaN : Number(parts[6]),
        });
      });
    return rows;
  });

  const stats = (): ReturnType<typeof observationStore.stats> => observationStore.stats();

  const openCreate = (): void => {
    const pondId = pondStore.pondsOfSeries(pondStore.state.currentSeries)[0]?.id ?? pondStore.state.ponds[0]?.id ?? '';
    setEditingId(null);
    setDraft(emptyDraft(pondId));
    setDialogOpen(true);
  };

  const openEdit = (row: Observation): void => {
    setEditingId(row.id);
    setDraft({
      pondId: row.pondId,
      date: row.date,
      densityGcm3: row.densityGcm3,
      tempC: row.tempC,
      levelCm: row.levelCm,
      windLevel: row.windLevel,
      evapMm: row.evapMm,
      panMm: row.panMm,
      panSource: row.panSource,
      status: row.status,
      voidReason: row.voidReason,
    });
    setDialogOpen(true);
  };

  const submit = async (): Promise<void> => {
    if (draft.pondId === '') {
      observationStore.setLastMessage('请选择蒸发池');
      return;
    }
    const editing = observationStore.rows().find((row) => row.id === editingId());
    await observationStore.saveOne({ ...draft, evapMm: previewEvap() }, editing?.id);
    setDialogOpen(false);
  };

  const submitBatch = async (): Promise<void> => {
    const rows = batchPreview();
    if (rows.length === 0) {
      observationStore.setLastMessage('没有可解析的行：每行格式为「池号,日期,密度,温度,水位,风力,蒸发皿读数」');
      return;
    }
    await observationStore.batchUpsert(pondStore.state.ponds, rows);
    setBatchOpen(false);
    setBatchText('');
  };

  const confirmDelete = async (): Promise<void> => {
    const row = deleting();
    if (row === null) return;
    await observationStore.remove(row.id);
    setDeleting(null);
  };

  const confirmVoid = async (): Promise<void> => {
    const row = voiding();
    if (row === null) return;
    await observationStore.voidReport(row.id, voidReason());
    setVoiding(null);
  };

  const confirmRemeasure = async (): Promise<void> => {
    const row = remeasuring();
    if (row === null) return;
    await observationStore.remeasure(row.id, panInput());
    setRemeasuring(null);
  };

  const openVoid = (row: Observation): void => {
    setVoiding(row);
    setVoidReason('蒸发皿复测');
  };

  const openRemeasure = (row: Observation): void => {
    setRemeasuring(row);
    setPanInput(row.panMm ?? 0);
  };

  return (
    <div class="space-y-3.5">
      <div class="flex flex-wrap gap-3">
        <StatBadge label="日报条数" value={stats().count} suffix="条" tone="primary" />
        <StatBadge label="有效 / 作废" value={`${stats().validCount} / ${stats().voidCount}`} suffix="条" tone="info" />
        <StatBadge
          label="蒸发皿读数覆盖"
          value={`${stats().panPct}%`}
          percent={stats().panPct}
          tone="success"
          hint={`${stats().panCovered} / ${stats().count} 条有效日报带有蒸发皿读数`}
        />
        <StatBadge label="场次日均蒸发量" value={stats().avgEvapMm} suffix="mm/d" tone="info" />
        <StatBadge label="区间累计蒸发量" value={stats().totalEvapMm} suffix="mm" tone="warning" />
        <StatBadge label="平均密度" value={stats().avgDensity} suffix="g/cm³" tone="default" />
        <StatBadge label="最新观测日期" value={stats().latestDate === '' ? '—' : stats().latestDate} tone="default" />
      </div>

      <Show when={observationStore.lastMessage() !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">
          {observationStore.lastMessage()}
        </div>
      </Show>

      <Show when={observationStore.error() !== ''}>
        <div class="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2 text-sm text-rose-700">
          {observationStore.error()}
        </div>
      </Show>

      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-[15px] font-semibold text-slate-800">气象观测录入台（按池号记蒸发皿读数，出成气象日报）</h2>
          <div class="flex flex-wrap gap-2">
            <button type="button" class={BTN_GHOST} onClick={() => setBatchOpen(true)} disabled={pondStore.state.ponds.length === 0}>
              批量填写
            </button>
            <button type="button" class={BTN_PRIMARY} onClick={openCreate} disabled={pondStore.state.ponds.length === 0}>
              + 录入观测
            </button>
          </div>
        </header>

        <FilterBar
          keyword={observationStore.filters().keyword}
          onKeyword={(value) => observationStore.patchFilters({ keyword: value })}
          fields={[{ key: 'series', label: '池系', options: pondStore.seriesOptions() }]}
          values={{ series: pondStore.state.currentSeries ?? 'all' }}
          onChange={(key, value) => {
            if (key === 'series') pondStore.setCurrentSeries(value === 'all' ? null : value);
          }}
          onReset={() => {
            observationStore.resetFilters();
            pondStore.setCurrentSeries(pondStore.seriesOptions()[0] ?? null);
          }}
          resultText={`命中 ${filtered().length} / ${observationStore.rows().length} 条`}
        >
          <label class="flex items-center gap-1.5 text-[13px] text-slate-600">
            <span>日期区间</span>
            <input
              type="date"
              class="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
              value={observationStore.filters().from}
              onInput={(event) => observationStore.patchFilters({ from: event.currentTarget.value })}
            />
            <span class="text-slate-400">至</span>
            <input
              type="date"
              class="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
              value={observationStore.filters().to}
              onInput={(event) => observationStore.patchFilters({ to: event.currentTarget.value })}
            />
          </label>
        </FilterBar>

        <Show when={observationStore.rows().length === 0 && !observationStore.loading()}>
          <EmptyPanel
            title="还没有气象日报"
            description="按池号逐日录入密度、温度、水位、风力与蒸发皿读数出成日报；读数未出时调度端会先挂起该池走水，复测后可作废 / 补读。"
            actionText="录入第一条观测"
            onAction={openCreate}
          />
        </Show>

        <Show when={observationStore.rows().length > 0}>
          <div class="overflow-x-auto">
            <table class="w-full min-w-[1120px] border-collapse text-sm">
              <thead>
                <tr class="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                  <th class="px-3 py-2">蒸发池</th>
                  <th class="px-3 py-2">日报日期</th>
                  <th class="px-3 py-2">日报状态</th>
                  <th class="px-3 py-2 text-right">密度（g/cm³）</th>
                  <th class="px-3 py-2 text-right">温度（℃）</th>
                  <th class="px-3 py-2 text-right">水位（cm）</th>
                  <th class="px-3 py-2 text-right">风力等级</th>
                  <th class="px-3 py-2 text-right">蒸发皿读数（mm/d）</th>
                  <th class="px-3 py-2 text-right">调度蒸发量（mm/d）</th>
                  <th class="px-3 py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                <For each={filtered()}>
                  {(row) => (
                    <tr
                      class={`border-b border-slate-100 hover:bg-slate-50/60 ${row.status === '作废' ? 'bg-rose-50/40 text-slate-400' : ''}`}
                    >
                      <td class="px-3 py-2.5">{pondLabel(row.pondId)}</td>
                      <td class="px-3 py-2.5">{row.date}</td>
                      <td class="px-3 py-2.5">
                        {row.status === '作废' ? (
                          <span class="rounded border border-rose-300 bg-rose-50 px-2 py-0.5 text-[11px] text-rose-700">
                            作废{row.voidReason !== '' ? ` · ${row.voidReason}` : ''}
                          </span>
                        ) : (
                          <span class="rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">
                            有效
                          </span>
                        )}
                      </td>
                      <td class="px-3 py-2.5 text-right tabular-nums">{row.densityGcm3}</td>
                      <td class="px-3 py-2.5 text-right tabular-nums">{row.tempC}</td>
                      <td class="px-3 py-2.5 text-right tabular-nums">{row.levelCm}</td>
                      <td class="px-3 py-2.5 text-right tabular-nums">{row.windLevel} 级</td>
                      <td class="px-3 py-2.5 text-right tabular-nums">
                        <Show
                          when={row.panMm !== null}
                          fallback={<span class="text-amber-600">待读数</span>}
                        >
                          <span class="font-medium text-slate-800">{row.panMm}</span>
                          <span class={`ml-1 rounded border px-1 py-0.5 text-[10px] ${PAN_SOURCE_STYLE[row.panSource]}`}>
                            {row.panSource}
                          </span>
                        </Show>
                      </td>
                      <td class="px-3 py-2.5 text-right tabular-nums font-medium text-brine-700">{row.evapMm}</td>
                      <td class="px-3 py-2.5">
                        <div class="flex gap-2">
                          <button class="text-xs text-brine-700 hover:underline" onClick={() => openEdit(row)}>
                            编辑
                          </button>
                          <Show when={row.status === '有效'}>
                            <button class="text-xs text-amber-600 hover:underline" onClick={() => openVoid(row)}>
                              复测作废
                            </button>
                          </Show>
                          <Show when={row.status === '作废' || row.panMm === null}>
                            <button class="text-xs text-sky-700 hover:underline" onClick={() => openRemeasure(row)}>
                              复测读数
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

        <Show when={observationStore.rows().length > 0 && filtered().length === 0}>
          <EmptyPanel
            title="没有符合筛选条件的观测记录"
            description="可以放宽日期区间或切换池系，或直接重置筛选。"
            actionText="重置筛选"
            onAction={() => observationStore.resetFilters()}
          />
        </Show>
      </section>

      <AppDialog
        open={dialogOpen()}
        title={editingId() === null ? '录入卤水日观测' : '编辑卤水日观测'}
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
            <span>观测日期</span>
            <input type="date" class={INPUT} value={draft.date} onInput={(event) => setDraft('date', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>密度（g/cm³）</span>
            <input
              type="number"
              step="0.001"
              min="1"
              max="1.4"
              class={INPUT}
              value={draft.densityGcm3}
              onInput={(event) => setDraft('densityGcm3', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>温度（℃）</span>
            <input
              type="number"
              step="0.5"
              class={INPUT}
              value={draft.tempC}
              onInput={(event) => setDraft('tempC', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>水位（cm）</span>
            <input
              type="number"
              step="1"
              class={INPUT}
              value={draft.levelCm}
              onInput={(event) => setDraft('levelCm', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>风力等级（0–8）</span>
            <input
              type="number"
              min="0"
              max="8"
              step="1"
              class={INPUT}
              value={draft.windLevel}
              onInput={(event) => setDraft('windLevel', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>蒸发皿读数（mm/d，留空 = 读数未出）</span>
            <input
              type="number"
              min="0"
              step="0.1"
              placeholder="读数未出时留空"
              class={INPUT}
              value={draft.panMm === null ? '' : draft.panMm}
              onInput={(event) => {
                const value = event.currentTarget.value;
                const panMm = value === '' ? null : Number(value);
                // 从「待读数」补入读数时，默认把来源切到气象站实测
                const panSource = panMm !== null && draft.panSource === '估算' ? '实测' : draft.panSource;
                setDraft({ panMm, panSource });
              }}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>读数来源</span>
            <select
              class={INPUT}
              value={draft.panSource}
              onChange={(event) => setDraft('panSource', event.currentTarget.value as ObservationDraft['panSource'])}
            >
              <option value="实测">气象站实测</option>
              <option value="复测">蒸发皿复测</option>
              <option value="反推">升级时按气温风力反推</option>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>气象日报状态</span>
            <select
              class={INPUT}
              value={draft.status}
              onChange={(event) => setDraft('status', event.currentTarget.value as ObservationDraft['status'])}
            >
              <option value="有效">有效</option>
              <option value="作废">作废（蒸发皿复测）</option>
            </select>
          </label>
        </div>
        <Show when={draft.status === '作废'}>
          <label class="mt-3 flex flex-col gap-1 text-[13px] text-slate-600">
            <span>作废原因</span>
            <input
              class={INPUT}
              value={draft.voidReason}
              placeholder="蒸发皿复测"
              onInput={(event) => setDraft('voidReason', event.currentTarget.value)}
            />
          </label>
        </Show>
        <p class="mt-3 rounded-md bg-brine-50 px-3 py-2 text-xs leading-relaxed text-brine-800">
          调度侧采用蒸发量为 <span class="tabular-nums font-semibold">{previewEvap()} mm/d</span>
          {draft.panMm === null
            ? '：蒸发皿读数未出，调度端会先挂起该池当日走水，读数补回后自动恢复并重算。'
            : '：有蒸发皿读数时按读数折算。'}
          同一蒸发池与同一日期只会保留一条日报，重复保存将覆盖原记录并触发调度侧重对账。
        </p>
      </AppDialog>

      <AppDialog
        open={batchOpen()}
        title="批量填写卤水日观测"
        onClose={() => setBatchOpen(false)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setBatchOpen(false)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submitBatch()} disabled={batchPreview().length === 0}>
              写入 {batchPreview().length} 条
            </button>
          </>
        }
      >
        <p class="mb-2 text-xs leading-relaxed text-slate-500">
          每行一条，格式为「池号,日期,密度,温度,水位,风力,蒸发皿读数」（读数可留空），以{' '}
          <span class="font-mono">#</span> 开头的行会被忽略。
          示例：<span class="font-mono">北-01,2026-09-28,1.112,27,38,3,8.4</span>
        </p>
        <textarea
          rows="8"
          class="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs outline-none focus:border-brine-500"
          placeholder={'北-01,2026-09-28,1.112,27,38,3,8.4\n北-02,2026-09-28,1.172,28,35,2'}
          value={batchText()}
          onInput={(event) => setBatchText(event.currentTarget.value)}
        />
        <Show when={batchPreview().length > 0}>
          <div class="mt-2 max-h-40 overflow-y-auto rounded-md border border-slate-200">
            <table class="w-full text-xs">
              <thead class="bg-slate-50 text-slate-500">
                <tr>
                  <th class="px-2 py-1 text-left">池号</th>
                  <th class="px-2 py-1 text-left">日期</th>
                  <th class="px-2 py-1 text-right">密度</th>
                  <th class="px-2 py-1 text-right">温度</th>
                  <th class="px-2 py-1 text-right">水位</th>
                  <th class="px-2 py-1 text-right">风力</th>
                  <th class="px-2 py-1 text-right">蒸发皿</th>
                </tr>
              </thead>
              <tbody>
                <For each={batchPreview()}>
                  {(row) => (
                    <tr class="border-t border-slate-100">
                      <td class="px-2 py-1">{row.pondCode}</td>
                      <td class="px-2 py-1">{row.date}</td>
                      <td class="px-2 py-1 text-right tabular-nums">{row.densityGcm3}</td>
                      <td class="px-2 py-1 text-right tabular-nums">{row.tempC}</td>
                      <td class="px-2 py-1 text-right tabular-nums">{row.levelCm}</td>
                      <td class="px-2 py-1 text-right tabular-nums">{row.windLevel}</td>
                      <td class="px-2 py-1 text-right tabular-nums">
                        {Number.isFinite(row.panMm) ? row.panMm : <span class="text-amber-600">待读数</span>}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </AppDialog>

      <AppDialog
        open={deleting() !== null}
        title="确认删除观测记录？"
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
          将删除「{pondLabel(deleting()?.pondId ?? '')}」在 {deleting()?.date}{' '}
          的气象日报；删除后该池当日走水会重新对账（缺日报时挂起）。
        </p>
      </AppDialog>

      <AppDialog
        open={voiding() !== null}
        title="蒸发皿复测：作废该条气象日报？"
        width="max-w-lg"
        onClose={() => setVoiding(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setVoiding(null)}>
              取消
            </button>
            <button class={BTN_WARN} onClick={() => void confirmVoid()}>
              确认作废并重算
            </button>
          </>
        }
      >
        <p class="mb-3 text-sm leading-relaxed text-slate-600">
          「{pondLabel(voiding()?.pondId ?? '')}」{voiding()?.date}{' '}
          的日报作废后，用它算出的水量与还没走的编排由调度端本侧重算 / 挂起；
          <span class="font-medium text-slate-800">已经走完（走水中 / 已出卤）的水照旧留着</span>。
        </p>
        <label class="flex flex-col gap-1 text-[13px] text-slate-600">
          <span>作废原因</span>
          <input class={INPUT} value={voidReason()} onInput={(event) => setVoidReason(event.currentTarget.value)} />
        </label>
      </AppDialog>

      <AppDialog
        open={remeasuring() !== null}
        title="蒸发皿复测：写回复测读数"
        width="max-w-lg"
        onClose={() => setRemeasuring(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setRemeasuring(null)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void confirmRemeasure()} disabled={!(panInput() > 0)}>
              写回复测读数
            </button>
          </>
        }
      >
        <p class="mb-3 text-sm leading-relaxed text-slate-600">
          复测读数写回后，该日报恢复有效（读数来源记为「复测」），挂起的走水自动恢复，
          水量按新读数重算；已走完的水不变。
        </p>
        <label class="flex flex-col gap-1 text-[13px] text-slate-600">
          <span>蒸发皿复测读数（mm/d）</span>
          <input
            type="number"
            min="0"
            step="0.1"
            class={INPUT}
            value={panInput() === 0 ? '' : panInput()}
            onInput={(event) => setPanInput(Number(event.currentTarget.value))}
          />
        </label>
      </AppDialog>
    </div>
  );
}
