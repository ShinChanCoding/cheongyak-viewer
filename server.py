# -*- coding: utf-8 -*-
"""
청약/분양 정보 통합 뷰어 - 로컬 백엔드 서버 (Python 표준 라이브러리만 사용)

기능
- web/ 폴더의 반응형 웹앱을 서빙
- /api/notices : 청약홈 + LH 공공 OpenAPI를 서버에서 호출해 공통 형식으로 정규화하여 반환
  (서비스키가 없거나 호출 실패 시 data/ 폴더의 샘플 데이터로 자동 대체)
- /api/health : 상태 확인

실행:  python server.py
설정:  config.example.json 을 config.json 으로 복사 후 서비스키 입력 (선택)
"""

import json
import os
import sys
import time
import urllib.parse
import urllib.request
import urllib.error
import socketserver
import http.server
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

# 간단한 메모리 캐시 (속도 개선): key -> (만료시각, 값)
_cache = {}


def cached(key, ttl, fn):
    now = time.time()
    hit = _cache.get(key)
    if hit and now < hit[0]:
        return hit[1]
    val = fn()
    _cache[key] = (now + ttl, val)
    return val

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")
DATA_DIR = os.path.join(BASE_DIR, "data")

# 공공데이터포털 OpenAPI 엔드포인트
APPLYHOME_URL = "https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail"
APPLYHOME_REMNDR_URL = "https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/getRemndrLttotPblancDetail"
APPLYHOME_MDL_URL = "https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancMdl"
APPLYHOME_CMPET_URL = "https://api.odcloud.kr/api/ApplyhomeInfoCmpetRtSvc/v1/getAPTLttotPblancCmpet"
LH_URL = "https://apis.data.go.kr/B552555/lhLeaseNoticeInfo1"
LH_DETAIL_URL = "https://apis.data.go.kr/B552555/lhLeaseNoticeDtlInfo1/getLeaseNoticeDtlInfo1"
LH_SPL_URL = "https://apis.data.go.kr/B552555/lhLeaseNoticeSplInfo1/getLeaseNoticeSplInfo1"

# 상세 API 권한 미승인(403/401) 시 자동으로 비활성화하여 불필요한 호출 차단
LH_DETAIL_DISABLED = False
_lh_detail_cache = {}


# ---------------------------------------------------------------------------
# 설정 로드
# ---------------------------------------------------------------------------
def load_config():
    cfg = {"applyhome_service_key": "", "lh_service_key": "", "kakao_js_key": "", "port": 8000}
    path = os.path.join(BASE_DIR, "config.json")
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                cfg.update({k: v for k, v in json.load(f).items() if not k.startswith("_")})
        except Exception as e:
            print(f"[warn] config.json 읽기 실패: {e}")
    # 환경변수 우선
    cfg["applyhome_service_key"] = os.environ.get("APPLYHOME_SERVICE_KEY", cfg["applyhome_service_key"])
    cfg["lh_service_key"] = os.environ.get("LH_SERVICE_KEY", cfg["lh_service_key"])
    cfg["kakao_js_key"] = os.environ.get("KAKAO_JS_KEY", cfg.get("kakao_js_key", ""))
    return cfg


CONFIG = load_config()


def load_sample(name):
    try:
        with open(os.path.join(DATA_DIR, name), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"[warn] 샘플 로드 실패 {name}: {e}")
        return []


# ---------------------------------------------------------------------------
# 유틸: 날짜 정규화 (YYYYMMDD -> YYYY-MM-DD)
# ---------------------------------------------------------------------------
def fmt_date(v):
    if not v:
        return ""
    s = str(v).strip().replace(".", "-").replace("/", "-")
    digits = "".join(ch for ch in s if ch.isdigit())
    if len(digits) == 8:
        return f"{digits[0:4]}-{digits[4:6]}-{digits[6:8]}"
    return s


