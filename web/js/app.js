/* 청약/분양 통합 뷰어 - 프론트엔드 로직 */
(function () {
  "use strict";

  const state = {
    all: [],
    sources: {},
    filter: { source: "all", category: "all", q: "", onlyOpen: false, sort: "deadline", stage: "all", region: "all", favOnly: false },
    view: "list",
  };

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

  // ----- 날짜/디데이 -----
  function today() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }
  function parseDate(s) {
    if (!s) return null;
    const m = String(s).match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3]);
  }
  function dday(endStr) {
    const end = parseDate(endStr);
    if (!end) return null;
    return Math.round((end - today()) / 86400000);
  }
  function statusOfRange(startStr, endStr) {
    const s = parseDate(startStr), e = parseDate(endStr), t = today();
    if (e && t > e) return { key: "closed", label: "마감", cls: "st-closed" };
    if (s && t < s) return { key: "upcoming", label: "접수예정", cls: "st-upcoming" };
    return { key: "open", label: "접수중", cls: "st-open" };
  }
  function statusOf(n) { return statusOfRange(n.applyStart, n.applyEnd); }
  function ddayShort(startStr, endStr) {
    const st = statusOfRange(startStr, endStr);
    if (st.key === "closed") return "";
    if (st.key === "upcoming") { const d = dday(startStr); return d === null ? "" : `D-${d}`; }
    const d = dday(endStr);
    if (d === null) return "상시";
    return d === 0 ? "오늘 마감" : `D-${d}`;
  }
  function md(s) { const m = String(s || "").match(/\d{4}-(\d{2})-(\d{2})/); return m ? `${m[1]}.${m[2]}` : (s || "-"); }

  // 지역(시/도) 분류
  const SIDO = [
    ["서울", "서울"], ["부산", "부산"], ["대구", "대구"], ["인천", "인천"], ["광주", "광주"],
    ["대전", "대전"], ["울산", "울산"], ["세종", "세종"], ["경기", "경기"], ["강원", "강원"],
    ["충청북", "충북"], ["충북", "충북"], ["충청남", "충남"], ["충남", "충남"],
    ["전라북", "전북"], ["전북", "전북"], ["전라남", "전남"], ["전남", "전남"],
    ["경상북", "경북"], ["경북", "경북"], ["경상남", "경남"], ["경남", "경남"], ["제주", "제주"],
  ];
  const SIDO_ORDER = ["서울", "경기", "인천", "부산", "대구", "광주", "대전", "울산", "세종", "강원", "충북", "충남", "전북", "전남", "경북", "경남", "제주", "기타"];
  function regionOf(n) {
    const r = n.region || "";
    for (const [pre, short] of SIDO) { if (r.startsWith(pre) || r.includes(pre)) return short; }
    return "기타";
  }
  // 지도 검색용 주소 (상세주소 우선, 없으면 시/도)
  function mapAddr(n) {
    const a = n.address || n.region || "";
    return a && a.length > 3 ? a : "";
  }

  // ----- 카카오 지도 임베드 (키 있을 때만) -----
  let _kakaoKey, _kakaoReady;
  async function getKakaoKey() {
    if (_kakaoKey !== undefined) return _kakaoKey;
    try { _kakaoKey = (await (await fetch("/api/config")).json()).kakaoJsKey || ""; }
    catch (e) { _kakaoKey = ""; }
    return _kakaoKey;
  }
  function loadKakao(key) {
    if (_kakaoReady) return _kakaoReady;
    _kakaoReady = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${key}&autoload=false&libraries=services`;
      s.onload = () => window.kakao.maps.load(() => resolve(window.kakao));
      s.onerror = reject;
      document.head.appendChild(s);
    });
    return _kakaoReady;
  }
  function mapErr(msg) {
    return `<div class="map-err">🗺️ ${msg}</div>`;
  }
  async function initMap(containerId, address) {
    const el = document.getElementById(containerId);
    const key = await getKakaoKey();
    if (!key) return "nokey";
    let kakao;
    try {
      kakao = await loadKakao(key);
    } catch (e) {
      if (el) el.innerHTML = mapErr(`지도를 불러오지 못했습니다. 카카오 개발자 콘솔에서 <b>현재 도메인(${location.origin})</b>이 [앱 설정 → 플랫폼 → Web]에 등록·저장됐는지, 그리고 키가 <b>JavaScript 키</b>(REST API 키 아님)인지 확인하세요.`);
      return "failed";
    }
    if (!el) return "failed";
    return new Promise((resolve) => {
      const place = (x, y) => {
        const ll = new kakao.maps.LatLng(y, x);
        const map = new kakao.maps.Map(el, { center: ll, level: 4 });
        new kakao.maps.Marker({ map, position: ll });
        resolve("ok");
      };
      const geo = new kakao.maps.services.Geocoder();
      geo.addressSearch(address, (res, status) => {
        if (status === kakao.maps.services.Status.OK && res[0]) { place(res[0].x, res[0].y); return; }
        new kakao.maps.services.Places().keywordSearch(address, (r2, s2) => {
          if (s2 === kakao.maps.services.Status.OK && r2[0]) { place(r2[0].x, r2[0].y); return; }
          el.innerHTML = mapErr(`이 주소를 지도에서 찾지 못했습니다.<br>아래 "🗺️ 지도" 버튼으로 확인하세요.`);
          resolve("failed");
        });
      });
    });
  }

  // ----- 관심공고 즐겨찾기 (브라우저 저장) -----
  const FAV_KEY = "apt_favs";
  function getFavs() { try { return JSON.parse(localStorage.getItem(FAV_KEY)) || []; } catch (e) { return []; } }
  function isFav(id) { return getFavs().includes(id); }
  function toggleFav(id) {
    const f = getFavs(), i = f.indexOf(id);
    if (i >= 0) f.splice(i, 1); else f.push(id);
    localStorage.setItem(FAV_KEY, JSON.stringify(f));
  }
  function regionsInData() {
    const set = {};
    state.all.forEach((n) => { const r = regionOf(n); set[r] = (set[r] || 0) + 1; });
    return SIDO_ORDER.filter((s) => set[s]).map((s) => ({ region: s, count: set[s] }));
  }
  function ddayLabel(n) {
    const st = statusOf(n);
    if (st.key === "closed") return "마감";
    if (st.key === "upcoming") {
      const d = dday(n.applyStart);
      return d === 0 ? "오늘 시작" : `시작 D-${d}`;
    }
    const d = dday(n.applyEnd);
    if (d === null) return "상시";
    return d === 0 ? "오늘 마감" : `마감 D-${d}`;
  }

  const CATS = ["전체", "민간분양", "공공분양", "무순위·잔여세대", "국민임대", "행복주택", "영구임대", "통합공공임대", "전세임대", "장기전세", "공공임대"];
  const CAT_COLORS = {
    민간분양: "#2563eb", 공공분양: "#0891b2", "무순위·잔여세대": "#e11d48", 국민임대: "#16a34a", 행복주택: "#db2777",
    영구임대: "#7c3aed", 통합공공임대: "#ea580c", 전세임대: "#0d9488", 장기전세: "#9333ea", 공공임대: "#0284c7",
  };

  // ----- 데이터 로드 -----
  async function loadNotices() {
    try {
      const res = await fetch("/api/notices?source=all");
      const data = await res.json();
      state.all = data.items || [];
      state.sources = data.sources || {};
    } catch (e) {
      console.error(e);
      state.all = [];
    }
    renderSourceBadge();
    render();
  }

  function renderSourceBadge() {
    const el = $("#sourceBadge");
    const s = state.sources;
    const label = (v) => (v === "live" ? "실시간" : "샘플");
    const parts = [];
    if (s.applyhome) parts.push(`청약홈 ${label(s.applyhome)}`);
    if (s.lh) parts.push(`LH ${label(s.lh)}`);
    const allLive = Object.values(s).length && Object.values(s).every((v) => v === "live");
    const allSample = Object.values(s).every((v) => v === "sample");
    el.className = "src-badge " + (allLive ? "live" : allSample ? "sample" : "mixed");
    el.textContent = "● " + (parts.join(" · ") || "불러오는 중…");
  }

  // ----- 필터링 -----
  function filtered() {
    let arr = state.all.slice();
    const f = state.filter;
    if (f.source !== "all") arr = arr.filter((n) => (f.source === "applyhome" ? n.source === "청약홈" : n.source === "LH"));
    if (f.category !== "all") arr = arr.filter((n) => n.category === f.category);
    if (f.region !== "all") arr = arr.filter((n) => regionOf(n) === f.region);
    if (f.q) {
      const q = f.q.toLowerCase();
      arr = arr.filter((n) => (n.title + n.region + n.supplier + n.type).toLowerCase().includes(q));
    }
    if (f.onlyOpen) arr = arr.filter((n) => statusOf(n).key !== "closed");
    if (f.favOnly) { const favs = getFavs(); arr = arr.filter((n) => favs.includes(n.id)); }
    if (f.stage !== "all") {
      arr = arr.filter((n) => (n.schedule || []).some(
        (x) => x.label === f.stage && statusOfRange(x.start, x.end).key !== "closed"));
    }
    arr.sort((a, b) => {
      if (f.sort === "deadline") {
        const da = dday(a.applyEnd), db = dday(b.applyEnd);
        return (da === null ? 9999 : da) - (db === null ? 9999 : db);
      }
      return (parseDate(b.recruitDate) || 0) - (parseDate(a.recruitDate) || 0);
    });
    return arr;
  }

  // ----- 렌더: 공고 카드 -----
  function scheduleBlock(n) {
    const sch = n.schedule || [];
    if (!sch.length) {
      return `<div class="dates"><div><b>접수</b><span>${n.applyStart || "-"} ~ ${n.applyEnd || "-"}</span></div></div>`;
    }
    const rows = sch.map((x) => {
      const st = statusOfRange(x.start, x.end);
      const milestone = /발표/.test(x.label);   // 당첨자 발표 등은 접수가 아닌 '이벤트'
      const badge = milestone
        ? (st.key === "closed" ? "발표완료" : "발표예정")
        : st.label;
      return `<div class="sch-row ${st.cls}">
        <span class="sch-label">${x.label}</span>
        <span class="sch-date">${md(x.start)}${x.end && x.end !== x.start ? "~" + md(x.end) : ""}</span>
        <span class="sch-badge ${st.cls}">${badge}</span>
        <span class="sch-dday">${ddayShort(x.start, x.end)}</span>
      </div>`;
    }).join("");
    return `<div class="schedule"><div class="sch-title">📌 청약 단계별 일정</div>${rows}</div>`;
  }

  // 공고 보기 버튼: LH PDF는 inline, 청약홈은 앱 내 상세모달, 그 외는 원문
  function docButton(n) {
    if (n.docUrl) {
      return `<a class="act-btn" href="/api/doc?url=${encodeURIComponent(n.docUrl)}" target="_blank" rel="noopener">📄 공고문 보기</a>`;
    }
    if (n.source === "청약홈" && n.hm) {
      return `<button class="act-btn" data-detail="${n.id}">📄 공고 상세보기</button>`;
    }
    // 볼 수 있는 실제 공고 페이지가 있으면 링크, 없으면 비활성화
    const generic = !n.url || /^https?:\/\/(www\.applyhome\.co\.kr|apply\.lh\.or\.kr)\/?$/.test(n.url);
    if (!generic) {
      return `<a class="act-btn" href="${n.url}" target="_blank" rel="noopener">📄 공고 내용 보기</a>`;
    }
    return `<button class="act-btn disabled" disabled title="제공되는 공고 내용이 없습니다">📄 공고 내용 없음</button>`;
  }

  // ----- 분양가/면적 포맷 -----
  function fmtPrice(manwon) {
    const v = +manwon || 0;
    if (!v) return "-";
    const eok = Math.floor(v / 10000), man = v % 10000;
    return (eok ? `${eok}억` : "") + (man ? ` ${man.toLocaleString("ko-KR")}만원` : (eok ? "" : `${v}만원`));
  }
  // 금액 문자열 포맷: 숫자(원)면 억/만원으로, "공고문 참조" 등 텍스트는 그대로
  function fmtMoney(v) {
    const s = String(v == null ? "" : v).trim();
    if (!s) return "-";
    const digits = s.replace(/[,\s]/g, "");
    if (!/^\d+$/.test(digits)) return s;            // "공고문 참조" 등
    const won = +digits;
    if (won === 0) return "-";
    const eok = Math.floor(won / 100000000);
    const man = Math.floor((won % 100000000) / 10000);
    if (eok) return `${eok}억${man ? " " + man.toLocaleString("ko-KR") + "만" : ""}원`;
    if (man) return `${man.toLocaleString("ko-KR")}만원`;
    return `${won.toLocaleString("ko-KR")}원`;
  }
  function fmtType(t) {
    const m = String(t || "").match(/([\d.]+)\s*([A-Za-z]*)/);
    if (!m) return t || "-";
    return `${(+m[1]).toFixed(2)}㎡${m[2] ? " " + m[2] : ""}`;
  }

  // ----- 상세 모달 (Level 2: 전체 내용 / Level 3: 평형·공고문 세부) -----
  async function openDetail(id) {
    const n = state.all.find((x) => x.id === id);
    if (!n) return;
    const box = $("#modalBody");
    $("#modal").hidden = false;
    document.body.style.overflow = "hidden";
    box.innerHTML = `<div class="md-head"><div class="md-tags"><span class="cat" style="background:${CAT_COLORS[n.category] || "#475569"}">${n.category}</span></div>
      <h2>${n.title}</h2></div><p class="empty">상세 정보를 불러오는 중…</p>`;
    let units = [];
    if (n.source === "청약홈" && n.hm) {
      try {
        const res = await fetch(`/api/applyhome-detail?hm=${encodeURIComponent(n.hm)}&pb=${encodeURIComponent(n.pb)}`);
        units = (await res.json()).units || [];
      } catch (e) { /* 무시 */ }
      // 접수 마감된 공고는 경쟁률도 조회
      if (statusOf(n).key === "closed" && !n.cmpet) {
        try {
          const r2 = await fetch(`/api/applyhome-cmpet?hm=${encodeURIComponent(n.hm)}&pb=${encodeURIComponent(n.pb)}`);
          n.cmpet = (await r2.json()).rates || [];
        } catch (e) { /* 무시 */ }
      }
    } else if (n.source === "LH" && n.lhKey) {
      // LH 상세는 여기서 지연 로딩 (목록 속도 개선)
      try {
        const res = await fetch("/api/lh-detail?" + new URLSearchParams(n.lhKey).toString());
        const j = await res.json();
        const d = j.detail || {};
        ["totalUnits", "priceNote", "winnerDate", "contractStart", "contractEnd", "moveInDate", "docUrl", "address"]
          .forEach((k) => { if (d[k]) n[k] = d[k]; });
        if (d.schedule && d.schedule.length) n.schedule = d.schedule;
        n.lhUnits = j.units || [];
      } catch (e) { /* 무시 */ }
    }
    box.innerHTML = renderDetail(n, units);
    if (mapAddr(n)) {
      initMap("mdMap", mapAddr(n)).then((st) => { if (st === "nokey") { const w = $("#mdMapWrap"); if (w) w.remove(); } });
    }
  }

  function renderDetail(n, units) {
    const sumUnits = units.reduce((s, u) => s + (u.units || 0), 0);
    const prices = units.map((u) => u.price).filter(Boolean);
    const priceRange = prices.length
      ? (Math.min(...prices) === Math.max(...prices) ? fmtPrice(prices[0]) : `${fmtPrice(Math.min(...prices))} ~ ${fmtPrice(Math.max(...prices))}`)
      : "";
    // 특별공급: 평형별 합계 우선, 없으면 notice.special 칩
    const spSum = {};
    units.forEach((u) => Object.entries(u.sp || {}).forEach(([k, v]) => (spSum[k] = (spSum[k] || 0) + v)));
    let spChips = Object.entries(spSum).filter(([, v]) => v > 0).map(([k, v]) => `<span class="chip">${k} ${v}세대</span>`).join("");
    if (!spChips && (n.special || []).length) spChips = n.special.map((s) => `<span class="chip">${s}</span>`).join("");

    const totalUnits = sumUnits || n.totalUnits || "";
    const priceBanner = priceRange
      ? `<div class="md-price"><span class="md-price-lbl">분양가 (최고가 기준)</span><b>${priceRange}</b></div>`
      : (n.priceNote ? `<div class="md-price"><span class="md-price-lbl">공급 정보</span><b>${n.priceNote}</b></div>` : "");

    const milestones = [
      ["당첨자 발표", n.winnerDate],
      ["계약", n.contractStart ? n.contractStart + (n.contractEnd ? ` ~ ${n.contractEnd}` : "") : ""],
      ["입주 예정", n.moveInDate],
    ].filter(([, v]) => v);
    const msHtml = milestones.length
      ? `<div class="dates">${milestones.map(([k, v]) => `<div><b>${k}</b><span>${v}</span></div>`).join("")}</div>` : "";

    const rows = units.map((u) => `<tr><td class="t">${fmtType(u.type)}</td><td>${u.units || "-"}세대</td><td class="p">${fmtPrice(u.price)}</td></tr>`).join("");
    // 금액 셀: 숫자면 포맷, "공고문 참조" 등 텍스트면 PDF 링크로
    const moneyCell = (v) => {
      const s = String(v == null ? "" : v).trim();
      const isNum = /^\d+$/.test(s.replace(/[,\s]/g, ""));
      if (isNum) return fmtMoney(s);
      if (!s || s === "-") return "-";
      return n.docUrl ? `<a class="ref-link" href="/api/doc?url=${encodeURIComponent(n.docUrl)}" target="_blank" rel="noopener">${s} 📄</a>` : s;
    };
    const lhRows = (n.lhUnits || []).map((u) => `<tr>
        <td class="t">${u.type || "-"}</td>
        <td>${u.areaEx ? u.areaEx + "㎡" : "-"}</td>
        <td>${u.units || u.nowUnits || "-"}</td>
        <td class="p">${moneyCell(u.deposit)}</td>
        <td>${moneyCell(u.rent)}</td></tr>`).join("");
    const cmpet = (n.cmpet || []).filter((c) => c.req > 0 || c.supply > 0);
    const cmpetRows = cmpet.map((c) => `<tr>
        <td class="t">${fmtType(c.type)}</td>
        <td>${c.supply || "-"}</td>
        <td>${c.req != null ? c.req.toLocaleString("ko-KR") : "-"}</td>
        <td class="p ${c.under ? "under" : ""}">${c.under ? "미달" : (c.rate ? c.rate.toFixed(2) + " : 1" : "-")}</td></tr>`).join("");
    const docBtn = n.docUrl ? `<a class="act-btn" href="/api/doc?url=${encodeURIComponent(n.docUrl)}" target="_blank" rel="noopener">📄 공고문 PDF</a>` : "";

    return `
      <div class="md-head">
        <div class="md-tags"><span class="cat" style="background:${CAT_COLORS[n.category] || "#475569"}">${n.category}</span>
          <span class="src">${n.source}</span>${/무순위/.test(n.supplyKind || "") ? '<span class="kind">무순위</span>' : ""}</div>
        <h2>${n.title}</h2>
        <p class="md-sub">📍 ${n.address || n.region || "-"}${n.supplier ? ` · 🏢 ${n.supplier}` : ""}</p>
      </div>
      ${priceBanner}
      <div class="md-stats two">
        <div><b>${totalUnits ? totalUnits + "세대" : "-"}</b><span>총 공급세대</span></div>
        <div><b>${n.recruitDate || "-"}</b><span>모집공고일</span></div>
      </div>
      <h3 class="md-h3">📌 청약 일정</h3>
      ${scheduleBlock(n)}
      ${msHtml}
      ${units.length ? `<h3 class="md-h3">🏘️ 주택형별 분양가</h3>
        <div class="md-table-wrap"><table class="md-table">
          <thead><tr><th>주택형(전용)</th><th>공급세대</th><th>분양가</th></tr></thead>
          <tbody>${rows}</tbody></table></div>` : ""}
      ${lhRows ? `<h3 class="md-h3">🏘️ 면적별 ${/분양/.test(n.category) ? "공급가" : "임대조건"}</h3>
        <div class="md-table-wrap"><table class="md-table lh-tbl">
          <thead><tr><th>주택형</th><th>전용</th><th>세대</th><th>보증금</th><th>월임대료</th></tr></thead>
          <tbody>${lhRows}</tbody></table></div>` : ""}
      ${cmpetRows ? `<h3 class="md-h3">🔥 청약 경쟁률 (1순위)</h3>
        <div class="md-table-wrap"><table class="md-table cmpet-tbl">
          <thead><tr><th>주택형(전용)</th><th>공급</th><th>1순위 접수</th><th>경쟁률</th></tr></thead>
          <tbody>${cmpetRows}</tbody></table></div>` : ""}
      ${spChips ? `<h3 class="md-h3">🎯 특별공급 물량</h3><div class="chips">${spChips}</div>` : ""}
      ${mapAddr(n) ? `<div id="mdMapWrap"><h3 class="md-h3">🗺️ 위치</h3><div id="mdMap" class="md-map"></div></div>` : ""}
      <div class="md-actions">
        <a class="apply-btn" href="${n.url}" target="_blank" rel="noopener">신청 / 공고 바로가기 ↗</a>
        ${docBtn}
        ${mapAddr(n) ? `<a class="act-btn" href="https://map.naver.com/p/search/${encodeURIComponent(mapAddr(n))}" target="_blank" rel="noopener">🗺️ 지도</a>` : ""}
      </div>`;
  }

  function closeModal() { $("#modal").hidden = true; document.body.style.overflow = ""; }

  // 지역 축약 (시/도 + 시군구)
  function regionShort(n) {
    const r = (n.region || "").trim();
    if (!r) return "-";
    return r.split(/\s+/).slice(0, 2).join(" ");
  }

  // Level 1: 컴팩트 카드 (핵심만, 클릭하면 상세 모달)
  function card(n) {
    const st = statusOf(n);
    const color = CAT_COLORS[n.category] || "#475569";
    const kindTag = /무순위/.test(n.supplyKind || "") ? `<span class="kind">무순위</span>` : "";
    return `
      <article class="card" data-detail="${n.id}" role="button" tabindex="0">
        <div class="card-top">
          <span class="cat" style="background:${color}">${n.category}</span>
          ${kindTag}
          <span class="status ${st.cls}">${st.label}</span>
          ${st.key !== "closed" ? `<span class="dday">${ddayLabel(n)}</span>` : ""}
        </div>
        <h3 class="card-title">${n.title || "(제목 없음)"}</h3>
        <div class="card-sub">
          <span>📍 ${regionShort(n)}</span>
          ${n.totalUnits ? `<span>🏠 ${n.totalUnits}세대</span>` : ""}
          ${n.type ? `<span>🏷️ ${n.type}</span>` : ""}
        </div>
        <div class="card-foot">
          <span class="cf-left">
            <button class="fav ${isFav(n.id) ? "on" : ""}" data-fav="${n.id}" aria-label="관심공고" title="관심공고">${isFav(n.id) ? "★" : "☆"}</button>
            <span class="cf-meta">${n.source}${n.applyEnd ? " · 마감 " + md(n.applyEnd) : ""}</span>
          </span>
          <span class="chev">자세히 ›</span>
        </div>
      </article>`;
  }

  // ----- 렌더: 목록 (필터 포함) -----
  function renderList() {
    const arr = filtered();
    const f = state.filter;
    const catBtns = CATS.map((c) => {
      const val = c === "전체" ? "all" : c;
      return `<button class="catpill ${f.category === val ? "active" : ""}" data-cat="${val}">${c}</button>`;
    }).join("");

    const regions = regionsInData();
    const regionBtns = `<button class="rgpill ${f.region === "all" ? "active" : ""}" data-rg="all">전국</button>` +
      regions.map((r) => `<button class="rgpill ${f.region === r.region ? "active" : ""}" data-rg="${r.region}">${r.region}<i>${r.count}</i></button>`).join("");

    return `
      <div class="filter-card">
        <div class="filter-row">
          <div class="seg">
            ${["all:전체", "applyhome:청약홈", "lh:LH"].map((s) => {
              const [v, l] = s.split(":");
              return `<button class="segbtn ${f.source === v ? "active" : ""}" data-src="${v}">${l}</button>`;
            }).join("")}
          </div>
          <div class="search-wrap">
            <svg viewBox="0 0 24 24" class="search-ic"><path d="M21 21l-4.3-4.3M11 19a8 8 0 110-16 8 8 0 010 16z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            <input id="search" class="search" type="search" placeholder="단지명·지역·사업주체 검색" value="${f.q}">
          </div>
          <label class="chkopen"><input type="checkbox" id="onlyOpen" ${f.onlyOpen ? "checked" : ""}> <span>접수중만</span></label>
          <button id="favToggle" class="favbtn ${f.favOnly ? "active" : ""}">${f.favOnly ? "★" : "☆"} 관심${getFavs().length ? ` ${getFavs().length}` : ""}</button>
          <select id="stage" class="sel">
            ${["all:전체 단계", "특별공급:특별공급 진행", "1순위:1순위 진행", "2순위:2순위 진행"].map((s) => {
              const [v, l] = s.split(":");
              return `<option value="${v}" ${f.stage === v ? "selected" : ""}>${l}</option>`;
            }).join("")}
          </select>
          <select id="sort" class="sel">
            <option value="deadline" ${f.sort === "deadline" ? "selected" : ""}>마감 임박순</option>
            <option value="recent" ${f.sort === "recent" ? "selected" : ""}>최신 공고순</option>
          </select>
        </div>
        <div class="filter-label">지역</div>
        <div class="rgpills">${regionBtns}</div>
        <div class="filter-label">유형</div>
        <div class="catpills">${catBtns}</div>
      </div>
      <div class="result-count"><b>${arr.length}</b>건의 공고</div>
      ${arr.length ? `<div class="cards">${arr.map(card).join("")}</div>` : `<p class="empty">조건에 맞는 공고가 없습니다.</p>`}`;
  }

  // ----- 렌더: 가이드 -----
  function renderGuide() {
    const G = window.GUIDE;
    const list = (items) => `<ul class="g-list">${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;

    const 분양Cards = G.분양.map((b) => `
      <div class="g-card" style="border-left:4px solid ${CAT_COLORS[b.key] || "#2563eb"}">
        <h4>${b.name}</h4>
        <p><b>대상</b> ${b.who}</p>
        <p><b>장점</b> ${b.merit}</p>
        <p><b>유의</b> ${b.caution}</p>
        ${b.types ? `<p><b>세부유형</b> ${b.types.join(" · ")}</p>` : ""}
        <p><b>신청처</b> ${b.channel}</p>
        <div class="chips">${(b.special || []).map((s) => `<span class="chip">${s}</span>`).join("")}</div>
      </div>`).join("");

    const 임대Cards = G.임대.map((b) => `
      <div class="g-card" style="border-left:4px solid ${CAT_COLORS[b.key] || "#16a34a"}">
        <h4>${b.name}</h4>
        <p><b>대상</b> ${b.who}</p>
        <p><b>임대료</b> ${b.rent}</p>
        <p><b>거주기간</b> ${b.term}</p>
        <p><b>신청처</b> ${b.channel}</p>
      </div>`).join("");

    const gajeom = `
      <div class="gajeom">
        ${G.gajeom.items.map((i) => `
          <div class="gj-row">
            <span class="gj-name">${i.name}</span>
            <span class="gj-track"><span class="gj-fill" style="width:${(i.max / G.gajeom.total) * 100}%"></span></span>
            <span class="gj-max">${i.max}점</span>
            <span class="gj-note">${i.note}</span>
          </div>`).join("")}
        <div class="gj-total">합계 최대 <b>${G.gajeom.total}점</b></div>
      </div>`;

    const special = `<div class="g-table">${G.special.items.map((i) =>
      `<div class="gt-row"><div class="gt-k">${i.name}</div><div class="gt-v">${i.cond}</div></div>`).join("")}</div>`;

    const channels = G.channels.items.map((c) =>
      `<a class="g-channel" href="${c.url}" target="_blank" rel="noopener"><b>${c.name} ↗</b><span>${c.desc}</span></a>`).join("");

    return `
      <section class="g-sec">
        <h2 class="sec-title">${G.intro.title}</h2>
        <p class="g-lead">${G.intro.summary}</p>
        <ol class="g-flow">${G.intro.flow.map((s) => `<li>${s}</li>`).join("")}</ol>
      </section>

      <section class="g-sec"><h2 class="sec-title">🏦 ${G.accounts.title}</h2>${list(G.accounts.points)}</section>

      <section class="g-sec">
        <h2 class="sec-title">🥇 ${G.ranks.title}</h2>
        <div class="g-two">
          <div><h4>민영주택</h4>${list(G.ranks.민영주택)}</div>
          <div><h4>국민주택</h4>${list(G.ranks.국민주택)}</div>
        </div>
      </section>

      <section class="g-sec"><h2 class="sec-title">🧮 ${G.gajeom.title}</h2><p class="g-lead">${G.gajeom.desc}</p>${gajeom}</section>

      <section class="g-sec"><h2 class="sec-title">🏢 분양 유형</h2><div class="g-grid">${분양Cards}</div></section>

      <section class="g-sec"><h2 class="sec-title">🏠 임대 유형</h2><div class="g-grid">${임대Cards}</div></section>

      <section class="g-sec"><h2 class="sec-title">🎯 ${G.special.title}</h2><p class="g-lead">${G.special.desc}</p>${special}</section>

      <section class="g-sec"><h2 class="sec-title">💵 ${G.income.title}</h2>${list(G.income.points)}</section>

      <section class="g-sec"><h2 class="sec-title">✅ ${G.steps.title}</h2>${list(G.steps.items)}</section>

      <section class="g-sec"><h2 class="sec-title">🔗 ${G.channels.title}</h2><div class="g-channels">${channels}</div></section>

      <p class="disclaimer">⚠️ ${G.disclaimer}</p>`;
  }

  // ----- 렌더: 당첨 전략 -----
  function renderStrategy() {
    const S = window.STRATEGY;
    const list = (items) => `<ul class="g-list">${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;

    const changes = S.changes2026.items.map((i) =>
      `<div class="s-item"><h4>🆕 ${i.t}</h4><p>${i.d}</p></div>`).join("");

    const raise = S.raiseScore.items.map((i) =>
      `<div class="s-item"><h4>${i.t}</h4><p>${i.d}</p></div>`).join("");

    const byType = S.byType.items.map((i) =>
      `<div class="gt-row"><div class="gt-k">${i.who}</div><div class="gt-v">${i.how}</div></div>`).join("");

    const tl = S.timeline.items.map((s) => `<li>${s}</li>`).join("");

    return `
      <div class="updated-badge">🗓️ ${S.updated} · 최신 제도 반영</div>
      <section class="g-sec"><h2 class="sec-title">🎯 ${S.intro ? "왜 전략인가" : ""}</h2><p class="g-lead">${S.intro}</p></section>

      <section class="g-sec"><h2 class="sec-title">📣 ${S.changes2026.title}</h2><div class="s-grid">${changes}</div></section>

      <section class="g-sec">
        <h2 class="sec-title">📈 ${S.raiseScore.title}</h2>
        <div class="s-grid">${raise}</div>
        <p class="tip">💡 ${S.raiseScore.tip}</p>
      </section>

      <section class="g-sec"><h2 class="sec-title">🧭 ${S.byType.title}</h2><div class="g-table">${byType}</div></section>

      <section class="g-sec"><h2 class="sec-title">🚫 ${S.avoid.title}</h2>${list(S.avoid.items)}</section>

      <section class="g-sec"><h2 class="sec-title">✅ ${S.timeline.title}</h2><ol class="g-flow">${tl}</ol></section>`;
  }

  // ----- 렌더: 대출 + 계산기 -----
  function renderLoan() {
    const L = window.LOAN;
    const list = (items) => `<ul class="g-list">${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;

    const products = L.products.map((p) => `
      <div class="loan-card">
        <div class="loan-head"><h4>${p.name}</h4><span class="loan-tag">${p.tag}</span></div>
        <div class="loan-rate">${p.rate}</div>
        <div class="loan-income"><span class="li-label">소득 기준</span><span class="li-val">${p.income}</span></div>
        <div class="loan-rows">
          <div><b>대상</b><span>${p.who}</span></div>
          <div><b>자산</b><span>${p.asset}</span></div>
          <div><b>주택가격</b><span>${p.house}</span></div>
          <div><b>한도</b><span>${p.limit}</span></div>
        </div>
        <p class="loan-note">${p.note}</p>
      </div>`).join("");

    const it = L.incomeTable;
    const incomeTable = `
      <div class="inc-table-wrap">
        <table class="inc-table">
          <thead><tr>${it.cols.map((c, i) => `<th class="${i === 0 ? "first" : ""}">${c}</th>`).join("")}</tr></thead>
          <tbody>${it.rows.map((r) => `<tr>${r.map((c, i) => i === 0 ? `<th class="first">${c}</th>` : `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody>
        </table>
      </div>
      <p class="tip">💡 ${it.note}</p>`;

    return `
      <div class="updated-badge">🗓️ ${L.updated}</div>
      <section class="g-sec"><h2 class="sec-title">💰 내 집 마련 자금, 어떻게?</h2><p class="g-lead">${L.intro}</p></section>

      <section class="g-sec">
        <h2 class="sec-title">🧮 대출 상환 계산기</h2>
        <div class="calc">
          <div class="calc-inputs">
            <label>대출 금액 (만원)<input type="number" id="c-amount" value="30000" min="0" step="100"></label>
            <label>연 이자율 (%)<input type="number" id="c-rate" value="3.5" min="0" step="0.05"></label>
            <label>대출 기간 (년)<input type="number" id="c-years" value="30" min="1" max="50" step="1"></label>
            <label>상환 방식
              <select id="c-method">
                <option value="amort">원리금균등 (매월 동일)</option>
                <option value="equalp">원금균등 (점차 감소)</option>
                <option value="bullet">만기일시 (이자만)</option>
              </select>
            </label>
            <label>연 소득 (만원, 선택)<input type="number" id="c-income" value="6000" min="0" step="100"></label>
          </div>
          <div class="calc-result" id="calcResult"></div>
        </div>
      </section>

      <section class="g-sec"><h2 class="sec-title">🏦 주요 대출 상품 비교</h2><div class="loan-grid">${products}</div></section>

      <section class="g-sec"><h2 class="sec-title">💵 ${it.title}</h2>${incomeTable}</section>

      <section class="g-sec"><h2 class="sec-title">📉 ${L.dsr.title}</h2>${list(L.dsr.points)}</section>

      <section class="g-sec"><h2 class="sec-title">💡 대출 꿀팁</h2>${list(L.tips)}</section>

      <p class="disclaimer">⚠️ ${L.disclaimer}</p>`;
  }

  // 대출 계산 (만원 단위 입력 → 원 단위 계산)
  function computeLoan() {
    const amount = (+($("#c-amount") || {}).value || 0) * 10000; // 원
    const rate = (+($("#c-rate") || {}).value || 0) / 100;
    const years = +($("#c-years") || {}).value || 0;
    const method = ($("#c-method") || {}).value || "amort";
    const income = (+($("#c-income") || {}).value || 0) * 10000;
    const n = years * 12;
    const r = rate / 12;
    let monthly = 0, firstMonth = 0, totalInterest = 0;

    if (amount <= 0 || n <= 0) return setCalcResult(null);

    if (method === "amort") {
      monthly = r === 0 ? amount / n : (amount * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
      totalInterest = monthly * n - amount;
      firstMonth = monthly;
    } else if (method === "equalp") {
      const principal = amount / n;
      firstMonth = principal + amount * r;       // 첫 달(최대)
      const lastMonth = principal + principal * r; // 마지막 달(최소)
      totalInterest = (amount * r * (n + 1)) / 2;  // 등차합
      monthly = (firstMonth + lastMonth) / 2;      // 평균
    } else { // bullet
      monthly = amount * r;            // 매월 이자만
      firstMonth = monthly;
      totalInterest = monthly * n;     // 만기 원금 별도
    }

    const annualRepay = method === "bullet" ? monthly * 12 : firstMonth * 12;
    const dsr = income > 0 ? (annualRepay / income) * 100 : null;
    const incomeManwon = income > 0 ? income / 10000 : null;
    setCalcResult({ amount, method, monthly, firstMonth, totalInterest, n, dsr, incomeManwon });
  }

  // 입력 소득(만원, 일반 기준)으로 가능한 정책대출 안내
  function eligibleLoans(incomeManwon) {
    if (incomeManwon === null) return "";
    const ok = [], no = [];
    (window.LOAN.products || []).forEach((p) => {
      if (p.incomeMax === null) { ok.push(p.name + "(소득제한 없음)"); return; }
      (incomeManwon <= p.incomeMax ? ok : no).push(p.name);
    });
    return `
      <div class="elig">
        <div class="elig-title">연소득 ${Math.round(incomeManwon).toLocaleString("ko-KR")}만원(일반 기준)으로 가능한 대출</div>
        <div class="elig-ok">✅ ${ok.join(" · ")}</div>
        ${no.length ? `<div class="elig-no">⚠️ 일반 기준 초과: ${no.join(" · ")} <em>— 신혼·생애최초·다자녀·출산이면 완화 기준으로 가능할 수 있음</em></div>` : ""}
      </div>`;
  }

  function won(v) { return Math.round(v).toLocaleString("ko-KR") + "원"; }
  function manwon(v) { return Math.round(v / 10000).toLocaleString("ko-KR") + "만원"; }

  function setCalcResult(res) {
    const el = $("#calcResult");
    if (!el) return;
    if (!res) { el.innerHTML = `<p class="empty">금액과 기간을 입력하세요.</p>`; return; }
    const methodLabel = { amort: "원리금균등", equalp: "원금균등", bullet: "만기일시" }[res.method];
    let rows = "";
    if (res.method === "amort") {
      rows = `<div class="cr-big"><span>월 상환액</span><b>${won(res.monthly)}</b></div>`;
    } else if (res.method === "equalp") {
      rows = `<div class="cr-big"><span>첫 달 상환액</span><b>${won(res.firstMonth)}</b></div>
              <div class="cr-row"><span>매월 점차 감소 (평균 ${won(res.monthly)})</span></div>`;
    } else {
      rows = `<div class="cr-big"><span>월 이자</span><b>${won(res.monthly)}</b></div>
              <div class="cr-row"><span>만기에 원금 ${manwon(res.amount)} 별도 상환</span></div>`;
    }
    const dsrHtml = res.dsr === null ? "" :
      `<div class="cr-row dsr-row ${res.dsr > 40 ? "over" : "ok"}">
        <span>이 대출만의 DSR(추정)</span><b>${res.dsr.toFixed(1)}%</b>
        <em>${res.dsr > 40 ? "은행권 40% 초과 — 다른 대출까지 합치면 한도 제한 가능" : "은행권 40% 이내 (기존 대출 합산 시 달라질 수 있음)"}</em>
      </div>`;
    el.innerHTML = `
      <div class="cr-method">${methodLabel} · ${res.n / 12}년(${res.n}회)</div>
      ${rows}
      <div class="cr-row"><span>총 이자</span><b>${won(res.totalInterest)}</b></div>
      <div class="cr-row"><span>총 상환액(원금+이자)</span><b>${won(res.amount + res.totalInterest)}</b></div>
      ${dsrHtml}
      ${eligibleLoans(res.incomeManwon)}
      <p class="cr-note">※ 실제 금리·한도는 신용도·규제·스트레스 DSR에 따라 달라집니다. 참고용 추정치입니다.</p>`;
  }

  // ----- 메인 렌더 -----
  function render() {
    $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === state.view));
    const main = $("#main");
    if (state.view === "list") main.innerHTML = renderList();
    else if (state.view === "guide") main.innerHTML = renderGuide();
    else if (state.view === "strategy") main.innerHTML = renderStrategy();
    else if (state.view === "loan") main.innerHTML = renderLoan();
    bindDynamic();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ----- 이벤트 바인딩 -----
  function bindDynamic() {
    if (state.view === "loan") {
      ["c-amount", "c-rate", "c-years", "c-method", "c-income"].forEach((id) => {
        const el = $("#" + id);
        if (el) el.oninput = el.onchange = computeLoan;
      });
      computeLoan();
      return;
    }
    if (state.view !== "list") return;
    $$(".segbtn").forEach((b) => b.onclick = () => { state.filter.source = b.dataset.src; render(); });
    $$(".catpill").forEach((b) => b.onclick = () => { state.filter.category = b.dataset.cat; render(); });
    $$(".rgpill").forEach((b) => b.onclick = () => { state.filter.region = b.dataset.rg; render(); });
    const s = $("#search");
    if (s) s.oninput = debounce((e) => { state.filter.q = e.target.value; render(); restoreFocus("#search"); }, 250);
    const o = $("#onlyOpen");
    if (o) o.onchange = (e) => { state.filter.onlyOpen = e.target.checked; render(); };
    const sort = $("#sort");
    if (sort) sort.onchange = (e) => { state.filter.sort = e.target.value; render(); };
    const stage = $("#stage");
    if (stage) stage.onchange = (e) => { state.filter.stage = e.target.value; render(); };
    const favT = $("#favToggle");
    if (favT) favT.onclick = () => { state.filter.favOnly = !state.filter.favOnly; render(); };
  }

  function restoreFocus(sel) {
    const el = $(sel);
    if (el) { el.focus(); const v = el.value; el.value = ""; el.value = v; }
  }
  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  // ----- 초기화 -----
  function init() {
    $$(".nav-btn").forEach((b) => b.onclick = () => { state.view = b.dataset.view; render(); });
    $("#refreshBtn").onclick = loadNotices;
    // 공고 상세보기 버튼 (이벤트 위임)
    document.addEventListener("click", (e) => {
      const fav = e.target.closest("[data-fav]");
      if (fav) { e.preventDefault(); e.stopPropagation(); toggleFav(fav.dataset.fav); render(); return; }
      const btn = e.target.closest("[data-detail]");
      if (btn) { e.preventDefault(); openDetail(btn.dataset.detail); }
      if (e.target.closest("[data-close]")) closeModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeModal();
      const c = e.target.closest && e.target.closest("[data-detail]");
      if (c && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openDetail(c.dataset.detail); }
    });
    loadNotices();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
