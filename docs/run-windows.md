# Windows에서 Northstar 실행 및 검증

## 편집기 실행

프로젝트 루트의 `RUN-NORTHSTAR.bat`를 더블클릭하면 Northstar Editor가 실행됩니다. 경로는 배치 파일 위치를 기준으로 계산하므로 프로젝트 폴더에 공백이나 한글이 포함되어도 실행할 수 있습니다.

`apps/editor/release`에 패키지된 `Northstar Editor.exe`가 있으면 그 파일을 먼저 실행합니다. 패키지가 없으면 Node.js 22.6 이상과 npm을 확인하고, 필요한 PSD Bridge 및 Editor 의존성을 설치한 다음 PSD Bridge와 Editor를 차례로 빌드해 Electron GUI를 엽니다. 준비나 실행 중 실패하면 창에 원인과 점검 방법을 표시하고 키 입력을 기다립니다.

개발용 사전 요건은 [Node.js 다운로드](https://nodejs.org/)에서 설치할 수 있습니다. npm 설치, 빌드 또는 시작 문제는 배치 창의 안내에 따라 해당 단계에서 출력된 오류를 확인하세요.

## Windows 검증 실행

프로젝트 루트의 `TEST-NORTHSTAR.bat`를 더블클릭하면 PSD Bridge와 Editor 빌드를 준비한 뒤 다음 검사를 순서대로 실행합니다.

- Editor TypeScript 타입 검사와 단위 테스트
- M1 문서 GUI 스모크
- M2 PSD 및 AI GUI 스모크
- M3 편집 및 문서 저장/재열기 GUI 스모크

각 검사의 성공/실패 요약은 창에 표시합니다. 전체 명령 출력과 결과는 `%TEMP%\northstar-test-*.log`에 기록됩니다. CI에서는 `NORTHSTAR_TEST_LOG` 환경 변수로 로그 파일 위치를 지정할 수 있습니다. 실패한 검사는 나머지 검사도 계속 실행하며, 최종 종료 코드는 실패가 있으면 1입니다.

## CI

`.github/workflows/m4-packaging-validation.yml`은 Windows Runner에서 이 검증 배치를 실행하고, ZIP 패키지 검사 및 패키지 GUI 스모크와 함께 결과 로그를 업로드합니다. 패키지의 서명 및 배포 범위는 [M4 패키지 검증](m4-validation.md)을 참고하세요.
