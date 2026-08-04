/**
 * ============================================================
 * ui-controller.js — 화면(UI) 제어 로직
 * ------------------------------------------------------------
 * 이 파일은 DOM 렌더링과 이벤트 처리만 담당합니다.
 *  - 실제 계산(수요계획/공급계획/물류/MRP 등)은 전혀 하지 않고,
 *    전부 planning-engine.js 의 PlanningEngine.xxx() 함수를 호출합니다.
 *  - 이 파일이 하는 일: 입력값 읽기(gatherMasterData) →
 *    PlanningEngine 호출 → 결과를 테이블/차트/문구로 그리기(render*)
 * ============================================================
 */

const WEEKS = 6; // 플래닝 호라이즌(주). 화면 전체에서 공통으로 사용.

// 파이프라인 상단에 표시할 7개 스텝 정의 (라벨/부제만 담당하는 화면용 메타데이터)
const stationDefs = [
  { label: '기준정보', sub: 'MASTER DATA' },
  { label: '수요계획', sub: 'DEMAND PLAN' },
  { label: '공급계획', sub: 'SUPPLY PLAN' },
  { label: '생산계획', sub: 'PRODUCTION' },
  { label: '자재소요계획', sub: 'MRP' },
  { label: '물류계획', sub: 'LOGISTICS' },
  { label: 'S&OP 보고서', sub: 'REPORT' },
];

/* ------------------------------------------------------------
 * 1. 파이프라인 스텝퍼 & 패널 전환
 * ---------------------------------------------------------- */

function buildPipeline() {
  const pipe = document.getElementById('pipeline');
  pipe.innerHTML = '';
  stationDefs.forEach((s, i) => {
    const st = document.createElement('div');
    st.className = 'station' + (i === 0 ? ' active' : '');
    st.id = 'station-' + i;
    st.innerHTML = `<div class="num">STEP ${String(i + 1).padStart(2, '0')}</div><div class="label">${s.label}</div><div class="sub">${s.sub}</div>`;
    st.onclick = () => showPanel(i);
    pipe.appendChild(st);
    if (i < stationDefs.length - 1) {
      const p = document.createElement('div');
      p.className = 'pipe';
      pipe.appendChild(p);
    }
  });
}

function showPanel(i) {
  for (let j = 0; j < stationDefs.length; j++) {
    document.getElementById('panel-' + j).classList.toggle('show', j === i);
    document.getElementById('station-' + j).classList.toggle('active', j === i);
  }
}

/* ------------------------------------------------------------
 * 2. 기준정보 입력폼 보조 (주차별 수요예측/조정계수 입력칸 생성)
 * ---------------------------------------------------------- */

function buildForecastInputs() {
  const box = document.getElementById('forecast-inputs');
  const adjBox = document.getElementById('adj-inputs');
  box.innerHTML = '';
  adjBox.innerHTML = '';
  const sample = [400, 420, 430, 440, 410, 400];
  for (let w = 0; w < WEEKS; w++) {
    const f = document.createElement('div');
    f.className = 'field';
    f.innerHTML = `<label>W${w + 1}</label><input type="number" id="fc-${w}" value="${sample[w]}">`;
    box.appendChild(f);
    const a = document.createElement('div');
    a.className = 'field';
    a.innerHTML = `<label>W${w + 1}</label><input type="number" id="adj-${w}" value="100">`;
    adjBox.appendChild(a);
  }
  document.getElementById('hrz-label').textContent = WEEKS + ' WEEKS';
}