def http_get_json(url, timeout=10):
    req = urllib.request.Request(url, headers={"User-Agent": "cheongyak-viewer/1.0", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read()
        charset = resp.headers.get_content_charset()
    # 인코딩 자동 감지: 헤더 우선, 없으면 UTF-8(청약홈) → 실패 시 CP949(LH는 EUC-KR)
    for enc in [charset, "utf-8", "cp949"]:
        if not enc:
            continue
        try:
            return json.loads(data.decode(enc))
        except (UnicodeDecodeError, LookupError):
            continue
    return json.loads(data.decode("utf-8", errors="replace"))


# ---------------------------------------------------------------------------
# 청약홈(한국부동산원) 분양정보 조회
# ---------------------------------------------------------------------------
def _odcloud_rows(url, key, per_page):
    full = url + "?" + urllib.parse.urlencode({"page": 1, "perPage": per_page, "serviceKey": key}, safe="%+")
    data = http_get_json(full)
    return data.get("data", []) if isinstance(data, dict) else []


def fetch_applyhome(per_page=100, keep=80, remndr_keep=20):
    key = CONFIG.get("applyhome_service_key", "")
    if not key:
        return load_sample("sample_applyhome.json"), "sample"
    try:
        # 1) 정식 APT 분양 (오피스텔/생숙/도시형/민간임대는 별도 엔드포인트라 자동 제외)
        reg = [normalize_applyhome(r) for r in _odcloud_rows(APPLYHOME_URL, key, per_page)
               if str(r.get("HOUSE_SECD_NM", "")).strip() == "APT"]  # 순수 아파트만
        # 2) 무순위/잔여세대 (APT) — 최신순 일부만
        rem = [normalize_applyhome_remndr(r) for r in _odcloud_rows(APPLYHOME_REMNDR_URL, key, per_page)]
        rem.sort(key=lambda n: n.get("recruitDate", ""), reverse=True)
        out = reg + rem[:remndr_keep]
        out.sort(key=lambda n: n.get("recruitDate", ""), reverse=True)
        out = out[:keep]
        return (out, "live") if out else (load_sample("sample_applyhome.json"), "sample")
    except Exception as e:
        print(f"[warn] 청약홈 API 호출 실패 -> 샘플 사용: {e}")
        return load_sample("sample_applyhome.json"), "sample"


def _build_schedule(r, stages):
    """[(라벨, 시작키, 종료키)] -> [{label,start,end}] (날짜 있는 단계만)."""
    out = []
    for label, sk, ek in stages:
        s, e = fmt_date(r.get(sk)), fmt_date(r.get(ek))
        if s or e:
            out.append({"label": label, "start": s, "end": e})
    return out


def _grouped_schedule(r, groups):
    """[(라벨, [(시작키,종료키),...])] -> 그룹별 최소시작~최대종료로 묶은 [{label,start,end}].
    같은 단계의 해당지역/기타경기/기타지역을 하나로 합쳐 간결하게 표시."""
    out = []
    for label, pairs in groups:
        starts, ends = [], []
        for sk, ek in pairs:
            s, e = fmt_date(r.get(sk)), fmt_date(r.get(ek))
            if s:
                starts.append(s)
            if e:
                ends.append(e)
        if starts or ends:
            out.append({"label": label, "start": min(starts) if starts else "", "end": max(ends) if ends else ""})
    return out


def _span(schedule):
    starts = [x["start"] for x in schedule if x["start"]]
    ends = [x["end"] for x in schedule if x["end"]]
    return (min(starts) if starts else ""), (max(ends) if ends else "")


def normalize_applyhome(r):
    def g(*keys):
        for k in keys:
            if r.get(k) not in (None, ""):
                return r.get(k)
        return ""
    detail = str(g("HOUSE_DTL_SECD_NM"))   # 민영 / 국민 등
    category = "공공분양" if ("국민" in detail or "공공" in detail) else "민간분양"
    units = g("TOT_SUPLY_HSHLDCO")
    # 청약 단계별 일정 — 해당지역/기타경기/기타지역을 묶어 특별공급 / 1순위 / 2순위로 간결화
    schedule = _grouped_schedule(r, [
        ("특별공급", [("SPSPLY_RCEPT_BGNDE", "SPSPLY_RCEPT_ENDDE")]),
        ("1순위", [
            ("GNRL_RNK1_CRSPAREA_RCPTDE", "GNRL_RNK1_CRSPAREA_ENDDE"),
            ("GNRL_RNK1_ETC_GG_RCPTDE", "GNRL_RNK1_ETC_GG_ENDDE"),
            ("GNRL_RNK1_ETC_AREA_RCPTDE", "GNRL_RNK1_ETC_AREA_ENDDE"),
        ]),
        ("2순위", [
            ("GNRL_RNK2_CRSPAREA_RCPTDE", "GNRL_RNK2_CRSPAREA_ENDDE"),
            ("GNRL_RNK2_ETC_GG_RCPTDE", "GNRL_RNK2_ETC_GG_ENDDE"),
            ("GNRL_RNK2_ETC_AREA_RCPTDE", "GNRL_RNK2_ETC_AREA_ENDDE"),
        ]),
    ])
    span_s, span_e = _span(schedule)
    return {
        "id": "ah-" + str(g("PBLANC_NO", "HOUSE_MANAGE_NO") or g("HOUSE_NM")),
        "source": "청약홈",
        "category": category,
        "supplyKind": "정식청약",
        "type": (detail or "분양주택"),
        "title": g("HOUSE_NM"),
        "region": g("HSSPLY_ADRES", "SUBSCRPT_AREA_CODE_NM"),
        "address": g("HSSPLY_ADRES"),
        "hm": str(g("HOUSE_MANAGE_NO")),
        "pb": str(g("PBLANC_NO")),
        "supplier": g("BSNS_MBY_NM", "CNSTRCT_ENTRPS_NM"),
        "houseType": "APT",
        "totalUnits": int(units) if str(units).isdigit() else units,
        "priceNote": "",
        "recruitDate": fmt_date(g("RCRIT_PBLANC_DE")),
        "applyStart": span_s or fmt_date(g("RCEPT_BGNDE")),
        "applyEnd": span_e or fmt_date(g("RCEPT_ENDDE")),
        "winnerDate": fmt_date(g("PRZWNER_PRESNATN_DE")),
        "contractStart": fmt_date(g("CNTRCT_CNCLS_BGNDE")),
        "contractEnd": fmt_date(g("CNTRCT_CNCLS_ENDDE")),
        "moveInDate": fmt_date(g("MVN_PREARNGE_YM")),
        "url": g("PBLANC_URL") or "https://www.applyhome.co.kr/",
        "schedule": schedule,
        "special": [],
    }


def _int(v):
    s = str(v).replace(",", "").strip()
    return int(s) if s.isdigit() else 0


def fetch_applyhome_mdl(hm, pb):
    """청약홈 APT 주택형별 상세(평형·분양가·특별공급 물량)."""
    key = CONFIG.get("applyhome_service_key", "")
    if not key or not (hm or pb):
        return []
    params = {
        "page": 1, "perPage": 100, "serviceKey": key,
        "cond[HOUSE_MANAGE_NO::EQ]": hm, "cond[PBLANC_NO::EQ]": pb,
    }
    url = APPLYHOME_MDL_URL + "?" + urllib.parse.urlencode(params, safe="%+")
    rows = http_get_json(url).get("data", [])
    out = []
    for r in rows:
        out.append({
            "type": r.get("HOUSE_TY", ""),
            "area": r.get("SUPLY_AR", ""),
            "units": _int(r.get("SUPLY_HSHLDCO")),
            "price": _int(r.get("LTTOT_TOP_AMOUNT")),     # 만원
            "special": _int(r.get("SPSPLY_HSHLDCO")),
            "general": _int(r.get("ETC_HSHLDCO")),
            "sp": {
                "신혼부부": _int(r.get("NWBB_HSHLDCO")),
                "생애최초": _int(r.get("LFE_FRST_HSHLDCO")),
                "다자녀": _int(r.get("MNYCH_HSHLDCO")),
                "노부모부양": _int(r.get("OLD_PARNTS_SUPORT_HSHLDCO")),
                "기관추천": _int(r.get("INSTT_RECOMEND_HSHLDCO")),
                "신생아": _int(r.get("NWWDS_HSHLDCO")),
                "청년": _int(r.get("YGMN_HSHLDCO")),
                "이전기관": _int(r.get("TRANSR_INSTT_ENFSN_HSHLDCO")),
            },
        })
    return out


def fetch_applyhome_cmpet(hm, pb):
    """청약홈 APT 경쟁률: 주택형별 1순위 접수/공급 집계 (접수 마감 공고만 데이터 존재)."""
    key = CONFIG.get("applyhome_service_key", "")
    if not key or not (hm or pb):
        return []
    params = {
        "page": 1, "perPage": 200, "serviceKey": key,
        "cond[HOUSE_MANAGE_NO::EQ]": hm, "cond[PBLANC_NO::EQ]": pb,
    }
    url = APPLYHOME_CMPET_URL + "?" + urllib.parse.urlencode(params, safe="%+")
    try:
        rows = http_get_json(url).get("data", [])
    except Exception as e:
        print(f"[warn] 청약홈 경쟁률 조회 실패: {e}")
        return []
    by_type = {}
    for r in rows:
        ty = str(r.get("HOUSE_TY", ""))
        d = by_type.setdefault(ty, {"type": ty, "supply": 0, "req1": 0})
        if _int(r.get("SUPLY_HSHLDCO")):
            d["supply"] = _int(r.get("SUPLY_HSHLDCO"))
        if str(r.get("SUBSCRPT_RANK_CODE")) == "1":
            d["req1"] += _int(r.get("REQ_CNT"))
    out = []
    for d in by_type.values():
        supply, req = d["supply"], d["req1"]
        out.append({
            "type": d["type"], "supply": supply, "req": req,
            "rate": round(req / supply, 2) if supply else 0,
            "under": supply > 0 and req < supply,
        })
    return out


def normalize_applyhome_remndr(r):
    """무순위/잔여세대(계약취소·불법행위 재공급 등) APT 공고."""
    def g(*keys):
        for k in keys:
            if r.get(k) not in (None, ""):
                return r.get(k)
        return ""
    kind = str(g("HOUSE_SECD_NM")) or "무순위/잔여세대"   # 무순위/잔여세대, 계약취소주택 등
    units = g("TOT_SUPLY_HSHLDCO")
    schedule = _grouped_schedule(r, [
        ("접수", [
            ("SUBSCRPT_RCEPT_BGNDE", "SUBSCRPT_RCEPT_ENDDE"),
            ("GNRL_RCEPT_BGNDE", "GNRL_RCEPT_ENDDE"),
            ("SPSPLY_RCEPT_BGNDE", "SPSPLY_RCEPT_ENDDE"),
        ]),
    ])
    span_s, span_e = _span(schedule)
    return {
        "id": "ahr-" + str(g("PBLANC_NO", "HOUSE_MANAGE_NO") or g("HOUSE_NM")),
        "source": "청약홈",
        "category": "무순위·잔여세대",
        "supplyKind": "무순위/잔여세대",
        "type": kind,
        "title": g("HOUSE_NM"),
        "region": g("HSSPLY_ADRES", "SUBSCRPT_AREA_CODE_NM"),
        "address": g("HSSPLY_ADRES"),
        "supplier": g("BSNS_MBY_NM"),
        "houseType": "APT",
        "totalUnits": int(units) if str(units).isdigit() else units,
        "priceNote": "",
        "recruitDate": fmt_date(g("RCRIT_PBLANC_DE")),
        "applyStart": span_s,
        "applyEnd": span_e,
        "winnerDate": fmt_date(g("PRZWNER_PRESNATN_DE")),
        "contractStart": fmt_date(g("CNTRCT_CNCLS_BGNDE")),
        "contractEnd": fmt_date(g("CNTRCT_CNCLS_ENDDE")),
        "moveInDate": fmt_date(g("MVN_PREARNGE_YM")),
        "url": g("PBLANC_URL") or "https://www.applyhome.co.kr/",
        "schedule": schedule,
        "special": [],
    }


# ---------------------------------------------------------------------------
# LH 분양/임대 공고 조회 (응답 형식이 비표준이라 방어적으로 파싱)
# ---------------------------------------------------------------------------
def extract_lh_list(data):
    """LH 응답 [{dsSch:[...]},{dsList:[...]}] 에서 실제 레코드 리스트(dsList)만 추출."""
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict) and isinstance(item.get("dsList"), list):
                return item["dsList"]
    if isinstance(data, dict) and isinstance(data.get("dsList"), list):
        return data["dsList"]
    return []


def lh_category(tp):
    tp = str(tp)
    if "분양" in tp:
        return "공공분양"
    if "장기전세" in tp:
        return "장기전세"
    if "행복" in tp:
        return "행복주택"
    if "통합" in tp:
        return "통합공공임대"
    if "국민" in tp:
        return "국민임대"
    if "영구" in tp:
        return "영구임대"
    if "전세" in tp:
        return "전세임대"
    return tp or "공공임대"   # 매입임대 등은 유형명 그대로


def fetch_lh(per_page=100, keep=60):
    key = CONFIG.get("lh_service_key", "")
    if not key:
        return load_sample("sample_lh.json"), "sample"
    try:
        # 최근 4개월 공고를 조회 (게시일 기준)
        end = datetime.now()
        start = end - timedelta(days=120)
        params = {
            "serviceKey": key, "PG_SZ": per_page, "PAGE": 1,
            "PAN_ST_DT": start.strftime("%Y%m%d"), "PAN_ED_DT": end.strftime("%Y%m%d"),
        }
        url = LH_URL + "/lhLeaseNoticeInfo1?" + urllib.parse.urlencode(params, safe="%+")
        rows = extract_lh_list(http_get_json(url))
        out, raw_by_id = [], {}
        NON_HOUSING = ("어린이집", "상가", "주차장", "창고", "공장", "토지", "단지내")
        for r in rows:
            upp = str(r.get("UPP_AIS_TP_NM", ""))
            tp = str(r.get("AIS_TP_CD_NM", ""))
            # 주택(임대/분양)만 — 상가·토지·어린이집 등 비주거 제외
            if upp and ("임대" not in upp and "분양" not in upp):
                continue
            if any(w in tp for w in NON_HOUSING):
                continue
            n = normalize_lh(r)
            out.append(n)
            raw_by_id[n["id"]] = r
        out = [n for n in out if n.get("title")]
        out.sort(key=lambda n: n.get("recruitDate", ""), reverse=True)
        out = out[:keep]
        # 상태(접수예정/중/마감) 정확도를 위해 상세에서 '청약 접수' 시작/종료일을 가져와 반영
        # (병렬 + PAN_ID 캐싱 -> 모달 열 때도 캐시 재사용. 목록 응답은 10분 캐시)
        enrich_lh_status([(n, raw_by_id[n["id"]]) for n in out])
        return (out, "live") if out else (load_sample("sample_lh.json"), "sample")
    except Exception as e:
        print(f"[warn] LH API 호출 실패 -> 샘플 사용: {e}")
        return load_sample("sample_lh.json"), "sample"


def enrich_lh_status(pairs):
    """각 LH 공고의 상태를 상세의 '청약 접수' 시작/종료일로 보정 (병렬). 권한 없으면 스킵."""
    if LH_DETAIL_DISABLED or not pairs:
        return

    def work(p):
        n, raw = p
        d = fetch_lh_detail(raw)
        if not d:
            return
        sch = d.get("schedule") or []
        acp = [x for x in sch if x.get("label") == "청약 접수"]
        s, e = _span(acp or sch)
        if s:
            n["applyStart"] = s
        if e:
            n["applyEnd"] = e

    try:
        with ThreadPoolExecutor(max_workers=32) as ex:
            list(ex.map(work, pairs))
    except Exception as e:
        print(f"[warn] LH 상태 보강 실패: {e}")


def fetch_lh_detail(raw):
    """공고별 상세정보 조회 (PAN_ID 등 식별자 필요). 권한 미승인 시 None + 자동 비활성화."""
    global LH_DETAIL_DISABLED
    if LH_DETAIL_DISABLED:
        return None
    pan = str(raw.get("PAN_ID", ""))
    if not pan:
        return None
    if pan in _lh_detail_cache:
        return _lh_detail_cache[pan]
    key = CONFIG.get("lh_service_key", "")
    params = {
        "serviceKey": key,
        "PAN_ID": pan,
        "CCR_CNNT_SYS_DS_CD": raw.get("CCR_CNNT_SYS_DS_CD", ""),
        "UPP_AIS_TP_CD": raw.get("UPP_AIS_TP_CD", ""),
        "AIS_TP_CD": raw.get("AIS_TP_CD", ""),
        "SPL_INF_TP_CD": raw.get("SPL_INF_TP_CD", ""),
    }
    url = LH_DETAIL_URL + "?" + urllib.parse.urlencode(params, safe="%+")
    try:
        result = normalize_lh_detail(http_get_json(url, timeout=8))
        _lh_detail_cache[pan] = result
        return result
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            LH_DETAIL_DISABLED = True
            print(f"[info] LH 상세 API 미승인({e.code}) -> 상세 보강 비활성화 (목록 정보만 표시)")
        _lh_detail_cache[pan] = None
        return None
    except Exception as e:
        print(f"[warn] LH 상세 조회 실패(PAN_ID={pan}): {e}")
        _lh_detail_cache[pan] = None
        return None


def fetch_lh_spl(raw):
    """LH 공급정보: 주택형별 전용면적·세대수·임대보증금·월임대료(또는 분양가)."""
    key = CONFIG.get("lh_service_key", "")
    pan = str(raw.get("PAN_ID", ""))
    if not key or not pan:
        return []
    params = {
        "serviceKey": key, "PAN_ID": pan,
        "CCR_CNNT_SYS_DS_CD": raw.get("CCR_CNNT_SYS_DS_CD", ""),
        "UPP_AIS_TP_CD": raw.get("UPP_AIS_TP_CD", ""),
        "AIS_TP_CD": raw.get("AIS_TP_CD", ""),
        "SPL_INF_TP_CD": raw.get("SPL_INF_TP_CD", ""),
    }
    url = LH_SPL_URL + "?" + urllib.parse.urlencode(params, safe="%+")
    try:
        data = http_get_json(url, timeout=10)
    except Exception as e:
        print(f"[warn] LH 공급정보 조회 실패(PAN_ID={pan}): {e}")
        return []
    # [{dsSch},{dsList01Nm, dsList01, ...}] 에서 dsList01 추출
    rows = []
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict) and isinstance(item.get("dsList01"), list):
                rows = item["dsList01"]
                break
    out = []
    for r in rows:
        out.append({
            "type": str(r.get("HTY_NNA", "")).strip(),
            "areaEx": str(r.get("DDO_AR", "")).strip(),    # 전용면적
            "areaSp": str(r.get("SPL_AR", "")).strip(),     # 공급면적
            "units": str(r.get("HSH_CNT", "")).strip(),
            "nowUnits": str(r.get("NOW_HSH_CNT", "")).strip(),
            "deposit": str(r.get("LS_GMY", "")).strip(),    # 임대보증금(원) 또는 "공고문 참조"
            "rent": str(r.get("RFE", "")).strip(),          # 월임대료(원) 또는 "공고문 참조"
            "danji": str(r.get("SBD_LGO_NM", "")).strip(),
        })
    return out


