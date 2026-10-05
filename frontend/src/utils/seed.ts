/**
 * 演示数据播种（幂等）
 * 父 → 子 → 孙三层链路：蒸发池 → 闸门串级 / 气象日报（卤水日观测）→ 离子组分分析 → 走水编排
 * 所有 id 固定，保证 /gates、/observations、/assays、/schedules 打开就有真实串级与数据。
 */
import { db, ROW_REVISION } from './db';
import type { Pond } from '../types/pond';
import type { Gate } from '../types/gate';
import type { Observation, PanSource, ReportStatus } from '../types/observation';
import type { Assay } from '../types/assay';
import type { Schedule, ReconcileStatus, ScheduleState } from '../types/schedule';
import { autoVerdict, estimateEvapMm, inferPanMm, round1 } from './brine';

const SEED_TIME = '2026-09-01T00:30:00.000Z';

/** 固定 id，便于文档与深链验证 */
export const SEED_IDS = {
  pondA: 'pond-north-01',
  pondB: 'pond-north-02',
  pondC: 'pond-north-03',
  pondD: 'pond-south-04',
  pondE: 'pond-south-05',
} as const;

function wrap<T>(row: Omit<T, 'createdAt' | 'updatedAt' | 'revision'>): T {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION } as T;
}

interface ObservationSeedOptions {
  /** 旧日报没有蒸发皿读数，按气温风力反推 */
  inferred?: boolean;
  /** 日报出成但蒸发皿还没读数（调度侧据此挂起走水） */
  missingPan?: boolean;
  /** 日报作废（蒸发皿复测） */
  voided?: boolean;
}

/**
 * 生成气象日报。蒸发皿读数按淡水皿口径给值；evapMm 为调度侧采用的蒸发量：
 * 有读数时按折算系数折算，否则按经验公式估算。
 */
function observation(
  id: string,
  pondId: string,
  date: string,
  densityGcm3: number,
  tempC: number,
  levelCm: number,
  windLevel: number,
  options: ObservationSeedOptions = {},
): Observation {
  const inferred = options.inferred === true;
  const panMm = options.missingPan
    ? null
    : inferred
      ? inferPanMm(tempC, windLevel)
      : round1(estimateEvapMm(densityGcm3, tempC, levelCm, windLevel) / 0.72);
  const panSource: PanSource = options.missingPan ? '估算' : inferred ? '反推' : '实测';
  const status: ReportStatus = options.voided ? '作废' : '有效';
  return wrap<Observation>({
    id,
    pondId,
    date,
    densityGcm3,
    tempC,
    levelCm,
    windLevel,
    evapMm: estimateEvapMm(densityGcm3, tempC, levelCm, windLevel),
    panMm,
    panSource,
    status,
    voidReason: options.voided ? '蒸发皿复测，读数待复测确认' : '',
  });
}

/** 生成化验记录，verdict 默认自动判定 */
function assay(
  id: string,
  pondId: string,
  date: string,
  liGpl: number,
  kGpl: number,
  mgGpl: number,
  naGpl: number,
  labName: string,
  manual?: { verdict: Assay['verdict']; verdictManual: true },
): Assay {
  return wrap<Assay>({
    id,
    pondId,
    date,
    liGpl,
    kGpl,
    mgGpl,
    naGpl,
    labName,
    verdict: manual?.verdict ?? autoVerdict(liGpl, kGpl),
    verdictManual: manual?.verdictManual ?? false,
  });
}

interface ScheduleSeedOptions {
  /** 挂起前的原状态 */
  stateBeforeHold?: ScheduleState | null;
  holdReason?: string;
  reconcileStatus?: ReconcileStatus | '';
  basisReportId?: string;
  recomputeCount?: number;
}

/** 生成走水编排，补齐挂起 / 对账字段 */
function schedule(
  id: string,
  pondId: string,
  planDate: string,
  targetDensity: number,
  volumeM3: number,
  operator: string,
  state: ScheduleState,
  orderIndex: number,
  options: ScheduleSeedOptions = {},
): Schedule {
  return wrap<Schedule>({
    id,
    pondId,
    planDate,
    targetDensity,
    volumeM3,
    operator,
    state,
    orderIndex,
    stateBeforeHold: options.stateBeforeHold ?? null,
    holdReason: options.holdReason ?? '',
    reconcileStatus: options.reconcileStatus ?? '',
    basisReportId: options.basisReportId ?? '',
    recomputeCount: options.recomputeCount ?? 0,
    recomputedAt: '',
  });
}