/** 입력폼에 데모용 샘플값을 채우고 즉시 재계산합니다. */
function loadSample() {
  buildForecastInputs();
  const set = (id, v) => { document.getElementById(id).value = v; };
  set('m-cust', 'A유통');
  set('m-fg', '완제품1'); set('m-fgstock0', 400); set('m-fgwip', 400); set('m-fgsafety', 150); set('m-fglot', 100);
  set('m-fgyield', 96); set('m-fgcost', 8500); set('m-fgprice', 14000);
  set('m-sfg', '반제품A'); set('m-sfgstock0', 150); set('m-sfgsafety', 100); set('m-sfglot', 120); set('m-sfgcost', 4200); set('m-sfgyield', 98);
  set('m-dc1name', '수도권 물류센터'); set('m-dc1ratio', 60); set('m-dc1capa', 220); set('m-dc1stock0', 120); set('m-dc1safety', 80); set('m-dc1lt', 2);
  set('m-dc2name', '영남권 물류센터'); set('m-dc2capa', 180); set('m-dc2stock0', 80); set('m-dc2safety', 60); set('m-dc2lt', 4);
  set('m-rm', '원자재A'); set('m-rmstock0', 1200); set('m-rmlt', 9); set('m-rmcost', 1800);
  set('m-bom-sfg', 1); set('m-bom-rm', 2);
  set('m-factory', '1공장');
  set('m-fgline', '완제품 조립라인'); set('m-fgequip', '자동포장기 L1'); set('m-fgroute', '조립 → 검사 → 포장');
  set('m-fgcapa', 420); set('m-fglt', 4); set('m-fghours', 40); set('m-fgtime', 4.5);
  set('m-sfgline', '반제품 성형라인'); set('m-sfgequip', '믹서/성형기 M1'); set('m-sfgroute', '혼합 → 성형 → 건조');
  set('m-sfgcapa', 360); set('m-sfglt', 3); set('m-sfghours', 40); set('m-sfgtime', 6);
  runAll();
}

/* ------------------------------------------------------------
 * 3. 입력값 읽기 유틸 + 기준정보(M) 수집
 * ---------------------------------------------------------- */

function num(id) { return parseFloat(document.getElementById(id).value) || 0; }
function txt(id) { return document.getElementById(id).value; }

/**
 * 화면의 모든 입력값을 읽어 하나의 기준정보 객체(M)로 모읍니다.
 * 이 객체는 PlanningEngine.computeDistributionPlan()/computeMRPCascade() 등에 그대로 전달됩니다.
 * (DOM을 읽는 유일한 지점 — 계산 로직 쪽에는 DOM 접근이 전혀 없습니다)
 */
function gatherMasterData() {
  return {
    cust: txt('m-cust'),
    fg: txt('m-fg'), fgStock0: num('m-fgstock0'), fgWip: num('m-fgwip'), fgSafety: num('m-fgsafety'), fgLot: num('m-fglot') || 1,
    fgYield: num('m-fgyield') / 100, fgCost: num('m-fgcost'), fgPrice: num('m-fgprice'),
    sfg: txt('m-sfg'), sfgStock0: num('m-sfgstock0'), sfgSafety: num('m-sfgsafety'), sfgLot: num('m-sfglot') || 1, sfgYield: num('m-sfgyield') / 100, sfgCost: num('m-sfgcost'),
    dc1: txt('m-dc1name'), dc1Ratio: num('m-dc1ratio'), dc1Capa: num('m-dc1capa'), dc1Stock0: num('m-dc1stock0'), dc1Safety: num('m-dc1safety'), dc1LtDays: num('m-dc1lt'),
    dc2: txt('m-dc2name'), dc2Capa: num('m-dc2capa'), dc2Stock0: num('m-dc2stock0'), dc2Safety: num('m-dc2safety'), dc2LtDays: num('m-dc2lt'),
    rm: txt('m-rm'), rmStock0: num('m-rmstock0'), rmCost: num('m-rmcost'), rmLtDays: num('m-rmlt'),
    bomSfg: num('m-bom-sfg'), bomRm: num('m-bom-rm'),
    factory: txt('m-factory'),
    fgLine: txt('m-fgline'), fgEquip: txt('m-fgequip'), fgRoute: txt('m-fgroute'), fgCapa: num('m-fgcapa'), fgLtDays: num('m-fglt'), fgHours: num('m-fghours'), fgTime: num('m-fgtime'),
    sfgLine: txt('m-sfgline'), sfgEquip: txt('m-sfgequip'), sfgRoute: txt('m-sfgroute'), sfgCapa: num('m-sfgcapa'), sfgLtDays: num('m-sfglt'), sfgHours: num('m-sfghours'), sfgTime: num('m-sfgtime'),
  };
}

