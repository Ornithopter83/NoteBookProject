# M10 내보내기 파일 영속성 검증

`document:export`는 먼저 목적지와 원본 경로의 동일 파일 여부를 확인합니다. SVG, PNG, JPEG, PDF, 평면 PSD는 목적지와 같은 폴더에 고유한 임시 파일로 완성한 다음 실제 파일 종류와 바이트 크기를 확인하고 목적지로 이동합니다. 생성 도중 오류가 나면 기존 목적지 파일을 건드리지 않습니다. 성공 응답에는 최종 저장 경로와 디스크에서 다시 읽은 실제 바이트 크기가 포함됩니다.

AI 내보내기는 Windows의 Adobe Illustrator COM 자동화만 사용합니다. Illustrator가 SVG를 열고 PDF 호환 네이티브 AI로 저장한 뒤 문서를 닫고 저장한 AI를 다시 열 수 있어야 성공합니다. 저장 파일 자체는 PDF 호환 서명, 끝 표시, 비어 있지 않은 길이로 검사하고 최종 저장본의 SHA-256을 방금 저장한 데이터와 비교합니다. `inspectAi`의 제한된 파싱 결과를 성공 판정에 사용하지 않습니다. 유효성이 확인된 임시 AI만 최종 경로에 반영됩니다. 가짜 `.ai` 파일은 만들지 않습니다.

PowerShell 오류는 PowerShell 5.1의 시스템 코드 페이지나 표준 출력 스트림에 맡기지 않습니다. 스크립트가 오류를 UTF-8 파일로 기록하고 Electron 프로세스가 이를 UTF-8로 읽습니다. PowerShell stdout/stderr 스트림은 사용자에게 바이너리나 인코딩이 깨진 출력을 노출하지 않도록 무시합니다. 원인, Illustrator 부재, 시간 초과, 취소는 각각 별도 오류 안내로 전달됩니다.

## Windows E2E

`apps/editor/scripts/m10-export-persistence-smoke.cjs`는 Electron UI를 실제 실행합니다. 먼저 M6 GUI 스모크를 호출해 PNG, SVG, PDF, JPEG, PSD 파일이 생기고 형식별 내용 검사가 통과하는지 확인합니다. 그다음 별도 앱 실행에서 SVG와 PDF 대체 내보내기 및 AI 분기를 검사합니다. Illustrator가 있으면 저장·닫기·재열기까지 끝난 네이티브 AI의 크기와 PDF 호환 서명·끝 표시를 확인합니다. 없으면 설치 안내가 표시되고 `.ai` 파일이 생기지 않았는지 확인합니다.

이 검증은 `.github/workflows/m4-packaging-validation.yml`의 Windows 패키징 작업에 연결되어 있습니다. CI의 Windows 이미지에 Illustrator가 없는 경우 미설치 분기가 실행됩니다. Illustrator 설치가 제공되는 환경에서만 네이티브 저장·재열기 분기가 실제 실행됩니다.
