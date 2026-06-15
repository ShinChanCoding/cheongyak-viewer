# 배포 가이드 (Render + GitHub)

이 앱은 파이썬 표준 라이브러리만 쓰는 상시 서버(`server.py`)라 **개조 없이 Render에 바로 배포**됩니다.

## 사전 준비
- GitHub 계정
- Render 계정 (https://render.com — GitHub로 가입 가능, 무료)
- 발급받은 공공데이터 서비스 키 (청약홈·LH, 같은 키 가능)

## 1단계 — GitHub에 코드 올리기
> `config.json`(키 파일)은 `.gitignore`에 있어 **절대 올라가지 않습니다.** 키는 Render 환경변수로 넣습니다.

```bash
git init
git add .
git commit -m "청약·분양 통합 뷰어"
# GitHub에서 빈 저장소 생성 후:
git remote add origin https://github.com/<사용자명>/<저장소명>.git
git branch -M main
git push -u origin main
```
(또는 GitHub CLI: `gh repo create <이름> --public --source=. --push`)

## 2단계 — Render에서 배포
1. https://render.com 로그인 → **New +** → **Blueprint**
2. 방금 만든 GitHub 저장소 선택 → Render가 `render.yaml`을 자동 인식
3. **Apply** 클릭

또는 수동(Blueprint 없이):
- **New +** → **Web Service** → 저장소 연결
- Runtime: `Python`
- Build Command: `pip install -r requirements.txt`
- Start Command: `python server.py`
- Instance Type: **Free**

## 3단계 — 환경변수(키) 입력  ⚠️ 필수
Render 서비스 → **Environment** 탭에서 추가:

| Key | Value |
|---|---|
| `APPLYHOME_SERVICE_KEY` | 발급받은 청약홈 인증키 |
| `LH_SERVICE_KEY` | 발급받은 LH 인증키 (보통 동일) |

저장하면 자동 재배포됩니다. (키가 없으면 샘플 데이터로 동작)

## 4단계 — 확인
- 배포 완료 후 `https://<서비스명>.onrender.com` 접속
- `…/api/health` 로 키 인식 여부 확인 가능

## 참고
- **무료 플랜 cold start**: 15분 미사용 시 잠들어 첫 요청이 ~30초 걸립니다. (깨면 정상 속도)
- **공공 API 한도**: data.go.kr 개발계정 일 40,000건. 트래픽 많아지면 운영단계 신청 고려.
- `git push` 할 때마다 **자동 재배포**됩니다.