/* ------------------------------------------------------------
 * 4. 메인 실행 함수 — "▶ 전체 계산 실행" 버튼이 호출
 *    입력값 수집 → PlanningEngine 호출 → 결과를 화면에 렌더링
 * ---------------------------------------------------------- */

function runAll() {
  const M = gatherMasterData();

  const forecast = [], adj = [];
  for (let w = 0; w < WEEKS; w++) {
    forecast.push(num('fc-' + w));
    adj.push(num('adj-' + w) / 100);
  }

  // ---- 계산은 전부 PlanningEngine(백로직)에 위임 ----
  const demandPlan = PlanningEngine.computeDemandPlan(forecast, adj, WEEKS);
  const { supplyPlan, supplyGap, invAfterSupply } = PlanningEngine.computeSupplyPlan(demandPlan, M.fgStock0, M.fgCapa, WEEKS);
  const dist = PlanningEngine.computeDistributionPlan(M, demandPlan, WEEKS);
  const mrp = PlanningEngine.computeMRPCascade(M, dist.grFG, WEEKS);
  const metrics = PlanningEngine.computeReportMetrics(M, demandPlan, supplyPlan, mrp.planFG, mrp.planSFG, dist.planDC1, dist.planDC2);

  // ---- 결과를 화면에 렌더링 ----
  renderRouting(M, mrp.LT_FG, mrp.LT_SFG, mrp.LT_RM, dist.LT_DC1, dist.LT_DC2);
  renderDemandPlan(forecast, adj, demandPlan);
  renderSupplyPlan(demandPlan, supplyPlan, supplyGap, invAfterSupply, M);
  renderProductionPlan(M, mrp.planFG, mrp.utilFG, mrp.LT_FG);
  renderMRP(M, mrp.planSFG, mrp.planRM, mrp.utilSFG, mrp.LT_SFG, mrp.LT_RM);
  renderLogistics(M, dist.planDC1, dist.planDC2, dist.LT_DC1, dist.LT_DC2);
  renderReport(M, demandPlan, supplyPlan, mrp.planFG, mrp.planSFG, dist.planDC1, dist.planDC2, metrics);

  alert('전체 계산 완료');
}

/* ------------------------------------------------------------
 * 5. 렌더링 함수들 — 오직 화면 그리기만 담당 (계산 없음)
 * ---------------------------------------------------------- */

function weekHeaders() {
  let h = '<tr><th>구분</th>';
  for (let w = 0; w < WEEKS; w++) h += `<th>W${w + 1}</th>`;
  return h + '</tr>';
}

