# 오늘의 배송 루트

주소만 입력하면 자동으로 좌표를 찾고(카카오 로컬 API), 실제 도로 주행거리 기준으로(OSRM) 오늘의 배송 순서를 계산해주는 개인용 웹앱입니다.

## 배포 방법 (GitHub → Vercel)

### 1) 이 폴더를 GitHub 저장소에 올리기
1. github.com 에서 로그인 후 오른쪽 위 `+` → `New repository`
2. 저장소 이름 입력 (예: `delivery-route-app`), Public/Private 아무거나 선택 후 `Create repository`
3. 생성된 저장소 페이지에서 `Add file` → `Upload files` 클릭
4. 이 폴더 안의 파일들(`index.html`, `package.json`, `api` 폴더 전체)을 통째로 끌어다 놓기
5. 아래 `Commit changes` 버튼 클릭

### 2) Vercel에서 이 저장소를 불러와 배포하기
1. vercel.com 로그인 (GitHub 계정으로 로그인하면 저장소가 바로 보입니다)
2. `Add New...` → `Project`
3. 방금 만든 `delivery-route-app` 저장소를 찾아 `Import`
4. Framework Preset은 `Other`로 두고 그대로 진행 (수정할 것 없음)
5. **배포하기 전에** 아래 3번 "환경변수 설정"을 먼저 하고 `Deploy` 클릭

### 3) 환경변수(카카오 API 키) 설정
1. Vercel 프로젝트 설정 화면에서 `Environment Variables` 항목을 찾습니다
2. Key: `KAKAO_REST_KEY`
3. Value: 카카오 디벨로퍼스에서 발급받은 REST API 키
4. `Add` 클릭 후 저장
5. (이미 배포한 뒤에 추가했다면) 프로젝트의 `Deployments` 탭에서 최신 배포 옆 `...` 메뉴 → `Redeploy` 한 번 눌러줘야 키가 적용됩니다

배포가 끝나면 `https://프로젝트이름.vercel.app` 같은 주소가 생기고, 그 주소로 접속하면 앱이 바로 열립니다. 핸드폰 브라우저에서 그 주소를 열고 "홈 화면에 추가"를 하면 앱처럼 쓸 수 있습니다.

## 참고 사항

- 배달처 데이터는 이 앱을 여는 브라우저(기기)에 저장됩니다(localStorage). 기기를 바꾸면 데이터가 안 보이니, 여러 기기에서 쓰려면 나중에 별도 데이터베이스 연동이 필요합니다.
- 실제 도로 경로 계산은 무료 공개 서버(OSRM)를 사용합니다. 개인이 하루 몇 번 쓰는 용도로는 충분하지만, 아주 가끔 응답이 느리거나 실패할 수 있습니다.
- 카카오 REST API 키는 서버 코드(`api/geocode.js`)에서만 사용되고 `process.env.KAKAO_REST_KEY`로 읽어오기 때문에, 이 GitHub 저장소 코드 어디에도 키 값 자체는 들어있지 않습니다.
