/**
 * ============================================================
 * planning-engine.js — S&OP / MRP 계산 백로직
 * ------------------------------------------------------------
 * 이 파일은 순수 계산 로직만 담당합니다.
 *  - DOM을 읽거나(document.getElementById 등) 쓰지 않습니다.
 *  - 화면 렌더링과 관련된 코드는 전혀 포함하지 않습니다.
 *  - 모든 함수는 "입력값 → 결과값"만 반환하는 순수 함수입니다.
 *
 * 화면(UI)에서는 js/ui-controller.js 가 이 파일의 함수들을
 * PlanningEngine.xxx(...) 형태로 호출해서 계산 결과를 받아
 * 테이블/차트로 그리는 역할만 담당합니다.
 *
 * 계산 흐름:
 *   1) computeDemandPlan   : 수요예측 → 수요계획
 *   2) computeSupplyPlan   : 수요계획 → 공급계획(ATP)
 *   3) computeMRPCascade   : 완제품 → 반제품 → 원자재 2단계 MRP
 *                            (생산/조달 리드타임 오프셋 반영)
 *   4) computeReportMetrics: 위 결과를 종합한 S&OP 리포트 지표
 * ============================================================
 */
const PlanningEngine = (function () {

  /**
   * 일(day) 단위 리드타임을 주(week) 단위 오프셋으로 변환합니다.
   * 예: 9일 리드타임 → ceil(9/7) = 2주 앞당겨 착수해야 함.
   * 0일이면 0주(오프셋 없음, 당해 주차 즉시 처리 가능하다고 간주).
   */
  function ltWeeks(days) {
    return Math.max(0, Math.ceil(days / 7));
  }

  /**
   * 표준 "시계열 MRP 레코드"(Time-Phased MRP Record) 전개.
   * 실제 APS/MRP 시스템의 넷팅(Netting) 로직과 동일한 방식입니다.
   *
   * 매 주(w)마다:
   *   총소요량(GR)      : 이 품목이 그 주에 필요한 수량(상위 품목의 종속수요 또는 독립수요)
   *   순소요량(NR)      : GR + 안전재고 - 기초가용재고(POH, 이전 주 기말재고) 를 넘는 부족분
   *   계획입고량(PORcpt): 순소요량을 로트사이즈 단위로 올림한, "그 주에 완성/입고되어야 하는 수량"
   *   기말재고(POH)     : 이전 재고 + 계획입고 - 총소요량
   *
   * 그리고 리드타임(lt, 주 단위)만큼 "계획착수량(release)"을 앞당깁니다.
   *   계획착수 시점 = 계획입고 시점(w) - 리드타임(lt)
   * 즉, w주차에 완성되어야 하는 물량은 (w-lt)주차에 이미 착수(생산 시작/발주)되어 있어야 합니다.
   * 만약 그 착수 시점이 플래닝 호라이즌 시작(0주차) 이전이라면, 이미 리드타임을
   * 확보할 수 없는 상황이므로 0주차에 "긴급 착수"로 몰아넣고 lateFlag 로 표시합니다.
   *
   * @param {Object}   params
   * @param {number[]} params.GR      - 주별 총소요량 배열 (길이 = weeks)
   * @param {number}   params.safety  - 안전재고 수량
   * @param {number}   params.begin   - 기초재고(플래닝 시작 시점의 재고)
   * @param {number}   params.lot     - 로트사이즈(생산/발주 단위). 0 또는 미지정 시 1(로트 제약 없음)
   * @param {number}   params.lt      - 리드타임(주 단위, ltWeeks()로 변환된 값)
   * @param {?number}  params.capa    - 주간 가용 Capa(EA). null 이면 Capa 체크 생략(원자재 등)
   * @param {number}   params.yieldRate - 수율(0~1). 미지정 시 1(수율 손실 없음)
   * @param {number}   params.weeks   - 플래닝 호라이즌 주수
   *
   * @returns {Object} {
   *   GR        : 입력받은 총소요량 그대로 반환(참조용)
   *   NR        : 주별 순소요량
   *   PORcpt    : 주별 계획입고 {input, output} — input=투입(원료소요/Capa 산정 기준), output=수율반영 산출량
   *   POH       : 주별 기말 가용재고(Projected On Hand)
   *   release   : 주별 계획착수량(리드타임 오프셋 반영, 하위 품목의 종속수요로 전달됨)
   *   lateFlag  : 그 주 계획입고량 중, 리드타임을 확보하지 못해 긴급 착수된 경우 true
   *   capaFlag  : 그 주 착수(release) 물량이 라인 Capa를 초과하면 true (capa가 null이면 전부 false)
   * }
   */
  function planItem({ GR, safety, begin, lot, lt, capa, yieldRate, weeks }) {
    const rate = yieldRate || 1;
    const lotSize = lot || 1;

    let poh = begin;
    const NR = [];
    const PORcpt = [];
    const POH = [];

    for (let w = 0; w < weeks; w++) {
      // 1) 순소요량 = 이번 주 소요량 + 안전재고 - 이전 기말재고 (부족분만, 음수면 0)
      const nr = Math.max(0, GR[w] + safety - poh);
      NR.push(nr);

      // 2) 수율 손실을 감안해 필요한 "투입" 수량을 역산 (수율 96%면 100개 필요 시 104개 투입해야 함)
      const inputNeeded = rate < 1 ? nr / rate : nr;

      // 3) 로트사이즈 단위로 올림 → 계획입고(투입 기준)
      const rcptInput = nr > 0 ? Math.ceil(inputNeeded / lotSize) * lotSize : 0;

      // 4) 수율을 반영한 실제 산출량(양품 기준) — 재고에는 이 수량이 반영됨
      const rcptOutput = Math.round(rcptInput * rate);
      PORcpt.push({ input: rcptInput, output: rcptOutput });

      // 5) 기말재고 갱신
      poh = poh + rcptOutput - GR[w];
      POH.push(poh);
    }

    // ---- 리드타임만큼 착수 시점을 앞당김 ----
    const release = new Array(weeks).fill(0);
    const lateFlag = new Array(weeks).fill(false);
    for (let w = 0; w < weeks; w++) {
      if (PORcpt[w].input > 0) {
        const releaseWeek = w - lt;
        if (releaseWeek >= 0) {
          release[releaseWeek] += PORcpt[w].input;
        } else {
          // 호라이즌 시작 이전에 착수했어야 하는 물량 → 0주차로 몰아 긴급 처리, 플래그 표시
          release[0] += PORcpt[w].input;
          lateFlag[w] = true;
        }
      }
    }

    // ---- Capa 초과 여부 체크(착수 시점 기준) ----
    const capaFlag = capa != null ? release.map((v) => v > capa) : new Array(weeks).fill(false);

    return { GR, NR, PORcpt, POH, release, lateFlag, capaFlag };
  }

  /**
   * STEP 1. 수요계획 = 수요예측 × 주별 조정계수
   * (프로모션/트렌드 등 정성적 요인을 반영한 예측치 보정)
   */
  function computeDemandPlan(forecast, adjPct, weeks) {
    const demandPlan = [];
    for (let w = 0; w < weeks; w++) {
      demandPlan.push(Math.round(forecast[w] * adjPct[w]));
    }
    return demandPlan;
  }

  /**
   * STEP 2. 공급계획 (ATP, Available-To-Promise)
   * 리드타임을 고려하지 않고, "지금 당장 가용한 재고 + 이번 주 Capa"만으로
   * 얼마나 공급 가능한지 판단하는 단순 모델입니다.
   * (실제 리드타임 반영 확정 공급 능력은 STEP 3~4의 MRP 결과를 봐야 합니다.)
   */
  function computeSupplyPlan(demandPlan, fgStock0, fgCapa, weeks) {
    let runStock = fgStock0;
    const supplyPlan = [];
    const supplyGap = [];
    const invAfterSupply = [];
    for (let w = 0; w < weeks; w++) {
      const available = runStock + fgCapa;
      const supply = Math.min(demandPlan[w], available);
      supplyPlan.push(supply);
      supplyGap.push(demandPlan[w] - supply);
      runStock = available - supply;
      invAfterSupply.push(runStock);
    }
    return { supplyPlan, supplyGap, invAfterSupply };
  }

  /**
   * STEP 3~4. 완제품 → 반제품 → 원자재 2단계 MRP 캐스케이드.
   * 리드타임 오프셋이 실제 "주차 이동"으로 반영되는 핵심 로직입니다.
   *
   * 전개 순서:
   *  ① 고객 수요(demandPlan)를 물류 리드타임만큼 앞당겨
   *     "완제품 창고출고 필요 시점(GR_FG)"으로 환산
   *  ② 완제품 MRP 전개 → 계획착수량(release) 산출
   *  ③ 완제품 계획착수량 × BOM비율 = 반제품 총소요량(GR_SFG)
   *     (완제품이 "착수"하는 시점에 반제품이 실제로 소비되므로,
   *      반제품 종속수요는 완제품의 need 시점이 아니라 release 시점에 발생합니다)
   *  ④ 반제품 MRP 전개 → 계획착수량(release) 산출
   *  ⑤ 반제품 계획착수량 × BOM비율 = 원자재 총소요량(GR_RM)
   *  ⑥ 원자재 MRP 전개(Capa 개념 없음, 조달 리드타임만 적용)
   *
   * @param {Object} M - 기준정보(마스터데이터) 객체. ui-controller.js 의
   *                     gatherMasterData() 가 화면 입력값을 모아 만들어 전달합니다.
   * @param {number[]} demandPlan - STEP1에서 계산된 주별 수요계획
   * @param {number} weeks - 플래닝 호라이즌 주수
   * @returns {Object} { planFG, planSFG, planRM, utilFG, utilSFG,
   *                      LT_FG, LT_SFG, LT_RM, LT_LOGI, shipLateFlag }
   */
  function computeMRPCascade(M, demandPlan, weeks) {
    // 리드타임(일) → 리드타임(주) 오프셋으로 변환
    const LT_FG = ltWeeks(M.fgLtDays);
    const LT_SFG = ltWeeks(M.sfgLtDays);
    const LT_RM = ltWeeks(M.rmLtDays);
    const LT_LOGI = ltWeeks(M.logiLtDays);

    // ① 물류 리드타임만큼 앞당긴 완제품 총소요량(GR_FG)
    const grFG = new Array(weeks).fill(0);
    const shipLateFlag = new Array(weeks).fill(false);
    for (let w = 0; w < weeks; w++) {
      const needWeek = w - LT_LOGI;
      if (needWeek >= 0) {
        grFG[needWeek] += demandPlan[w];
      } else {
        grFG[0] += demandPlan[w];
        shipLateFlag[0] = true;
      }
    }

    // ② 완제품 MRP 전개
    const planFG = planItem({
      GR: grFG, safety: M.fgSafety, begin: M.fgStock0, lot: M.fgLot,
      lt: LT_FG, capa: M.fgCapa, yieldRate: M.fgYield, weeks,
    });

    // ③④ 반제품 총소요량 = 완제품 계획착수량 × BOM비율 → 반제품 MRP 전개
    const grSFG = planFG.release.map((v) => v * M.bomSfg);
    const planSFG = planItem({
      GR: grSFG, safety: M.sfgSafety, begin: M.sfgStock0, lot: M.sfgLot,
      lt: LT_SFG, capa: M.sfgCapa, weeks,
    });

    // ⑤⑥ 원자재 총소요량 = 반제품 계획착수량 × BOM비율 → 원자재 MRP 전개(Capa 없음)
    const grRM = planSFG.release.map((v) => v * M.bomRm);
    const planRM = planItem({
      GR: grRM, safety: 0, begin: M.rmStock0, lot: 1, lt: LT_RM, capa: null, weeks,
    });

    // ---- 참고 지표: 라인 가동률 (착수 물량 × 단위표준시간 / 가용시간) ----
    const utilFG = planFG.release.map((v) =>
      M.fgHours > 0 ? Math.round((v * M.fgTime) / 60 / M.fgHours * 1000) / 10 : 0
    );
    const utilSFG = planSFG.release.map((v) =>
      M.sfgHours > 0 ? Math.round((v * M.sfgTime) / 60 / M.sfgHours * 1000) / 10 : 0
    );

    return { planFG, planSFG, planRM, utilFG, utilSFG, LT_FG, LT_SFG, LT_RM, LT_LOGI, shipLateFlag };
  }

  /**
   * STEP 5. S&OP 보고서용 파생 지표 계산 (KPI / 리스크 문구 / 손익)
   * 화면에 뿌릴 "완성 문장"은 만들지 않고, 판단에 필요한 숫자·불리언만 반환합니다.
   * (문구 조립은 ui-controller.js 쪽 책임)
   */
  function computeReportMetrics(M, demandPlan, supplyPlan, planFG, planSFG) {
    const totalDemand = demandPlan.reduce((a, b) => a + b, 0);
    const totalSupply = supplyPlan.reduce((a, b) => a + b, 0);
    const fillRate = totalDemand ? Math.round((totalSupply / totalDemand) * 1000) / 10 : 0;

    const capaWeeks = planFG.capaFlag.filter(Boolean).length + planSFG.capaFlag.filter(Boolean).length;
    const lateWeeks = planFG.lateFlag.filter(Boolean).length + planSFG.lateFlag.filter(Boolean).length;
    const minInv = Math.min(...planFG.POH);

    // 손익: 매출은 실제 즉시 공급 가능한(ATP) 수량 기준, 원가는 완제품 계획입고 투입수량 기준
    const totalProdInputFG = planFG.PORcpt.reduce((a, b) => a + b.input, 0);
    const revenue = totalSupply * M.fgPrice;
    const cogs = totalProdInputFG * M.fgCost;
    const margin = revenue - cogs;
    const marginPct = revenue ? Math.round((margin / revenue) * 1000) / 10 : 0;

    return {
      totalDemand, totalSupply, fillRate,
      capaWeeks, lateWeeks, minInv,
      revenue, cogs, margin, marginPct,
    };
  }

  // ---- 외부(ui-controller.js)에 공개하는 함수 목록 ----
  return {
    ltWeeks,
    planItem,
    computeDemandPlan,
    computeSupplyPlan,
    computeMRPCascade,
    computeReportMetrics,
  };
})();