/** 생산/물류 라우팅(공장 › 라인 › 설비 › 공정, 물류센터) 다이어그램 렌더링 */
function renderRouting(M, LT_FG, LT_SFG, LT_RM, LT_DC1, LT_DC2) {
  const mk = (title, name, sub) => `<div class="rnode"><div class="rtitle">${title}</div><div class="rmain">${name}</div><div class="rsub">${sub}</div></div>`;
  const arrow = `<div class="rarrow">→</div>`;

  document.getElementById('routing-sfg').innerHTML =
    mk('공장', M.factory, '') + arrow +
    mk('반제품 라인', M.sfgLine, '설비: ' + M.sfgEquip) + arrow +
    mk('공정순서', M.sfgRoute, 'Capa ' + M.sfgCapa.toLocaleString() + 'EA/주 · LT ' + LT_SFG + '주') + arrow +
    mk('산출', M.sfg, 'BOM: RM×' + M.bomRm + '/EA');

  document.getElementById('routing-fg').innerHTML =
    mk('공장', M.factory, '') + arrow +
    mk('완제품 라인', M.fgLine, '설비: ' + M.fgEquip) + arrow +
    mk('공정순서', M.fgRoute, 'Capa ' + M.fgCapa.toLocaleString() + 'EA/주 · LT ' + LT_FG + '주') + arrow +
    mk('산출', M.fg, 'BOM: ' + M.sfg + '×' + M.bomSfg + '/EA');

  document.getElementById('routing-dc').innerHTML =
    mk('완제품 창고', M.fg, '공장 완성품 재고') + arrow +
    mk('운송(거점1)', M.dc1, 'Capa ' + M.dc1Capa.toLocaleString() + 'EA/주 · LT ' + LT_DC1 + '주') + arrow +
    mk('운송(거점2)', M.dc2, 'Capa ' + M.dc2Capa.toLocaleString() + 'EA/주 · LT ' + LT_DC2 + '주') + arrow +
    mk('산출', '고객 배송', '거점별 재고로 수요 충족');

  document.getElementById('route-desc-fg').textContent = `${M.factory} > ${M.fgLine}(${M.fgEquip}) 기준 생산 라우팅입니다.`;
  document.getElementById('lt-note-fg').textContent =
    `완제품 생산 리드타임 ${M.fgLtDays}일(${LT_FG}주)이 착수 시점 계산에 반영됩니다. 총소요량(GR)은 물류계획 단계에서 두 거점의 공장 출하지시 물량을 합산한 값입니다. 호라이즌 시작 이전으로 밀려나는 착수 물량은 W1에 긴급 반영되고 "리드타임 부족"으로 표시됩니다.`;
  document.getElementById('lt-note-sfgrm').textContent =
    `반제품 생산 리드타임 ${M.sfgLtDays}일(${LT_SFG}주), 원자재 조달 리드타임 ${M.rmLtDays}일(${LT_RM}주)이 각각의 착수/발주 시점 계산에 반영됩니다.`;
  document.getElementById('lt-note-dc').textContent =
    `거점1(${M.dc1}) 이동 리드타임 ${M.dc1LtDays}일(${LT_DC1}주), 거점2(${M.dc2}) 이동 리드타임 ${M.dc2LtDays}일(${LT_DC2}주)이 각 거점의 공장 출하지시 시점 계산에 반영됩니다.`;
}

function renderDemandPlan(forecast, adj, demandPlan) {
  let html = weekHeaders();
  html += '<tr><td>수요예측(입력)</td>' + forecast.map((v) => `<td>${v.toLocaleString()}</td>`).join('') + '</tr>';
  html += '<tr><td>조정계수(%)</td>' + adj.map((v) => `<td>${Math.round(v * 100)}</td>`).join('') + '</tr>';
  html += '<tr><td><b>수요계획(EA)</b></td>' + demandPlan.map((v) => `<td><b>${v.toLocaleString()}</b></td>`).join('') + '</tr>';
  document.getElementById('tbl-demandplan').innerHTML = html;
}

function renderSupplyPlan(demandPlan, supplyPlan, supplyGap, inv, M) {
  let html = weekHeaders();
  html += '<tr><td>수요계획(EA)</td>' + demandPlan.map((v) => `<td>${v.toLocaleString()}</td>`).join('') + '</tr>';
  html += '<tr><td>완제품 라인 Capa(EA)</td>' + demandPlan.map(() => `<td>${M.fgCapa.toLocaleString()}</td>`).join('') + '</tr>';
  html += '<tr><td><b>공급계획(EA)</b></td>' + supplyPlan.map((v) => `<td><b>${v.toLocaleString()}</b></td>`).join('') + '</tr>';
  html += '<tr><td>Gap(부족)</td>' + supplyGap.map((v) => `<td style="color:${v > 0 ? 'var(--coral)' : 'var(--ink-dim)'}">${v > 0 ? '-' + v.toLocaleString() : '0'}</td>`).join('') + '</tr>';
  html += '<tr><td>기말재고(EA)</td>' + inv.map((v) => `<td>${v.toLocaleString()}</td>`).join('') + '</tr>';
  document.getElementById('tbl-supplyplan').innerHTML = html;
}