export async function seedDatabase(): Promise<void> {
  const exists = await db.ponds.count();
  if (exists > 0) return;

  // ---------------- 蒸发池（5 口，跨 2 个池系、3 个阶段） ----------------
  const ponds: Pond[] = [
    wrap<Pond>({ id: SEED_IDS.pondA, code: '北-01', seriesName: '北部一系', areaM2: 12000, depthCm: 45, stage: '钠盐', status: '在用' }),
    wrap<Pond>({ id: SEED_IDS.pondB, code: '北-02', seriesName: '北部一系', areaM2: 9000, depthCm: 40, stage: '钾盐', status: '在用' }),
    wrap<Pond>({ id: SEED_IDS.pondC, code: '北-03', seriesName: '北部一系', areaM2: 6800, depthCm: 35, stage: '锂盐', status: '在用' }),
    wrap<Pond>({ id: SEED_IDS.pondD, code: '南-04', seriesName: '南部二系', areaM2: 15000, depthCm: 50, stage: '钠盐', status: '在用' }),
    wrap<Pond>({ id: SEED_IDS.pondE, code: '南-05', seriesName: '南部二系', areaM2: 7200, depthCm: 38, stage: '钾盐', status: '清池中' }),
  ];

  // ---------------- 闸门串级（上游 → 下游，形成完整走向链） ----------------
  const gates: Gate[] = [
    wrap<Gate>({ id: 'gate-a-b', fromPondId: SEED_IDS.pondA, toPondId: SEED_IDS.pondB, openingPct: 65, widthCm: 120, state: '半开', note: '北部一系主走水通道' }),
    wrap<Gate>({ id: 'gate-b-c', fromPondId: SEED_IDS.pondB, toPondId: SEED_IDS.pondC, openingPct: 40, widthCm: 100, state: '半开', note: '进入锂盐阶段前的控流闸' }),
    wrap<Gate>({ id: 'gate-d-e', fromPondId: SEED_IDS.pondD, toPondId: SEED_IDS.pondE, openingPct: 80, widthCm: 140, state: '半开', note: '南部二系主走水通道' }),
    wrap<Gate>({ id: 'gate-b-e', fromPondId: SEED_IDS.pondB, toPondId: SEED_IDS.pondE, openingPct: 0, widthCm: 90, state: '关闭', note: '跨池系调水备用闸，当前关闭' }),
  ];

  // ---------------- 气象日报（每池 2–4 条，密度随日期递增） ----------------
  const observations: Observation[] = [
    // 最早两条为升级前的旧日报：没有蒸发皿读数，按当时气温风力反推
    observation('obs-a1', SEED_IDS.pondA, '2026-08-20', 1.045, 28, 45, 2, { inferred: true }),
    observation('obs-d1', SEED_IDS.pondD, '2026-08-21', 1.038, 30, 50, 4, { inferred: true }),
    observation('obs-a2', SEED_IDS.pondA, '2026-08-30', 1.062, 30, 43, 3),
    observation('obs-a3', SEED_IDS.pondA, '2026-09-10', 1.086, 29, 41, 2),
    observation('obs-a4', SEED_IDS.pondA, '2026-09-22', 1.108, 26, 39, 3),
    observation('obs-b1', SEED_IDS.pondB, '2026-08-22', 1.112, 27, 40, 2),
    observation('obs-b2', SEED_IDS.pondB, '2026-09-02', 1.14, 29, 38, 3),
    observation('obs-b3', SEED_IDS.pondB, '2026-09-14', 1.168, 28, 36, 2),
    observation('obs-c1', SEED_IDS.pondC, '2026-08-25', 1.195, 26, 35, 1),
    observation('obs-c2', SEED_IDS.pondC, '2026-09-05', 1.222, 27, 33, 2),
    observation('obs-c3', SEED_IDS.pondC, '2026-09-18', 1.248, 25, 31, 2),
    // 计划走水日的日报已作废（蒸发皿复测），对应走水被挂起
    observation('obs-c4', SEED_IDS.pondC, '2026-10-10', 1.254, 24, 30, 2, { voided: true }),
    observation('obs-d2', SEED_IDS.pondD, '2026-09-01', 1.055, 31, 48, 3),
    observation('obs-d3', SEED_IDS.pondD, '2026-09-12', 1.074, 29, 46, 2),
    observation('obs-d4', SEED_IDS.pondD, '2026-09-24', 1.092, 27, 44, 3),
    observation('obs-d5', SEED_IDS.pondD, '2026-10-04', 1.101, 26, 43, 3),
    observation('obs-e1', SEED_IDS.pondE, '2026-08-24', 1.12, 28, 38, 2),
    observation('obs-e2', SEED_IDS.pondE, '2026-09-04', 1.146, 29, 36, 2),
    // 当日日报出成，但蒸发皿读数还没出：走水先挂起等读数
    observation('obs-a5', SEED_IDS.pondA, '2026-10-02', 1.112, 25, 38, 3, { missingPan: true }),
  ];

  // ---------------- 离子组分分析（含达标 / 接近 / 未达标三种判定） ----------------
  const assays: Assay[] = [
    assay('assay-a1', SEED_IDS.pondA, '2026-09-22', 0.12, 6.4, 42.5, 88.2, '盐湖中心化验室'),
    assay('assay-b1', SEED_IDS.pondB, '2026-09-14', 0.72, 15.5, 21.8, 58.4, '盐湖中心化验室'),
    assay('assay-c1', SEED_IDS.pondC, '2026-09-05', 1.05, 18.2, 9.6, 26.1, '盐湖中心化验室'),
    assay('assay-c2', SEED_IDS.pondC, '2026-09-18', 1.32, 22.6, 8.4, 24.3, '盐湖中心化验室'),
    assay('assay-d1', SEED_IDS.pondD, '2026-09-24', 0.08, 4.2, 48.9, 96.5, '南部化验站'),
    assay('assay-e1', SEED_IDS.pondE, '2026-09-04', 0.48, 13.6, 24.2, 61.7, '南部化验站', {
      verdict: '接近',
      verdictManual: true,
    }),
  ];

  // ---------------- 走水编排（覆盖各状态，orderIndex 决定先后） ----------------
  const schedules: Schedule[] = [
    // 当日日报缺蒸发皿读数：已挂起，原状态「已排」，等读数后恢复并重算
    schedule('schedule-a1', SEED_IDS.pondA, '2026-10-02', 1.115, 1200, '韩江', '挂起', 1, {
      stateBeforeHold: '已排',
      holdReason: '日报缺蒸发皿读数',
      reconcileStatus: '待读数',
    }),
    schedule('schedule-d1', SEED_IDS.pondD, '2026-10-04', 1.098, 1600, '王锐', '已排', 2, {
      reconcileStatus: '已对账',
      basisReportId: 'obs-d5',
    }),
    // 已经在走水：即便依据日报变化也照旧留着，不重算
    schedule('schedule-b1', SEED_IDS.pondB, '2026-10-06', 1.175, 900, '韩江', '走水中', 3),
    schedule('schedule-c1', SEED_IDS.pondC, '2026-10-12', 1.255, 600, '李文', '待排', 4),
    // 当日日报作废（蒸发皿复测）：已挂起，复测读数补回后恢复
    schedule('schedule-c2', SEED_IDS.pondC, '2026-10-10', 1.252, 560, '李文', '挂起', 5, {
      stateBeforeHold: '待排',
      holdReason: '当日日报已作废',
      reconcileStatus: '日报作废',
    }),
    schedule('schedule-e1', SEED_IDS.pondE, '2026-09-28', 1.15, 700, '王锐', '已出卤', 6),
  ];

  await db.transaction('rw', db.ponds, db.gates, db.observations, db.assays, db.schedules, async () => {
    await db.ponds.bulkPut(ponds);
    await db.gates.bulkPut(gates);
    await db.observations.bulkPut(observations);
    await db.assays.bulkPut(assays);
    await db.schedules.bulkPut(schedules);
  });
}