def normalize_lh_detail(data):
    """상세 응답에서 접수일정/세대수/전용면적/입주예정/당첨발표/계약/공고문파일 추출.
    응답: [{dsSch}, {dsSplScdl, dsSbd, dsAhflInfo, ...}] — dsXXXNm(라벨)은 무시."""
    body = {}
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict) and ("dsSplScdl" in item or "dsSbd" in item):
                body = item
                break
    elif isinstance(data, dict):
        body = data

    scdl = (body.get("dsSplScdl") or [{}])
    sbd = body.get("dsSbd") or []
    ahfl = body.get("dsAhflInfo") or []

    # 일정 (여러 행이면 접수는 min~max, 단일일자는 첫 값)
    def col(rows, key):
        return [fmt_date(r.get(key)) for r in rows if fmt_date(r.get(key))]
    acp_s = col(scdl, "SBSC_ACP_ST_DT")
    acp_e = col(scdl, "SBSC_ACP_CLSG_DT")
    ppr_s = col(scdl, "PPR_ACP_ST_DT")
    ppr_e = col(scdl, "PPR_ACP_CLSG_DT")
    win = col(scdl, "PZWR_ANC_DT")
    ctr_s = col(scdl, "CTRT_ST_DT")
    ctr_e = col(scdl, "CTRT_ED_DT")

    schedule = []
    if acp_s or acp_e:
        schedule.append({"label": "청약 접수", "start": min(acp_s) if acp_s else "", "end": max(acp_e) if acp_e else ""})
    if ppr_s or ppr_e:
        schedule.append({"label": "서류 접수", "start": min(ppr_s) if ppr_s else "", "end": max(ppr_e) if ppr_e else ""})
    if win:
        schedule.append({"label": "당첨자 발표", "start": min(win), "end": min(win)})

    # 단지: 총세대수 합, 전용면적 범위, 입주예정월
    total_units, areas, movein = 0, [], ""
    for r in sbd:
        if str(r.get("HSH_CNT", "")).replace(",", "").isdigit():
            total_units += int(str(r["HSH_CNT"]).replace(",", ""))
        if r.get("DDO_AR"):
            areas.append(str(r["DDO_AR"]))
        if not movein and r.get("MVIN_XPC_YM"):
            movein = str(r["MVIN_XPC_YM"]).replace(".", "-")

    # 전용면적 요약(숫자만 추려 최소~최대)
    area_note = ""
    nums = []
    for a in areas:
        for tok in str(a).replace("~", " ").split():
            try:
                nums.append(float(tok))
            except ValueError:
                pass
    if nums:
        lo, hi = round(min(nums), 1), round(max(nums), 1)
        area_note = f"전용 {lo:g}㎡" if lo == hi else f"전용 {lo:g}~{hi:g}㎡"

    # 공고문 PDF 링크
    doc_url = ""
    for f in ahfl:
        nm = str(f.get("SL_PAN_AHFL_DS_CD_NM", ""))
        if "PDF" in nm.upper() and f.get("AHFL_URL"):
            doc_url = f["AHFL_URL"]
            break

    # 단지 정확 주소 (지도용)
    address = ""
    for r in sbd:
        if r.get("LGDN_ADR"):
            address = str(r["LGDN_ADR"])
            break

    price_parts = []
    if area_note:
        price_parts.append(area_note)
    return {
        "schedule": schedule,
        "totalUnits": total_units or "",
        "priceNote": " · ".join(price_parts),
        "winnerDate": (min(win) if win else ""),
        "contractStart": (min(ctr_s) if ctr_s else ""),
        "contractEnd": (max(ctr_e) if ctr_e else ""),
        "moveInDate": movein,
        "docUrl": doc_url,
        "address": address,
    }