function renderProductionPlan(M, planFG, utilFG, LT_FG) {
  let html = weekHeaders();
  html += '<tr><td>총소요량(GR, 거점 출하지시 합산)</td>' + planFG.GR.map((v) => `<td>${v.toLocaleString()}</td>`).join('') + '</tr>';
  html += '<tr><td>순소요량(NR)</td>' + planFG.NR.map((v) => `<td>${v.toLocaleString()}</td>`).join('') + '</tr>';
  html += '<tr><td><b>계획입고량(완성시점)</b></td>' + planFG.PORcpt.map((v) => `<td><b>${v.output.toLocaleString()}</b></td>`).join('') + '</tr>';
  html += '<tr><td><b>계획착수량(생산개시, LT ' + LT_FG + '주 오프셋)</b></td>' + planFG.release.map((v, i) => `<td style="color:${planFG.capaFlag[i] ? 'var(--coral)' : 'var(--ink)'}"><b>${v.toLocaleString()}</b>${planFG.capaFlag[i] ? ' <span class="badge" style="color:var(--coral)">CAPA초과</span>' : ''}${planFG.lateFlag[i] ? ' <span class="badge" style="color:var(--amber)">긴급착수</span>' : ''}</td>`).join('') + '</tr>';
  html += '<tr><td>라인 가동률(%)</td>' + utilFG.map((v) => `<td style="color:${v > 100 ? 'var(--coral)' : 'var(--ink-dim)'}">${v}%</td>`).join('') + '</tr>';
  html += '<tr><td>기말 완제품재고(EA)</td>' + planFG.POH.map((v) => `<td style="color:${v < M.fgSafety ? 'var(--coral)' : 'var(--ink)'}">${v.toLocaleString()}</td>`).join('') + '</tr>';
  document.getElementById('tbl-productionplan').innerHTML = html;
}

function renderMRP(M, planSFG, planRM, utilSFG, LT_SFG, LT_RM) {
  let html = weekHeaders();
  html += `<tr><td colspan="${WEEKS + 1}" style="text-align:left;color:var(--amber);font-family:var(--font-display);font-size:11px;border:none;padding-top:12px;">▸ ${M.sfg} (반제품, LT ${LT_SFG}주)</td></tr>`;
  html += '<tr><td>총소요량(GR, 완제품 착수 기준)</td>' + planSFG.GR.map((v) => `<td>${v.toLocaleString()}</td>`).join('') + '</tr>';
  html += '<tr><td>순소요량(NR)</td>' + planSFG.NR.map((v) => `<td>${v.toLocaleString()}</td>`).join('') + '</tr>';
  html += '<tr><td><b>계획입고량</b></td>' + planSFG.PORcpt.map((v) => `<td><b>${v.output.toLocaleString()}</b></td>`).join('') + '</tr>';
  html += '<tr><td><b>계획착수량(LT 오프셋)</b></td>' + planSFG.release.map((v, i) => `<td style="color:${planSFG.capaFlag[i] ? 'var(--coral)' : 'var(--ink)'}"><b>${v.toLocaleString()}</b>${planSFG.capaFlag[i] ? ' <span class="badge" style="color:var(--coral)">CAPA초과</span>' : ''}${planSFG.lateFlag[i] ? ' <span class="badge" style="color:var(--amber)">긴급착수</span>' : ''}</td>`).join('') + '</tr>';
  html += '<tr><td>라인 가동률(%)</td>' + utilSFG.map((v) => `<td style="color:${v > 100 ? 'var(--coral)' : 'var(--ink-dim)'}">${v}%</td>`).join('') + '</tr>';
  html += '<tr><td>기말 반제품재고(EA)</td>' + planSFG.POH.map((v) => `<td>${v.toLocaleString()}</td>`).join('') + '</tr>';

  html += `<tr><td colspan="${WEEKS + 1}" style="text-align:left;color:var(--amber);font-family:var(--font-display);font-size:11px;border:none;padding-top:12px;">▸ ${M.rm} (원자재, LT ${LT_RM}주)</td></tr>`;
  html += '<tr><td>총소요량(GR, 반제품 착수 기준)</td>' + planRM.GR.map((v) => `<td>${v.toLocaleString()}</td>`).join('') + '</tr>';
  html += '<tr><td>순소요량(NR)</td>' + planRM.NR.map((v) => `<td>${v.toLocaleString()}</td>`).join('') + '</tr>';
  html += '<tr><td><b>계획발주량(LT 오프셋)</b></td>' + planRM.release.map((v, i) => `<td><b>${v.toLocaleString()}</b>${planRM.lateFlag[i] ? ' <span class="badge" style="color:var(--amber)">긴급발주</span>' : ''}</td>`).join('') + '</tr>';
  html += '<tr><td>기말 원자재재고</td>' + planRM.POH.map((v) => `<td style="color:${v < 0 ? 'var(--coral)' : 'var(--ink)'}">${v.toLocaleString()}</td>`).join('') + '</tr>';
  document.getElementById('tbl-mrp').innerHTML = html;
}

