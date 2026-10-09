# Windows에서 Northstar 실행 및 검증

## 편집기 실행

프로젝트 루트의 `RUN-NORTHSTAR.bat`를 더블클릭하면 Northstar Editor가 실행됩니다. 바로가기를 만들 때는 `RUN-NORTHSTAR.bat` 자체를 대상으로 지정하세요. 바로가기의 대상 경로는 따옴표로 감싸고, 시작 위치는 프로젝트 루트로 지정하면 폴더 이름에 공백·한글·특수문자가 있어도 경로가 깨지지 않습니다. 저장소 안에서는 `.lnk` 바로가기를 제공하지 않습니다.

`apps/editor/release/win-unpacked/Northstar Editor.exe`와 Electron 런타임 파일, `resources/app.asar`가 모두 유효하면 그 패키지를 먼저 실행합니다. 실행 파일 이름에 공백이 있으므로 명령줄에서 직접 지정할 때는 전체 경로를 따옴표로 감싸야 합니다. `scripts/m7-launch-check.ps1`이 PE 헤더, Electron 런타임 파일, 패키지 구성, 실행 종료 코드를 확인합니다.

실행 파일이 없거나 추출이 불완전하면 `apps/editor/release/Northstar-Editor-*-win-x64.zip` 중 가장 최근 ZIP을 검사합니다. ZIP 안의 절대 경로와 상위 폴더 이동 경로를 차단하고 임시 폴더에서 exe와 `resources/app.asar`를 확인한 다음에만 `win-unpacked`로 반영합니다. 사용할 수 있는 ZIP이 없거나 복구에 실패하면 Node.js 22.6 이상과 npm을 확인하고 PSD Bridge 및 Editor 의존성을 설치한 뒤 개발 GUI를 실행합니다. 누락 파일이나 실패 원인과 다음 점검 방법은 실행 창에 한글로 표시됩니다.

`.github/workflows/m4-packaging-validation.yml`은 CI에서 ZIP을 별도 임시 폴더에 추출해 검사합니다. CI 패키징 성공은 로컬 `release/win-unpacked` 폴더의 존재를 뜻하지 않습니다. 로컬 파일 상태는 실행할 때마다 별도로 확인합니다.

개발용 사전 요건은 [Node.js 다운로드](https://nodejs.org/)에서 설치할 수 있습니다. npm 설치, 빌드 또는 시작 문제는 배치 창의 안내에 따라 해당 단계에서 출력된 오류를 확인하세요.

## Windows 검증 실행

프로젝트 루트의 `TEST-NORTHSTAR.bat`를 더블클릭하면 PSD Bridge와 Editor 빌드를 준비한 뒤 다음 검사를 순서대로 실행합니다.

- Editor TypeScript 타입 검사와 단위 테스트
- M1 문서 GUI 스모크
- M2 PSD 및 AI GUI 스모크
- M3 편집 및 문서 저장/재열기 GUI 스모크

각 검사의 성공/실패 요약은 창에 표시합니다. 전체 명령 출력과 결과는 `%TEMP%\northstar-test-*.log`에 기록됩니다. CI에서는 `NORTHSTAR_TEST_LOG` 환경 변수로 로그 파일 위치를 지정할 수 있습니다. 실패한 검사는 나머지 검사도 계속 실행하며, 최종 종료 코드는 실패가 있으면 1입니다.

최종 실행 경로 검사는 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File apps\editor\scripts\m7-launch-e2e.ps1`로 실행합니다. 검사는 `%TEMP%`의 새 임시 폴더 안에 프로젝트 fixture를 만들고 실제 `RUN-NORTHSTAR.bat` 및 패키지 검사 스크립트를 복사해 사용합니다. 공백 경로의 GUI 기동, 정상 종료와 종료 코드 전달, 잘못된 바로가기 대상, exe 누락 후 ZIP 복구, 불완전·손상 ZIP, 복구 중 rollback, 패키지 실패 후 개발 실행 전환을 확인한 뒤 fixture를 삭제합니다. 실제 `release` 패키지와 문서는 변경하지 않습니다.

## CI

`.github/workflows/m4-packaging-validation.yml`은 Windows Runner에서 기존 검증 배치와 M7 격리 실행 E2E를 실행하고, ZIP 패키지 검사 및 패키지 GUI 스모크와 함께 결과 로그를 업로드합니다. 패키지의 서명 및 배포 범위는 [M4 패키지 검증](m4-validation.md)을 참고하세요.