def normalize_lh(r):
    def g(*keys):
        for k in keys:
            if isinstance(r, dict) and r.get(k) not in (None, ""):
                return r.get(k)
        return ""
    tp = str(g("AIS_TP_CD_NM"))                  # 행복주택 / 국민임대 / 공공분양 등
    upp = str(g("UPP_AIS_TP_NM"))                # 임대주택 / 분양주택
    recruit = fmt_date(g("PAN_NT_ST_DT", "PAN_DT"))
    close = fmt_date(g("CLSG_DT"))
    return {
        "id": "lh-" + str(g("PAN_ID") or g("PAN_NM")),
        "source": "LH",
        "category": lh_category(tp or upp),
        "supplyKind": upp or "공공주택",
        "type": tp or upp or "공공주택",
        "title": g("PAN_NM"),
        "region": g("CNP_CD_NM"),
        "address": g("CNP_CD_NM"),
        "supplier": "한국토지주택공사(LH)",
        "houseType": tp or "임대",
        "totalUnits": "",
        "priceNote": "",
        "recruitDate": recruit,
        "applyStart": recruit,
        "applyEnd": close,
        "winnerDate": "",
        "contractStart": "",
        "contractEnd": "",
        "moveInDate": "",
        "url": g("DTL_URL", "DTL_URL_MOB") or "https://apply.lh.or.kr/",
        "statusText": g("PAN_SS"),
        "schedule": ([{"label": "공고~마감", "start": recruit, "end": close}] if close else []),
        "special": [],
        # 상세는 모달 열 때 /api/lh-detail 로 지연 로딩 (목록 속도 개선)
        "lhKey": {
            "pan": str(g("PAN_ID")), "ccr": str(g("CCR_CNNT_SYS_DS_CD")),
            "upp": str(g("UPP_AIS_TP_CD")), "ais": str(g("AIS_TP_CD")), "spl": str(g("SPL_INF_TP_CD")),
        },
    }