/** 물류센터(거점) 2개소의 배분수요 → 거점입고 → 공장 출하지시 → 거점재고를 렌더링 */
function renderLogistics(M, planDC1, planDC2, LT_DC1, LT_DC2) {
  const block = (name, plan, lt, safety) => {
    let html = `<tr><td colspan="${WEEKS + 1}" style="text-align:left;color:var(--amber);font-family:var(--font-display);font-size:11px;border:none;padding-top:12px;">▸ ${name} (물류센터, LT ${lt}주)</td></tr>`;
    html += '<tr><td>총소요량(GR, 거점 배분수요)</td>' + plan.GR.map((v) => `<td>${v.toLocaleString()}</td>`).join('') + '</tr>';
    html += '<tr><td>순소요량(NR)</td>' + plan.NR.map((v) => `<td>${v.toLocaleString()}</td>`).join('') + '</tr>';
    html += '<tr><td><b>거점입고량</b></td>' + plan.PORcpt.map((v) => `<td><b>${v.output.toLocaleString()}</b></td>`).join('') + '</tr>';
    html += '<tr><td><b>공장 출하지시(LT 오프셋)</b></td>' + plan.release.map((v, i) => `<td style="color:${plan.capaFlag[i] ? 'var(--coral)' : 'var(--ink)'}"><b>${v.toLocaleString()}</b>${plan.capaFlag[i] ? ' <span class="badge" style="color:var(--coral)">CAPA초과</span>' : ''}${plan.lateFlag[i] ? ' <span class="badge" style="color:var(--amber)">긴급출하</span>' : ''}</td>`).join('') + '</tr>';
    html += '<tr><td>기말 거점재고(EA)</td>' + plan.POH.map((v) => `<td style="color:${v < safety ? 'var(--coral)' : 'var(--ink)'}">${v.toLocaleString()}</td>`).join('') + '</tr>';
    return html;
  };
  let html = weekHeaders();
  html += block(M.dc1, planDC1, LT_DC1, M.dc1Safety);
  html += block(M.dc2, planDC2, LT_DC2, M.dc2Safety);
  document.getElementById('tbl-logistics').innerHTML = html;
}

