# Project design
프로젝트명: Northstar — Windows 데스크톱 레이어 기반 그래픽 편집기.

목표: 도형·텍스트·이미지·벡터 객체의 생성, 선택, 변형, 레이어 관리, Undo/Redo, 자체 문서 저장·재열기를 지원한다. PSD와 PDF 호환 AI 파일은 검증된 기능 범위에서 처리한다.

기준: origin/main SHA 1865a9eca154c222816d3de0386ae94d84dbc8a4. 초기 커밋만 있는 저장소에서 새로 구축한다.

구성:
apps/editor — Electron·React·TypeScript·Vite 기반 편집기, 캔버스, 레이어·속성 패널, 문서 모델과 안전한 preload IPC.
packages/psd-bridge — ag-psd 기반 PSD 계층·래스터·속성 읽기·편집·저장.
packages/ai-bridge — PDF 호환 AI 판별, 제한적 벡터·텍스트 분석과 안전한 변환.
docs/projecthub/initial-plan.md — 최초 설계와 완료 기준.

M1: 편집기 기본 GUI, 객체·레이어 편집, .nbdoc 왕복, 독립 PSD·AI 모듈, 빌드와 자동 테스트를 완료한다.
M2: PSD 편집기 통합과 실제 GUI 왕복, 지원 가능한 PDF 호환 AI 가져오기, 포맷별 손실 경고를 구현한다.
M3: 정밀 변형, 그룹, 텍스트·벡터, 레이어 속성과 편집 안정성을 확장한다. 네이티브 AI 저장은 검증된 백엔드가 있을 때만 구현한다.
M4: 실제 Adobe 생성 샘플 호환성, 대용량·오류 입력, Windows 패키징과 실행을 검증한다.

원칙: 데이터 손실 가능성을 사용자에게 고지하고 불확실한 변환은 거부한다. PDF를 .ai로 변경하는 행위를 네이티브 AI 저장으로 인정하지 않는다. 검증되지 않은 Adobe 호환성을 보장하지 않는다.

최종 완료 기준: Windows 실행, 객체·레이어 편집, .nbdoc 왕복, 지원 범위 내 PSD 왕복, PDF 호환 AI 가져오기, 오류·손실 처리, 실제 샘플 검증과 배포 검사를 통과한다.