# ---------------------------------------------------------------------------
# HTTP 핸들러
# ---------------------------------------------------------------------------
class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    def log_message(self, fmt, *args):
        pass  # 조용히

    def _send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    # 공고문(PDF) 바로보기: 원본은 attachment라 다운로드되므로 inline PDF로 변환해 프록시
    ALLOWED_DOC_HOSTS = ("apply.lh.or.kr", "applyhome.co.kr", "api.odcloud.kr", "data.go.kr")

    def _serve_doc(self, url):
        try:
            host = urllib.parse.urlparse(url).hostname or ""
            if not any(host == h or host.endswith("." + h) for h in self.ALLOWED_DOC_HOSTS):
                self._send_json({"error": "허용되지 않은 출처"}, 400)
                return
            req = urllib.request.Request(url, headers={"User-Agent": "cheongyak-viewer/1.0"})
            with urllib.request.urlopen(req, timeout=20) as up:
                body = up.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Disposition", "inline")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "private, max-age=600")
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self._send_json({"error": f"문서를 불러올 수 없습니다: {e}"}, 502)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/health":
            self._send_json({
                "ok": True,
                "time": datetime.now().isoformat(timespec="seconds"),
                "applyhome_key": bool(CONFIG.get("applyhome_service_key")),
                "lh_key": bool(CONFIG.get("lh_service_key")),
            })
            return
        if parsed.path == "/api/config":
            self._send_json({"kakaoJsKey": CONFIG.get("kakao_js_key", "")})
            return
        if parsed.path == "/api/applyhome-detail":
            qs = urllib.parse.parse_qs(parsed.query)
            try:
                hm, pb = qs.get("hm", [""])[0], qs.get("pb", [""])[0]
                units = cached("ah-mdl:" + hm + ":" + pb, 1800, lambda: fetch_applyhome_mdl(hm, pb))
                self._send_json({"units": units})
            except Exception as e:
                self._send_json({"units": [], "error": str(e)}, 502)
            return
        if parsed.path == "/api/applyhome-cmpet":
            qs = urllib.parse.parse_qs(parsed.query)
            hm, pb = qs.get("hm", [""])[0], qs.get("pb", [""])[0]
            try:
                rates = cached("ah-cmpet:" + hm + ":" + pb, 1800, lambda: fetch_applyhome_cmpet(hm, pb))
                self._send_json({"rates": rates})
            except Exception as e:
                self._send_json({"rates": [], "error": str(e)}, 502)
            return
        if parsed.path == "/api/lh-detail":
            qs = urllib.parse.parse_qs(parsed.query)
            raw = {
                "PAN_ID": qs.get("pan", [""])[0], "CCR_CNNT_SYS_DS_CD": qs.get("ccr", [""])[0],
                "UPP_AIS_TP_CD": qs.get("upp", [""])[0], "AIS_TP_CD": qs.get("ais", [""])[0],
                "SPL_INF_TP_CD": qs.get("spl", [""])[0],
            }
            try:
                pan = raw["PAN_ID"]
                detail = fetch_lh_detail(raw) or {}
                units = cached("lh-spl:" + pan, 1800, lambda: fetch_lh_spl(raw))
                self._send_json({"detail": detail, "units": units})
            except Exception as e:
                self._send_json({"detail": {}, "units": [], "error": str(e)}, 502)
            return
        if parsed.path == "/api/doc":
            self._serve_doc(urllib.parse.parse_qs(parsed.query).get("url", [""])[0])
            return
        if parsed.path == "/api/notices":
            qs = urllib.parse.parse_qs(parsed.query)
            source = (qs.get("source", ["all"])[0]).lower()
            items, sources = [], {}
            if source in ("all", "applyhome"):
                ah, ah_src = cached("notices:applyhome", 1800, fetch_applyhome)
                items += ah
                sources["applyhome"] = ah_src
            if source in ("all", "lh"):
                lh, lh_src = cached("notices:lh", 1800, fetch_lh)
                items += lh
                sources["lh"] = lh_src
            self._send_json({"items": items, "sources": sources, "count": len(items)})
            return
        # 정적 파일
        super().do_GET()