/** KPI 카드, 3종 차트, 리스크 코멘트, 손익 테이블을 한 번에 그립니다. */
function renderReport(M, demandPlan, supplyPlan, planFG, planSFG, planDC1, planDC2, metrics) {
  document.getElementById('sop-scope').textContent =
    `${M.cust} × ${M.fg} 기준, ${WEEKS}주 플래닝 호라이즌 — 원자재→반제품→완제품 2단계 BOM, 물류센터 2개소(${M.dc1}/${M.dc2}), 리드타임 오프셋을 반영한 시계열 MRP 결과를 종합한 자동 생성 리포트입니다.`;

  // ---- KPI 카드 ----
  const kpis = [
    { label: '충족률(Fill Rate, ATP)', val: metrics.fillRate + '%', cls: metrics.fillRate >= 98 ? 'good' : (metrics.fillRate < 90 ? 'risk' : '') },
    { label: 'Capa 초과 발생(완제품+반제품)', val: metrics.capaWeeks + ' 회', cls: metrics.capaWeeks > 0 ? 'risk' : 'good' },
    { label: '운송 Capa 초과 발생(거점1+거점2)', val: metrics.dcCapaWeeks + ' 회', cls: metrics.dcCapaWeeks > 0 ? 'risk' : 'good' },
    { label: '리드타임 부족(긴급착수) 발생', val: metrics.lateWeeks + ' 회', cls: metrics.lateWeeks > 0 ? 'risk' : 'good' },
    { label: '최저 완제품 기말재고', val: metrics.minInv.toLocaleString() + ' EA', cls: metrics.minInv < M.fgSafety ? 'risk' : 'good' },
  ];
  document.getElementById('kpi-row').innerHTML = kpis.map((k) =>
    `<div class="kpi ${k.cls}"><div class="v">${k.val}</div><div class="l">${k.label}</div></div>`
  ).join('');

  // ---- 차트 1: 수요 vs 공급 Gap ----
  const maxV = Math.max(...demandPlan, ...supplyPlan, 1);
  document.getElementById('chart-gap').innerHTML = demandPlan.map((d, i) => {
    const sH = Math.max(2, supplyPlan[i] / maxV * 110);
    const dH = Math.max(2, d / maxV * 110);
    return `<div class="bargrp"><div style="position:relative;width:100%;height:100%;display:flex;align-items:flex-end;justify-content:center;">
      <div class="bar" style="height:${sH}px;"></div>
      <div class="bar" style="height:${dH}px;position:absolute;bottom:0;width:70%;background:transparent;border:1px dashed var(--amber);"></div>
    </div><div class="barlabel">W${i + 1}</div></div>`;
  }).join('');

  // ---- 차트 2: 완제품 기말재고 추이 ----
  const maxInv = Math.max(...planFG.POH, M.fgSafety, 1);
  document.getElementById('chart-inv').innerHTML = planFG.POH.map((v, i) => {
    const h = Math.max(2, Math.abs(v) / maxInv * 110);
    const below = v < M.fgSafety;
    return `<div class="bargrp"><div class="bar" style="height:${h}px;background:${below ? 'var(--coral)' : 'var(--teal)'};"></div><div class="barlabel">W${i + 1}</div></div>`;
  }).join('');

  // ---- 차트 3: 완제품/반제품 착수 물량 (리드타임 오프셋 반영 결과 시각화) ----
  const maxRel = Math.max(...planFG.release, ...planSFG.release, 1);
  document.getElementById('chart-release').innerHTML = planFG.release.map((v, i) => {
    const h1 = Math.max(2, v / maxRel * 110);
    const h2 = Math.max(2, planSFG.release[i] / maxRel * 110);
    return `<div class="bargrp"><div style="display:flex;gap:4px;align-items:flex-end;height:100%;">
      <div class="bar" style="width:16px;height:${h1}px;background:var(--amber);"></div>
      <div class="bar" style="width:16px;height:${h2}px;background:var(--teal);"></div>
    </div><div class="barlabel">W${i + 1}</div></div>`;
  }).join('');

  // ---- 리스크 코멘트(규칙 기반 자동 생성 문구) ----
  let comments = [];
  if (metrics.capaWeeks > 0) {
    const fgW = planFG.capaFlag.map((f, i) => (f ? 'W' + (i + 1) : null)).filter(Boolean).join(', ');
    const sfgW = planSFG.capaFlag.map((f, i) => (f ? 'W' + (i + 1) : null)).filter(Boolean).join(', ');
    let s = `<b style="color:var(--coral)">Capa 초과:</b> `;
    if (fgW) s += `완제품 라인 착수 ${fgW}주차`;
    if (fgW && sfgW) s += ', ';
    if (sfgW) s += `반제품 라인 착수 ${sfgW}주차`;
    s += ` 물량이 주간 Capa를 초과합니다. 잔업/외주 또는 설비 증설을 검토하세요.`;
    comments.push(s);
  }
  if (metrics.dcCapaWeeks > 0) {
    const dc1W = planDC1.capaFlag.map((f, i) => (f ? 'W' + (i + 1) : null)).filter(Boolean).join(', ');
    const dc2W = planDC2.capaFlag.map((f, i) => (f ? 'W' + (i + 1) : null)).filter(Boolean).join(', ');
    let s = `<b style="color:var(--coral)">운송 Capa 초과:</b> `;
    if (dc1W) s += `${M.dc1} 출하지시 ${dc1W}주차`;
    if (dc1W && dc2W) s += ', ';
    if (dc2W) s += `${M.dc2} 출하지시 ${dc2W}주차`;
    s += ` 물량이 이동 Capa를 초과합니다. 배차 증편 또는 거점 배분비율 조정을 검토하세요.`;
    comments.push(s);
  }
  if (metrics.lateWeeks > 0) {
    comments.push(`<b style="color:var(--amber)">리드타임 부족:</b> 일부 물량은 필요한 착수 시점이 플래닝 호라이즌 시작 이전이라, W1에 긴급 반영되었습니다. 이는 현재 리드타임 대비 호라이즌 시작 시점의 사전 재고/발주가 부족함을 의미합니다.`);
  }
  if (metrics.minInv < M.fgSafety) {
    comments.push(`<b style="color:var(--coral)">재고 위험:</b> 최저 완제품 기말재고(${metrics.minInv.toLocaleString()}EA)가 안전재고(${M.fgSafety.toLocaleString()}EA)를 하회합니다.`);
  }
  if (metrics.fillRate < 100) {
    comments.push(`<b>수요충족률(ATP) ${metrics.fillRate}%</b> — 총 수요 ${metrics.totalDemand.toLocaleString()}EA 중 ${metrics.totalSupply.toLocaleString()}EA만 즉시 공급 가능합니다.`);
  }
  if (comments.length === 0) {
    comments.push(`<b style="color:var(--teal)">정상:</b> 전 구간 Capa·리드타임·재고 제약 없이 계획이 성립합니다.`);
  }
  const isRisk = !(comments.length === 1 && comments[0].includes('정상'));
  document.getElementById('risk-comment').innerHTML = comments.map((c) => `<p style="margin:0 0 10px;">${c}</p>`).join('') +
    (isRisk ? `<span class="stamp">RISK DETECTED</span>` : `<span class="stamp safe">PLAN OK</span>`);

  // ---- 손익 요약 테이블 ----
  document.getElementById('tbl-pl').innerHTML = `
    <tr><td>총 공급수량(ATP) 기준 매출 추정</td><td>${metrics.revenue.toLocaleString()} 원</td></tr>
    <tr><td>총 완제품 계획입고 투입수량 기준 원가</td><td>${metrics.cogs.toLocaleString()} 원</td></tr>
    <tr><td><b>추정 매출총이익</b></td><td><b style="color:${metrics.margin >= 0 ? 'var(--teal)' : 'var(--coral)'}">${metrics.margin.toLocaleString()} 원 (${metrics.marginPct}%)</b></td></tr>
  `;
}

/* ------------------------------------------------------------
 * 6. 초기 구동
 * ---------------------------------------------------------- */
buildPipeline();
buildForecastInputs();
loadSample();     // 샘플값 채우기 + 첫 계산 실행
showPanel(0);