def prewarm():
    """서버 시작 시 백그라운드로 목록 캐시를 미리 채워 첫 사용자 요청을 빠르게."""
    try:
        cached("notices:applyhome", 1800, fetch_applyhome)
        cached("notices:lh", 1800, fetch_lh)
        print("[info] 데이터 프리워밍 완료")
    except Exception as e:
        print(f"[warn] 프리워밍 실패: {e}")


def main():
    port = int(os.environ.get("PORT", CONFIG.get("port", 8000)))
    os.chdir(WEB_DIR)
    handler = Handler
    import threading
    threading.Thread(target=prewarm, daemon=True).start()
    with socketserver.ThreadingTCPServer(("", port), handler) as httpd:
        httpd.daemon_threads = True
        print("=" * 56)
        print("  청약/분양 통합 뷰어 서버 실행 중")
        print(f"  브라우저에서 열기:  http://localhost:{port}")
        ah = "발급됨" if CONFIG.get("applyhome_service_key") else "없음(샘플 사용)"
        lh = "발급됨" if CONFIG.get("lh_service_key") else "없음(샘플 사용)"
        print(f"  청약홈 서비스키: {ah}   |   LH 서비스키: {lh}")
        print("  종료하려면 Ctrl+C")
        print("=" * 56)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n서버를 종료합니다.")


if __name__ == "__main__":
    main()
